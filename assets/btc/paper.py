#!/usr/bin/env python3
"""模拟盘账本：与行情库**同一个 sqlite 文件**，不碰真钱。

口径（与实盘对齐，每次报数都要一致）：
- **开仓统一限价单**：挂出后不立即成交，没成交就一直挂着，直到下一次买卖点或主动撤单；
- **成交判定**：价格到达限价即视为成交。**限价已在市场另一侧时，挂出即成交**（真实交易所
  的吃单行为），成交价取「限价与当时价格中更优的那个」——多头 min、空头 max，
  所以不会出现「按 80276 挂空、市场 80532 却记 80276」这种凭空变好的入场价；
- **价格源**：优先用调用方传入的实时标记价（`mark_price`），没有则用库内最新收盘价。
  撮合、估值、平仓**必须用同一个价格**，否则面板顶部是实时价、浮盈按旧收盘价算，
  看起来就是「价格 79359 却在亏」；
- 手续费 0.05%（单边，开平各收一次），资金费不计；
- 同时只允许一个持仓、一张未成交挂单。
"""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timedelta, timezone

FEE_RATE = 0.0005

SCHEMA = """
CREATE TABLE IF NOT EXISTS paper_account (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    initial_capital REAL NOT NULL,
    cash            REAL NOT NULL,
    side            TEXT,
    qty             REAL,
    entry_price     REAL,
    entry_notional  REAL,
    entry_ts        TEXT,
    stop_price      REAL,
    leverage        REAL,
    updated_at      TEXT
);

CREATE TABLE IF NOT EXISTS paper_orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    side        TEXT NOT NULL,
    qty         REAL NOT NULL,
    limit_price REAL NOT NULL,
    notional    REAL NOT NULL,
    stop_price  REAL,
    reason      TEXT,
    created_at  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    filled_at   TEXT,
    fill_price  REAL,
    expires_at  TEXT
);

CREATE TABLE IF NOT EXISTS paper_trades (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    side          TEXT NOT NULL,
    qty           REAL NOT NULL,
    entry_price   REAL NOT NULL,
    exit_price    REAL NOT NULL,
    entry_ts      TEXT,
    exit_ts       TEXT,
    pnl           REAL NOT NULL,
    fee           REAL NOT NULL,
    entry_reason  TEXT,
    exit_reason   TEXT
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def connect(db_path: str) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    # 与行情同步共用同一个库：paper 后端与 live 后端可能同时写，等锁而不是直接报错
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.executescript(SCHEMA)
    # 老库补列：`CREATE TABLE IF NOT EXISTS` 不会给已存在的表加字段，
    # 直接 SELECT 会报 no such column（表现为「模拟盘坏了」）。
    for statement in (
        "ALTER TABLE paper_orders ADD COLUMN expires_at TEXT",
        "ALTER TABLE paper_orders ADD COLUMN leverage REAL",
        # 杠杆口径：老库没有该列，按 1x 处理（与旧行为一致）
        "ALTER TABLE paper_account ADD COLUMN leverage REAL",
    ):
        try:
            conn.execute(statement)
        except sqlite3.OperationalError:
            pass
    return conn


def _lev(value) -> float:
    """杠杆：非法/缺失按 1x。"""
    try:
        lev = float(value)
    except (TypeError, ValueError):
        return 1.0
    return min(125.0, max(1.0, lev))


def _mark(mark: float | None) -> float | None:
    """实时标记价（调用方传入）；非法值当没给，回落库内收盘价。"""
    if mark is None:
        return None
    try:
        value = float(mark)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _price(
    conn: sqlite3.Connection,
    symbol: str,
    timeframe: str,
    mark: float | None = None,
) -> tuple[float, int]:
    """取当前价：优先实时标记价，其次库内最新收盘价。

    两者**必须一起用于撮合与估值** —— 曾经撮合/估值为库内收盘价、面板顶部为实时价，
    用户看到的是「价格 79359，空单却浮亏」，因为浮盈是按落后的 80532 算的。
    """
    row = conn.execute(
        "SELECT close, ts FROM ohlcv WHERE symbol=? AND timeframe=? ORDER BY ts DESC LIMIT 1",
        (symbol, timeframe),
    ).fetchone()
    if row is None:
        raise RuntimeError("行情库还没有 K 线，先 btc_sync 再操作模拟盘")
    live = _mark(mark)
    if live is not None:
        return live, int(row["ts"])
    return float(row["close"]), int(row["ts"])


def _account(conn: sqlite3.Connection, capital: float) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM paper_account WHERE id=1").fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO paper_account (id, initial_capital, cash, updated_at)"
            " VALUES (1, ?, ?, ?)",
            (float(capital), float(capital), _now()),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM paper_account WHERE id=1").fetchone()
    return row


def _performance(conn: sqlite3.Connection) -> dict:
    rows = conn.execute("SELECT pnl, fee FROM paper_trades").fetchall()
    trades = len(rows)
    wins = sum(1 for row in rows if float(row["pnl"]) > 0)
    realized = sum(float(row["pnl"]) for row in rows)
    fees = sum(float(row["fee"]) for row in rows)
    return {
        "trades": trades,
        "wins": wins,
        "win_rate": round(wins / trades * 100, 2) if trades else 0.0,
        "realized_pnl": round(realized, 2),
        "fees_paid": round(fees, 2),
    }


def open_orders(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT id, side, qty, limit_price, notional, reason, created_at, expires_at"
        " FROM paper_orders WHERE status='open' ORDER BY id"
    ).fetchall()
    return [dict(row) for row in rows]


def renew_orders(
    conn: sqlite3.Connection,
    minutes: float,
    order_id: int | None = None,
) -> dict:
    """给未成交挂单续期（模型判断「继续等」时用）。

    只改 `expires_at`，订单本身不动：撤单重挂会丢队列位置，也可能在撤与挂之间错过成交。
    """
    minutes = min(24 * 60.0, max(1.0, float(minutes)))
    expires_at = (
        datetime.now(timezone.utc) + timedelta(minutes=minutes)
    ).isoformat().replace("+00:00", "Z")
    if order_id:
        rows = conn.execute(
            "SELECT id FROM paper_orders WHERE status='open' AND id=?",
            (int(order_id),),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT id FROM paper_orders WHERE status='open'"
        ).fetchall()
    ids = [int(row["id"]) for row in rows]
    if ids:
        placeholders = ",".join("?" * len(ids))
        conn.execute(
            "UPDATE paper_orders SET expires_at=?"
            f" WHERE status='open' AND id IN ({placeholders})",
            (expires_at, *ids),
        )
        conn.commit()
    return {"ids": ids, "expires_at": expires_at}


def expired_orders(conn: sqlite3.Connection) -> list[dict]:
    """已过时效但仍在挂着（只读，不撮合）：供后端叫醒巡检处理。

    刻意不在这里撮合：撮合会改账本，而「叫醒」这个动作必须便宜且无副作用 ——
    一次网络抖动不该顺手把单子成交掉。
    """
    rows = conn.execute(
        "SELECT id, side, qty, limit_price, expires_at FROM paper_orders"
        " WHERE status='open' AND expires_at IS NOT NULL AND expires_at <= ?"
        " ORDER BY id",
        (_now(),),
    ).fetchall()
    return [dict(row) for row in rows]


def try_fill(
    conn: sqlite3.Connection,
    symbol: str,
    timeframe: str,
    mark: float | None = None,
) -> list[dict]:
    """撮合未成交挂单：价格到达限价即成交。

    成交价取「限价与当前价中更优者」（多头 min、空头 max）：
    限价单不会成交得比限价更差，但**限价已在市场另一侧时属于立即吃单**，
    真实成交价是当时的市场价，而不是那个已经穿越的限价。
    旧版一律按限价记账，于是「80276 挂空、市场 80532」会记成 80276 成交，
    等于凭空得到一个市场没给过的入场价。
    """
    try:
        price, _ts = _price(conn, symbol, timeframe, mark)
    except Exception:
        return []

    orders = conn.execute(
        "SELECT * FROM paper_orders WHERE status='open' ORDER BY id"
    ).fetchall()
    filled: list[dict] = []
    for order in orders:
        side = order["side"]
        limit_price = float(order["limit_price"])
        # 做多：价格跌到限价或更低；做空：涨到限价或更高
        hit = price <= limit_price if side == "long" else price >= limit_price
        if not hit:
            continue

        account = _account(conn, 100000.0)
        # 已有持仓：同方向视为分批加仓（多档建仓的正常结果）；反向不自动反手
        if account["side"] and account["side"] != side:
            continue

        qty = float(order["qty"])
        fill_price = min(limit_price, price) if side == "long" else max(limit_price, price)
        cost = qty * fill_price
        lev = _lev(order["leverage"])
        # 占用的是保证金（名义/杠杆），与实盘「按杠杆算保证金」对齐
        margin = cost / lev
        fee = cost * FEE_RATE
        cash = float(account["cash"])
        partial = False
        if margin + fee > cash + 1e-9:
            # 按更优价成交的成本可能超过挂单时的名义金额（空单尤甚）。
            # 模拟盘不做部分成交，但「资金不足就永远挂着」更不像真实账户，
            # 这里按可用现金缩量成交，并在返回里标注。
            qty = (cash / (1 + FEE_RATE)) * lev / fill_price
            if qty <= 0:
                continue
            cost = qty * fill_price
            margin = cost / lev
            fee = cost * FEE_RATE
            partial = True

        now = _now()
        # 加仓：数量与成本累加，入场价取加权均价；止损沿用已挂的那张（不覆盖）
        existing_qty = float(account["qty"] or 0) if account["side"] else 0.0
        existing_notional = (
            float(account["entry_notional"] or 0) if account["side"] else 0.0
        )
        old_lev = _lev(account["leverage"])
        old_margin = existing_notional / old_lev if account["side"] else 0.0
        total_qty = existing_qty + qty
        total_notional = existing_notional + cost
        total_margin = old_margin + margin
        # 加仓可能换杠杆：按「总占用/总名义」反推等效杠杆
        entry_leverage = (
            total_notional / total_margin if total_margin > 0 else lev
        )
        entry_price = total_notional / total_qty if total_qty else fill_price
        entry_ts = account["entry_ts"] if account["side"] else now
        stop_price = account["stop_price"] if account["side"] else order["stop_price"]

        conn.execute(
            "UPDATE paper_account SET cash=?, side=?, qty=?, entry_price=?, entry_notional=?,"
            " entry_ts=?, stop_price=?, leverage=?, updated_at=? WHERE id=1",
            (
                cash - margin - fee,
                side,
                total_qty,
                entry_price,
                total_notional,
                entry_ts,
                stop_price,
                entry_leverage,
                now,
            ),
        )
        conn.execute(
            "UPDATE paper_orders SET status='filled', filled_at=?, fill_price=? WHERE id=?",
            (now, fill_price, order["id"]),
        )
        filled.append(
            {
                "order_id": order["id"],
                "side": side,
                "qty": round(qty, 8),
                "limit_price": round(limit_price, 2),
                "fill_price": round(fill_price, 2),
                "price": round(price, 2),
                "slipped": abs(fill_price - limit_price) > 1e-9,
                "partial": partial,
            }
        )
    if filled:
        conn.commit()
    return filled


def status(
    conn: sqlite3.Connection,
    symbol: str,
    timeframe: str,
    capital: float,
    mark: float | None = None,
) -> dict:
    # 每次读状态先撮合一次：面板与工具看到的就是「当前应有的状态」
    filled = try_fill(conn, symbol, timeframe, mark)
    account = _account(conn, capital)
    price, _ts = _price(conn, symbol, timeframe, mark)
    cash = float(account["cash"])
    position = None
    equity = cash

    if account["side"]:
        direction = 1 if account["side"] == "long" else -1
        qty = float(account["qty"])
        entry = float(account["entry_price"])
        notional = float(account["entry_notional"])
        leverage = _lev(account["leverage"])
        unrealized = (price - entry) * qty * direction
        # 占用的是保证金（名义/杠杆），不是全额名义 —— 与实盘口径对齐
        equity = cash + notional / leverage + unrealized
        stop = account["stop_price"]
        position = {
            "side": account["side"],
            "qty": round(qty, 8),
            "entry_price": round(entry, 2),
            "notional": round(notional, 2),
            "leverage": leverage,
            "entry_ts": account["entry_ts"],
            "stop_price": round(float(stop), 2) if stop is not None else None,
            "unrealized": round(unrealized, 2),
            "unrealized_pct": round(unrealized / notional * 100, 2) if notional else 0.0,
        }

    initial = float(account["initial_capital"])
    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "price": round(price, 2),
        "price_source": "mark" if _mark(mark) is not None else "close",
        "initial_capital": round(initial, 2),
        "cash": round(cash, 2),
        "equity": round(equity, 2),
        "return_pct": round((equity - initial) / initial * 100, 2) if initial else 0.0,
        "position": position,
        "open_orders": open_orders(conn),
        "just_filled": filled,
        "updated_at": account["updated_at"],
        **_performance(conn),
    }


def place_order(
    conn: sqlite3.Connection,
    *,
    symbol: str,
    timeframe: str,
    capital: float,
    side: str,
    notional: float,
    limit_price: float,
    stop_price: float | None = None,
    reason: str = "",
    ttl_minutes: float | None = None,
    leverage: float | None = None,
) -> dict:
    """挂一张限价单（不立即成交）。

    `ttl_minutes`：挂单时效。到点仍未成交时后端会叫醒巡检 —— 限价单最大的风险
    不是挂错价，而是「挂了一天还在等一个已经不成立的价格」。
    """
    if side not in ("long", "short"):
        raise ValueError("side 只能是 long 或 short")
    if notional <= 0 or limit_price <= 0:
        raise ValueError("notional 与 limit_price 必须大于 0")

    account = _account(conn, capital)
    if account["side"]:
        raise RuntimeError(
            f"已有持仓（{account['side']} {account['qty']} @ {account['entry_price']}），先平仓再开新仓"
        )

    # 允许同时挂多档（分批建仓），但设上限：再多说明该收敛成一档策略了
    pending = conn.execute(
        "SELECT COUNT(*) AS n FROM paper_orders WHERE status='open'"
    ).fetchone()
    if pending is not None and int(pending["n"]) >= 5:
        raise RuntimeError("未成交挂单已有 5 张（多档上限），先撤掉不用的再挂")

    lev = _lev(leverage)
    qty = notional / limit_price
    margin = notional / lev
    fee = notional * FEE_RATE
    cash = float(account["cash"])
    # 已挂多档也占用保证金：只按本单检查会让「5 档 × 40%」全部通过，
    # 结果成交时才发现现金不够（那时只能缩量，结果与计划不一致）。
    occupied = 0.0
    for row in conn.execute(
        "SELECT notional, leverage FROM paper_orders WHERE status='open'"
    ).fetchall():
        occupied += float(row["notional"] or 0) / _lev(row["leverage"])
    if occupied + margin + fee > cash + 1e-9:
        raise RuntimeError(
            f"可用保证金不足：按 {lev:g}x 本单需 {margin:.2f}（名义 {notional:.2f}）"
            f" + 手续费 {fee:.2f}，已挂单占用 {occupied:.2f}，当前可用 {cash:.2f}"
        )

    minutes = 60.0
    if ttl_minutes is not None:
        try:
            minutes = float(ttl_minutes)
        except (TypeError, ValueError):
            minutes = 60.0
    minutes = min(24 * 60.0, max(1.0, minutes))
    expires_at = (
        datetime.now(timezone.utc) + timedelta(minutes=minutes)
    ).isoformat().replace("+00:00", "Z")

    cursor = conn.execute(
        "INSERT INTO paper_orders (side, qty, limit_price, notional, stop_price, reason,"
        " created_at, expires_at, leverage) VALUES (?,?,?,?,?,?,?,?,?)",
        (side, qty, limit_price, notional, stop_price, reason, _now(), expires_at, lev),
    )
    conn.commit()
    return {
        "order_id": cursor.lastrowid,
        "side": side,
        "qty": round(qty, 8),
        "limit_price": round(limit_price, 2),
        "notional": round(notional, 2),
        "reason": reason,
        "status": "open",
        "expires_at": expires_at,
        "leverage": lev,
    }


def cancel_order(conn: sqlite3.Connection, order_id: int | None = None) -> dict:
    """撤掉挂单（不传 id 就撤全部未成交挂单）"""
    if order_id:
        cursor = conn.execute(
            "UPDATE paper_orders SET status='cancelled' WHERE id=? AND status='open'",
            (int(order_id),),
        )
    else:
        cursor = conn.execute(
            "UPDATE paper_orders SET status='cancelled' WHERE status='open'"
        )
    conn.commit()
    return {"cancelled": cursor.rowcount}


def close_position(
    conn: sqlite3.Connection,
    *,
    symbol: str,
    timeframe: str,
    reason: str,
    mark: float | None = None,
) -> dict:
    account = conn.execute("SELECT * FROM paper_account WHERE id=1").fetchone()
    if account is None or not account["side"]:
        raise RuntimeError("当前没有持仓，无需平仓")

    side = account["side"]
    qty = float(account["qty"])
    entry = float(account["entry_price"])
    notional = float(account["entry_notional"])
    price, _ts = _price(conn, symbol, timeframe, mark)
    direction = 1 if side == "long" else -1
    pnl = (price - entry) * qty * direction
    fee = notional * FEE_RATE
    cash = float(account["cash"]) + notional / _lev(account["leverage"]) + pnl - fee
    now = _now()

    conn.execute(
        "INSERT INTO paper_trades (side, qty, entry_price, exit_price, entry_ts, exit_ts,"
        " pnl, fee, entry_reason, exit_reason) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (side, qty, entry, price, account["entry_ts"], now, pnl, fee, None, reason),
    )
    conn.execute(
        "UPDATE paper_account SET cash=?, side=NULL, qty=NULL, entry_price=NULL,"
        " entry_notional=NULL, entry_ts=NULL, stop_price=NULL, updated_at=? WHERE id=1",
        (cash, now),
    )
    conn.commit()
    return {
        "closed": True,
        "side": side,
        "qty": round(qty, 8),
        "entry_price": round(entry, 2),
        "exit_price": round(price, 2),
        "pnl": round(pnl, 2),
        "fee": round(fee, 2),
        "reason": reason,
        "cash_after": round(cash, 2),
    }


def recent_trades(conn: sqlite3.Connection, limit: int = 5) -> list[dict]:
    rows = conn.execute(
        "SELECT side, qty, entry_price, exit_price, entry_ts, exit_ts, pnl, exit_reason"
        " FROM paper_trades ORDER BY id DESC LIMIT ?",
        (int(limit),),
    ).fetchall()
    return [dict(row) for row in rows]


def reset(conn: sqlite3.Connection, capital: float) -> dict:
    """清空账本并把初始资金恢复为 `capital`。

    **先读被清掉的内容再删**：调用方（`/reset moni`）要把「重置前是什么状态」
    写进记忆，否则下一轮对话里模型只看到「钱回到 10 万」，不知道之前发生过什么 ——
    连「是用户重置的还是数据丢了」都分不清。
    """
    account = conn.execute("SELECT * FROM paper_account WHERE id=1").fetchone()
    perf = _performance(conn)
    pending = conn.execute(
        "SELECT COUNT(*) AS n FROM paper_orders WHERE status='open'"
    ).fetchone()
    position = None
    if account is not None and account["side"]:
        position = {
            "side": account["side"],
            "qty": round(float(account["qty"]), 8),
            "entry_price": round(float(account["entry_price"]), 2),
        }

    cleared = {
        **perf,
        "open_orders": int(pending["n"]) if pending is not None else 0,
        "position": position,
        "cash_before": round(float(account["cash"]), 2) if account is not None else 0.0,
        "initial_capital_before": (
            round(float(account["initial_capital"]), 2)
            if account is not None
            else None
        ),
    }

    conn.execute("DELETE FROM paper_trades")
    conn.execute("DELETE FROM paper_orders")
    conn.execute("DELETE FROM paper_account")
    conn.commit()
    _account(conn, capital)
    return {"reset": True, "capital": capital, "cleared": cleared, "at": _now()}
