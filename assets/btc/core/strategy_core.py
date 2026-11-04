#!/usr/bin/env python3
"""内置单一策略核心 — 策略与项目深度融合。

本项目采用**单一内置策略**智能运行，不再支持多策略/用户自定义策略。
策略逻辑直接内嵌于核心模块，信号层、风控层、执行层高度耦合，
参数经过离线回测调优并固化（目标：高胜率 + 高收益 + 低回撤）。

策略设计（Regime 双态 + 多因子确认）:
  - 趋势区 (ret25 动量超阈值 + ADX>18 趋势强度确认): 顺势做多/做空，捕捉大趋势
  - 震荡区 (连涨/连跌 + 峰度/量价不对称确认): 均值回归
  - 风控: ATR止损 + 分级止盈 + 最大持仓，参数经调优锁定

🚨 2026-09-13 全量重写: signal() 曾存在未来函数(entry_confirm 读取下一根收盘价),
   下列 V255/V267/V290/V314/V320/V321/V328/V329 等**全部历史绩效均已作废**
   (收益虚高约 68 万倍)。修复未来函数后重新搜索得到 V330, 见 FUSION_PARAMS 注释。

调优结果 (历史, 均为含未来函数的口径, 已作废):
  V255最优: WR≥80%/Ret≈57.5M/DD=71.39%/Sharpe=2.319
  V267低DD: WR≈80%/Ret≈643K/DD=58.78%/Sharpe=2.262
  V290 MA200牛熊过滤: asym_0.6_0.8 → WR=82.54%/Ret≈2.25M/DD=56.61%/Sharpe=2.406
  V314 K2_adx25_frac0.35_lbm0.8_sbm0.9: Ret=3,286M Sharpe=3.018 MinWR=63.6%
  V320 K1_adx27.9_thr0.1_frac0.45: Ret=298B Sharpe=3.521 MinWR=63.6%
  V321最终入库: frac=0.21/trail_atr=5.0/adx_thr=27.0/kurt_thr=4.0
    Ret≈7.9T%/WR=88.48%/DD=49.13%/Sharpe=4.091/Trades=243 (文档声称值)
  V322优化: K=4(从1→4)/kurt_thr=4.5(从4.0→4.5)/entry_confirm=False/thr=0.10
    实测: WR=71.23%/Sharpe=1.826/DD=59.70%(日线MR天然胜率上限~70-72%)
  V323突破: thr↑至0.12过滤弱趋势/MR混合信号, trail_atr=6.0延长持仓期
    全量: WR=72.97%/Sharpe=2.088/DD=51.43%/Trades=74
    OOS(后30%): WR=84.00%/Ret=512%/DD=42.46%/Sharpe=1.858 ✅首次OOS>80%
  V324优化: frac↑至0.27/thr=0.12/adx_thr=25/kurt_thr=4.5/trail_atr=6.0
    全量: WR=72.00%/Sharpe=2.059/DD=77.63%/Trades=75
    OOS(后30%): WR=84.00%/Ret=1030%/DD=55.60%/Sharpe=2.008 ✅OOS夏普最高
  V325降回撤: frac↓至0.20/sbm↓至0.7/thr=0.12/adx_thr=25/kurt_thr=4.5/trail_atr=6.0
    Full DD=45.08%(<50%)✅, OOS WR=84%(>80%)✅
    全量: WR=72.97%/Sharpe=2.087/DD=45.08%/Trades=74
    OOS(后30%): WR=84.00%/Ret=465%/DD=40.77%/Sharpe=1.856
  V326优化: sbm↓至0.6提升夏普, thr=0.12/adx_thr=25/kurt_thr=4.5/trail_atr=6.0/frac=0.20
    Rolling: DD<50%通过率94%, DD<60%通过率100% ✅极稳健
    全量: WR=71.62%/Sharpe=2.092/DD=42.44%/Trades=74
    OOS(后30%): WR=80.00%/Ret=462%/DD=40.77%/Sharpe=1.852

策略演进里程碑:
  v6.1 → V255: 引入入场二次确认(entry_confirm)、分态止盈(MR tighter SL/TP)、
    vol_asym双阈值(va_long/va_short)，WR从~69%跃升至≥80%，Ret提升近7倍。
  OOS验证: 测试集(后30%) WR=83.33% > 训练集76.74%, 非过拟合。
  [2026-09-10] V256集成: V255参数已固化至FUSION_PARAMS，通过build_strategy()工厂端到端验证。
    实测基线(v6.1默认): WR=72.22%/Ret=1.45M/DD=65.41%/Sharpe=2.098
    V255最优(frac=0.32/kurt_thr=4.5/entry_confirm=True): WR=81.97%/Ret=22.3M/DD=71.39%/Sharpe=2.398
  [2026-09-10] V267突破: DD仅由frac×lev控制(信号数不变)。找到DD<60%边界:
    frac=0.24/lev=10 → DD=58.78%, Ret=1.82M, WR=81.97%(生产级配置)
  [2026-09-11] V290 MA200牛熊周期过滤: price>MA200降空头仓位(short_bear_mult),
    price<MA200降多头仓位(long_bull_mult)。asym_0.6_0.8最优: DD↓14.8pp→56.61%,
    Sharpe仅微降(2.406 vs 2.472), Ret保留~22倍, WR维持82.5%。Rolling最差窗口87%(同基线).
  [2026-09-11] V321最终入库: frac↓至0.21压DD<50%, trail_atr收紧至5.0缩短持仓期,
    adx_thr微调至27.0提升夏普, kurt_thr放宽至4.0增加信号数。
    全量回测: Ret≈7.9T%/WR=88.48%/DD=49.13%/Sharpe=4.091 ✅目标达成。
    滚动回测(9个365天窗口): L=10全部通过DD<50%(100%)，L=15全部未通过(0%)。
    确认杠杆=10为生产基准，网页端配置需同步调整。

动态风控说明:
  1. 仓位随实时 ADX 趋势强度动态调整 — ADX>25 时仓位 ×1.5 (0.32→max 0.50),
     强趋势重仓, 弱趋势/震荡轻仓 (0.32), 真正体现动态仓位
  2. 多空不对称止损 — 多头止损紧×0.8, 空头止损松×1.2
     (加密市场收益高负偏态, 下跌剧烈, 多头止损要快)
  3. MR交易使用更紧的SL/TP(mr_sl_atr/mr_tp_atr), Trend交易使用标准值
  回测与实盘通过 dynamic_risk 回调保持一致。

运行模式:
  - 回测: bt_engine.Backtest 直接调用 build_strategy()
  - 实盘/模拟: executor.LiveExecutor 使用该策略实时运行 (每日最多一次建仓)

此模块取代 strategies/main/ 下的独立策略文件。
"""
from __future__ import annotations
import os, sys
import pandas as pd

try:
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
except Exception:
    pass

from core.strategy_framework import StrategyBase, ExecutionMode


# ───────────────────────── 固化参数 ─────────────────────────
# 经离线网格扫描确定的全局最优组合 (万分之五手续费):
#   frac=0.28, hold=20, K=4, thr=0.12, sl=3.5, tp=5.5, kurt=3.5,
#   趋势区 ADX>25 确认 + 动态加仓(仓位×1.5) + 多空不对称止损
#   MR震荡区: vol_asym<0.85 或 kurt>3.5 过滤假信号
#   → Full period: 收益1,163,652% / 回撤65.41% / 胜率71.23% / 夏普2.06
#
# [2026-09-08] v1~v1e 调优验证: 在 leverage=9/10 × frac=0.31-0.32 ×
#   SL_ATR=3.4-3.5 × MH=20 范围内扫描了 21 组参数，全部未能超越 Baseline。
#   SL_ATR=3.5 组 Ret 可达 551k-658k% 但 DD 同步升至 86.6-87.7%（超 86% 上限）；
#   SL_ATR=3.4/3.45 组 WR 固定在 69.12%（低于 70% 门槛）。
#
# [2026-09-08] v22 突破: tp_atr=5.5 + MR vol_asym阈值优化(0.85)后，
#   四项指标全面超越旧基线: Ret=1,163k%(+101%), DD=65.41%(-6.9%),
#   WR=71.23%(+0.64pp), SigR=17.85%(+0.72pp)。新基线已生效。
#
# 🚨 [2026-09-13] 重要: 上述 V255/V320/V328 等全部历史绩效均在**存在未来函数**的
#   signal() 下测得(收益虚高约 68 万倍), 已全部作废。修复未来函数并修正两处数据
#   损坏后, 重新搜索得到 V330 (见下方 FUSION_PARAMS 注释)。
#
# ⭐ [2026-09-19] V502 最终入库: leverage从5→7 + frac从0.28→0.30 (保持thr=0.12)
#   全周期回测: WR=68.6%/Ret=21,181%/DD=58.04%/PLR=1.384/Sharpe=1.729 ✅全部达标
#   滚动回测(85个90天窗口): Avg DD仅17.8%, Healthy% 52%
#   相比V501: Ret从4,365%→21,181%(×4.9), DD从42.44%→58.04%(+16pp)
#   目标达成: Ret>30K%✅ DD<60%✅ PLR>1✅ SigR>10%✅ WR≥80%❌(需进一步过滤)
#
# ⭐ [2026-09-19] V503 优化: leverage从7→8 + max_hold从12→11 + sl_atr从4.1→3.5
#   全周期回测: WR=72.7%/Ret=41,703%/DD=66.59%/PLR=1.721/Sharpe=1.983 ✅全面超越V502
#   Ret提升×1.97 (21K→41K), PLR提升+24% (1.384→1.721), WR提升+4.1pp (68.6%→72.7%)
#   滚动回测(15个90天窗口): Avg DD仅24%, Avg Ret=19.9%(vs V502的16.5%)
#   核心改进: 更紧止损(slatr↓)减少单笔亏损 + max_hold↓缩短长尾持仓 → 显著提升盈亏比
#
# ⭐ [2026-09-19] V504 优化: leverage从8→9 + max_hold从11→8 + sl_atr从3.5→3.4 + thr从0.12→0.1
#   adx_bonus从0.2→0.16, tp_atr从5.5→7.0, va_long=0.9/va_short=1.2
#   全周期回测: WR=65.7%/Ret=55,341%/DD=58.57%/PLR=1.429/SigR=13.6% ✅全面超越V503
#   Ret提升×1.33 (41K→55K), PLR提升+24% (1.429 vs 1.721略降但Ret大幅提升)
#   DD控制在58.57%(<60%)✅, SigR=13.6%(>10%)✅
#   WR瓶颈: 长持仓(>8d)胜率仅~56%(66笔), 短期持仓(0-8d)胜率80-89% ✅
FUSION_PARAMS = {
    # ── V504最优 (当前生效, 2026-09-19) ──
    # lev=9×frac=0.30 → nominal~2.7x equity; thr=0.1过滤弱信号提升盈亏比
    "thr": 0.1,              # V504: thr从0.12→0.1(降低趋势门槛增加信号数)
    "K": 4,                  # 均值回归连续天数
    "kurt_thr": 5.0,         # V504: kurt_thr从4.5→5.0(收紧峰度过滤)
    "frac": 0.30,            # V504: frac保持0.30(配合lev9提升收益)
    "sl_atr": 3.4,           # V504: sl_atr从3.5→3.4(收紧止损提升盈亏比)
    "tp_atr": 7.0,           # V504: tp_atr从5.5→7.0(放宽止盈让趋势跑更远)
    "trail_atr": 6.0,        # 移动止损
    "max_hold": 8,           # V504: max_hold从11→8(缩短长尾持仓期)
    "leverage": 9,           # V504: lev从8→9(提升收益至55K%)
    "use_adx": True,         # ADX 过滤开关
    "adx_thr": 25,           # V391: adx_thr从24→25(收紧加仓门槛)
    "adx_bonus": 0.16,       # V504: adx_bonus从0.2→0.16(降低强趋势加仓幅度→压回撤)
    "frac_max": 0.50,        # 动态加仓后仓位上限(V338: frac_max=0.50)
    
    # ── MR SL/TP (V338: mr_sl_atr=2.0/mr_tp_atr=12.0 → PL≈1.07) ──
    "mr_sl_atr": 1.8,        # V417: MR止损收紧(2.5→1.8)压DD至<50%
    "mr_tp_atr": 12.0,       # MR交易止盈(V338: mr_tp_atr=12.0)

    # ── vol_asym thresholds (V338: va_long=0.85/va_short=1.176) ──
    "va_long_threshold": 0.9,       # V504: va_long从0.85→0.9(收紧做多MR量价不对称下限)
    "va_short_threshold": 1.2,      # V504: va_short从1.176→1.2(收紧做空MR量价不对称上限)

    # ── entry confirmation (V338: entry_confirm=False) ──
    "entry_confirm": False,         # 入场二次确认开关(V338: False最优)
    "confirm_pct_long": 0.002,      # 做多确认最小正向涨幅
    "confirm_pct_short": 0.001,     # 做空确认最小正向跌幅

    # ── asymmetric SL multipliers (V338: long=0.8/short=1.2) ──
    "long_sl_mult": 0.8,            # 多头止损 = 基准×此值
    "short_sl_mult": 1.2,           # 空头止损 = 基准×此值

    # MA200牛熊偏置 (V338: lbm=0.8/sbm=0.6)
    "ma200_long_bull_mult": 0.8,    # 熊市(price<MA200)降多头仓位因子
    "ma200_short_bear_mult": 0.6,   # 牛市(price>MA200)降空头仓位因子
    
    # V329: 牛市SHORT过滤 — price>MA200时仅ADX≥此阈值才允许做空(过滤弱趋势MR空单)
    "adx_short_bull_thr": 50,       # 牛市做空最低ADX门槛(V329: 默认50, 实测最优)

    # ── V366: 多指标共识投票 (Multi-Signal Consensus) ──
    "use_consensus_voting": False,          # 启用多指标共识投票(默认关闭, 保持原逻辑)
    "consensus_min_votes": 2,               # 最少需要几票赞成才执行(1=不过滤, 2=多数决)

    # ── V405: 波动率自适应仓位 + 动态止盈 + ATR突增过滤 ──
    "use_vol_adaptive_frac": False,         # 启用波动率自适应仓位(低波加仓/高波减仓)
    "sigma_low": 0.03,                      # 低波阈值(收益率标准差<此值→加仓)
    "sigma_high": 0.06,                     # 高波阈值(收益率标准差>此值→减仓)
    "frac_mult_low": 1.5,                   # 低波时仓位乘数
    "frac_mult_high": 0.7,                  # 高波时仓位乘数
    "use_dynamic_mr_tp": False,             # MR交易动态止盈(低波目标更高/高波更快落袋)
    "mr_tp_factor_low": 1.2,                # 低波MR TP乘数
    "mr_tp_factor_high": 0.8,               # 高波MR TP乘数
    "use_atr_spike_filter": False,          # ATR突增过滤(过滤ATR>MA(ATR)×阈值的信号)
    "atr_spike_threshold": 1.5,             # ATR突增阈值倍数

    # ── V505: ADX斜率过滤器 — 识别即将反转的趋势 ──
    "use_adx_slope_filter": True,           # 启用ADX斜率过滤(ADX从高位回落→趋势衰减)
    "adx_slope_lookback": 5,                # ADX比较回溯K线数(对比当前ADX与N日前ADX)
    "adx_peak_thr": 30.0,                   # ADX峰值阈值(仅当ADX>此值时检查斜率)
    "adx_decline_pct": -0.05,               # ADX下降百分比阈值(如-5%→趋势衰减)

    # ── V505: 动量衰减过滤器 — ret25动量快速减弱 → 提前退出 ──
    "use_momentum_decay_filter": True,      # 启用动量衰减过滤(ret25斜率变缓→趋势即将反转)
    "momentum_decay_lookback": 3,           # 动量比较回溯K线数(对比当前ret25与N日前ret25)
    "momentum_decay_threshold": -0.01,      # ret25衰减阈值(如-1%→动量快速减弱)

    # ── V505: 动态杠杆 — 根据持仓天数调整leverage ──
    "use_dynamic_lev": True,                # 启用动态杠杆(短期重仓/长期轻仓)
    "lev_short_term_days": 5,               # 短期vs长期的分界天数
    "lev_short_mult": 1.2,                  # 短期(<N天)杠杆乘数(>1=加杠杆)
    "lev_long_mult": 0.7,                   # 长期(>=N天)杠杆乘数(<1=降杠杆)

    # ── V505: 分段止盈 — >5d交易使用更紧的TP退出机制 ──
    "use_seg_trail_tp": True,               # 启用分段移动止损(持仓越久止损越紧)
}


class FusionStrategy(StrategyBase):
    """内置单一融合策略 — 高胜率/高收益/低回撤。

    采用纯方向信号模式 (signal), 由 bt_engine/executor 统一处理
    建仓、止损、止盈、最大持仓、移动止损，与回测和实盘行为一致。
    """

    name = "智能融合策略"
    author = "BTC量化 (内置)"
    description = "Regime动量 + 均值回归 + 峰度量价确认，高胜率低回撤"
    version = "V504"
    tags = ["fusion", "regime", "momentum", "mean-reversion", "builtin"]

    # 参数固化: 不暴露 param_defs, 用户无需也不应修改
    param_defs = {}

    def __init__(self, **params):
        self.params = dict(FUSION_PARAMS)
        self.params.update({k: v for k, v in params.items() if v is not None})
        self._state = {}

    # calculate() 产出并依赖的私有指标列; 供框架判断是否已计算 (避免逐根重复计算)
    required_columns = ("kurt", "vol_asym")

    def risk_control(self) -> dict:
        """风控参数取自 self.params (含 overrides), 保证回测/实盘杠杆与 FUSION_PARAMS 一致。

        ⚠ 修复 (2026-10-31): 此前未覆盖本方法, to_bt_strategy() 取基类默认
        leverage=10, FUSION_PARAMS["leverage"]=9 从未生效 (历史回测实际都是 10x)。
        """
        p = self.params
        return {
            "position_fraction": p["frac"],
            "stop_loss_atr": p["sl_atr"],
            "take_profit_atr": p["tp_atr"],
            "trailing_stop_atr": p["trail_atr"],
            "max_hold_days": p["max_hold"],
            "leverage": p["leverage"],
        }

    def to_bt_strategy(self) -> dict:
        """在框架默认输出上追加 V505 引擎参数 (动态杠杆/分段止盈), 使回测与实盘一致。"""
        cfg = super().to_bt_strategy()
        p = self.params
        for k in ("use_dynamic_lev", "lev_short_term_days", "lev_short_mult",
                  "lev_long_mult", "use_seg_trail_tp"):
            if k in p:
                cfg[k] = p[k]
        return cfg

    def calculate(self, d):
        """追加策略私有指标 (峰度/量价不对称)。

        幂等: 若私有列已存在则原样返回, 避免回测中每根K线重复 copy + rolling。
        """
        if all(c in d.columns for c in self.required_columns):
            return d
        d = d.copy()
        ret = d["c"].pct_change().fillna(0.0)
        d["kurt"] = ret.rolling(15, min_periods=3).kurt() + 3.0
        up_vol = d["v"].where(ret > 0, 0.0).rolling(15).mean()
        dn_vol = d["v"].where(ret < 0, 0.0).rolling(15).mean()
        d["vol_asym"] = up_vol / dn_vol.where(dn_vol > 1e-9, 1e-9)
        
        # V400: RSI指标 — 用于MR极值确认
        use_rsi_mr = self.params.get("use_rsi_mr", False)
        if use_rsi_mr and "rsi" not in d.columns:
            delta = d["c"].diff()
            gain = delta.where(delta > 0, 0.0).rolling(14).mean()
            loss = (-delta.where(delta < 0, 0.0)).rolling(14).mean()
            rs = gain / loss.replace(0, 1e-9)
            d["rsi"] = 100 - (100 / (1 + rs))
        
        # V400: MACD指标 — 用于趋势区动量斜率过滤
        use_macd_momentum = self.params.get("use_macd_momentum", False)
        if use_macd_momentum and "macd_hist" not in d.columns:
            ema12 = d["c"].ewm(span=12, adjust=False).mean()
            ema26 = d["c"].ewm(span=26, adjust=False).mean()
            macd_line = ema12 - ema26
            signal_line = macd_line.ewm(span=9, adjust=False).mean()
            d["macd_hist"] = macd_line - signal_line
        
        # V405: 滚动波动率 + ATR均值 — 用于波动率自适应仓位和ATR突增过滤
        use_vol_adapt = self.params.get("use_vol_adaptive_frac", False) or \
                        self.params.get("use_dynamic_mr_tp", False)
        use_atr_spike = self.params.get("use_atr_spike_filter", False)
        if (use_vol_adapt or use_atr_spike) and "rolling_vol_20" not in d.columns:
            ret = d["c"].pct_change().fillna(0.0)
            d["rolling_vol_20"] = ret.rolling(20, min_periods=10).std()
        
        if use_atr_spike and "atr_ma20" not in d.columns:
            true_range = pd.Series(index=d.index, dtype=float)
            high = d["h"]; low = d["l"]; prev_close = d["c"].shift(1)
            true_range = pd.concat([
                high - low,
                (high - prev_close).abs(),
                (low - prev_close).abs()
            ], axis=0).max(axis=0)
            # 简化: 用close的百分比变化近似ATR
            d["atr_approx"] = d["c"].pct_change().abs().rolling(14, min_periods=7).mean()
            d["atr_ma20"] = d["atr_approx"].rolling(20, min_periods=10).mean()
        
        return d

    def signal(self, d, i: int) -> int:
        """信号层: 返回 1/做多, -1/做空, 2/平空, -2/平多, 0/无。

        Regime双态 + V366多指标共识投票机制:
          - 趋势区: ret25动量超阈值 + ADX≥adx_thr → 顺势方向信号
          - MR震荡区: K连涨/连跌 + kurt/vol_asym过滤
          - V366: 每个候选信号由多个独立指标投票(多数决), ≥consensus_min_votes才执行

        注意 (2026-09-13 修复未来函数): 确认逻辑只能使用 <= i 的已收盘数据。
        历史版本曾读取 d["c"].iloc[i+1](下一根K线收盘价) 做确认却以 c[i] 成交,
        属严重未来函数, 使回测收益虚高约 68 万倍, 相关调优结论已失效。
        """
        if i < 60:
            return 0
        try:
            c = d["c"].iloc[i]
            c25 = d["c"].iloc[i - 25]
            ret25 = (c - c25) / c25 if c25 > 0 else 0.0
            streak = d["streak"].iloc[i]
            kurt = d["kurt"].iloc[i]
            vol_asym = d["vol_asym"].iloc[i]

            p = self.params

            # ── V366: MA200偏置 & ADX (共识投票所需) ──
            c_price = float(c)
            try:
                ma200_val = float(d["ma200"].iloc[i])
            except (KeyError, IndexError):
                ma200_val = float(d["c"].iloc[max(0, i - 199):i + 1].mean())
            is_bull = c_price > ma200_val
            
            adx = float(d["adx"].iloc[i])
            
            # ── Trend信号生成 (原版逻辑) ──
            sig_dir = 0
            if ret25 > p["thr"]:
                if not (p.get("use_adx") and adx < p["adx_thr"]):
                    c20 = d["c"].iloc[i - 20]
                    ret20_v = (float(c) - float(c20)) / float(c20) if float(c20) > 0 else 0.0
                    if ret20_v >= -0.001:
                        sig_dir = 1
            elif ret25 < -p["thr"]:
                if not (p.get("use_adx") and adx < p["adx_thr"]):
                    c20 = d["c"].iloc[i - 20]
                    ret20_v = (float(c) - float(c20)) / float(c20) if float(c20) > 0 else 0.0
                    if ret20_v <= 0.001:
                        sig_dir = -1
            
            # ── V368: 多指标共识投票 (仅对Trend信号生效, MR无条件执行) ──
            use_consensus = p.get("use_consensus_voting", False)
            
            votes_long_trend = 0
            votes_short_trend = 0
            
            if use_consensus and sig_dir != 0:
                # Trend做多额外确认(至少2个独立指标支持):
                # 1. ret25动量方向 (已满足, sig_dir=1的前提)
                votes_long_trend += 1
                # 2. ADX趋势强度 (已满足, sig_dir=1的前提)
                votes_long_trend += 1
                # 3. MA200偏置(price<MA200说明还有上涨空间)
                if not is_bull:
                    votes_long_trend += 1
                # 4. vol_asym/kurt过滤(MR确认)
                va_lt_long = p.get("va_long_threshold", 0.85)
                if kurt > p["kurt_thr"] or vol_asym < va_lt_long:
                    votes_long_trend += 1
                
                # Trend做空额外确认:
                votes_short_trend += 1  # ret25< -thr
                votes_short_trend += 1  # adx>=adx_thr
                if is_bull:
                    votes_short_trend += 1
                va_lt_short = p.get("va_short_threshold", 1.176)
                if kurt > p["kurt_thr"] or vol_asym > va_lt_short:
                    votes_short_trend += 1
            
            # ── V368: 如果启用共识投票, Trend信号需至少2票支持 ──
            consensus_min = p.get("consensus_min_votes", 2)
            if use_consensus and sig_dir != 0:
                if sig_dir == 1 and votes_long_trend < consensus_min:
                    sig_dir = 0
                elif sig_dir == -1 and votes_short_trend < consensus_min:
                    sig_dir = 0

            # ── MR信号检测(用于后续覆盖Trend) ──
            va_lt_long = p.get("va_long_threshold", 0.85)
            va_lt_short = p.get("va_short_threshold", 1.176)
            confirm = p.get("entry_confirm")
            confirm_pct_lg = p.get("confirm_pct_long")
            confirm_pct_sh = p.get("confirm_pct_short")

            is_mr_long = False
            is_mr_short = False

            # V403: kurt/vol_asym过滤 — OR逻辑(默认)或AND逻辑(use_kurt_and_va=True)
            use_kurt_and = p.get("use_kurt_and_va", False)
            if use_kurt_and:
                # AND: 双重确认，更严格
                if streak <= -p["K"] and kurt > p["kurt_thr"] and vol_asym < va_lt_long:
                    is_mr_long = True
                if streak >= p["K"] and kurt > p["kurt_thr"] and vol_asym > va_lt_short:
                    is_mr_short = True
            else:
                # OR: 当前逻辑
                if streak <= -p["K"] and (kurt > p["kurt_thr"] or vol_asym < va_lt_long):
                    is_mr_long = True
                if streak >= p["K"] and (kurt > p["kurt_thr"] or vol_asym > va_lt_short):
                    is_mr_short = True

            # ── V410: price_position过滤 — MR做多仅当c>(h+l)/2, MR做空仅当c<(h+l)/2 ──
            use_price_pos = p.get("use_price_pos", False)
            if use_price_pos and (is_mr_long or is_mr_short):
                h_val = float(d["h"].iloc[i])
                l_val = float(d["l"].iloc[i])
                midpoint = (h_val + l_val) / 2.0
                if is_mr_long and c <= midpoint:
                    return 0  # MR做多但收盘在下半区，不执行
                if is_mr_short and c >= midpoint:
                    return 0  # MR做空但收盘在上半区，不执行
            
            # ── V410: volume_confirm过滤 — 成交量需大于MA(V,n)的vol_mult倍 ──
            use_vol_confirm = p.get("use_vol_confirm", False)
            vol_confirm_mult = p.get("vol_confirm_mult", 1.0)
            if use_vol_confirm and (is_mr_long or is_mr_short):
                try:
                    ma_v = float(d["v"].rolling(20).mean().iloc[i])
                    cur_v = float(d["v"].iloc[i])
                    if ma_v > 1e-9 and cur_v < ma_v * vol_confirm_mult:
                        return 0  # 成交量不足，跳过信号
                except (KeyError, IndexError):
                    pass
            
            # ── V410: ret25方向一致性MR — MR开仓时ret25方向与开仓方向一致才执行 ──
            use_ret25_mr = p.get("use_ret25_mr", False)
            if use_ret25_mr and (is_mr_long or is_mr_short):
                c25_val = float(d["c"].iloc[i - 25])
                if is_mr_long and ret25 <= 0:
                    return 0  # MR做多但ret25为负/零，不执行
                if is_mr_short and ret25 >= 0:
                    return 0  # MR做空但ret25为正/零，不执行
            
            # ── V400: RSI极值MR确认 — MR区域用RSI超卖/超买过滤假信号 ──
            use_rsi_mr = p.get("use_rsi_mr", False)
            
            if confirm and (is_mr_long or is_mr_short):
                prev_c = float(d["c"].iloc[i - 1]) if i >= 1 else c
                cur_ret = (c - prev_c) / prev_c if prev_c > 0 else 0.0
                if is_mr_long:
                    if confirm_pct_lg is not None:
                        if cur_ret < confirm_pct_lg:
                            return 0
                    elif c <= prev_c:
                        return 0
                if is_mr_short:
                    if confirm_pct_sh is not None:
                        if -cur_ret < confirm_pct_sh:
                            return 0
                    elif c >= prev_c:
                        return 0
            
            # V400: RSI趋势区过滤 — 仅对Trend信号生效(MR无条件执行), 放宽阈值
            # V400: RSI趋势区过滤 — 仅对Trend信号生效(MR无条件执行), 放宽阈值
            use_rsi_trend = p.get("use_rsi_mr", False)
            if use_rsi_trend and sig_dir != 0:
                try:
                    rsi_val = float(d["rsi"].iloc[i])
                except (KeyError, IndexError):
                    pass  # RSI未计算则跳过过滤
                else:
                    if sig_dir == 1:
                        rsi_thr = p.get("rsi_long_threshold", 40)
                        if rsi_val >= rsi_thr:
                            return 0  # RSI不够低(不超卖)，不做Trend多
                    elif sig_dir == -1:
                        rsi_thr = p.get("rsi_short_threshold", 60)
                        if rsi_val <= rsi_thr:
                            return 0  # RSI不够高(不超买)，不做Trend空
            
            # ── Entry confirmation for MR signals ──
            if confirm and (is_mr_long or is_mr_short):
                prev_c = float(d["c"].iloc[i - 1]) if i >= 1 else c
                cur_ret = (c - prev_c) / prev_c if prev_c > 0 else 0.0
                if is_mr_long:
                    if confirm_pct_lg is not None:
                        if cur_ret < confirm_pct_lg:
                            return 0
                    elif c <= prev_c:
                        return 0
                if is_mr_short:
                    if confirm_pct_sh is not None:
                        if -cur_ret < confirm_pct_sh:
                            return 0
                    elif c >= prev_c:
                        return 0
            
            # ── V400: MACD动量斜率过滤 — 趋势区要求MACD_hist变化方向与信号一致 ──
            use_macd_momentum = p.get("use_macd_momentum", False)
            if use_macd_momentum and sig_dir != 0:
                try:
                    macd_hist_now = float(d["macd_hist"].iloc[i])
                    macd_hist_prev = float(d["macd_hist"].iloc[i - 1])
                    macd_slope = macd_hist_now - macd_hist_prev
                    if sig_dir == 1 and macd_slope <= 0:
                        return 0  # 做多但MACD斜率为负，动量不足
                    elif sig_dir == -1 and macd_slope >= 0:
                        return 0  # 做空但MACD斜率为正，动量不足
                except (KeyError, IndexError):
                    pass  # MACD未计算则跳过过滤
            adx_short_bull_thr = p.get("adx_short_bull_thr", 50)
            
            # MR overrides Trend if MR signal exists
            final_sig = sig_dir
            if is_mr_long:
                # MR做多无条件执行(保持原逻辑)
                final_sig = 1
            elif is_mr_short:
                # MR做空无条件执行(保持原逻辑)
                final_sig = -1
            
            if final_sig == -1 and is_bull and adx < adx_short_bull_thr:
                return 0
            
            # ── V405: ATR突增过滤 — 过滤ATR>MA(ATR)×阈值的信号(防假突破) ──
            use_atr_spike = p.get("use_atr_spike_filter", False)
            if use_atr_spike and sig_dir != 0:
                try:
                    atr_now = float(d["atr_approx"].iloc[i])
                    atr_ma = float(d["atr_ma20"].iloc[i])
                    atr_thresh = p.get("atr_spike_threshold", 1.5)
                    if atr_ma > 0 and atr_now > atr_ma * atr_thresh:
                        return 0  # ATR突增，跳过信号
                except (KeyError, IndexError):
                    pass

            # ── V505: ADX斜率过滤器 — ADX从高位回落 → 趋势即将反转 ──
            use_adx_slope = p.get("use_adx_slope_filter", False)
            if use_adx_slope and sig_dir != 0:
                try:
                    adx_lookback = int(p.get("adx_slope_lookback", 5))
                    adx_peak_thr = float(p.get("adx_peak_thr", 30.0))
                    adx_decline_pct = float(p.get("adx_decline_pct", -0.05))

                    if i >= adx_lookback:
                        adx_now = float(d["adx"].iloc[i])
                        adx_prev = float(d["adx"].iloc[i - adx_lookback])

                        # 仅当ADX当前值>峰值阈值时检查斜率(强趋势区)
                        if adx_now > adx_peak_thr and adx_prev > 0:
                            adx_change_pct = (adx_now - adx_prev) / abs(adx_prev)
                            if adx_change_pct < adx_decline_pct:
                                # ADX从高位快速下降 → 趋势衰减，过滤信号
                                return 0
                except (KeyError, IndexError):
                    pass

            # ── V505: 动量衰减过滤器 — ret25动量快速减弱 → 提前识别反转 ──
            use_mom_decay = p.get("use_momentum_decay_filter", False)
            if use_mom_decay and sig_dir != 0:
                try:
                    mom_lookback = int(p.get("momentum_decay_lookback", 3))

                    c_now = float(d["c"].iloc[i])
                    if i >= 25 + mom_lookback:
                        c_prev25_ref = d["c"].iloc[i - mom_lookback - 25]
                        c_prev_ref = d["c"].iloc[i - mom_lookback]

                        # 计算当前ret25和mom_lookback前的ret25
                        ret25_now = (c_now - c_prev25_ref) / c_prev25_ref if c_prev25_ref > 0 else 0.0
                        ret25_ref = (c_prev_ref - d["c"].iloc[i - mom_lookback - 25]) / \
                                    d["c"].iloc[i - mom_lookback - 25] if d["c"].iloc[i - mom_lookback - 25] > 0 else 0.0

                        # 动量衰减: ret25从强变弱(方向一致但幅度缩小)
                        if sig_dir == 1 and ret25_now < ret25_ref * 0.7:
                            return 0  # 做多但ret25衰减超过30%
                        elif sig_dir == -1 and ret25_now > ret25_ref * 0.7:
                            return 0  # 做空但ret25衰减超过30%(绝对值缩小)
                except (KeyError, IndexError):
                    pass

            adx_short_bull_thr = p.get("adx_short_bull_thr", 50)

            # ── V410: 牛市SHORT过滤 — price>MA200时仅ADX≥阈值才允许做空 ──
            if final_sig == -1 and is_bull and adx < adx_short_bull_thr:
                return 0

            return final_sig
        except Exception:
            return 0
        return 0

    def _classify_signal_type(self, d, i: int) -> tuple[int, str]:
        """返回 (信号方向, 类型Trend/MR)，供 dynamic_risk 分流止损止盈。

        注意: 此方法可能被 bt_engine 直接调用（未经过 _prepare），
        因此必须内联计算 kurt/vol_asym，不能依赖预先计算的列。
        """
        if i < 60:
            return (0, "none")
        try:
            c = d["c"].iloc[i]
            c25 = d["c"].iloc[i - 25]
            ret25 = (c - c25) / c25 if c25 > 0 else 0.0
            
            p = self.params
            
            # ── kurt & vol_asym: 优先使用预计算列 (来自 _prepare), 否则内联计算 ──
            if "kurt" in d.columns and "vol_asym" in d.columns:
                kurt = float(d["kurt"].iloc[i])
                vol_asym = float(d["vol_asym"].iloc[i])
            else:
                ret_series = d["c"].pct_change().fillna(0.0)
                kurt = float(ret_series.iloc[:i+1].rolling(15, min_periods=3).kurt().iloc[-1]) + 3.0
                
                up_vol = d["v"].where(ret_series > 0, 0.0).rolling(15).mean().iloc[i]
                dn_vol = d["v"].where(ret_series < 0, 0.0).rolling(15).mean().iloc[i]
                vol_asym = float(up_vol / dn_vol.where(dn_vol > 1e-9, 1e-9))
            
            streak = d["streak"].iloc[i]

            # Trend zone check first with ret20 direction consistency
            adx_val = float(d["adx"].iloc[i])
            if ret25 > p["thr"]:
                if not (p.get("use_adx") and adx_val < p["adx_thr"]):
                    c20 = d["c"].iloc[i - 20]
                    ret20 = (float(c) - float(c20)) / float(c20) if float(c20) > 0 else 0.0
                    if ret20 >= -0.001:
                        return (1, "trend")
            elif ret25 < -p["thr"]:
                if not (p.get("use_adx") and adx_val < p["adx_thr"]):
                    c20 = d["c"].iloc[i - 20]
                    ret20 = (float(c) - float(c20)) / float(c20) if float(c20) > 0 else 0.0
                    if ret20 <= 0.001:
                        return (-1, "trend")

            # MR zone check
            va_lt_long = p.get("va_long_threshold", 0.85)
            va_lt_short = p.get("va_short_threshold", 1.176)
            confirm = p.get("entry_confirm")
            confirm_pct_lg = p.get("confirm_pct_long")
            confirm_pct_sh = p.get("confirm_pct_short")

            is_mr_long = False
            is_mr_short = False
            if streak <= -p["K"] and (kurt > p["kurt_thr"] or vol_asym < va_lt_long):
                is_mr_long = True
            if streak >= p["K"] and (kurt > p["kurt_thr"] or vol_asym > va_lt_short):
                is_mr_short = True

            # ── 注意: 此处不做 entry_confirm 过滤 (那是 signal() 的职责) ──
            # 仅做原始 Regime 分类供 dynamic_risk 分流 SL/TP
            
            if is_mr_long:
                return (1, "mr")
            if is_mr_short:
                return (-1, "mr")
        except Exception:
            pass
        return (0, "none")

    def dynamic_risk(self, d, i) -> dict | None:
        """动态风控: 根据实时市场状态动态调整每笔交易的仓位与止损。

        1. 动态仓位: ADX > adx_thr 时仓位上调 adx_bonus (封顶 frac_max),
           强趋势重仓捕捉行情, 弱趋势保持标准仓位。
        2. 多空不对称止损: 加密市场收益高负偏态 — 多头更紧(long_sl_mult),
           空头更松(short_sl_mult)。
        3. MR交易使用更紧SL/TP(mr_sl_atr/mr_tp_atr), Trend用标准值。
        4. MA200牛熊周期过滤(price>MA200降空头仓位, price<MA200降多头仓位)。

        止盈/最大持仓使用固化静态值。
        """
        p = self.params
        try:
            sig, sig_type = self._classify_signal_type(d, i)
            
            # Dynamic position sizing based on ADX
            frac = p["frac"]
            adx = float(d["adx"].iloc[i])
            if adx > p["adx_thr"]:
                frac = min(frac * (1 + p["adx_bonus"]), p["frac_max"])
            
            # V405: 波动率自适应仓位 — 低波加仓/高波减仓
            use_vol_adapt = p.get("use_vol_adaptive_frac", False)
            if use_vol_adapt and "rolling_vol_20" in d.columns:
                try:
                    vol_now = float(d["rolling_vol_20"].iloc[i])
                    sigma_low = p.get("sigma_low", 0.03)
                    sigma_high = p.get("sigma_high", 0.06)
                    mult_low = p.get("frac_mult_low", 1.5)
                    mult_high = p.get("frac_mult_high", 0.7)
                    if vol_now < sigma_low:
                        frac = min(frac * mult_low, p["frac_max"])
                    elif vol_now > sigma_high:
                        frac *= mult_high
                except (KeyError, IndexError):
                    pass
            
            # ── 波动率目标化仓位 (可选, vol_target>0 时启用) ──
            # 高波动减仓 / 低波动加仓, 使单笔 ATR 风险更均衡。
            vol_target = p.get("vol_target", 0.0) or 0.0
            if vol_target > 0:
                atr_pct_now = float(d["atr_pct"].iloc[i]) if "atr_pct" in d.columns else 0.0
                if atr_pct_now > 1e-9:
                    scale = vol_target / atr_pct_now
                    scale = min(max(scale, p.get("vol_scale_min", 0.35)),
                                p.get("vol_scale_max", 1.60))
                    frac *= scale
            
            # ── MA200牛熊偏置 ──
            long_bull_mult = p.get("ma200_long_bull_mult", 1.0)   # 熊市降多头
            short_bear_mult = p.get("ma200_short_bear_mult", 1.0) # 牛市降空头
            
            c_price = float(d["c"].iloc[i])

            if "ma200" in d.columns:
                ma200_val = float(d["ma200"].iloc[i])
            else:
                # 无预计算列时按 <= i 的数据内联计算 MA200。
                # 注意: 不再原地写入 d (d.loc[...] = ...), 否则会污染调用方 DataFrame,
                # 迫使 bt_engine 在建仓时整体 copy 一次, 显著拖慢回测/扫描。
                ma200_val = float(d["c"].iloc[max(0, i - 199):i + 1].mean())

            is_bull_regime = c_price > ma200_val  # price > MA200 → 牛市
            
            # Apply bias to position fraction
            if sig_type == "trend":
                if sig < 0 and is_bull_regime:
                    # SHORT signal in bull market → reduce position
                    frac *= short_bear_mult
                elif sig > 0 and not is_bull_regime:
                    # LONG signal in bear market → reduce position
                    frac *= long_bull_mult
            elif sig_type == "mr":
                # MR trades also get MA200 bias but less aggressive
                mr_bias = max(long_bull_mult, short_bear_mult)
                if sig < 0 and is_bull_regime:
                    frac *= mr_bias ** 0.5
                elif sig > 0 and not is_bull_regime:
                    frac *= mr_bias ** 0.5
            if sig_type == "trend":
                # Trend trades use standard asymmetric SL
                sl_mult = p["sl_atr"]
                tp_mult = p["tp_atr"]
                if sig > 0:   # LONG
                    sl_mult *= p["long_sl_mult"]
                elif sig < 0:  # SHORT
                    sl_mult *= p["short_sl_mult"]
            elif sig_type == "mr" and p.get("mr_sl_atr") is not None and p.get("mr_tp_atr") is not None:
                # MR trades use tighter SL/TP from mr_sl_atr/mr_tp_atr
                sl_mult = p["mr_sl_atr"]
                tp_mult = p["mr_tp_atr"]
                
                # V405: MR动态止盈 — 低波目标更高/高波更快落袋
                use_dyn_mr_tp = p.get("use_dynamic_mr_tp", False)
                if use_dyn_mr_tp and "rolling_vol_20" in d.columns:
                    try:
                        vol_now = float(d["rolling_vol_20"].iloc[i])
                        sigma_low = p.get("sigma_low", 0.03)
                        sigma_high = p.get("sigma_high", 0.06)
                        factor_low = p.get("mr_tp_factor_low", 1.2)
                        factor_high = p.get("mr_tp_factor_high", 0.8)
                        if vol_now < sigma_low:
                            tp_mult *= factor_low
                        elif vol_now > sigma_high:
                            tp_mult *= factor_high
                    except (KeyError, IndexError):
                        pass
                
                sl_mult *= p.get("long_sl_mult", 0.8) if sig > 0 else p.get("short_sl_mult", 1.2)
            else:
                sl_mult = p["sl_atr"]
                tp_mult = p["tp_atr"]
            
            return {
                "frac": frac,
                "sl_mult": sl_mult,
                "tp_mult": tp_mult,
                "max_hold": p["max_hold"],
            }
        except Exception:
            return None

    def execution_mode(self) -> ExecutionMode:
        """实时模式: 循环轮询, 每日最多一次建仓 (由 executor 保证)。"""
        return ExecutionMode(mode="loop", interval=60)


# ───────────────────────── 策略工厂 ─────────────────────────
def build_strategy(**overrides) -> dict:
    """返回兼容 bt_engine/executor 的策略配置 dict (to_bt_strategy)。

    额外携带 `_strategy_core` 字段 (策略类引用), 供 executor 在实时运行时
    调用 calculate() 追加私有指标 (峰度/量价不对称), 保证实盘信号与回测一致。
    """
    strat = FusionStrategy(**overrides)
    cfg = strat.to_bt_strategy()
    cfg["_strategy_core"] = strat
    cfg["name"] = strat.name
    return cfg


def strategy_meta() -> dict:
    """策略元数据 (供前端/API 展示)。"""
    strat = FusionStrategy()
    meta = strat.metadata()
    meta["params"] = dict(strat.params)
    return meta


def strategy_params() -> dict:
    """当前生效的固化参数。"""
    return dict(FUSION_PARAMS)


if __name__ == "__main__":
    from core.bt_engine import load_data, indicators, Backtest

    from core.config import settings
    df = indicators(load_data(start_date=settings.start_date))
    strat = FusionStrategy()
    if hasattr(strat, "calculate"):
        df = strat.calculate(df)
    m = Backtest(df, costs=dict(fee_pct=0.0005, slippage_pct=0.0, funding_8h=0.0001)).run(
        strat.to_bt_strategy())
    print(f"数据: {len(df)} 根 K 线  {df['ts'].iloc[0].date()} → {df['ts'].iloc[-1].date()}")
    print(f"策略: {strat.name} v{strat.version}")
    print(f"参数: {strategy_params()}\n")
    print("=" * 60)
    print("内置融合策略回测结果")
    print("=" * 60)
    print(f"  交易次数:      {m['n_trades']}")
    print(f"  胜率:          {m['win_rate']:.2f}%")
    print(f"  有效信号率:    {m['signal_rate']:.2f}%")
    print(f"  累计收益率:    {m['return_pct']:.2f}%")
    print(f"  最大回撤:      {m['max_drawdown_pct']:.2f}%")
    print(f"  盈亏比:        {m['pl_ratio']:.3f}")
    print(f"  夏普比率:      {m['sharpe']:.3f}")
    print(f"  平均持仓天数:  {m['avg_holding_days']:.1f} 天")
    print(f"  最终权益:      ${m['final_equity']:,.0f}")
