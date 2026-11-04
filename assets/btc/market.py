#!/usr/bin/env python3
"""三阶段买卖点判断：周线定势 → 日线定向 → 小时线定时。

设计原则：
- 只做多周期一致性判断，冲突时明确 stand_aside，不硬凑信号。
- 所有指标来自 `core.bt_engine.indicators`（与回测/实盘同一套口径，因果无未来函数）。
- 周线由本地日线重采样；小时线只读本地 1h（行情同步由调用方负责），缺失则降级并标注。

对外接口：
- `analyze_timeframe(timeframe, limit)`：单周期指标摘要（1w / 1d / 4h / 1h）
- `three_stage_signal(symbol)`：完整三阶段结论 + 建议动作/入场/止损/目标
"""
from __future__ import annotations

from typing import Any

import pandas as pd

from core.config import settings


# ── 数据 ────────────────────────────────────────────────

def _num(x: Any, default: float = 0.0) -> float:
    try:
        v = float(x)
        return default if v != v else v          # NaN 判定
    except (TypeError, ValueError):
        return default


def _daily() -> pd.DataFrame:
    from core.bt_engine import load_data
    df = load_data(use_db=True, symbol=settings.symbol,
                   timeframe=settings.timeframe, start_date=settings.start_date)
    if df is None or len(df) < 60:
        raise RuntimeError("本地日线不足（<60 根），先 refresh_data / sync_data")
    return df


def _weekly(daily: pd.DataFrame) -> pd.DataFrame:
    d = daily[["ts", "o", "h", "l", "c", "v"]].copy().set_index("ts")
    # label="left"：用该周的开始日做标签，避免出现「未来日期」（周五收盘标签）
    w = d.resample("W-FRI", label="left", closed="right").agg(
        {"o": "first", "h": "max", "l": "min", "c": "last", "v": "sum"}).dropna()
    return w.reset_index()


def _hourly(limit: int = 400) -> tuple[pd.DataFrame | None, str]:
    """返回 (DataFrame, 来源)。来源：local / unavailable:<原因>。

    刻意**不联网**：行情同步由调用方（xzh 侧）负责并落库，这里只读本地 1h。
    缺失时返回 degraded，让结论里明确写「小时线未确认」——
    否则三阶段会在一次工具调用里卡住等网络，而且模型分不清「没数据」和「网络差」。
    """
    from core.bt_engine import load_data
    try:
        df = load_data(use_db=True, symbol=settings.symbol, timeframe="1h")
        if df is not None and len(df) >= 120:
            return df.tail(limit).reset_index(drop=True), "local"
        bars = 0 if df is None else len(df)
        return None, f"unavailable: 本地 1h 只有 {bars} 根（<120），先同步 1h 数据"
    except Exception as e:
        return None, f"unavailable: {type(e).__name__}: {e}"


def _ind(df: pd.DataFrame) -> pd.DataFrame:
    from core.bt_engine import indicators
    return indicators(df)


# ── 摘要 ────────────────────────────────────────────────

def _snapshot(d: pd.DataFrame, bars: int = 20) -> dict:
    last = d.iloc[-1]
    prev = d.iloc[-2] if len(d) >= 2 else last
    c = _num(last["c"])
    ma = {w: _num(last.get(f"ma{w}")) for w in (5, 10, 20, 50, 100, 200)}
    hi = _num(d["h"].tail(bars).max())
    lo = _num(d["l"].tail(bars).min())
    pos = (c - lo) / (hi - lo) if hi > lo else 0.5
    return {
        "bars": int(len(d)),
        "as_of": str(last["ts"])[:19],
        "close": round(c, 2),
        "ma": {str(k): round(v, 2) for k, v in ma.items() if v > 0},
        "ma_align": ("bull" if ma[5] and ma[20] and ma[50] and ma[5] > ma[20] > ma[50]
                     else "bear" if ma[5] and ma[20] and ma[50] and ma[5] < ma[20] < ma[50]
                     else "mixed"),
        "adx": round(_num(last.get("adx")), 1),
        "plus_di": round(_num(last.get("plus_di")), 1),
        "minus_di": round(_num(last.get("minus_di")), 1),
        "rsi": round(_num(last.get("rsi")), 1),
        "rsi_prev": round(_num(prev.get("rsi")), 1),
        "macd_hist": round(_num(last.get("macd_hist")), 3),
        "macd_hist_prev": round(_num(prev.get("macd_hist")), 3),
        "atr": round(_num(last.get("atr")), 2),
        "atr_pct": round(_num(last.get("atr_pct")) * 100, 2),
        "vol_ratio": round(_num(last.get("vol_ratio")), 2),
        f"hi{bars}": round(hi, 2),
        f"lo{bars}": round(lo, 2),
        "range_pos": round(pos, 2),
        "chg_20": round((c / _num(d["c"].iloc[-bars - 1]) - 1) * 100, 2) if len(d) > bars else 0.0,
    }


def analyze_timeframe(timeframe: str = "1d", limit: int = 200) -> dict:
    """单周期指标摘要。timeframe 支持 1w / 1d / 4h / 1h。"""
    tf = (timeframe or "1d").lower()
    try:
        if tf in ("1w", "1week", "w"):
            daily = _daily()
            df = _weekly(daily)
            src = "local(1d→1w)"
        elif tf in ("1h", "60m", "h1"):
            df, src = _hourly(limit=max(120, int(limit)))
            if df is None:
                return {"error": f"小时线不可用（{src}）", "timeframe": tf}
        elif tf in ("4h", "240m"):
            df, src = _hourly(limit=max(240, int(limit) * 2))
            if df is None:
                return {"error": f"小周期不可用（{src}）", "timeframe": tf}
            df = df.set_index("ts").resample("4h").agg(
                {"o": "first", "h": "max", "l": "min", "c": "last", "v": "sum"}
            ).dropna().reset_index()
            src = src + "→4h"
        else:
            df = _daily()
            src = "local(1d)"
        d = _ind(df)
        snap = _snapshot(d, bars=int(limit) if tf in ("1h", "4h") else 20)
        snap["timeframe"] = tf
        snap["source"] = src
        return snap
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}", "timeframe": tf}


# ── 三阶段 ──────────────────────────────────────────────

def _stage1_weekly(d: pd.DataFrame) -> dict:
    last = d.iloc[-1]
    c = _num(last["c"])
    ma20 = _num(last.get("ma20"))
    ma50 = _num(last.get("ma50"))
    ma20_prev = _num(d["ma20"].iloc[-5]) if len(d) >= 5 else ma20
    slope = (ma20 - ma20_prev) / ma20_prev if ma20_prev else 0.0
    adx = _num(last.get("adx"))
    plus_di, minus_di = _num(last.get("plus_di")), _num(last.get("minus_di"))
    hi20, lo20 = _num(d["h"].tail(20).max()), _num(d["l"].tail(20).min())

    if c > ma20 > ma50 and slope > 0.001 and adx >= 18:
        trend = "bull"
    elif c < ma20 < ma50 and slope < -0.001 and adx >= 18:
        trend = "bear"
    else:
        trend = "range"

    if trend == "range":
        conf = max(0.30, 0.75 - abs(adx - 15) / 50)
        if c > ma20 > ma50:
            align = "价格在均线上方，但 MA20W < MA50W（中期未转多）"
        elif c < ma20 < ma50:
            align = "价格在均线下方，但 MA20W > MA50W（中期未转空）"
        else:
            align = f"均线未排列（MA20W {ma20:,.0f} / MA50W {ma50:,.0f}）"
        reasons = [align,
                   f"ADX {adx:.1f}" + ("（<18 趋势强度不足）" if adx < 18 else "（有强度但均线不支持）"),
                   f"价格与 MA20W 偏离 {((c / ma20 - 1) * 100 if ma20 else 0):+.1f}%"]
    else:
        conf = min(0.95, 0.45
                   + min(abs(c / ma20 - 1) / 0.12, 1) * 0.2
                   + min(abs(slope) / 0.02, 1) * 0.15
                   + min(max(adx - 18, 0) / 30, 1) * 0.2)
        reasons = [f"收盘{'高于' if c > ma20 else '低于'} MA20W",
                   f"MA20W 斜率 {slope * 100:+.2f}%/周",
                   f"ADX {adx:.1f}，+DI {plus_di:.1f} / -DI {minus_di:.1f}"]

    return {
        "trend": trend,
        "confidence": round(conf, 2),
        "evidence": reasons,
        "ma20": round(ma20, 2), "ma50": round(ma50, 2),
        "slope_pct": round(slope * 100, 2),
        "adx": round(adx, 1),
        "range": {"hi20": round(hi20, 2), "lo20": round(lo20, 2)},
    }


def _stage2_daily(d: pd.DataFrame, trend: str) -> dict:
    last = d.iloc[-1]
    prev = d.iloc[-2]
    c = _num(last["c"])
    ma20, ma50 = _num(last.get("ma20")), _num(last.get("ma50"))
    rsi, rsi_prev = _num(last.get("rsi")), _num(prev.get("rsi"))
    hist, hist_prev = _num(last.get("macd_hist")), _num(prev.get("macd_hist"))
    adx = _num(last.get("adx"))
    hi20, lo20 = _num(d["h"].tail(20).max()), _num(d["l"].tail(20).min())
    pos = (c - lo20) / (hi20 - lo20) if hi20 > lo20 else 0.5

    reasons: list[str] = []
    bias = "wait"
    conf = 0.35

    if trend == "bull":
        checks = {
            "站上 MA50D": c > ma50,
            "RSI 在 38–68（回调后不超买）": 38 <= rsi <= 68,
            "MACD 柱转强": hist > 0 or hist > hist_prev,
            "贴近 MA20D 或区间中下部": (ma20 > 0 and abs(c / ma20 - 1) <= 0.04) or pos <= 0.62,
        }
        ok = sum(checks.values())
        bias = "long" if ok >= 3 else "wait"
        conf = min(0.9, 0.35 + 0.13 * ok)
        reasons = [f"{'✓' if v else '✗'} {k}" for k, v in checks.items()]
        reasons.append(f"RSI {rsi:.1f}（前值 {rsi_prev:.1f}），区间位置 {pos:.0%}")
    elif trend == "bear":
        checks = {
            "跌破 MA50D": c < ma50,
            "RSI 在 32–62（反弹后不超卖）": 32 <= rsi <= 62,
            "MACD 柱转弱": hist < 0 or hist < hist_prev,
            "贴近 MA20D 或区间中上部": (ma20 > 0 and abs(c / ma20 - 1) <= 0.04) or pos >= 0.38,
        }
        ok = sum(checks.values())
        bias = "short" if ok >= 3 else "wait"
        conf = min(0.9, 0.35 + 0.13 * ok)
        reasons = [f"{'✓' if v else '✗'} {k}" for k, v in checks.items()]
        reasons.append(f"RSI {rsi:.1f}（前值 {rsi_prev:.1f}），区间位置 {pos:.0%}")
    else:
        if pos <= 0.22 and rsi < 38:
            bias, conf = "long", 0.55
            reasons = [f"区间下沿（位置 {pos:.0%}）", f"RSI {rsi:.1f} 超卖"]
        elif pos >= 0.78 and rsi > 62:
            bias, conf = "short", 0.55
            reasons = [f"区间上沿（位置 {pos:.0%}）", f"RSI {rsi:.1f} 超买"]
        else:
            reasons = [f"区间中部（位置 {pos:.0%}），无边缘反转优势",
                       f"ADX {adx:.1f} 无趋势"]

    return {
        "bias": bias,
        "confidence": round(conf, 2),
        "evidence": reasons,
        "rsi": round(rsi, 1),
        "macd_hist": round(hist, 3),
        "range_pos": round(pos, 2),
        "range": {"hi20": round(hi20, 2), "lo20": round(lo20, 2)},
    }


def _stage3_hourly(d: pd.DataFrame | None, source: str, bias: str) -> dict:
    if bias == "wait":
        return {"entry": "wait", "source": source,
                "reason": "日线无方向，小时线不单独入场"}
    if d is None:
        return {"entry": "wait", "source": source, "degraded": True,
                "reason": f"小时线不可用（{source}）：只做日线级判断，等下根日线收盘或补 1h 数据后再定时"}

    last = d.iloc[-1]
    prev = d.iloc[-2] if len(d) >= 2 else last
    c = _num(last["c"])
    ma20, ma50 = _num(last.get("ma20")), _num(last.get("ma50"))
    rsi = _num(last.get("rsi"))
    hist = _num(last.get("macd_hist"))
    atr = _num(last.get("atr"))
    lows = d["l"].tail(24)
    highs = d["h"].tail(24)

    if bias == "long":
        checks = {
            "站上 MA20H": c > ma20 > 0,
            "MA20H > MA50H": ma20 > ma50 > 0,
            "RSI 45–72（不追超买）": 45 <= rsi <= 72,
            "MACD 柱 > 0": hist > 0,
        }
        ok = sum(checks.values())
        trigger = ok >= 3 and c > ma20
        stop = _num(lows.min()) - 0.5 * atr
        risk = max(c - stop, atr * 0.5)
        return {
            "entry": "now" if trigger else "wait",
            "source": source,
            "checks": [f"{'✓' if v else '✗'} {k}" for k, v in checks.items()],
            "passed": f"{ok}/4",
            "atr": round(atr, 2),
            "entry_zone": sorted([round(ma20 if ma20 > 0 else c - 0.6 * atr, 2),
                                  round(c + 0.2 * atr, 2)]),
            "stop": round(stop, 2),
            "targets": [round(c + 2 * risk, 2), round(c + 3 * risk, 2)],
            "rr": "1:2 / 1:3",
        }

    checks = {
        "跌破 MA20H": c < ma20 > 0,
        "MA20H < MA50H": ma20 < ma50 > 0,
        "RSI 28–55（不追超卖）": 28 <= rsi <= 55,
        "MACD 柱 < 0": hist < 0,
    }
    ok = sum(checks.values())
    trigger = ok >= 3 and c < ma20
    stop = _num(highs.max()) + 0.5 * atr
    risk = max(stop - c, atr * 0.5)
    return {
        "entry": "now" if trigger else "wait",
        "source": source,
        "checks": [f"{'✓' if v else '✗'} {k}" for k, v in checks.items()],
        "passed": f"{ok}/4",
        "atr": round(atr, 2),
        "entry_zone": sorted([round(c - 0.2 * atr, 2),
                              round(ma20 if ma20 > 0 else c + 0.6 * atr, 2)]),
        "stop": round(stop, 2),
        "targets": [round(c - 2 * risk, 2), round(c - 3 * risk, 2)],
        "rr": "1:2 / 1:3",
    }


def _decide(trend: str, bias: str, entry: str) -> tuple[str, str, str]:
    """返回 (action, 中文说明, 仓位建议)。"""
    if trend == "bull" and bias == "long":
        if entry == "now":
            return "long", "周线多头 + 日线做多 + 小时线触发：顺势做多", "标准仓位（1.0x）"
        return "wait", "周线多头、日线做多，但小时线未触发：等回踩 MA20H/前低再进", "0（等待）"
    if trend == "bear" and bias == "short":
        if entry == "now":
            return "short", "周线空头 + 日线做空 + 小时线触发：顺势做空", "标准仓位（1.0x）"
        return "wait", "周线空头、日线做空，但小时线未触发：等反弹到 MA20H 再进", "0（等待）"
    if trend == "range" and bias in ("long", "short") and entry == "now":
        return bias, "震荡市边缘反转 + 小时线确认：轻仓逆势", "半仓（0.5x），到区间中部止盈"
    if trend == "range":
        return "stand_aside", "周线震荡且未到区间边缘：不做", "0"
    if bias == "wait":
        return "stand_aside", "周线有方向但日线无顺势信号：不做逆势", "0"
    return "stand_aside", "周线与日线方向冲突：观望", "0"


def three_stage_signal(symbol: str | None = None) -> dict:
    """三阶段买卖点判断：周线定势 → 日线定向 → 小时线定时。"""
    try:
        daily = _daily()
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}

    daily_ind = _ind(daily)
    snap_daily = _snapshot(daily_ind, bars=20)
    weekly_ind = _ind(_weekly(daily))
    snap_weekly = _snapshot(weekly_ind, bars=20)

    s1 = _stage1_weekly(weekly_ind)
    s2 = _stage2_daily(daily_ind, s1["trend"])

    hourly_df, hourly_src = _hourly(400)
    s3 = _stage3_hourly(_ind(hourly_df) if hourly_df is not None else None, hourly_src, s2["bias"])

    action, reason, position = _decide(s1["trend"], s2["bias"], s3.get("entry", "wait"))
    confidence = round(min(s1["confidence"], s2["confidence"],
                           s3.get("confidence", s2["confidence"])) *
                       (0.85 if s3.get("degraded") else 1.0), 2)

    return {
        "symbol": symbol or settings.symbol,
        "as_of": snap_daily.get("as_of"),
        "stage1_weekly": s1,
        "stage2_daily": s2,
        "stage3_hourly": s3,
        "action": action,
        "reason": reason,
        "position_hint": position,
        "confidence": confidence,
        "snapshots": {"weekly": snap_weekly, "daily": snap_daily},
        "discipline": [
            "同一自然日最多主动建仓一次；止损后当日不再入场",
            "单笔风险按止损距离计算，建议 ≤ 账户权益 2%",
            "周线与日线冲突时一律观望，不做逆势",
        ],
    }
