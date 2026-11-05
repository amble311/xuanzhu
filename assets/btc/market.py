#!/usr/bin/env python3
"""三阶段买卖点判断：周线定势 → 日线定向 → 4 小时线定时。

设计原则：
- 只做多周期一致性判断，冲突时明确 stand_aside，不硬凑信号。
- 所有指标来自 `core.bt_engine.indicators`（与回测/实盘同一套口径，因果无未来函数）。
- 周线由日线重采样；4 小时线由 1h 重采样（行情同步只维护 1d + 1h），缺失则降级并标注。

对外接口：
- `analyze_timeframe(timeframe, limit)`：单周期指标摘要（1w / 1d / 4h / 1h）
- `three_stage_signal(symbol)`：完整三阶段结论 + 建议动作/入场/止损/目标
"""
from __future__ import annotations

import ast
import math
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
    缺失时返回 degraded，让结论里明确写「4 小时线未确认」——
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


def _h4(limit: int = 360) -> tuple[pd.DataFrame | None, str]:
    """4 小时线：由本地 1h **重采样**得到。

    为什么不单独同步 4h：多一个周期就多一份要维护、要对齐、要补的数据，
    而 4h 完全由 1h 聚合而来（`o=first / h=max / l=min / c=last / v=sum`）。
    同步链路因此不用改（仍是 1d + 1h）。
    """
    need = max(240, int(limit) * 4)
    raw, src = _hourly(limit=need)
    if raw is None:
        return None, src.replace("1h", "4h")
    h4 = (
        raw.set_index("ts")
        .resample("4h")
        .agg({"o": "first", "h": "max", "l": "min", "c": "last", "v": "sum"})
        .dropna()
        .reset_index()
    )
    if len(h4) < 120:
        return None, f"unavailable: 重采样后只有 {len(h4)} 根 4h（<120），先同步更多 1h 数据"
    return h4.tail(limit).reset_index(drop=True), f"{src}→4h"


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
        "score": {"bull": 1, "bear": -1, "range": 0}[trend],
        "confidence": round(conf, 2),
        "evidence": reasons,
        "ma20": round(ma20, 2), "ma50": round(ma50, 2),
        "slope_pct": round(slope * 100, 2),
        "adx": round(adx, 1),
        "range": {"hi20": round(hi20, 2), "lo20": round(lo20, 2)},
    }


def _stage2_daily(d: pd.DataFrame) -> dict:
    """日线定向（独立打分，不依赖周线）。

    三周期各自给 -1/0/+1 是刻意的：周线多头 + 日线回调时这里是 0，
    由综合规则决定「允许做多但仓位减半」，而不是让日线否决整个方向。
    """
    last = d.iloc[-1]
    prev = d.iloc[-2]
    c = _num(last["c"])
    ma20, ma50 = _num(last.get("ma20")), _num(last.get("ma50"))
    rsi, rsi_prev = _num(last.get("rsi")), _num(prev.get("rsi"))
    hist, hist_prev = _num(last.get("macd_hist")), _num(prev.get("macd_hist"))
    adx = _num(last.get("adx"))
    hi20, lo20 = _num(d["h"].tail(20).max()), _num(d["l"].tail(20).min())
    pos = (c - lo20) / (hi20 - lo20) if hi20 > lo20 else 0.5

    long_checks = {
        "站上 MA50D": c > ma50,
        "RSI 在 38–68（回调后不超买）": 38 <= rsi <= 68,
        "MACD 柱转强": hist > 0 or hist > hist_prev,
        "贴近 MA20D 或区间中下部": (ma20 > 0 and abs(c / ma20 - 1) <= 0.04) or pos <= 0.62,
    }
    short_checks = {
        "跌破 MA50D": c < ma50,
        "RSI 在 32–62（反弹后不超卖）": 32 <= rsi <= 62,
        "MACD 柱转弱": hist < 0 or hist < hist_prev,
        "贴近 MA20D 或区间中上部": (ma20 > 0 and abs(c / ma20 - 1) <= 0.04) or pos >= 0.38,
    }
    long_ok = sum(long_checks.values())
    short_ok = sum(short_checks.values())

    bias, conf = "wait", 0.35
    checks: dict = {}
    if long_ok >= 3 and long_ok > short_ok:
        bias, conf, checks = "long", min(0.9, 0.35 + 0.13 * long_ok), long_checks
    elif short_ok >= 3 and short_ok > long_ok:
        bias, conf, checks = "short", min(0.9, 0.35 + 0.13 * short_ok), short_checks
    elif pos <= 0.22 and rsi < 38:
        # 区间下沿反转：不强求站上 MA50D，但也不与明确空头同时成立
        bias, conf = "long", 0.55
    elif pos >= 0.78 and rsi > 62:
        bias, conf = "short", 0.55

    if checks:
        reasons = [f"{'✓' if v else '✗'} {k}" for k, v in checks.items()]
        reasons.append(f"RSI {rsi:.1f}（前值 {rsi_prev:.1f}），区间位置 {pos:.0%}")
    elif bias == "long":
        reasons = [f"区间下沿（位置 {pos:.0%}）", f"RSI {rsi:.1f} 超卖"]
    elif bias == "short":
        reasons = [f"区间上沿（位置 {pos:.0%}）", f"RSI {rsi:.1f} 超买"]
    else:
        reasons = [
            f"未形成方向（多头 {long_ok}/4，空头 {short_ok}/4）",
            f"RSI {rsi:.1f}，区间位置 {pos:.0%}，ADX {adx:.1f}",
        ]

    return {
        "bias": bias,
        "score": 1 if bias == "long" else -1 if bias == "short" else 0,
        "confidence": round(conf, 2),
        "evidence": reasons,
        "rsi": round(rsi, 1),
        "macd_hist": round(hist, 3),
        "range_pos": round(pos, 2),
        "range": {"hi20": round(hi20, 2), "lo20": round(lo20, 2)},
    }


def _stage3_4h_trend(d: pd.DataFrame | None, source: str) -> dict:
    """第三阶段：4 小时线**定势**（-1 / 0 / +1）。

    4h 由本地 1h 重采样得到（`o=first / h=max / l=min / c=last / v=sum`）。
    这里只判趋势，不判断入场 —— 入场交给 1 小时线（`_stage4_1h`）。

    旧设计让 4h 兼任「定时」：周(7天)→日(1天)→4h(6倍) 跨度合理；
    现在按「三周期判势、1h 择时」拆开，4h 只保留趋势语义，
    否则同一个周期既算方向又当扳机，会重复计数。
    """
    if d is None:
        return {
            "trend": "range",
            "score": None,
            "degraded": True,
            "source": source,
            "reason": f"4 小时线不可用（{source}）：第三个周期无法判定",
        }

    last = d.iloc[-1]
    c = _num(last["c"])
    ma20, ma50 = _num(last.get("ma20")), _num(last.get("ma50"))
    adx = _num(last.get("adx"))

    # 与周线一致：均线排列 + ADX 强度确认。只看排列的话，
    # 横盘里价格贴着均线上方一点点也会算「上涨势」，把方向放得太松。
    if ma20 > 0 and ma50 > 0 and c > ma20 > ma50 and adx >= 18:
        trend, score = "bull", 1
    elif ma20 > 0 and ma50 > 0 and c < ma20 < ma50 and adx >= 18:
        trend, score = "bear", -1
    else:
        trend, score = "range", 0

    return {
        "trend": trend,
        "score": score,
        "confidence": 0.7 if score else 0.5,
        "source": source,
        "evidence": [
            f"收盘 {c:,.0f} / MA20(4h) {ma20:,.0f} / MA50(4h) {ma50:,.0f}",
            f"ADX(4h) {adx:.1f}",
        ],
        "ma20": round(ma20, 2),
        "ma50": round(ma50, 2),
        "adx": round(adx, 1),
    }


def _stage4_1h(side: str) -> dict:
    """第四阶段：1 小时线**机会评估**（决定「现在进不进」，不决定方向）。

    分工（用户设定）：
    - 周 / 日 / 4h 只回答「允许做多还是做空」（`_side_filter`）；
    - 1h 做技术分析，回答「**现在有没有值得进的机会**」；没有就 `entry=wait`。

    机会不是「四条指标打勾」，而是按结构/位置/动量/量能/形态打分（0–100）：
      - 结构（30）：1h 趋势与方向一致 30、横盘 15、反向 0；
      - 位置（20）：回调到 MA20 附近 20；追高/追空（贴着 48 根极值）0；
      - 动量（20）：MACD 柱方向一致 10，且转强再 +10；
      - 量能（15）：`vol_ratio` ≥1.2 得满，≥0.8 得一半；
      - 形态（15）：回调入场或放量突破前 48 根极值。
    ≥60 分且**结构、位置、形态都不为 0** 才给 `now` —— 避免「指标都对但没有
    入场形态」被算成机会。

    1h 仍然不能把三周期给出的方向翻过来（那会让最噪音的周期拥有否决权）；
    它只能「不给入场许可」，即 `wait`。

    数据不足时返回 degraded=True + entry=wait，而不是退回日线级入场。
    """
    if side not in ("long", "short"):
        return {
            "entry": "wait",
            "source": "skipped",
            "reason": "三周期未同向，1 小时线不单独入场",
        }

    h1, src = _hourly(limit=240)
    if h1 is None:
        return {
            "entry": "wait",
            "source": src,
            "degraded": True,
            "reason": f"1 小时线不可用（{src}）：无法定时，先 btc_sync 补 1h",
        }

    d = _ind(h1)
    last = d.iloc[-1]
    prev = d.iloc[-2] if len(d) >= 2 else last
    c = _num(last["c"])
    ma20, ma50, ma200 = (
        _num(last.get("ma20")),
        _num(last.get("ma50")),
        _num(last.get("ma200")),
    )
    rsi, rsi_prev = _num(last.get("rsi")), _num(prev.get("rsi"))
    hist, hist_prev = _num(last.get("macd_hist")), _num(prev.get("macd_hist"))
    atr = _num(last.get("atr"))
    vol_ratio = _num(last.get("vol_ratio"))

    # 关键位取**当前根之前**的 48 根：用当前 K 线自己当突破参照会自证成立
    window = d.iloc[-49:-1] if len(d) >= 49 else d.iloc[:-1]
    hi48 = _num(window["h"].max()) if len(window) else c
    lo48 = _num(window["l"].min()) if len(window) else c
    pos = (c - lo48) / (hi48 - lo48) if hi48 > lo48 else 0.5

    trend_up = ma20 > 0 and ma50 > 0 and c > ma20 > ma50
    trend_down = ma20 > 0 and ma50 > 0 and c < ma20 < ma50
    trend = "up" if trend_up else "down" if trend_down else "flat"
    near_ma20 = ma20 > 0 and atr > 0 and abs(c - ma20) <= atr

    # 止损 / 目标：近 24 小时极值 ±0.5 ATR（与旧版口径一致）
    lows = d["l"].tail(24)
    highs = d["h"].tail(24)

    if side == "long":
        # 结构看「中期趋势有没有坏」：价格在 MA50 上方、MA20 未跌破 MA50 就算多头结构。
        # 短期跌破 MA20 属于回调 —— 那正是 pullback 想进的位置，不能判成趋势反转
        # （旧逻辑要求 c > MA20 > MA50，回踩到 MA20 下方就永远 wait，自相矛盾）。
        if ma50 > 0 and c > ma50:
            structure = 30 if (ma20 > 0 and ma20 >= ma50) else 15
        else:
            structure = 0
        if near_ma20:
            position = 20
        elif pos >= 0.9:
            position = 0  # 追高：已经贴着 48 根高点，盈亏比差
        elif pos <= 0.6:
            position = 12
        else:
            position = 6
        momentum = 20 if (hist > 0 and hist >= hist_prev) else 10 if hist > 0 else 0
        volume = 15 if vol_ratio >= 1.2 else 8 if vol_ratio >= 0.8 else 0

        pullback = near_ma20 and structure > 0 and rsi >= 40 and (
            trend_up or (rsi > rsi_prev and rsi >= 45)
        )
        breakout = c > hi48 and vol_ratio >= 1.2 and 40 <= rsi <= 78
        pattern = 15 if (pullback or breakout) else 0
        opportunity = "pullback" if pullback else "breakout" if breakout else "none"

        checks = {
            "站上 MA20（1h）": c > ma20 > 0,
            "MA20 > MA50（1h）": ma20 > ma50 > 0,
            "RSI 40–72（不追超买）": 40 <= rsi <= 72,
            "MACD 柱 > 0 或转强": hist > 0 or hist >= hist_prev,
        }
        stop = _num(lows.min()) - 0.5 * atr
        risk = max(c - stop, atr * 0.5)
        # 失效条件用「本次的止损价」，不要用 MA50 —— 价格可能本来就在 MA50 另一侧，
        # 那种条件写出来当刻就已经成立，等于没给判断依据。
        invalidation = (
            f"1h 收盘跌破止损 {stop:,.2f} 或 RSI 跌回 35 以下 → 本次机会失效"
        )
        entry_zone = sorted([
            round(ma20 if ma20 > 0 else c - 0.6 * atr, 2),
            round(c + 0.2 * atr, 2),
        ])
        targets = [round(c + 2 * risk, 2), round(c + 3 * risk, 2)]
        levels = {
            "support": sorted(
                {round(x, 2) for x in (ma20, ma50, lo48) if 0 < x < c},
                reverse=True,
            )[:2],
            "resistance": sorted(
                {round(x, 2) for x in (ma20, ma50, hi48) if x > c}
            )[:2],
        }
    else:
        if ma50 > 0 and c < ma50:
            structure = 30 if (ma20 > 0 and ma20 <= ma50) else 15
        else:
            structure = 0
        if near_ma20:
            position = 20
        elif pos <= 0.1:
            position = 0  # 追空：已贴着 48 根低点
        elif pos >= 0.4:
            position = 12
        else:
            position = 6
        momentum = 20 if (hist < 0 and hist <= hist_prev) else 10 if hist < 0 else 0
        volume = 15 if vol_ratio >= 1.2 else 8 if vol_ratio >= 0.8 else 0

        pullback = near_ma20 and structure > 0 and rsi <= 60 and (
            trend_down or (rsi < rsi_prev and rsi <= 55)
        )
        breakout = c < lo48 and vol_ratio >= 1.2 and 22 <= rsi <= 60
        pattern = 15 if (pullback or breakout) else 0
        opportunity = "pullback" if pullback else "breakout" if breakout else "none"

        checks = {
            "跌破 MA20（1h）": c < ma20 > 0,
            "MA20 < MA50（1h）": ma20 < ma50 > 0,
            "RSI 28–60（不追超卖）": 28 <= rsi <= 60,
            "MACD 柱 < 0 或转弱": hist < 0 or hist <= hist_prev,
        }
        stop = _num(highs.max()) + 0.5 * atr
        risk = max(stop - c, atr * 0.5)
        invalidation = (
            f"1h 收盘涨破止损 {stop:,.2f} 或 RSI 回到 65 以上 → 本次机会失效"
        )
        entry_zone = sorted([
            round(c - 0.2 * atr, 2),
            round(ma20 if ma20 > 0 else c + 0.6 * atr, 2),
        ])
        targets = [round(c - 2 * risk, 2), round(c - 3 * risk, 2)]
        levels = {
            "support": sorted(
                {round(x, 2) for x in (ma20, ma50, lo48) if 0 < x < c},
                reverse=True,
            )[:2],
            "resistance": sorted(
                {round(x, 2) for x in (ma20, ma50, hi48) if x > c}
            )[:2],
        }

    breakdown = {
        "structure": structure,
        "position": position,
        "momentum": momentum,
        "volume": volume,
        "pattern": pattern,
    }
    score = sum(breakdown.values())
    # 60 分是「值得做」的下限；结构或形态为 0 一律 wait，
    # 避免「指标都对但 1h 没趋势/没形态」被算成机会。
    trigger = score >= 60 and structure > 0 and pattern > 0 and position > 0
    ok = sum(checks.values())

    return {
        "entry": "now" if trigger else "wait",
        "source": src,
        "score": score,
        "score_breakdown": breakdown,
        "opportunity": opportunity,
        "trend": trend,
        "checks": [f"{'✓' if v else '✗'} {k}" for k, v in checks.items()],
        "passed": f"{ok}/4",
        "levels": levels,
        "invalidation": invalidation,
        "entry_zone": entry_zone,
        "stop": round(stop, 2),
        "targets": targets,
        "rr": "1:2 / 1:3",
        # 原始指标交给模型补充判断（模型可以更保守，但不能推翻方向）
        "snapshot": {
            "close": round(c, 2),
            "ma20": round(ma20, 2),
            "ma50": round(ma50, 2),
            "ma200": round(ma200, 2),
            "rsi": round(rsi, 1),
            "rsi_prev": round(rsi_prev, 1),
            "macd_hist": round(hist, 3),
            "macd_hist_prev": round(hist_prev, 3),
            "atr": round(atr, 2),
            "vol_ratio": round(vol_ratio, 2),
            "range_pos": round(pos, 2),
            "hi48": round(hi48, 2),
            "lo48": round(lo48, 2),
        },
    }


def _side_filter(scores: dict) -> tuple[str, str]:
    """三周期打分 → 只做多 / 只做空 / 不做。

    规则（用户设定）：三周期都 ≥0 只做多，都 ≤0 只做空，**全 0 不做**。
    任一周期数据不足 → unknown（不放行）：拿不到数据时「默认允许」是最危险的
    选择，所以这里宁可挡掉，并在 `side_reason` 里说清缺什么。
    """
    values = [scores["weekly"], scores["daily"], scores["h4"]]
    if any(v is None for v in values):
        return (
            "unknown",
            "至少一个周期数据不足（4 小时线由本地 1h 重采样，先 btc_sync 补 1h）",
        )
    if all(v == 0 for v in values):
        return "none", "三周期全部横盘（0 / 0 / 0）：不做"
    if all(v >= 0 for v in values):
        return "long", "三周期均 ≥0 且至少一个向上：只做多"
    if all(v <= 0 for v in values):
        return "short", "三周期均 ≤0 且至少一个向下：只做空"
    return "none", "三周期方向冲突（有正有负）：不做"


def _decide(
    side: str,
    entry: str,
    neutral: bool,
    signal4: dict | None = None,
    confidence: float | None = None,
) -> tuple[str, str, str]:
    """返回 (action, 中文说明, 仓位建议)。"""
    if side == "unknown":
        return "stand_aside", "数据不足：至少一个周期的行情不可用，不做", "0"
    if side == "none":
        return "stand_aside", "三周期不同向（或全为横盘）：不做", "0"

    direction = "多" if side == "long" else "空"
    position = "半仓（0.5x，含横盘周期）" if neutral else "标准仓位（1.0x）"
    # 技能文档写了「confidence < 0.5 再减半」，代码必须真的做，否则两边对不上
    if isinstance(confidence, (int, float)) and confidence < 0.5:
        position += "；置信度 <0.5，仓位再减半"
    info = signal4 or {}
    score = info.get("score")
    score_text = f"评分 {score}/100" if isinstance(score, (int, float)) else "无评分"

    if entry == "now":
        kind = {
            "pullback": "回调入场",
            "breakout": "放量突破",
        }.get(str(info.get("opportunity") or ""), "")
        detail = f"1 小时线{kind}机会（{score_text}）" if kind else f"1 小时线给出机会（{score_text}）"
        return side, f"三周期{direction}头 + {detail}：做{direction}", position
    if info.get("degraded"):
        return "wait", "1 小时线数据不足，无法判断机会：不做（先 btc_sync 补 1h）", "0（等待）"
    return (
        "wait",
        f"三周期同向，但 1 小时线暂无操作机会（{score_text}，需 ≥60 且形态成立）：等回调/突破再进",
        "0（等待）",
    )


def three_stage_signal(symbol: str | None = None) -> dict:
    """三周期打分 + 1 小时线择时（周线 / 日线 / 4h 判势，1h 定时）。

    与旧版的差别（2026-11-05）：第三阶段由「4h 定时」拆成「4h 判势 + 1h 定时」，
    并引入 -1 / 0 / +1 打分：三周期都 ≥0 只做多、都 ≤0 只做空、全 0 不做。
    方向由三周期投票决定；1h 只能延后入场，不能把方向翻过来。
    """
    try:
        daily = _daily()
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}

    daily_ind = _ind(daily)
    snap_daily = _snapshot(daily_ind, bars=20)
    weekly_ind = _ind(_weekly(daily))
    snap_weekly = _snapshot(weekly_ind, bars=20)

    s1 = _stage1_weekly(weekly_ind)
    s2 = _stage2_daily(daily_ind)

    h4_df, h4_src = _h4(360)
    s3 = _stage3_4h_trend(_ind(h4_df) if h4_df is not None else None, h4_src)

    scores = {
        "weekly": s1.get("score"),
        "daily": s2.get("score"),
        "h4": s3.get("score"),
    }
    side, side_reason = _side_filter(scores)
    s4 = _stage4_1h(side)
    neutral = any(v == 0 for v in scores.values() if v is not None)

    base = min(
        s1["confidence"],
        s2["confidence"],
        s3.get("confidence") or s2["confidence"],
    )
    degraded = bool(s3.get("degraded") or s4.get("degraded"))
    confidence = round(base * (0.85 if degraded else 1.0), 2)

    action, reason, position = _decide(
        side, s4.get("entry", "wait"), neutral, s4, confidence
    )

    return {
        "symbol": symbol or settings.symbol,
        "as_of": snap_daily.get("as_of"),
        "score": {**scores, "sum": sum(v or 0 for v in scores.values())},
        "side_filter": side,
        "side_reason": side_reason,
        "stage1_weekly": s1,
        "stage2_daily": s2,
        "stage3_4h": {**s3, "note": "4 小时线只用于判势，入场看 stage4_1h"},
        "stage4_1h": s4,
        "action": action,
        "reason": reason,
        "position_hint": position,
        "confidence": confidence,
        "snapshots": {"weekly": snap_weekly, "daily": snap_daily},
        "discipline": [
            "同一自然日最多主动建仓一次；止损后当日不再入场",
            "单笔风险按止损距离计算，建议 ≤ 账户权益 2%",
            "三周期（周/日/4h）不同向时一律不做；1 小时线只定时、不翻方向",
        ],
    }


# ── 指标探测（后台触发器的数据来源） ──────────────────────

#: 只暴露这几个字段：触发器能写的条件与这里的键一一对应，加字段要两边一起改
PROBE_FIELDS = ("close", "rsi", "adx", "macd_hist", "ma_gap_pct", "atr", "ma20", "ma50", "vol_ratio")

#: 公式最大长度：再长说明该写成脚本，而不是塞进 5 分钟一次的评估里
FORMULA_MAX_LEN = 200

#: 公式里允许调用的函数（**只有这三个**，没有任何内建函数可用）
FORMULA_FUNCS = {"abs": abs, "min": min, "max": max}

#: AST 白名单：表达式、四则/幂/取模、一元正负、and/or/not、比较、变量、常量、白名单调用
_FORMULA_NODES = (
    ast.Expression,
    ast.BinOp,
    ast.UnaryOp,
    ast.BoolOp,
    ast.Compare,
    ast.Name,
    ast.Load,
    ast.Constant,
    ast.Call,
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.Div,
    ast.Mod,
    ast.Pow,
    ast.USub,
    ast.UAdd,
    ast.Not,
    ast.And,
    ast.Or,
    ast.Gt,
    ast.GtE,
    ast.Lt,
    ast.LtE,
    ast.Eq,
    ast.NotEq,
)


def formula_variables(snapshots: dict[str, dict], price: float | None = None) -> dict:
    """把 probe 的快照摊平成公式变量（如 `rsi_1h`、`ma20_4h`）。

    用「字段_周期」而不是 `1h.rsi`：点号在 Python 表达式里是属性访问，
    而属性访问正是要禁掉的东西 —— 变量名必须能被当成普通标识符。
    """
    variables: dict[str, float] = {}
    for tf, snap in snapshots.items():
        if snap.get("error"):
            continue
        for name in PROBE_FIELDS:
            value = snap.get(name)
            if isinstance(value, (int, float)) and math.isfinite(float(value)):
                variables[f"{name}_{tf}"] = float(value)
    if price is not None:
        try:
            mark = float(price)
        except (TypeError, ValueError):
            mark = 0.0
        if mark > 0:
            variables["price"] = mark
    return variables


def eval_formula(expression: str, variables: dict) -> dict:
    """求值一条**受限公式**（叫醒条件用）。

    这不是「让模型写代码」：只允许白名单变量、四则运算、比较与
    `abs/min/max`。属性访问、下标、lambda、推导式、导入、赋值全部拒绝 ——
    后台进程无人值守，能读凭据文件，执行任意代码等于开了个后门。

    返回 `{"value": float}` 或 `{"error": "可读的原因"}`。
    """
    if not isinstance(expression, str) or not expression.strip():
        return {"error": "公式为空"}
    expression = expression.strip()
    if len(expression) > FORMULA_MAX_LEN:
        return {"error": f"公式太长（超过 {FORMULA_MAX_LEN} 字符）"}

    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        return {"error": f"语法错误：{exc.msg}"}

    for node in ast.walk(tree):
        if not isinstance(node, _FORMULA_NODES):
            return {"error": f"不支持的语法：{type(node).__name__}（只能用变量、数字、+-*/%、比较与 and/or/not）"}
        if isinstance(node, ast.Name) and node.id not in FORMULA_FUNCS:
            if node.id not in variables:
                return {"error": f"未知变量：{node.id}"}
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in FORMULA_FUNCS:
                return {"error": "只允许调用 abs() / min() / max()"}
            if node.keywords:
                return {"error": "不允许关键字参数"}
        if isinstance(node, ast.Constant) and not isinstance(node.value, (int, float)):
            return {"error": "只允许数字常量"}

    try:
        value = eval(  # noqa: S307 —— 已按白名单校验过 AST，且禁用全部内建函数
            compile(tree, "<formula>", "eval"),
            {"__builtins__": {}},
            {**variables, **FORMULA_FUNCS},
        )
    except ZeroDivisionError:
        return {"error": "计算失败：除零（分母在某些周期可能为 0）"}
    except Exception as exc:  # pragma: no cover —— 白名单之外的意外
        return {"error": f"计算失败：{type(exc).__name__}: {exc}"}

    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        return {"error": "结果不是有限数值（可能是除零或比较式）"}
    return {"value": round(float(value), 6)}


def probe_timeframes(
    timeframes: list[str] | None = None,
    formulas: list[dict] | None = None,
    price: float | None = None,
) -> dict:
    """返回指定周期的指标快照，供 xzh 侧评估「叫醒条件」。

    刻意**只读本地库**（与 `_hourly` 同口径）：后台每 5 分钟调一次，
    联网拉数据会让触发判断依赖网络；行情新鲜度由 `btc_sync` 负责。

    `ma_gap_pct` = 收盘价相对 MA20 的偏离百分比（正=在均线上方）。
    `formulas` 是 `[{id, expression}]`：一次调用把公式一起算完，
    避免为每条条件各起一个 python 进程。
    """
    wanted = timeframes or ["1h", "4h", "1d"]
    result: dict[str, dict] = {}
    for tf in wanted:
        snap = analyze_timeframe(str(tf), limit=200)
        if snap.get("error"):
            result[str(tf)] = {"error": snap["error"]}
            continue
        ma20 = _num((snap.get("ma") or {}).get("20"))
        ma50 = _num((snap.get("ma") or {}).get("50"))
        close = _num(snap.get("close"))
        result[str(tf)] = {
            "as_of": snap.get("as_of"),
            "close": close,
            "rsi": _num(snap.get("rsi")),
            "adx": _num(snap.get("adx")),
            "macd_hist": _num(snap.get("macd_hist")),
            "ma_gap_pct": round((close / ma20 - 1) * 100, 2) if ma20 > 0 else 0.0,
            "atr": _num(snap.get("atr")),
            "ma20": ma20,
            "ma50": ma50,
            "vol_ratio": _num(snap.get("vol_ratio")),
        }

    if formulas:
        variables = formula_variables(result, price)
        result["formulas"] = {
            str(item.get("id")): eval_formula(str(item.get("expression") or ""), variables)
            for item in formulas
            if isinstance(item, dict) and item.get("id")
        }
        result["variables"] = sorted(variables)
    return result
