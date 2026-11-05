#!/usr/bin/env python3
"""btc 计算层 CLI —— 由 xzh 的 btc_* 工具以子进程调用。

约定：
- 参数走 stdin（JSON），结果走 stdout（JSON 单行），stderr 只放调试信息；
- **只依赖 numpy + pandas**：行情同步、下单、进程管理都在 Node 侧做，
  这样不需要 ccxt / fastapi / textual，venv 小、装得快；
- 输出前统一清洗（numpy 标量、Timestamp、NaN/Inf），保证 Node 侧 JSON.parse 不会炸。

命令：
    status      运行环境与本地数据的概况
    save        写入 K 线（stdin: {symbol, timeframe, rows: [[ts_ms,o,h,l,c,v], ...]}）
    signal      三阶段买卖点（周线定势 → 日线定向 → 小时线定时）
    backtest    全量回测（可传 overrides 覆盖策略参数）
"""
from __future__ import annotations

import json
import math
import os
import sys
import traceback

ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


def _read_payload() -> dict:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    return json.loads(raw)


def _clean(value):
    """把 numpy / pandas / 非有限浮点转成 JSON 安全的原生类型。"""
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return value
    if isinstance(value, dict):
        return {str(k): _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value]
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if hasattr(value, "item"):  # numpy 标量
        return _clean(value.item())
    return value


def _emit(ok: bool, data=None, error: str | None = None) -> None:
    sys.stdout.write(
        json.dumps(_clean({"ok": ok, "data": data, "error": error}), ensure_ascii=False)
    )
    sys.stdout.write("\n")


# ─────────────────────────── 命令 ───────────────────────────


def cmd_status(_payload: dict) -> dict:
    import pandas as pd

    from core.config import settings
    from core.database import BTCDatabase

    db = BTCDatabase(settings.db_path)
    timeframes = {}
    for tf in ("1d", "1h"):
        last = db.get_last_ts(settings.symbol, tf)
        timeframes[tf] = {
            "bars": db.get_ohlcv_count(settings.symbol, tf),
            "last_ts": last or None,
            "last_utc": (
                pd.to_datetime(last, unit="ms", utc=True).isoformat() if last else None
            ),
        }
    return {
        "symbol": settings.symbol,
        "db_path": settings.db_path,
        "python": sys.version.split()[0],
        "pandas": pd.__version__,
        "start_date": settings.start_date,
        "timeframes": timeframes,
        "risk": {
            "max_account_dd": settings.max_account_dd,
            "max_risk_per_trade": settings.max_risk_per_trade,
            "max_consec_loss": settings.max_consec_loss,
            "daily_loss_limit": settings.daily_loss_limit,
            "leverage": settings.leverage,
            "paper_trading": settings.paper_trading,
        },
    }


def cmd_save(payload: dict) -> dict:
    import pandas as pd

    from core.config import settings
    from core.database import BTCDatabase

    rows = payload.get("rows") or []
    if not rows:
        return {"written": 0}
    symbol = payload.get("symbol") or settings.symbol
    timeframe = payload.get("timeframe") or "1d"

    df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
    # 币安给的是 UTC 毫秒；先按 UTC 解释，再转北京时间（与 core 的读出口径一致）
    df["ts"] = pd.to_datetime(df["ts"], unit="ms", utc=True).dt.tz_convert(
        "Asia/Shanghai"
    )
    written = BTCDatabase(settings.db_path).save_ohlcv(df, symbol, timeframe)
    return {"written": written, "symbol": symbol, "timeframe": timeframe}


def cmd_signal(_payload: dict) -> dict:
    import market

    result = market.three_stage_signal()
    if isinstance(result, dict) and result.get("error"):
        raise RuntimeError(result["error"])
    return result


def cmd_probe(payload: dict) -> dict:
    """指标探测：给后台触发器的「条件是否成立」提供数据。

    只读本地库、只算几个字段，5 分钟一次的调用开销可以忽略；
    与 `signal` 分开是因为触发器不该顺带跑完整三阶段（那会算一堆用不上的指标）。
    """
    import market

    timeframes = payload.get("timeframes") or ["1h", "4h", "1d"]
    formulas = payload.get("formulas") or []
    price = payload.get("price")
    return market.probe_timeframes(
        [str(tf) for tf in timeframes],
        [item for item in formulas if isinstance(item, dict)],
        None if price is None else float(price),
    )


def cmd_backtest(payload: dict) -> dict:
    from core.bt_engine import Backtest, check_targets, indicators, load_data
    from core.config import settings
    from core.strategy_core import build_strategy, strategy_params

    overrides = payload.get("overrides") or {}
    start_date = payload.get("start_date") or settings.start_date
    initial_capital = float(payload.get("initial_capital") or 1_000_000.0)

    df = load_data(start_date=start_date)
    if df is None or len(df) < 200:
        raise RuntimeError(
            f"本地日线不足（{0 if df is None else len(df)} 根），先同步 1d 数据"
        )

    df = indicators(df)
    strategy = build_strategy(**overrides)
    core = strategy.get("_strategy_core")
    if core is not None and hasattr(core, "calculate"):
        df = core.calculate(df)

    metrics = Backtest(df).run(strategy, initial_capital=initial_capital)
    trades = metrics.pop("trades", []) or []
    metrics.pop("equity_curve", None)
    metrics.pop("dd_curve", None)
    metrics.pop("pending_trades", None)

    return {
        "symbol": settings.symbol,
        "bars": len(df),
        "first": df["ts"].iloc[0].isoformat(),
        "last": df["ts"].iloc[-1].isoformat(),
        "params": strategy_params(),
        "overrides": overrides,
        "metrics": metrics,
        "targets": check_targets(metrics),
        # 只回最近几笔明细：完整曲线进上下文会把窗口打满，要看全部请直接查库
        "recent_trades": trades[-5:],
        "trade_count": len(trades),
        "costs": {"fee_pct": 0.0005, "slippage_pct": 0.0, "funding_8h": 0.0001},
    }


def _paper_conn(payload: dict):
    """模拟盘与行情库共用同一个 sqlite 文件"""
    import paper

    from core.config import settings

    return paper, paper.connect(payload.get("db") or settings.db_path)


def _paper_args(payload: dict) -> dict:
    from core.config import settings

    return {
        "symbol": payload.get("symbol") or settings.symbol,
        "timeframe": payload.get("timeframe") or settings.timeframe,
        "capital": float(
            payload.get("capital")
            or os.getenv("BTC_PAPER_CAPITAL", "100000")
        ),
        # 实时标记价：撮合/估值/平仓共用它，避免面板顶部与浮盈用两个价格
        "mark": payload.get("mark_price"),
        # 挂单时效（分钟）：到点未成交由后端叫醒巡检处理
        "ttl_minutes": payload.get("expires_min"),
        # 杠杆：保证金 = 名义/杠杆，与实盘口径一致（缺省 1x）
        "leverage": payload.get("leverage"),
    }


def cmd_paper_status(payload: dict) -> dict:
    paper, conn = _paper_conn(payload)
    args = _paper_args(payload)
    data = paper.status(
        conn, args["symbol"], args["timeframe"], args["capital"], args["mark"]
    )
    data["recent_trades"] = paper.recent_trades(
        conn, int(payload.get("limit") or 5)
    )
    return data


def cmd_paper_open(payload: dict) -> dict:
    paper, conn = _paper_conn(payload)
    args = _paper_args(payload)
    if payload.get("limit_price") is None:
        raise ValueError("模拟盘开仓需要 limit_price（与实盘一致，统一用限价单）")
    result = paper.place_order(
        conn,
        symbol=args["symbol"],
        timeframe=args["timeframe"],
        capital=args["capital"],
        side=str(payload.get("side") or "").lower(),
        notional=float(payload.get("notional") or 0),
        limit_price=float(payload.get("limit_price")),
        stop_price=payload.get("stop_price"),
        reason=str(payload.get("reason") or ""),
        ttl_minutes=args["ttl_minutes"],
        leverage=args["leverage"],
    )
    status = paper.status(
        conn, args["symbol"], args["timeframe"], args["capital"], args["mark"]
    )
    status["recent_trades"] = paper.recent_trades(conn, 5)
    result["status"] = status
    return result


def cmd_paper_close(payload: dict) -> dict:
    paper, conn = _paper_conn(payload)
    args = _paper_args(payload)
    result = paper.close_position(
        conn,
        symbol=args["symbol"],
        timeframe=args["timeframe"],
        reason=str(payload.get("reason") or ""),
        mark=args["mark"],
    )
    status = paper.status(
        conn, args["symbol"], args["timeframe"], args["capital"], args["mark"]
    )
    status["recent_trades"] = paper.recent_trades(conn, 5)
    result["status"] = status
    return result


def cmd_paper_cancel(payload: dict) -> dict:
    """撤掉模拟盘挂单（不传 order_id 撤全部）"""
    paper, conn = _paper_conn(payload)
    args = _paper_args(payload)
    order_id = payload.get("order_id")
    result = paper.cancel_order(conn, int(order_id) if order_id else None)
    status = paper.status(
        conn, args["symbol"], args["timeframe"], args["capital"], args["mark"]
    )
    status["recent_trades"] = paper.recent_trades(conn, 5)
    result["status"] = status
    return result


def cmd_paper_reset(payload: dict) -> dict:
    paper, conn = _paper_conn(payload)
    args = _paper_args(payload)
    return paper.reset(conn, args["capital"])


def cmd_paper_expired(payload: dict) -> dict:
    """已过时效仍未成交的模拟挂单（只读，不撮合、不改账本）。"""
    paper, conn = _paper_conn(payload)
    return {"orders": paper.expired_orders(conn)}


def cmd_paper_renew(payload: dict) -> dict:
    """给未成交挂单续期（模型判断继续等时用）。"""
    paper, conn = _paper_conn(payload)
    return paper.renew_orders(
        conn,
        float(payload.get("expires_min") or 60),
        payload.get("order_id"),
    )


COMMANDS = {
    "status": cmd_status,
    "save": cmd_save,
    "signal": cmd_signal,
    "probe": cmd_probe,
    "backtest": cmd_backtest,
    "paper-status": cmd_paper_status,
    "paper-open": cmd_paper_open,
    "paper-cancel": cmd_paper_cancel,
    "paper-close": cmd_paper_close,
    "paper-reset": cmd_paper_reset,
    "paper-expired": cmd_paper_expired,
    "paper-renew": cmd_paper_renew,
}


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    handler = COMMANDS.get(command)
    if handler is None:
        _emit(False, error=f"未知命令：{command}（可用：{', '.join(COMMANDS)}）")
        return 2
    try:
        _emit(True, data=handler(_read_payload()))
        return 0
    except Exception as exc:  # noqa: BLE001 - 统一交给上游展示
        _emit(False, error=f"{type(exc).__name__}: {exc}", data={
            "traceback": traceback.format_exc(limit=6)
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
