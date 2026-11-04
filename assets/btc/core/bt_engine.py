#!/usr/bin/env python3
"""BTC 日线 10x 杠杆回测引擎。

严格遵循规范定义（无未来函数）:
  - 信号在 T 日收盘计算（仅用 T 及以前数据）
  - 默认 signal_close: 建仓/平仓按 T 日收盘价成交；
    entry_timing="next_open" 仅为旧策略兼容（T+1 开盘）
  - 止损/止盈用后续 K 线最高/最低逐笔判定
  - 持仓期间产生的潜在信号被过滤（有效信号率定义）
  - 最大回撤基于 K 线最高/最低逐笔权益变化，含盘中波动
  - 收益率按复利、扣除全部成本（手续费/资金费）

成本模型（新交易模型：按 T 日收盘价挂限价单，回测默认全部成交，故不考虑滑点。
仅保留手续费 + 资金费，均可配置，默认取贴近真实 taker 值，可调至规范上限做压力测试）:
  - fee_pct      每边手续费占名义价值比例（默认 0.05%，即 0.0005，买/卖各一次）
  - funding_8h   每 8 小时资金费率占名义价值比例（默认 0.01%，即 0.0001）
  - slippage_pct 保留字段但已不使用（新模型按收盘价成交，无滑点）
"""
from __future__ import annotations
import os, sys
from zoneinfo import ZoneInfo
import numpy as np
import pandas as pd

try:
    _PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
except Exception:
    _PROJECT_ROOT = os.getcwd()  # Pyodide/无 __file__ 环境
DB_PATH = os.path.join(_PROJECT_ROOT, "data", "btc.db")


class BacktestCancelled(RuntimeError):
    """回测被外部中断（agent /stop 或 UI 取消）。"""


# ─────────────────────────────── 数据 ───────────────────────────────
# 回测数据固定起点 (UTC) — 保证跨日期运行回测信号可复现
DATA_START_DATE = pd.Timestamp("2023-01-01", tz="UTC")
WARMUP_BARS = 120   # 指标预热缓冲(根), 与 database.WARMUP_DAYS 对应


def _to_cn_date(s) -> pd.Timestamp | None:
    """把 'YYYY-MM-DD' / 时间戳统一为北京时间 00:00 的 Timestamp(与 df.ts 口径一致)。"""
    try:
        ts = pd.Timestamp(s)
    except Exception:
        return None
    if ts.tzinfo is None:
        ts = ts.tz_localize("Asia/Shanghai")
    else:
        ts = ts.tz_convert("Asia/Shanghai")
    return ts.normalize()


def load_data(path: str = "", use_db: bool = True, symbol: str = "BTC/USDT",
              timeframe: str = "1d", limit: int = 0, days_back: int | None = None,
              start_date: str | pd.Timestamp | None = None) -> pd.DataFrame:
    """加载K线数据。

    数据源优先级:
      1. SQLite3数据库 (data/btc.db) — 若 use_db=True 且数据库存在
      2. JSON缓存 (cache/.btc_daily_cache.json) — 若 path指定或数据库无数据
      3. 指定path的JSON文件

    start_date (推荐, 优先于 days_back):
      - 回测起始日期(北京时间, 如 "2023-01-01"); 返回 [start_date 及之后的数据]
      - 不再往前推预热期，直接从用户设置的日期开始。

    days_back (旧口径, 向后兼容):
      - 最近 `days_back` 根 + 120 根预热缓冲; 数据不足时用全部可用数据。
      - 均未提供时 → 固定起点 DATA_START_DATE (2023-01-01)。
    """
    df = _load_data_raw(path, use_db, symbol, timeframe, limit)
    if len(df) == 0:
        return df
    ts_utc = df["ts"]
    if ts_utc.dt.tz is None:
        ts_utc = ts_utc.dt.tz_localize("UTC")
    # 转北京时间 (UTC+8): 让 ts 的日期 = 北京时间日期
    df["ts"] = ts_utc.dt.tz_convert("Asia/Shanghai")
    df = df.reset_index(drop=True)

    # ── 优先: 按回测起始日期取窗口（不含预热） ──
    if start_date:
        start_ts = _to_cn_date(start_date)
        if start_ts is not None:
            mask = (df["ts"] >= start_ts).to_numpy()
            if mask.any():
                idx = int(np.argmax(mask))          # 第一根 >= start_date 的索引
                return df.iloc[idx:].reset_index(drop=True)
            # start_date 晚于库中全部数据: 数据不足, 返回空
            return pd.DataFrame()

    if days_back is not None and days_back > 0:
        # 动态回看窗口: 最近 days_back 根 + 120 根预热缓冲
        total = min(int(days_back) + WARMUP_BARS, len(df))
        return df.tail(total).reset_index(drop=True)
    # 默认固定起点过滤: 统一数据窗口, 确保 streak 等路径依赖指标可复现
    df = df[ts_utc >= DATA_START_DATE].reset_index(drop=True)
    return df


def _load_data_raw(path: str = "", use_db: bool = True, symbol: str = "BTC/USDT",
                   timeframe: str = "1d", limit: int = 0) -> pd.DataFrame:
    """加载K线数据 (不做起点过滤)。

    数据源优先级:
      1. SQLite3数据库 (data/btc.db) — 唯一数据源，不再使用JSON缓存
    """
    if use_db and not path and os.path.exists(DB_PATH):
        try:
            from core.database import BTCDatabase
            db = BTCDatabase(DB_PATH)
            df = db.load_ohlcv(symbol, timeframe, limit=limit)
            db.close()
            if len(df) > 0:
                df = df.rename(columns={"open": "o", "high": "h", "low": "l",
                                        "close": "c", "volume": "v"})
                return df
        except Exception as e:
            log.warning(f"SQLite加载失败: {e}")

    raise FileNotFoundError(f"SQLite数据库无数据: {DB_PATH}。请先运行数据同步 (/api/data/sync-all)")


# ───────────────────────────── 指标（因果，无前瞻）─────────────────
def indicators(df: pd.DataFrame) -> pd.DataFrame:
    d = df.copy()
    c, h, l = d["c"], d["h"], d["l"]

    for w in (5, 10, 20, 50, 100, 200):
        d[f"ma{w}"] = c.rolling(w, min_periods=w).mean()

    rng = (h - l).where((h - l) > 1e-9, (c - d["o"]).abs().where((c - d["o"]).abs() > 1e-9, 1.0))
    d["cp"] = ((c - l) / rng).clip(0.0, 1.0)

    delta = c.diff()
    gain = delta.clip(lower=0.0).ewm(alpha=1 / 14, adjust=False).mean()
    loss = (-delta.clip(upper=0.0)).ewm(alpha=1 / 14, adjust=False).mean()
    d["rsi"] = 100 - 100 / (1 + gain / loss.where(loss > 1e-12, 1e-12))

    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    d["atr"] = tr.ewm(alpha=1 / 14, adjust=False).mean()
    d["atr_pct"] = d["atr"] / c

    m = c.rolling(20, min_periods=20).mean()
    s = c.rolling(20, min_periods=20).std(ddof=0)
    d["bb_m"], d["bb_u"], d["bb_l"], d["bb_w"] = m, m + 2 * s, m - 2 * s, (m + 2 * s - (m - 2 * s)) / m

    for w in (10, 20, 55):
        d[f"dc_h{w}"] = h.rolling(w, min_periods=w).max().shift(1)  # 截至昨日通道，避免当日突破自身
        d[f"dc_l{w}"] = l.rolling(w, min_periods=w).min().shift(1)

    ema12 = c.ewm(span=12, adjust=False).mean()
    ema26 = c.ewm(span=26, adjust=False).mean()
    d["macd"] = ema12 - ema26
    d["macd_sig"] = d["macd"].ewm(span=9, adjust=False).mean()
    d["macd_hist"] = d["macd"] - d["macd_sig"]

    low9 = l.rolling(9, min_periods=9).min()
    high9 = h.rolling(9, min_periods=9).max()
    rsv = (c - low9) / (high9 - low9).where(high9 - low9 > 1e-9, 1e-9) * 100
    d["k"] = rsv.ewm(alpha=1 / 3, adjust=False).mean()
    d["d"] = d["k"].ewm(alpha=1 / 3, adjust=False).mean()
    d["j"] = 3 * d["k"] - 2 * d["d"]

    up, down = h.diff(), -l.diff()
    plus_dm = up.where((up > down) & (up > 0), 0.0)
    minus_dm = down.where((down > up) & (down > 0), 0.0)
    atr_adx = tr.ewm(alpha=1 / 14, adjust=False).mean()
    plus_di = 100 * plus_dm.ewm(alpha=1 / 14, adjust=False).mean() / atr_adx.where(atr_adx > 1e-9, 1e-9)
    minus_di = 100 * minus_dm.ewm(alpha=1 / 14, adjust=False).mean() / atr_adx.where(atr_adx > 1e-9, 1e-9)
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).where((plus_di + minus_di) > 1e-9, 1e-9)
    d["adx"] = dx.ewm(alpha=1 / 14, adjust=False).mean()
    d["plus_di"], d["minus_di"] = plus_di, minus_di

    d["vol_ma20"] = d["v"].rolling(20, min_periods=20).mean()
    d["vol_ratio"] = d["v"] / d["vol_ma20"].where(d["vol_ma20"] > 1e-9, 1e-9)

    sign = np.sign(c.pct_change().fillna(0.0))
    streak, cur = [], 0
    for s in sign:
        if s > 0: cur = cur + 1 if cur > 0 else 1
        elif s < 0: cur = cur - 1 if cur < 0 else -1
        else: cur = 0
        streak.append(cur)
    d["streak"] = streak

    d["trend_up"] = (d["ma50"] > d["ma200"]) & (c > d["ma50"])
    d["trend_dn"] = (d["ma50"] < d["ma200"]) & (c < d["ma50"])
    d["vol_q"] = d["atr_pct"].rolling(120, min_periods=60).rank(pct=True)
    return d


# ───────────────────────────── 回测核心 ─────────────────────────────
class Backtest:
    def __init__(self, df: pd.DataFrame, costs: dict | None = None):
        self.d = df.reset_index(drop=True)
        # 默认成本: 手续费 0.05%(万分之五) + 资金费 0.01%/8h, 无滑点(新模型按收盘价成交)
        self.costs = dict(fee_pct=0.0005, slippage_pct=0.0, funding_8h=0.0001)
        if costs:
            self.costs.update(costs)
        # 每根K线收取的资金费期数: 日线=3 (每天3个8h), 8h=1, 4h=2 等
        # 默认3保持日线向后兼容; 非日线周期需在 costs 里传 funding_periods_per_bar
        self.costs.setdefault("funding_periods_per_bar", 3)
        self._funding_periods = self.costs["funding_periods_per_bar"]
        self._cur_sl = None
        self._cur_tp = None
        self._cur_liq = None
        self._cur_best = None  # 持仓以来最有利价(用于移动止损)

    def run(self, strategy, initial_capital=1_000_000.0, cancel_check=None):
        """cancel_check: 可选回调，每 32 根 K 线询问一次；True 时抛 BacktestCancelled。"""
        d = self.d
        n = len(d)
        o = d["o"].values; h = d["h"].values; l = d["l"].values; c = d["c"].values
        # 新交易模型: 按T日收盘价挂限价单(回测默认全部成交), 只扣手续费, 无滑点
        side_cost = self.costs["fee_pct"]
        funding = self.costs["funding_8h"]
        lev = strategy.get("leverage", 10)
        frac = strategy.get("position_fraction", 1.0)
        max_hold = strategy.get("max_hold", 5)
        sl_mult = strategy.get("sl_atr", 1.5)
        tp_mult = strategy.get("tp_atr", 3.0)
        trail_atr = strategy.get("trail_atr", None)  # 移动止损 ATR 倍数; None=不用
        use_signal_close = strategy.get("signal_close", False)  # 新信号系统
        # 精确订单模式: 策略通过 get_order() 返回精确买卖价/止损止盈/仓位
        use_precise = strategy.get("use_precise_order", False)
        get_order_fn = strategy.get("get_order_fn")
        # 动态风控: 每笔建仓时根据实时数据返回动态 {frac, sl_mult, tp_mult, max_hold}
        # (方向信号模式下用, 使策略级风控随市场状态动态调整)
        dynamic_risk_fn = strategy.get("dynamic_risk_fn")

        # ── V505: 动态杠杆参数 ──
        use_dynamic_lev = strategy.get("use_dynamic_lev", False)
        lev_short_term_days = int(strategy.get("lev_short_term_days", 5))
        lev_short_mult = float(strategy.get("lev_short_mult", 1.2))
        lev_long_mult = float(strategy.get("lev_long_mult", 0.7))

        # ── V505: 分段止盈参数 (持仓越久止损越紧) ──
        use_seg_trail_tp = strategy.get("use_seg_trail_tp", False)

        atr_arr = d["atr"].values
        dates = d["ts"].dt.strftime("%Y-%m-%d").values

        # 精确订单模式下的持仓私有参数 (精确止损/止盈/移动止损/仓位)
        precise = {}  # {side, entry_price, stop, tp, frac, qty, trail_atr, max_hold}

        # 判断最后一根K线是否未收盘 (基于实际时间, 非硬编码 i==n-1)
        # 币安1d K线时间戳为开盘时间(北京时间08:00), 收盘在次日北京时间08:00
        # df["ts"] 现在是 tz-aware (Asia/Shanghai), 用 tz-aware 比较
        last_is_pending = False
        if n > 0:
            last_close_ts = d["ts"].iloc[-1] + pd.Timedelta(days=1)
            last_is_pending = last_close_ts > pd.Timestamp.now(d["ts"].iloc[-1].tz)

        cash = initial_capital      # 已实现现金
        peak = cash
        max_dd = 0.0
        pos = 0
        entry_px = 0.0
        qty = 0.0
        entry_idx = -1
        entry_date = None
        margin = 0.0               # 该仓占用保证金(=notional/lev)，用于穿仓损失上限

        trades = []
        mtm_curve = []             # 每根 K 线收盘按盯市权益
        dd_curve = []              # 基于含盘中极值的权益
        signal_bars = 0
        total_bars = 0
        pending_trades = []       # 今日未收盘K线的信号 (仅展示, 不实际建仓)

        for i in range(n):
            if cancel_check is not None and (i & 31) == 0 and cancel_check():
                raise BacktestCancelled("回测已中断")
            mtm = cash  # 默认盯市=现金(平仓且无信号时)
            # ── 0) 计算信号 (新系统: 持仓时也需检查平仓/反转信号) ──
            pending_reversal = 0
            sig = strategy["entry_fn"](d, i) if use_signal_close else 0

            # ── 1) 持仓中: 资金费 + 盘中盯市 + 止损/止盈/最大持仓/强平 ──
            if pos != 0:
                hold_days = i - entry_idx
                # ── V505: 动态杠杆 — 短期重仓/长期轻仓 ──
                eff_lev = lev
                if use_dynamic_lev and hold_days >= lev_short_term_days:
                    eff_lev = int(lev * lev_long_mult)
                    if eff_lev < 1:
                        eff_lev = 1

                # 资金费(每日 ~3 个 8h): 多头支付, 空头收取(BTC永续正资金费率惯例)
                if pos > 0:
                    cash -= qty * entry_px * funding * self._funding_periods
                else:
                    cash += qty * entry_px * funding * self._funding_periods

                # ── V505: 分段移动止损 — 持仓越久止损越紧 ──
                eff_trail = precise.get("trail_atr") if use_precise else trail_atr
                seg_mult = 1.0
                if use_seg_trail_tp and hold_days > 3:
                    # 持仓>3d后逐步收紧移动止损
                    if hold_days <= 7:
                        seg_mult = 0.85    # 4-7d: 收紧15%
                    elif hold_days <= 12:
                        seg_mult = 0.70    # 8-12d: 收紧30%
                    else:
                        seg_mult = 0.55    # >12d: 收紧45%(快速退出)

                if eff_trail and pos != 0:
                    adj_trail = eff_trail * seg_mult
                    if pos > 0:
                        self._cur_best = max(self._cur_best, h[i])
                        new_sl = self._cur_best - adj_trail * atr_arr[i]
                        if new_sl > self._cur_sl:
                            self._cur_sl = new_sl
                    else:
                        self._cur_best = min(self._cur_best, l[i])
                        new_sl = self._cur_best + adj_trail * atr_arr[i]
                        if new_sl < self._cur_sl:
                            self._cur_sl = new_sl

                # ── V505: 动态杠杆调整强平价 ──
                if pos > 0:
                    self._cur_liq = entry_px - entry_px / (eff_lev * frac) * 0.98
                else:
                    self._cur_liq = entry_px + entry_px / (eff_lev * frac) * 0.98

                # 盘中实际承受价: 若触发止损/强平则在触发价成交, 否则取真实极值
                # (止损单已在更优价位成交, 不应再承受更差价格)
                if pos > 0:
                    if l[i] <= self._cur_liq:
                        adverse = self._cur_liq
                    elif l[i] <= self._cur_sl:
                        adverse = self._cur_sl
                    else:
                        adverse = l[i]
                    favorable = self._cur_tp if h[i] >= self._cur_tp else h[i]
                else:
                    if h[i] >= self._cur_liq:
                        adverse = self._cur_liq
                    elif h[i] >= self._cur_sl:
                        adverse = self._cur_sl
                    else:
                        adverse = h[i]
                    favorable = self._cur_tp if l[i] <= self._cur_tp else l[i]
                # 盯市权益(收盘)与盘中极值权益
                if pos > 0:
                    mtm = cash + qty * (c[i] - entry_px)
                    eq_low = cash + qty * (adverse - entry_px)
                    eq_high = cash + qty * (favorable - entry_px)
                else:
                    mtm = cash + qty * (entry_px - c[i])
                    eq_low = cash + qty * (entry_px - adverse)
                    eq_high = cash + qty * (entry_px - favorable)
                peak = max(peak, eq_high)
                dd_now = (peak - eq_low) / peak if peak > 0 else 0.0
                max_dd = max(max_dd, dd_now)

                # 精确订单模式: 持仓期间调用 get_order 判断是否主动平仓/反转
                order_exit = False
                if use_precise and get_order_fn is not None and pos != 0:
                    try:
                        ord_ = get_order_fn(d, i)
                        if ord_ is not None and ord_.exit:
                            order_exit = True
                            # 反转: 若给出反向 side 且入场价有效, 标记 pending_reversal
                            if ord_.side in ("LONG", "SHORT") and ord_.is_valid:
                                want = 1 if ord_.side == "LONG" else -1
                                cur = 1 if pos > 0 else -1
                                if want != cur:
                                    pending_reversal = want
                    except Exception:
                        order_exit = False

                # 出场判定（顺序: 强平 > 止损 > 止盈 > 最大持仓 > 信号平仓 > exit_fn > 精确平仓）
                exit_reason, exit_px = None, None
                # 强平: 不利方向触及强平价
                if pos > 0 and l[i] <= self._cur_liq:
                    exit_px = self._cur_liq; exit_reason = "LIQ"
                elif pos < 0 and h[i] >= self._cur_liq:
                    exit_px = self._cur_liq; exit_reason = "LIQ"
                elif pos > 0 and l[i] <= self._cur_sl:
                    exit_px = self._cur_sl; exit_reason = "SL"
                elif pos < 0 and h[i] >= self._cur_sl:
                    exit_px = self._cur_sl; exit_reason = "SL"
                elif pos > 0 and h[i] >= self._cur_tp:
                    exit_px = self._cur_tp; exit_reason = "TP"
                elif pos < 0 and l[i] <= self._cur_tp:
                    exit_px = self._cur_tp; exit_reason = "TP"
                elif hold_days >= precise.get("max_hold", max_hold):
                    exit_px = c[i]; exit_reason = "MAXHOLD"
                elif use_signal_close and hold_days > 0 and pos > 0 and sig in (-1, -2):
                    exit_px = c[i]; exit_reason = "SIG"
                    if sig == -1: pending_reversal = -1
                elif use_signal_close and hold_days > 0 and pos < 0 and sig in (1, 2):
                    exit_px = c[i]; exit_reason = "SIG"
                    if sig == 1: pending_reversal = 1
                elif strategy.get("exit_fn") is not None and strategy["exit_fn"](d, i, pos, entry_idx):
                    exit_px = c[i]; exit_reason = "SIG"
                elif order_exit:
                    exit_px = c[i]; exit_reason = "ORD"

                if exit_reason is not None:
                    if pos > 0:
                        fill = exit_px * (1 - side_cost)
                        pnl = qty * (fill - entry_px)
                    else:
                        fill = exit_px * (1 + side_cost)
                        pnl = qty * (entry_px - fill)
                    # 强平: 损失上限为保证金(孤立保证金), 剩余保证金返还
                    if exit_reason == "LIQ":
                        pnl = -margin  # 损失全部保证金
                    cash += pnl
                    exit_date = dates[i]
                    holding_days = (pd.to_datetime(exit_date) - pd.to_datetime(entry_date)).days + 1
                    trades.append({
                        "entry_date": entry_date, "exit_date": exit_date,
                        "signal_date": signal_date,
                        "side": "LONG" if pos > 0 else "SHORT", "entry": round(entry_px, 2),
                        "exit": round(fill, 2), "gross_ret_pct": pnl / (qty * entry_px) * pos * 100,
                        "pnl": round(pnl, 2), "win": pnl > 0,
                        "holding_days": holding_days, "reason": exit_reason,
                    })
                    pos = 0; qty = 0.0; margin = 0.0
                    mtm = cash

            # ── 2) 空仓: T 日收盘信号(≤i 数据), 建仓 ──
            if pos == 0 and i + 1 < n:
                total_bars += 1
                if not use_signal_close:
                    sig = strategy["entry_fn"](d, i)  # 旧系统: 在此计算信号
                entry_sig = pending_reversal if pending_reversal else sig

                # 精确订单模式: 调用 get_order 获取精确方案
                order = None
                if use_precise and get_order_fn is not None:
                    try:
                        order = get_order_fn(d, i)
                    except Exception:
                        order = None
                    if order is not None and order.side in ("LONG", "SHORT") and order.is_valid:
                        entry_sig = 1 if order.side == "LONG" else -1

                if entry_sig in (1, -1):
                    signal_bars += 1

                    if order is not None and order.is_valid and order.side in ("LONG", "SHORT"):
                        # ── 精确订单模式: 以精确 entry_price 挂限价单 ──
                        # 限价单成交判定: 下一根K线(或盘中)最高/最低必须触及/越过 entry_price 才成交
                        limit_px = order.entry_price
                        # 回测用 T+1 根K线判定 (i+1 < n 已保证)
                        hi_next, lo_next = h[i + 1], l[i + 1]
                        if entry_sig > 0:  # 做多: 需最低价 ≤ 买入限价
                            filled = lo_next <= limit_px
                        else:              # 做空: 需最高价 ≥ 卖出限价
                            filled = hi_next >= limit_px
                        if not filled:
                            # 未触达 → 当日放弃该限价单, 继续空仓等待
                            mtm = cash
                            mtm_curve.append(mtm)
                            peak = max(peak, mtm)
                            dd_curve.append((peak - mtm) / peak if peak > 0 else 0.0)
                            continue
                        # 成交价: 做多以 min(开盘, 限价), 做空以 max(开盘, 限价) 模拟优先成交
                        if entry_sig > 0:
                            px = min(o[i + 1], limit_px)
                        else:
                            px = max(o[i + 1], limit_px)
                        entry_px = px * (1 + side_cost) if entry_sig > 0 else px * (1 - side_cost)
                        pos = entry_sig
                        entry_idx = i + 1
                        entry_date = dates[i + 1]
                        signal_date = dates[i]   # 信号日 (T日收盘后算出信号)
                        entry_idx_actual = i + 1
                        # 仓位: 优先订单精确 qty, 其次 position_fraction
                        order_frac = order.position_fraction
                        eff_frac = order_frac if order_frac is not None else frac
                        notional = cash * lev * eff_frac
                        qty = order.qty if order.qty else notional / entry_px
                        margin = notional / lev
                        # ── 动态风控: 每笔建仓时根据实时数据调整仓位/止损/止盈 ──
                        dyn_sl_mult = sl_mult
                        dyn_tp_mult = tp_mult
                        dyn_frac_bias = 1.0
                        if dynamic_risk_fn is not None:
                            try:
                                # 直接复用 d (策略私有列已由调用方预先 calculate, 幂等跳过);
                                # 策略的 dynamic_risk 约定为只读, 不得原地修改 d,
                                # 因此无需每笔建仓都整体 copy 一次 DataFrame (原实现的主要性能瓶颈之一)。
                                _dyn_data = d
                                strat_core = strategy.get("_strategy_core")
                                if hasattr(strat_core, 'calculate'):
                                    calc_fn = getattr(strat_core, 'calculate', None)
                                    if callable(calc_fn):
                                        _dyn_data = calc_fn(_dyn_data)
                                dyn_res = dynamic_risk_fn(_dyn_data, i)
                                if dyn_res is not None:
                                    dyn_sl_mult = dyn_res.get("sl_mult", sl_mult)
                                    dyn_tp_mult = dyn_res.get("tp_mult", tp_mult)
                                    dyn_frac_bias = dyn_res.get("frac", 1.0)
                            except Exception:
                                pass
                        
                        # 仓位偏置 (MA200牛熊等): 在order_frac或全局frac基础上乘bias
                        eff_frac = order_frac if order_frac is not None else frac
                        eff_frac *= dyn_frac_bias
                        notional = cash * lev * eff_frac
                        qty = order.qty if order.qty else notional / entry_px
                        if order.stop_loss:
                            sl_px = order.stop_loss
                        elif use_precise:
                            eff_sl_m = dyn_sl_mult if order.stop_loss is None else sl_mult
                            sl_px = entry_px - eff_sl_m * atr_val if entry_sig > 0 else entry_px + eff_sl_m * atr_val
                        else:
                            sl_px = entry_px - dyn_sl_mult * atr_val if entry_sig > 0 else entry_px + dyn_sl_mult * atr_val
                        if order.take_profit:
                            tp_px = order.take_profit
                        elif use_precise:
                            eff_tp_m = dyn_tp_mult if order.take_profit is None else tp_mult
                            tp_px = entry_px + eff_tp_m * atr_val if entry_sig > 0 else entry_px - eff_tp_m * atr_val
                        else:
                            tp_px = entry_px + dyn_tp_mult * atr_val if entry_sig > 0 else entry_px - dyn_tp_mult * atr_val
                        self._cur_sl = sl_px
                        self._cur_tp = tp_px
                        self._cur_liq = entry_px - entry_px / (lev * eff_frac) * 0.98 if entry_sig > 0 else \
                                         entry_px + entry_px / (lev * eff_frac) * 0.98
                        precise = {
                            "side": entry_sig, "entry_price": entry_px,
                            "frac": eff_frac,
                            "trail_atr": order.trailing_atr,
                            "max_hold": order.max_hold_days,
                        }
                    else:
                        # ── 方向信号模式(向后兼容): 按T日收盘价建仓 ──
                        # 动态风控: 每笔建仓时根据实时数据动态调整仓位/止损/止盈/最大持仓
                        eff_frac = frac
                        eff_sl_mult = sl_mult
                        eff_tp_mult = tp_mult
                        eff_max_hold = max_hold
                        dyn = None
                        if dynamic_risk_fn is not None:
                            try:
                                dyn = dynamic_risk_fn(d, i) or {}
                                eff_frac = dyn.get("frac", frac)
                                eff_sl_mult = dyn.get("sl_mult", sl_mult)
                                eff_tp_mult = dyn.get("tp_mult", tp_mult)
                                eff_max_hold = dyn.get("max_hold", max_hold)
                            except Exception:
                                dyn = None
                        # entry_timing 仅用于兼容旧策略: "next_open" 仍按T+1开盘价
                        if strategy.get("entry_timing", "signal_close") == "next_open":
                            px = o[i + 1]
                            entry_idx_actual = i + 1
                        else:
                            px = c[i]
                            entry_idx_actual = i
                        entry_px = px * (1 + side_cost) if entry_sig > 0 else px * (1 - side_cost)
                        pos = entry_sig
                        entry_idx = entry_idx_actual
                        entry_date = dates[entry_idx_actual]
                        signal_date = dates[i]   # 信号日 (T日收盘后算出信号)
                        notional = cash * lev * eff_frac
                        qty = notional / entry_px
                        margin = notional / lev
                        # 记录该笔交易的动态最大持仓 (供持仓期间 MAXHOLD 判断)
                        precise["max_hold"] = eff_max_hold
                        # 用信号日 i 的 ATR(已完全可知)设止损/止盈/强平价
                        atr_val = atr_arr[i] if not np.isnan(atr_arr[i]) else entry_px * 0.02
                        if pos > 0:
                            self._cur_sl = entry_px - eff_sl_mult * atr_val
                            self._cur_tp = entry_px + eff_tp_mult * atr_val
                            self._cur_liq = entry_px - entry_px / (lev * eff_frac) * 0.98  # 强平价(留 2% 缓冲)
                        else:
                            self._cur_sl = entry_px + eff_sl_mult * atr_val
                            self._cur_tp = entry_px - eff_tp_mult * atr_val
                            self._cur_liq = entry_px + entry_px / (lev * eff_frac) * 0.98
                    self._cur_best = entry_px
                    mtm = cash  # 建仓日盯市=现金(开盘建仓, 当日收盘计入下根)

            # ── 2b) 最后一根K线: 若有信号, 仅记录为 pending (不建仓, 仅展示信号点) ──
            # 最后一根无论是否收盘都无法在下一根开盘执行 (无下一根数据)
            # 但只有未收盘时 signal_type 标为 "pending" (信号可能变), 已收盘则标为 "confirmed" (信号已确定)
            elif pos == 0 and i == n - 1:
                if not use_signal_close:
                    sig = strategy["entry_fn"](d, i)
                entry_sig = pending_reversal if pending_reversal else sig
                # 精确订单模式: 记录精确入场价
                pend_order = None
                if use_precise and get_order_fn is not None:
                    try:
                        pend_order = get_order_fn(d, i)
                    except Exception:
                        pend_order = None
                    if pend_order is not None and pend_order.side in ("LONG", "SHORT") and pend_order.is_valid:
                        entry_sig = 1 if pend_order.side == "LONG" else -1
                if entry_sig in (1, -1):
                    pend_px = pend_order.entry_price if (pend_order is not None and pend_order.is_valid) else c[i]
                    pending_trades.append({
                        "signal_date": dates[i],
                        "side": "LONG" if entry_sig > 0 else "SHORT",
                        "signal_price": round(pend_px, 2),
                        "signal_type": "pending" if last_is_pending else "confirmed",
                    })

            mtm_curve.append(mtm)
            peak = max(peak, mtm)
            dd_curve.append((peak - mtm) / peak if peak > 0 else 0.0)

        # 收尾平仓
        if pos != 0:
            i = n - 1
            if pos > 0:
                fill = c[i] * (1 - side_cost); pnl = qty * (fill - entry_px)
            else:
                fill = c[i] * (1 + side_cost); pnl = qty * (entry_px - fill)
            cash += pnl
            exit_date = dates[i]
            holding_days = (pd.to_datetime(exit_date) - pd.to_datetime(entry_date)).days + 1
            trades.append({
                "entry_date": entry_date, "exit_date": exit_date,
                "signal_date": signal_date,
                "side": "LONG" if pos > 0 else "SHORT", "entry": round(entry_px, 2),
                "exit": round(fill, 2), "gross_ret_pct": pnl / (qty * entry_px) * pos * 100,
                "pnl": round(pnl, 2), "win": pnl > 0, "holding_days": holding_days, "reason": "EOD",
            })
            mtm_curve[-1] = cash

        return self._summarize(trades, mtm_curve, dd_curve, signal_bars, total_bars, initial_capital, cash, max_dd, pending_trades)

    def _summarize(self, trades, mtm_curve, dd_curve, signal_bars, total_bars, init, final, max_dd_runtime, pending_trades=None):
        eq = np.array(mtm_curve, dtype=float)
        dd = np.array(dd_curve, dtype=float)
        n_trades = len(trades)
        wins = [t for t in trades if t["win"]]
        losses = [t for t in trades if not t["win"]]
        win_rate = len(wins) / n_trades * 100 if n_trades else 0.0
        signal_rate = signal_bars / total_bars * 100 if total_bars else 0.0
        ret_pct = (final - init) / init * 100
        # 最大回撤: 取运行期逐笔(H/L)与曲线孰大
        max_dd_pct = max(max_dd_runtime, float(np.max(dd)) if len(dd) else 0.0) * 100

        avg_win = np.mean([t["pnl"] for t in wins]) if wins else 0.0
        avg_loss = np.mean([abs(t["pnl"]) for t in losses]) if losses else 0.0
        pl_ratio = avg_win / avg_loss if avg_loss > 0 else float("inf")

        daily_ret = np.diff(eq) / np.where(eq[:-1] > 0, eq[:-1], 1.0) if len(eq) > 1 else np.array([0.0])
        sharpe = (daily_ret.mean() / daily_ret.std() * np.sqrt(252)) if daily_ret.std() > 1e-12 else 0.0

        max_con_win = max_con_loss = cw = cl = 0
        for t in trades:
            if t["win"]:
                cw += 1; cl = 0; max_con_win = max(max_con_win, cw)
            else:
                cl += 1; cw = 0; max_con_loss = max(max_con_loss, cl)
        avg_hold = np.mean([t["holding_days"] for t in trades]) if trades else 0.0

        return {
            "n_trades": n_trades, "win_rate": round(win_rate, 2),
            "signal_rate": round(signal_rate, 2), "return_pct": round(ret_pct, 2),
            "max_drawdown_pct": round(max_dd_pct, 2), "pl_ratio": round(pl_ratio, 3),
            "sharpe": round(float(sharpe), 3), "avg_win": round(float(avg_win), 2),
            "avg_loss": round(float(avg_loss), 2), "max_consec_win": max_con_win,
            "max_consec_loss": max_con_loss, "avg_holding_days": round(float(avg_hold), 1),
            "final_equity": round(final, 2), "signal_bars": signal_bars,
            "total_bars_eval": total_bars, "trades": trades,
            "equity_curve": mtm_curve, "dd_curve": dd_curve,
            "pending_trades": pending_trades or [],
        }


# ────────────────────────── 目标检查 ──────────────────────────
TARGETS = dict(return_pct=500.0, signal_rate=6.0, max_drawdown_pct=50.0,
               pl_ratio=1.5, sharpe=1.0)


def check_targets(m: dict) -> dict:
    return {
        "return_pct>500": m["return_pct"] > TARGETS["return_pct"],
        "signal_rate>6": m["signal_rate"] > TARGETS["signal_rate"],
        "max_dd<50": m["max_drawdown_pct"] < TARGETS["max_drawdown_pct"],
        "pl_ratio>1.5": m["pl_ratio"] > TARGETS["pl_ratio"],
        "sharpe>1.0": m["sharpe"] > TARGETS["sharpe"],
    }


DEFAULT_COSTS = dict(fee_pct=0.0005, slippage_pct=0.0, funding_8h=0.0001)


def rolling_backtest(strategy: dict, df: pd.DataFrame = None, window: int = 90,
                     step: int = 15, costs: dict | None = None,
                     initial_capital: float = 1_000_000.0) -> list[dict]:
    """滚动回测 (walk-forward): 回测实时滚动, 与实盘运行并行验证策略有效性。

    以滑动窗口方式, 每隔 step 根K线截取 window 根K线运行一次回测,
    返回每个窗口的绩效 dict 列表 (含窗口起止时间)。调用方可用于:
      - 实时并行展示"当前窗口策略绩效" (最新窗口)
      - 观察策略绩效的时间稳定性 (是否持续有效)
      - 判断策略是否需要调整 (绩效漂移预警)

    Args:
        strategy: 策略配置 dict (build_strategy 产出)
        df: 数据 (默认自动 load_data+indicators); 若含策略私有指标须预先计算
        window: 每个回测窗口的 K线根数
        step: 窗口滑动步长 (根K线)
        costs: 成本参数
    Returns:
        list[dict]: 每个窗口一个 dict {start, end, n_bars, n_trades, win_rate,
                    return_pct, max_drawdown_pct, sharpe, pl_ratio, score}
    """
    if df is None:
        df = indicators(load_data())
    df = df.reset_index(drop=True)
    n = len(df)
    results = []
    # 策略私有指标已由调用方预先计算 (rolling_backtest 不重复计算)
    for start in range(0, n - window + 1, step):
        end = start + window
        sub = df.iloc[start:end].reset_index(drop=True)
        if len(sub) < 80:  # 指标预热需要足够样本
            continue
        try:
            m = Backtest(sub, costs=costs or DEFAULT_COSTS).run(
                strategy, initial_capital=initial_capital)
            score = m["return_pct"] / max(m["max_drawdown_pct"], 1) * (m["win_rate"] / 100)
            results.append({
                "start": str(sub["ts"].iloc[0].date()),
                "end": str(sub["ts"].iloc[-1].date()),
                "n_bars": int(len(sub)),
                "交易次数": int(m["n_trades"]),
                "胜率": float(round(m["win_rate"], 2)),
                "累计收益率": float(round(m["return_pct"], 2)),
                "最大回撤": float(round(m["max_drawdown_pct"], 2)),
                "夏普比率": float(round(m["sharpe"], 3)),
                "盈亏比": float(round(m["pl_ratio"], 3)),
                "score": float(round(score, 2)),
            })
        except Exception:
            continue
    return results


def latest_rolling_stats(strategy: dict, df: pd.DataFrame = None, window: int = 90,
                         costs: dict | None = None) -> dict | None:
    """返回最新窗口的滚动回测绩效 (供实盘并行展示"当前策略有效性")。

    与 rolling_backtest 不同, 此函数只对最后 window 根K线跑一次回测,
    返回该窗口的绩效摘要; 若策略在当前市场环境下失效 (收益<0 或 回撤过大),
    调用方可用 is_healthy=False 提示。
    """
    if df is None:
        df = indicators(load_data())
    df = df.reset_index(drop=True)
    if len(df) < 80:
        return None
    sub = df.iloc[-window:].reset_index(drop=True)
    try:
        m = Backtest(sub, costs=costs or DEFAULT_COSTS).run(strategy)
    except Exception as e:
        return None
    return {
        "start": str(sub["ts"].iloc[0].date()),
        "end": str(sub["ts"].iloc[-1].date()),
        "n_bars": int(len(sub)),
        "交易次数": int(m["n_trades"]),
        "胜率": float(round(m["win_rate"], 2)),
        "累计收益率": float(round(m["return_pct"], 2)),
        "最大回撤": float(round(m["max_drawdown_pct"], 2)),
        "夏普比率": float(round(m["sharpe"], 3)),
        "盈亏比": float(round(m["pl_ratio"], 3)),
        "is_healthy": bool(m["return_pct"] > 0 and m["max_drawdown_pct"] < 60),
    }


if __name__ == "__main__":
    df = indicators(load_data())
    print(f"数据: {len(df)} 根 K 线  {df['ts'].iloc[0].date()} → {df['ts'].iloc[-1].date()}")
    print("指标列:", [c for c in df.columns if c not in ('ts','o','h','l','c','v')][:20], "...")
