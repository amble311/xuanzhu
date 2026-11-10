#!/usr/bin/env python3
"""A 股离线研究/回测（供 `xzh a research` 调用）。

输入 JSON（stdin）：
{
  "codes": [{"code": "...", "bars": [{"date","open","high","low","close","volume","amount"}]}],
  "index": [{"date","close"}],
  "grid": {"stop_atr": [1.5], "trail_trigger": [0.08], "max_positions": [5]}
}

输出 JSON（stdout）：{"ok": true, "results": [...], "best": {...}}
依赖 pandas / numpy；缺失时返回明确错误（不自动安装）。
"""
import json
import sys


def main():
    try:
        import pandas as pd
        import numpy as np
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({
            "ok": False,
            "error": f"缺少 pandas/numpy：{exc}；请先 pip install pandas numpy，或用系统 Python 环境运行",
        }, ensure_ascii=False))
        return

    raw = json.load(sys.stdin)
    index = pd.DataFrame(raw.get("index", []))
    if not index.empty:
        index["date"] = index["date"].astype(str).str.slice(0, 10)
        index = index.set_index("date")
    if index.empty:
        print(json.dumps({"ok": False, "error": "指数数据为空"}, ensure_ascii=False))
        return
    index["ma20"] = index["close"].rolling(20).mean()

    frames = {}
    for item in raw.get("codes", []):
        bars = item.get("bars", [])
        if len(bars) < 60:
            continue
        frame = pd.DataFrame(bars)
        frame["ma20"] = frame["close"].rolling(20).mean()
        frame["ma5"] = frame["close"].rolling(5).mean()
        frame["ret20"] = frame["close"].pct_change(20) * 100
        tr = np.maximum(
            frame["high"] - frame["low"],
            np.maximum(
                (frame["high"] - frame["close"].shift(1)).abs(),
                (frame["low"] - frame["close"].shift(1)).abs(),
            ),
        )
        frame["atr20"] = tr.rolling(20).mean()
        frame["amount20"] = frame["amount"].rolling(20).mean() if "amount" in frame else 0
        frame["date"] = frame["date"].astype(str).str.slice(0, 10)
        frames[item["code"]] = frame.set_index("date")

    grid = raw.get("grid", {})
    stop_mults = grid.get("stop_atr", [1.5])
    trails = grid.get("trail_trigger", [0.08])
    max_positions = int(grid.get("max_positions", [5])[0])
    results = []

    for stop_mult in stop_mults:
        for trail in trails:
            result = backtest(frames, index, float(stop_mult), float(trail), max_positions)
            result["params"] = {"stop_atr": stop_mult, "trail_trigger": trail, "max_positions": max_positions}
            results.append(result)

    best = max(results, key=lambda item: item["returnPct"]) if results else None
    print(json.dumps({"ok": True, "results": results, "best": best}, ensure_ascii=False))


def backtest(frames, index, stop_mult, trail, max_positions):
    dates = [str(value)[:10] for value in index.index]
    if len(dates) < 30:
        return {"returnPct": 0, "maxDrawdownPct": 0, "winRatePct": 0, "trades": 0, "avgHoldDays": 0}
    cash = 1_000_000.0
    positions = {}
    pending_buys = []
    pending_sells = []
    equity_curve = []
    wins = 0
    closed = 0
    hold_days = []
    buy_day = {}

    def price(code, date, column="close"):
        try:
            row = frames[code].loc[date]
            return float(row[column])
        except Exception:
            return None

    for day_index, date in enumerate(dates):
        # 开盘执行上一轮挂单
        for code, qty in pending_sells:
            position = positions.get(code)
            open_price = price(code, date, "open")
            if not position or open_price is None or day_index <= position["buy_index"]:
                continue
            amount = open_price * qty
            fee = amount * 0.00025 + amount * 0.0005
            cash += amount - fee
            pnl = (open_price - position["cost"]) * qty - fee
            closed += 1
            if pnl > 0:
                wins += 1
            hold_days.append(day_index - position["buy_index"])
            position["qty"] -= qty
            if position["qty"] <= 0:
                positions.pop(code, None)
        pending_sells = []

        for code in pending_buys:
            if len(positions) >= max_positions or code in positions:
                continue
            open_price = price(code, date, "open")
            if open_price is None or open_price <= 0:
                continue
            equity = cash + sum(
                (price(symbol, date) or position["cost"]) * position["qty"]
                for symbol, position in positions.items()
            )
            qty = int((equity * 0.2) // open_price // 100 * 100)
            amount = qty * open_price
            fee = amount * 0.00025
            if qty < 100 or cash < amount + fee:
                continue
            cash -= amount + fee
            positions[code] = {
                "qty": qty,
                "cost": open_price,
                "peak": open_price,
                "buy_index": day_index,
            }
        pending_buys = []

        # 收盘评估卖点
        for code, position in list(positions.items()):
            close = price(code, date)
            if close is None:
                continue
            position["peak"] = max(position["peak"], close)
            if day_index <= position["buy_index"]:
                continue
            try:
                atr = float(frames[code].loc[date, "atr20"])
            except Exception:
                atr = close * 0.035
            stop_pct = max(0.05, stop_mult * atr / close) if close > 0 else 0.05
            stop = position["cost"] * (1 - stop_pct)
            if position["peak"] >= position["cost"] * (1 + trail):
                stop = max(stop, position["peak"] * (1 - stop_pct))
            if close <= stop:
                pending_sells.append((code, position["qty"]))

        # 收盘选股
        try:
            index_row = index.loc[date]
            gate = float(index_row["close"]) > float(index_row["ma20"])
        except Exception:
            gate = False
        if gate and len(positions) + len(pending_buys) < max_positions:
            candidates = []
            for code, frame in frames.items():
                if code in positions or code in pending_buys:
                    continue
                try:
                    row = frame.loc[date]
                except Exception:
                    continue
                close = float(row["close"])
                ma20 = float(row["ma20"])
                ret20 = float(row["ret20"])
                amount = float(row["amount20"]) if "amount20" in row else 0
                if close <= ma20 or ret20 <= 0 or (close - ma20) / ma20 > 0.08:
                    continue
                if amount and amount < 50_000_000:
                    continue
                candidates.append((ret20, code))
            candidates.sort(reverse=True)
            for _, code in candidates[: max_positions - len(positions)]:
                pending_buys.append(code)

        equity = cash + sum(
            (price(code, date) or position["cost"]) * position["qty"]
            for code, position in positions.items()
        )
        equity_curve.append(equity)

    peak = 0.0
    worst = 0.0
    for value in equity_curve:
        peak = max(peak, value)
        if peak > 0:
            worst = min(worst, (value - peak) / peak)
    final = equity_curve[-1] if equity_curve else 1_000_000.0
    return {
        "returnPct": round((final - 1_000_000.0) / 1_000_000.0 * 100, 2),
        "maxDrawdownPct": round(worst * 100, 2),
        "winRatePct": round(wins / closed * 100, 1) if closed else 0,
        "trades": closed,
        "avgHoldDays": round(sum(hold_days) / len(hold_days), 1) if hold_days else 0,
    }


if __name__ == "__main__":
    main()
