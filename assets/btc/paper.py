#!/usr/bin/env python3
"""模拟盘账本：与行情库**同一个 sqlite 文件**，不碰真钱。

口径（与实盘对齐，每次报数都要一致）：
- **开仓统一限价单**：挂出后不立即成交，没成交就一直挂着，直到下一次买卖点或主动撤单；
- **成交判定用收盘价**：最新收盘价到达限价即视为**全部成交**（模拟盘不做部分成交）；
- 成交价 = 限价（限价单不会成交得更差）；平仓按最新收盘价结算；
- 手续费 0.05%（单边，开平各收一次），资金费不计；
- 同时只允许一个持仓、一张未成交挂单。
"""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timezone

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
    fill_price  REAL
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
    return conn


def _price(conn: sqlite3.Connection, symbol: str, timeframe: str) -> tuple[float, int]:
    row = conn.execute(
        "SELECT close, ts FROM ohlcv WHERE symbol=? AND timeframe=? ORDER BY ts DESC LIMIT 1",
        (symbol, timeframe),
    ).fetchone()
    if row is None:
        raise RuntimeError("行情库还没有 K 线，先 btc_sync 再操作模拟盘")
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
        "SELECT id, side, qty, limit_price, notional, reason, created_at"
        " FROM paper_orders WHERE status='open' ORDER BY id"
    ).fetchall()
    return [dict(row) for row in rows]


def try_fill(conn: sqlite3.Connection, symbol: str, timeframe: str) -> list[dict]:
    """按**收盘价**撮合未成交挂单：价格到达限价即全部成交。"""
    try:
        price, _ts = _price(conn, symbol, timeframe)
    except Exception:
        return []

    orders = conn.execute(
        "SELECT * FROM paper_orders WHERE status='open' ORDER BY id"
    ).fetchall()
    filled: list[dict] = []
    for order in orders:
        side = order["side"]
        limit_price = float(order["limit_price"])
        # 做多：收盘价跌到限价或更低；做空：涨到限价或更高
        hit = price <= limit_price if side == "long" else price >= limit_price
        if not hit:
            continue

        account = _account(conn, 100000.0)
        if account["side"]:
            continue  # 已有持仓（不该发生），跳过等人工处理

        qty = float(order["qty"])
        notional = float(order["notional"])
        fee = notional * FEE_RATE
        cash = float(account["cash"])
        if notional + fee > cash + 1e-9:
            continue

        now = _now()
        conn.execute(
            "UPDATE paper_account SET cash=?, side=?, qty=?, entry_price=?, entry_notional=?,"
            " entry_ts=?, stop_price=?, updated_at=? WHERE id=1",
            (
                cash - notional - fee,
                side,
                qty,
                limit_price,
                notional,
                now,
                order["stop_price"],
                now,
            ),
        )
        conn.execute(
            "UPDATE paper_orders SET status='filled', filled_at=?, fill_price=? WHERE id=?",
            (now, limit_price, order["id"]),
        )
        filled.append(
            {
                "order_id": order["id"],
                "side": side,
                "qty": round(qty, 8),
                "fill_price": round(limit_price, 2),
            }
        )
    if filled:
        conn.commit()
    return filled


def status(conn: sqlite3.Connection, symbol: str, timeframe: str, capital: float) -> dict:
    # 每次读状态先撮合一次：面板与工具看到的就是「当前应有的状态」
    filled = try_fill(conn, symbol, timeframe)
    account = _account(conn, capital)
    price, _ts = _price(conn, symbol, timeframe)
    cash = float(account["cash"])
    position = None
    equity = cash

    if account["side"]:
        direction = 1 if account["side"] == "long" else -1
        qty = float(account["qty"])
        entry = float(account["entry_price"])
        notional = float(account["entry_notional"])
        unrealized = (price - entry) * qty * direction
        equity = cash + notional + unrealized
        stop = account["stop_price"]
        position = {
            "side": account["side"],
            "qty": round(qty, 8),
            "entry_price": round(entry, 2),
            "notional": round(notional, 2),
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
) -> dict:
    """挂一张限价单（不立即成交）。"""
    if side not in ("long", "short"):
        raise ValueError("side 只能是 long 或 short")
    if notional <= 0 or limit_price <= 0:
        raise ValueError("notional 与 limit_price 必须大于 0")

    account = _account(conn, capital)
    if account["side"]:
        raise RuntimeError(
            f"已有持仓（{account['side']} {account['qty']} @ {account['entry_price']}），先平仓再开新仓"
        )

    pending = conn.execute(
        "SELECT id, side, limit_price FROM paper_orders WHERE status='open' LIMIT 1"
    ).fetchone()
    if pending is not None:
        raise RuntimeError(
            f"已有未成交挂单（#{pending['id']} {pending['side']} @ {pending['limit_price']}），先撤单"
        )

    qty = notional / limit_price
    fee = notional * FEE_RATE
    cash = float(account["cash"])
    if notional + fee > cash + 1e-9:
        raise RuntimeError(
            f"可用现金不足：需要 {notional + fee:.2f}（含手续费），当前 {cash:.2f}"
        )

    cursor = conn.execute(
        "INSERT INTO paper_orders (side, qty, limit_price, notional, stop_price, reason, created_at)"
        " VALUES (?,?,?,?,?,?,?)",
        (side, qty, limit_price, notional, stop_price, reason, _now()),
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
) -> dict:
    account = conn.execute("SELECT * FROM paper_account WHERE id=1").fetchone()
    if account is None or not account["side"]:
        raise RuntimeError("当前没有持仓，无需平仓")

    side = account["side"]
    qty = float(account["qty"])
    entry = float(account["entry_price"])
    notional = float(account["entry_notional"])
    price, _ts = _price(conn, symbol, timeframe)
    direction = 1 if side == "long" else -1
    pnl = (price - entry) * qty * direction
    fee = notional * FEE_RATE
    cash = float(account["cash"]) + notional + pnl - fee
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
    conn.execute("DELETE FROM paper_trades")
    conn.execute("DELETE FROM paper_orders")
    conn.execute("DELETE FROM paper_account")
    conn.commit()
    _account(conn, capital)
    return {"reset": True, "capital": capital}
