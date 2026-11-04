#!/usr/bin/env python3
"""市场区间识别与策略路由 — 基于历史数据量化分析。

架构:
    RegimeDetector → 多因子打分 + 滞后确认 → 当前市场状态 (bull/bear/sideways)
    StrategyRouter → 状态 → 适配子策略 + 参数调优

历史数据分析结论 (2023-2026, 1389根日线):
    - Bull (476天): MA200上方, ret25均值+13.7%, ADX=31.9, RSI=63.6, ATR%=3.39%
      → 趋势跟随收益 >> 均值回归
    - Bear (283天): MA200下方, ret25均值-9.6%, ADX=30.3, RSI=39.7, ATR%=4.06%
      → 做空趋势跟随有效
    - Sideways (630天): 混合状态, ADX=27.0, RSI=52.7, vol_q=0.44
      → 均值回归(连涨/连跌)有效

区间持续: bull平均14天, bear平均7天, sideways平均7天
转移: sideways→bull 40%, sideways→bear 60%; bull/bear几乎不直接互转
"""
from __future__ import annotations
import numpy as np
import pandas as pd
from typing import Optional

# ────────────────────────────────────────────────
# RegimeDetector — 多因子打分 + 滞后确认
# ────────────────────────────────────────────────
class RegimeDetector:
    """基于多因子打分的市场状态检测器。

    因子:
      - MA200位置 (价格 vs 长期均线)
      - ret25 (25日动量)
      - ADX (趋势强度门控, <27视为震荡)
      - RSI (过热/超卖辅助)

    输出: "bull" | "bear" | "sideways"
    滞后机制: 连续 N 天同一方向才切换，防止频繁翻转
    """

    def __init__(self, persist: int = 4, adx_threshold: float = 27.0,
                 momentum_threshold: float = 0.03):
        self.persist = persist              # 滞后天数
        self.adx_threshold = adx_threshold  # ADX低于此值→震荡
        self.momentum_threshold = momentum_threshold  # ret25阈值

    def detect(self, d: pd.DataFrame) -> dict:
        """检测当前市场状态。

        Args:
            d: 含指标列的 DataFrame (需有 c, ma200, adx, rsi, ret25)

        Returns:
            {
                "regime": "bull"|"bear"|"sideways",
                "score": float,           # 综合得分
                "confidence": float,      # 置信度 0-1
                "factors": {...},         # 各因子值
                "trend_direction": str,   # "up"|"down"|"flat"
                "volatility_pct": float,  # ATR%
            }
        """
        if len(d) < 60:
            return self._default_result("insufficient_data")

        c = d["c"].values
        ma200 = d["ma200"].values
        adx = d["adx"].values
        rsi = d["rsi"].values
        atr_pct = d["atr_pct"].values
        ret25 = (c[-1] / c[-26]) - 1.0 if len(c) >= 26 else 0.0

        i = len(d) - 1  # 最新一根

        # ── 因子打分 ──
        score = 0.0
        factors = {}

        # MA200位置: +2/0/-2
        above_ma200 = c[i] > ma200[i]
        factors["above_ma200"] = bool(above_ma200)
        if above_ma200:
            score += 2.0
        else:
            score -= 2.0

        # ret25动量: ±2 (归一化)
        r25_norm = np.clip(ret25 / 0.10, -2.0, 2.0)
        factors["ret25"] = float(ret25 * 100)
        factors["ret25_norm"] = float(r25_norm)
        score += r25_norm

        # ADX门控: <threshold → 强制震荡
        adx_val = float(adx[i]) if not np.isnan(adx[i]) else 0.0
        factors["adx"] = adx_val
        if adx_val >= self.adx_threshold:
            factors["trend_strength"] = True
        else:
            factors["trend_strength"] = False

        # RSI辅助: >68过热减分, <32超卖加分
        rsi_val = float(rsi[i]) if not np.isnan(rsi[i]) else 50.0
        factors["rsi"] = rsi_val
        if rsi_val > 68:
            score -= 1.0
        elif rsi_val < 32:
            score += 1.0

        atr_pct_val = float(atr_pct[i]) * 100 if not np.isnan(atr_pct[i]) else 0.0
        factors["atr_pct"] = atr_pct_val

        # ── 滞后确认 (检查最近 persist 天的方向一致性) ──
        lookback = min(self.persist, len(d))
        recent_scores = []
        for j in range(len(d) - lookback, len(d)):
            s = self._score_at(j, d)
            recent_scores.append(s)

        avg_recent = np.mean(recent_scores)
        std_recent = np.std(recent_scores) + 1e-9
        confidence = float(np.clip(abs(avg_recent) / (2.0 * std_recent), 0, 1))

        # 最终判定: 综合当前分 + 近期均值
        combined_score = score * 0.6 + avg_recent * 0.4

        if adx_val < self.adx_threshold:
            regime = "sideways"
        elif combined_score >= 1.5 and above_ma200:
            regime = "bull"
        elif combined_score <= -1.5 and not above_ma200:
            regime = "bear"
        else:
            regime = "sideways"

        trend_dir = "up" if above_ma200 else ("down" if c[i] < ma200[i] * 0.98 else "flat")

        return {
            "regime": regime,
            "score": float(score),
            "combined_score": float(combined_score),
            "confidence": confidence,
            "factors": factors,
            "trend_direction": trend_dir,
            "volatility_pct": atr_pct_val,
        }

    def _score_at(self, i: int, d: pd.DataFrame) -> float:
        """计算某一根K线的综合分数。"""
        c = d["c"].values; ma200 = d["ma200"].values
        if np.isnan(ma200[i]) or c[i] <= 0:
            return 0.0
        above = 1.0 if c[i] > ma200[i] else -1.0
        r25 = (c[i] / c[max(0, i-25)]) - 1.0 if i >= 25 and c[max(0,i-25)] > 0 else 0.0
        return above * 2.0 + np.clip(r25 / 0.10, -2.0, 2.0)

    def _default_result(self, reason):
        return {
            "regime": "sideways",
            "score": 0.0,
            "combined_score": 0.0,
            "confidence": 0.0,
            "factors": {"reason": reason},
            "trend_direction": "flat",
            "volatility_pct": 0.0,
        }


# ────────────────────────────────────────────────
# 子策略 — 三个区间适配策略
# ────────────────────────────────────────────────
from core.strategy_framework import StrategyBase, ExecutionMode

class BullStrategy(StrategyBase):
    """牛市策略 — 顺势做多为主，做空仅极端超卖时。

    历史特征 (bull regime, n=476天):
      - 日均收益 +0.265%, 年化波动率 49%
      - ADX均值 31.9 (强趋势), RSI 63.6 (偏多)
      - ret25 均值 +13.7%
      → 趋势跟随 >> 均值回归; 仓位可适度加大; 止损稍宽

    信号逻辑:
      - 做多: ret25 > thr AND ADX >= adx_thr (顺势突破)
      - 做空: 仅当 RSI < 30 AND ret25 < -8% (极端超卖反弹做空)
      - 平仓: ATR止损 / 移动止盈 / 最大持仓天数
    """
    name = "牛市策略"
    author = "RegimeRouter"
    description = "牛市区间适配: 顺势做多为主, 宽松止损, 高置信度加仓"
    version = "V1.0"
    tags = ("bull", "trend", "long")

    def __init__(self, **params):
        self.params = {
            # 入场阈值 — 牛市放宽: 更容易触发做多
            "entry_threshold": 0.10,      # ret25 > 10% (vs 震荡区12%)
            "adx_min": 25,                # ADX≥25 (vs 震荡区27)
            # 做空极保守: 仅极端超卖
            "short_rsi_max": 30,          # RSI<30才考虑做空
            "short_ret25_max": -0.08,     # ret25<-8%
            # 风控 — 牛市宽松: 止损宽, 持仓久
            "stop_loss_atr": 4.0,         # 比震荡区(3.5)宽
            "trailing_stop_atr": 6.0,     # 移动止盈放宽
            "take_profit_atr": 99,        # 不主动止盈, 让利润奔跑
            "max_hold_days": 30,          # 持仓期延长
            "position_fraction": 0.30,    # 仓位略高 (vs 震荡区22%)
            "leverage": 10,
            # 动态加仓: 低波动时加仓
            "use_vol_adaptive_frac": True,
            "sigma_low": 0.035,
            "frac_mult_low": 1.5,
            "sigma_high": 0.07,
            "frac_mult_high": 0.6,
        }
        self.params.update({k: v for k, v in params.items() if v is not None})

    def signal(self, d, i: int) -> int:
        """牛市信号: 顺势做多为主。"""
        if i < 60:
            return 0
        try:
            c = d["c"].iloc[i]
            c25 = d["c"].iloc[i - 25]
            ret25 = (c - c25) / c25 if c25 > 0 else 0.0
            adx_val = float(d["adx"].iloc[i]) if not np.isnan(d["adx"].iloc[i]) else 0.0
            rsi_val = float(d["rsi"].iloc[i]) if not np.isnan(d["rsi"].iloc[i]) else 50.0

            thr = self.params.get("entry_threshold", 0.10)
            adx_min = self.params.get("adx_min", 25)

            # 做多: ret25超阈值 + ADX确认趋势
            if ret25 > thr and adx_val >= adx_min:
                return 1

            # 做空: 仅极端超卖 (RSI<30 AND ret25<-8%)
            short_rsi_max = self.params.get("short_rsi_max", 30)
            short_ret25_max = self.params.get("short_ret25_max", -0.08)
            if rsi_val < short_rsi_max and ret25 < short_ret25_max:
                return -1

            return 0
        except Exception:
            return 0

    def risk_control(self) -> dict:
        p = self.params
        return {
            "position_fraction": p["position_fraction"],
            "stop_loss_atr": p["stop_loss_atr"],
            "trailing_stop_atr": p["trailing_stop_atr"],
            "take_profit_atr": p["take_profit_atr"],
            "max_hold_days": p["max_hold_days"],
            "leverage": p["leverage"],
        }

    def dynamic_risk(self, d, i):
        """牛市动态风控: 低波动加仓, 高波动减仓。"""
        if i < 60:
            return None
        try:
            ret = d["c"].pct_change().fillna(0.0)
            sigma = float(ret.iloc[max(0,i-30):i+1].std())
            sigma_low = self.params.get("sigma_low", 0.035)
            sigma_high = self.params.get("sigma_high", 0.07)
            base_frac = self.params["position_fraction"]

            if sigma < sigma_low:
                mult = self.params.get("frac_mult_low", 1.5)
            elif sigma > sigma_high:
                mult = self.params.get("frac_mult_high", 0.6)
            else:
                mult = 1.0

            # 键名与 executor._check_entry / bt_engine 约定一致: frac/sl_mult/tp_mult
            return {
                "frac": min(base_frac * mult, 0.5),
                "sl_mult": self.params["stop_loss_atr"],
                "tp_mult": self.params.get("take_profit_atr", 99),
            }
        except Exception:
            return None

    def execution_mode(self) -> ExecutionMode:
        return ExecutionMode(mode="fixed_time", times=["16:00"])


class BearStrategy(StrategyBase):
    """熊市策略 — 顺势做空为主，做多仅极端超买时。

    历史特征 (bear regime, n=283天):
      - 日均收益 +0.502% (做空视角), 年化波动率 119.8%
      - ADX均值 30.3, RSI 39.7 (偏空)
      - ret25 均值 -9.6%, ATR%=4.06% (高波动)
      → 做空趋势跟随有效; 止损需更宽(高波); 仓位控制严格

    信号逻辑:
      - 做空: ret25 < -thr AND ADX >= adx_thr (顺势破位)
      - 做多: 仅当 RSI > 70 AND ret25 > +8% (极端超买反弹做多)
      - 平仓: ATR止损 / 移动止盈 / 最大持仓天数
    """
    name = "熊市策略"
    author = "RegimeRouter"
    description = "熊市区间适配: 顺势做空为主, 宽松止损应对高波动, 严格仓位控制"
    version = "V1.0"
    tags = ("bear", "trend", "short")

    def __init__(self, **params):
        self.params = {
            # 入场阈值 — 熊市放宽做空条件
            "entry_threshold": 0.10,       # ret25 < -10%
            "adx_min": 25,                 # ADX≥25
            # 做多极保守: 仅极端超买
            "long_rsi_min": 70,           # RSI>70才考虑做多
            "long_ret25_min": 0.08,       # ret25>+8%
            # 风控 — 熊市高波: 止损宽, 仓位低
            "stop_loss_atr": 4.5,         # 比牛市(4.0)更宽
            "trailing_stop_atr": 6.5,     # 移动止盈放宽
            "take_profit_atr": 99,        # 不主动止盈
            "max_hold_days": 30,          # 持仓期延长
            "position_fraction": 0.25,    # 仓位适中 (vs 震荡区22%)
            "leverage": 10,
            # 动态减仓: 高波动时减仓
            "use_vol_adaptive_frac": True,
            "sigma_low": 0.04,
            "frac_mult_low": 1.3,
            "sigma_high": 0.08,
            "frac_mult_high": 0.5,
        }
        self.params.update({k: v for k, v in params.items() if v is not None})

    def signal(self, d, i: int) -> int:
        """熊市信号: 顺势做空为主。"""
        if i < 60:
            return 0
        try:
            c = d["c"].iloc[i]
            c25 = d["c"].iloc[i - 25]
            ret25 = (c - c25) / c25 if c25 > 0 else 0.0
            adx_val = float(d["adx"].iloc[i]) if not np.isnan(d["adx"].iloc[i]) else 0.0
            rsi_val = float(d["rsi"].iloc[i]) if not np.isnan(d["rsi"].iloc[i]) else 50.0

            thr = self.params.get("entry_threshold", 0.10)
            adx_min = self.params.get("adx_min", 25)

            # 做空: ret25超阈值(负向) + ADX确认趋势
            if ret25 < -thr and adx_val >= adx_min:
                return -1

            # 做多: 仅极端超买 (RSI>70 AND ret25>+8%)
            long_rsi_min = self.params.get("long_rsi_min", 70)
            long_ret25_min = self.params.get("long_ret25_min", 0.08)
            if rsi_val > long_rsi_min and ret25 > long_ret25_min:
                return 1

            return 0
        except Exception:
            return 0

    def risk_control(self) -> dict:
        p = self.params
        return {
            "position_fraction": p["position_fraction"],
            "stop_loss_atr": p["stop_loss_atr"],
            "trailing_stop_atr": p["trailing_stop_atr"],
            "take_profit_atr": p["take_profit_atr"],
            "max_hold_days": p["max_hold_days"],
            "leverage": p["leverage"],
        }

    def dynamic_risk(self, d, i):
        """熊市动态风控: 高波动减仓。"""
        if i < 60:
            return None
        try:
            ret = d["c"].pct_change().fillna(0.0)
            sigma = float(ret.iloc[max(0,i-30):i+1].std())
            sigma_low = self.params.get("sigma_low", 0.04)
            sigma_high = self.params.get("sigma_high", 0.08)
            base_frac = self.params["position_fraction"]

            if sigma < sigma_low:
                mult = self.params.get("frac_mult_low", 1.3)
            elif sigma > sigma_high:
                mult = self.params.get("frac_mult_high", 0.5)
            else:
                mult = 1.0

            # 键名与 executor._check_entry / bt_engine 约定一致: frac/sl_mult/tp_mult
            return {
                "frac": min(base_frac * mult, 0.4),
                "sl_mult": self.params["stop_loss_atr"],
                "tp_mult": self.params.get("take_profit_atr", 99),
            }
        except Exception:
            return None

    def execution_mode(self) -> ExecutionMode:
        return ExecutionMode(mode="fixed_time", times=["16:00"])


class SidewaysStrategy(StrategyBase):
    """震荡策略 — 均值回归为主，连涨做空/连跌做多。

    历史特征 (sideways regime, n=630天):
      - 日均收益 +0.35%, 年化波动率 75%
      - ADX均值 27.0 (弱趋势), RSI 52.7 (中性)
      - ret25 均值 +1.6%, vol_q=0.44
      → 均值回归 >> 趋势跟随; 仓位适中; 止损紧

    信号逻辑:
      - 做空: K连涨(≥4) AND ret25>5% (超买回调)
      - 做多: K连跌(≤-4) AND ret25<-5% (超卖反弹)
      - 过滤: kurt/vol_asym排除假信号
      - 平仓: ATR止损 / 移动止盈 / 最大持仓天数
    """
    name = "震荡策略"
    author = "RegimeRouter"
    description = "震荡区间适配: 均值回归, 连涨/连跌反转信号, 紧止损快进出"
    version = "V1.0"
    tags = ("sideways", "mean_reversion")

    def __init__(self, **params):
        self.params = {
            # 入场阈值 — 震荡区收紧: 要求更强确认
            "streak_threshold": 4,         # 连涨/连跌根数
            "ret25_threshold": 0.05,       # ret25绝对值>5%
            "adx_max": 30,                 # ADX>30时不交易(趋势太强)
            # 过滤参数
            "kurt_filter": True,           # 启用峰度过滤
            "vol_asym_filter": True,       # 启用量价不对称过滤
            # 风控 — 震荡区紧: 止损窄, 持仓短
            "stop_loss_atr": 3.0,         # 比牛市/熊市更紧
            "trailing_stop_atr": 4.0,     # 移动止盈收紧
            "take_profit_atr": 5.0,       # 主动止盈 (MR目标明确)
            "max_hold_days": 12,          # 持仓期短
            "position_fraction": 0.22,    # 标准仓位
            "leverage": 10,
        }
        self.params.update({k: v for k, v in params.items() if v is not None})

    def signal(self, d, i: int) -> int:
        """震荡信号: 均值回归。"""
        if i < 60:
            return 0
        try:
            c = d["c"].iloc[i]
            c25 = d["c"].iloc[i - 25]
            ret25 = (c - c25) / c25 if c25 > 0 else 0.0
            adx_val = float(d["adx"].iloc[i]) if not np.isnan(d["adx"].iloc[i]) else 0.0

            streak_thr = self.params.get("streak_threshold", 4)
            r25_thr = self.params.get("ret25_threshold", 0.05)
            adx_max = self.params.get("adx_max", 30)

            # ADX过高时不交易(趋势太强, 不适合MR)
            if adx_val > adx_max:
                return 0

            # 计算连涨/连跌 (streak)
            rets = d["c"].pct_change().fillna(0.0).iloc[max(0,i-50):i+1]
            streak = 0
            for r in rets.values:
                if r > 0:
                    streak = streak + 1 if streak >= 0 else 1
                elif r < 0:
                    streak = streak - 1 if streak <= 0 else -1
                else:
                    streak = 0

            # 做空: 连涨超阈值 AND ret25正向
            if streak >= streak_thr and ret25 > r25_thr:
                return -1

            # 做多: 连跌超阈值 AND ret25负向
            if streak <= -streak_thr and ret25 < -r25_thr:
                return 1

            return 0
        except Exception:
            return 0

    def risk_control(self) -> dict:
        p = self.params
        return {
            "position_fraction": p["position_fraction"],
            "stop_loss_atr": p["stop_loss_atr"],
            "trailing_stop_atr": p["trailing_stop_atr"],
            "take_profit_atr": p["take_profit_atr"],
            "max_hold_days": p["max_hold_days"],
            "leverage": p["leverage"],
        }

    def execution_mode(self) -> ExecutionMode:
        return ExecutionMode(mode="fixed_time", times=["16:00"])


# ────────────────────────────────────────────────
# StrategyRouter — 区间→策略映射 + 参数适配
# ────────────────────────────────────────────────
class StrategyRouter:
    """市场状态路由器。

    每次需要策略时:
      1. 从最新数据检测当前 regime
      2. 选择对应子策略
      3. 根据 regime 特征微调参数 (如波动率自适应仓位)
      4. 返回 bt_engine/executor 兼容的策略配置 dict
    """

    def __init__(self, detector: Optional[RegimeDetector] = None):
        self.detector = detector or RegimeDetector(persist=4)
        self._strategies = {
            "bull": BullStrategy,
            "bear": BearStrategy,
            "sideways": SidewaysStrategy,
        }
        self._last_regime = "sideways"
        self._last_detection = None

    def detect(self, d: pd.DataFrame) -> dict:
        """检测当前市场状态。"""
        result = self.detector.detect(d)
        self._last_regime = result["regime"]
        self._last_detection = result
        return result

    def get_strategy_config(self, d: pd.DataFrame) -> dict:
        """获取当前适配的策略配置 (bt_engine/executor 兼容格式)。

        Args:
            d: 含指标列的 DataFrame

        Returns:
            策略配置 dict (与 build_strategy() 返回格式一致)
        """
        detection = self.detect(d)
        regime = detection["regime"]
        StrategyClass = self._strategies.get(regime, SidewaysStrategy)

        # 根据 regime 特征微调参数
        overrides = {}
        if regime == "bull":
            # 牛市: 低波动时加仓
            overrides["use_vol_adaptive_frac"] = True
        elif regime == "bear":
            # 熊市: 高波动时减仓
            overrides["use_vol_adaptive_frac"] = True
        else:
            # 震荡: 标准参数
            pass

        strat = StrategyClass(**overrides)
        cfg = strat.to_bt_strategy()
        cfg["_strategy_core"] = strat
        cfg["name"] = f"{strat.name} (regime={regime})"
        cfg["_regime"] = regime
        cfg["_detection"] = detection
        return cfg

    def get_detection(self, d: pd.DataFrame) -> dict:
        """获取当前市场状态检测结果。"""
        if self._last_detection is None or len(d) != len(self._last_detection.get("_df", [])):
            self.detect(d)
        return self._last_detection or {}


# ────────────────────────────────────────────────
# 工厂函数 — 兼容现有 build_strategy() 调用方式
# ────────────────────────────────────────────────
_router_instance: "StrategyRouter | None" = None


def get_router() -> StrategyRouter:
    """全局单例路由器 (执行器每次循环复用, 避免重复构造)。"""
    global _router_instance
    if _router_instance is None:
        _router_instance = StrategyRouter()
    return _router_instance


def build_strategy(**overrides) -> dict:
    """返回当前适配的策略配置 (基于实时 regime 检测)。

    与 strategy_core.build_strategy() 接口兼容，可直接替换使用。
    """
    from core.bt_engine import indicators, load_data

    # 加载数据 + 计算指标
    df = load_data(symbol="BTC/USDT", timeframe="1d")
    if df is None or len(df) < 60:
        raise ValueError("数据不足, 无法检测市场状态")

    d = indicators(df)

    router = get_router()
    return router.get_strategy_config(d)


def get_current_regime() -> dict:
    """获取当前市场状态 (便捷函数)。"""
    from core.bt_engine import indicators, load_data

    df = load_data(symbol="BTC/USDT", timeframe="1d")
    if df is None or len(df) < 60:
        return {"regime": "unknown", "error": "insufficient data"}

    d = indicators(df)
    router = StrategyRouter()
    return router.detect(d)


# ────────────────────────────────────────────────
# 自测试
# ────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 60)
    print("Regime Router — 当前市场状态检测")
    print("=" * 60)
    result = get_current_regime()
    if "error" in result:
        print(f"错误: {result['error']}")
    else:
        print(f"\n  市场状态: {result['regime'].upper()}")
        print(f"  综合得分: {result.get('combined_score', 0):.2f}")
        print(f"  置信度:   {result.get('confidence', 0)*100:.0f}%")
        print(f"  趋势方向: {result.get('trend_direction', 'N/A')}")
        print(f"  ATR%:     {result.get('volatility_pct', 0):.2f}%")
        print(f"\n  因子详情:")
        for k, v in result.get("factors", {}).items():
            print(f"    {k}: {v}")
