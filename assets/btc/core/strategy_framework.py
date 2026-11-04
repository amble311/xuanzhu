#!/usr/bin/env python3
"""通用策略框架 — 分层式设计。

三层结构:
  1. 信号层 (Signal):    策略作者实现 signal() → 返回 1/-1/2/-2/0
  2. 风控层 (Risk):      策略作者实现 risk_control() → 仓位/止损/止盈参数
  3. 执行层 (Execution): 框架自动接管 — T+1建仓、止损监控、成本扣除

信号定义:
  1  = 做多 (空仓→开多, 空仓持有→平空+开多)
  -1 = 做空 (空仓→开空, 多仓持有→平多+开空)
  2  = 平空 (空仓持有→平空)
  -2 = 平多 (多仓持有→平多)
  0  = 无信号

策略作者只需继承 StrategyBase 并实现 signal()，其余可选。
框架保证: 信号无未来函数、风控统一执行、成本真实扣除。

运行模式:
  - loop:        循环模式, 每 N 秒检查信号
  - fixed_time:  固定时间模式, 每天指定时间执行
  - event:       事件驱动模式, 价格变动超阈值时触发
  - manual:      手动模式, 用户点击触发
"""
from __future__ import annotations
import os, sys, importlib.util, inspect
from dataclasses import dataclass, field
from typing import Any, Callable

try:
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
except Exception:
    pass  # Pyodide/无 __file__ 环境


# ───────────────── 运行模式定义 ─────────────────
@dataclass
class ExecutionMode:
    """策略运行模式配置。"""
    mode: str = "loop"           # loop | fixed_time | event | manual
    interval: int = 3600         # loop模式: 检查间隔(秒)
    times: list[str] = field(default_factory=lambda: ["16:00"])  # fixed_time模式: 每日执行时间
    price_change_pct: float = 2.0  # event模式: 价格变动触发阈值(%)


# ───────────────── 精确订单信号 ─────────────────
@dataclass
class Order:
    """精确订单信号 — 策略基于历史数据 + 当天未收盘实时数据实时计算出的完整方案。

    side == None 表示无操作/空仓。入场价作为**限价单**处理:
      - 回测: 用下一根 K 线(或盘中实时)最高/最低判断是否触达, 触达才成交, 否则放弃
      - 实盘: 挂限价单等待成交
    止损/止盈给精确价格, 同时可叠加 ATR 兜底(移动止损)。
    """
    side: str | None = None          # "LONG" / "SHORT" / None(无操作)
    entry_price: float | None = None # 精确限价入场价 (None=用当前/收盘价)
    stop_loss: float | None = None   # 精确止损价 (None=用 risk_control 的 ATR 止损)
    take_profit: float | None = None # 精确止盈价 (None=用 risk_control 的 ATR 止盈)
    position_fraction: float | None = None  # 仓位比例(占权益, 0~1); None=用 risk_control 默认
    qty: float | None = None         # 可选: 直接指定数量 (优先于 position_fraction)
    trailing_atr: float | None = None  # ATR 兜底移动止损倍数 (None=用 risk_control 的 trailing_stop_atr)
    max_hold_days: int | None = None # 可选: 该笔交易最大持仓天数 (None=用 risk_control 默认)
    exit: bool | None = None         # True=强制平仓 (可在 get_order 中主动触发)
    reason: str = ""                 # 交易原因/备注

    @property
    def is_valid(self) -> bool:
        """入场价须为正数才有效。"""
        return self.entry_price is not None and self.entry_price > 0


# ───────────────── 策略基类 ─────────────────
class StrategyBase:
    """分层式策略框架基类 — 策略作者继承此类。

    必须实现:
      signal(d, i) → int   信号层: 1=做多, -1=做空, 2=平空, -2=平多, 0=无信号

    可选覆盖:
      risk_control() → dict        风控层: 仓位/止损/止盈参数
      should_exit(d, i, pos, ei) → bool  出场层: 自定义平仓逻辑 (向后兼容)
      execution_mode() → ExecutionMode   运行模式
      metadata → dict              元数据: 名称/作者/描述/版本
    """

    # ── 元数据 (子类覆盖) ──
    name: str = "未命名策略"
    author: str = ""
    description: str = ""
    version: str = "1.0"
    tags: list = []

    # ── 参数声明 (用于市场展示和用户自定义) ──
    # 格式: {"参数名": {"default": 值, "min": 最小, "max": 最大, "desc": "说明"}}
    param_defs: dict = {}

    def __init__(self, **params):
        """初始化策略, 可传入自定义参数覆盖默认值。"""
        self.params = {}
        for pname, pdef in self.param_defs.items():
            self.params[pname] = params.get(pname, pdef.get("default"))
        self._state = {}  # 策略内部状态 (闭包替代)

    # ─────────────── 信号层 (必须实现) ───────────────
    def signal(self, d, i: int) -> int:
        """计算交易信号。

        参数:
          d: DataFrame — K线数据+指标 (ts, o, h, l, c, v, ma*, rsi, atr, ...)
          i: int — 当前K线索引

        返回值:
          1  = 做多 (空仓时开多, 空仓持有时平空+开多)
          -1 = 做空 (空仓时开空, 多仓持有时平多+开空)
          2  = 平空 (空仓持有时平仓)
          -2 = 平多 (多仓持有时平仓)
          0  = 无信号

        约束:
          - 只能使用 d 中 i 及之前的数据 (无未来函数)
          - i < 60 时应返回 0 (预热期)
        """
        raise NotImplementedError("策略必须实现 signal() 方法")

    # ─────────────── 精确订单层 (可选覆盖, 推荐) ───────────────
    def get_order(self, d, i: int, live=None) -> "Order":
        """实时计算精确交易方案。

        这是推荐的信号方式: 策略基于历史数据 d[0..i] 以及当天未收盘的实时数据,
        实时给出当前完整的买卖方案 (精确买卖价格/止损止盈价格/仓位)。

        参数:
          d: DataFrame — K线数据+指标 (ts, o, h, l, c, v, ma*, rsi, atr, ...)
          i: int — 当前K线索引 (最后一根可能是未收盘的盘中K线)
          live: dict|None — 实盘/实时模式下附加的实时行情
                {price: 当前实时价, bid, ask, ts, ...} (模拟盘/回测为 None)

        返回值:
          Order 对象:
            side            "LONG"/"SHORT"/None(无操作)
            entry_price     精确限价入场价
            stop_loss       精确止损价
            take_profit     精确止盈价
            position_fraction  仓位比例(0~1)
            qty             可选精确数量
            trailing_atr    ATR兜底移动止损
            max_hold_days   可选最大持仓天数
            exit            True=强制平仓

        约束:
          - 只能使用 d 中 i 及之前的数据 + live 实时价 (无未来函数)
          - i < 60 时应返回 Order() (空, 预热期)
          - 若返回 None 或 Order(side=None), 表示无操作
        默认实现: 回退到 signal() 返回的方向信号, 由框架自动生成 Order。
        """
        sig = self.signal(d, i)
        if sig in (1, -1):
            return Order(side="LONG" if sig > 0 else "SHORT", reason=f"signal({sig})")
        if sig in (2, -2):
            return Order(side=None, exit=True, reason=f"signal({sig})")
        return Order()

    # ─────────────── 动态风控层 (可选覆盖) ───────────────
    def dynamic_risk(self, d, i) -> dict | None:
        """动态风控: 每笔建仓时根据实时市场数据返回动态风控参数。

        返回 (可部分省略, 省略项用 risk_control 的静态值):
          frac: float      — 该笔交易动态仓位比例
          sl_mult: float   — 该笔交易动态 ATR 止损倍数
          tp_mult: float   — 该笔交易动态 ATR 止盈倍数
          max_hold: int    — 该笔交易动态最大持仓天数
        返回 None → 使用静态风控。
        """
        return None

    # ─────────────── 风控层 (可选覆盖) ───────────────
    def risk_control(self) -> dict:
        """返回风控参数。

        返回:
          position_fraction: float — 仓位比例 (占权益的%)
          stop_loss_atr: float — 止损 = N × ATR
          take_profit_atr: float — 止盈 = N × ATR (99=不止盈)
          trailing_stop_atr: float — 移动止损 = N × ATR (99=不用)
          max_hold_days: int — 最大持仓天数
          leverage: int — 杠杆倍数
        """
        return {
            "position_fraction": 0.22,
            "stop_loss_atr": 3.5,
            "take_profit_atr": 99,
            "trailing_stop_atr": 99,
            "max_hold_days": 25,
            "leverage": 10,
        }

    # ─────────────── 出场层 (可选覆盖) ───────────────
    def should_exit(self, d, i: int, position: dict, entry_index: int) -> bool:
        """自定义平仓逻辑。

        参数:
          d: DataFrame — K线数据
          i: int — 当前K线索引
          position: dict — 当前持仓 {side, entry_price, qty, entry_date, stop}
          entry_index: int — 建仓时的K线索引

        返回: True=平仓, False=继续持有

        注意: ATR止损和最大持仓天数由框架自动处理, 此方法仅用于自定义出场。
        """
        return False

    # ─────────────── 运行模式 (可选覆盖) ───────────────
    def execution_mode(self) -> ExecutionMode:
        """返回策略运行模式配置。"""
        return ExecutionMode()

    # ─────────────── 元数据 ───────────────
    def metadata(self) -> dict:
        """返回策略元数据。"""
        return {
            "name": self.name,
            "author": self.author,
            "description": self.description,
            "version": self.version,
            "tags": list(self.tags),
            "param_defs": dict(self.param_defs),
        }

    # ─────────────── 框架内部: 转为 bt_engine 兼容格式 ───────────────
    def to_bt_strategy(self) -> dict:
        """转换为 bt_engine.Backtest 兼容的策略dict。

        支持两种信号模式:
          - 精确订单模式: 策略实现 get_order() 时, 自动携带 get_order_fn,
            回测/实盘按其返回的 Order (精确买卖价格/止损止盈/仓位) 执行。
          - 方向信号模式(向后兼容): 未实现 get_order() 时, 回退到 signal() 返回 {0,1,-1,2,-2}。
        """
        risk = self.risk_control()
        sig = self.signal
        exit_fn = self.should_exit

        # 统一数据预处理: calculate() 追加自定义指标
        # ⚠ 性能关键: entry_fn/exit_fn 会在回测主循环中**每根K线**被调用,
        #   若每次都重算 (copy 整个 DataFrame + rolling), 1351 根K线将耗时数十秒,
        #   使参数扫描/滚动回测不可用。故:
        #     1) 策略可用 required_columns 声明其私有指标列;
        #     2) 列已存在时直接复用, 不重复计算 (calculate 本身也应实现幂等)。
        _required = tuple(getattr(self, 'required_columns', ()) or ())

        def _prepare(d):
            calc_fn = getattr(self, 'calculate', None)
            if not callable(calc_fn):
                return d
            if _required and all(c in d.columns for c in _required):
                return d  # 已计算过, 复用
            return calc_fn(d)

        def entry_fn(d, i):
            # 精确订单模式: 由 get_order 返回精确方案, entry_fn 仅提供方向给引擎判定
            if use_precise:
                try:
                    o = self.get_order(_prepare(d), i)
                    if o is not None and o.side in ("LONG", "SHORT") and o.is_valid:
                        return 1 if o.side == "LONG" else -1
                    if o is not None and o.exit:
                        return 2  # 平仓信号
                except Exception:
                    return 0
                return 0
            return sig(_prepare(d), i)

        def exit_fn_wrapped(d, i, pos, ei):
            return exit_fn(_prepare(d), i, pos, ei)

        # 精确订单信号: get_order(d, i, live) → Order 或 None
        def get_order_fn(d, i, live=None):
            return self.get_order(_prepare(d), i, live)

        # 是否实现精确订单模式: 子类覆盖了 get_order (非默认实现) 才启用
        use_precise = self.__class__.get_order is not StrategyBase.get_order

        # 入场时序必须与实盘/模拟盘执行器一致: 执行器在 T日收盘价挂单成交 (signal_close),
        # 因此回测也应使用 signal_close, 否则回测(T+1开盘)与实盘(T日收盘)使用不同入场价,
        # 导致回测结果无法代表实盘表现。
        return {
            "entry_fn": entry_fn,
            "exit_fn": exit_fn_wrapped,
            "get_order_fn": get_order_fn,
            "use_precise_order": use_precise,  # 精确订单模式标志
            "signal_close": True,  # 新信号系统: signal() 返回 2/-2/1/-1 可触发平仓
            "leverage": risk.get("leverage", 10),
            "position_fraction": risk.get("position_fraction", 0.22),
            "max_hold": risk.get("max_hold_days", 25),
            "sl_atr": risk.get("stop_loss_atr", 3.5),
            "trail_atr": risk.get("trailing_stop_atr", 99),
            "tp_atr": risk.get("take_profit_atr", 99),
            "entry_timing": "signal_close",
            # 动态风控: 若策略实现了 dynamic_risk(), 每笔建仓时按实时数据动态调整
            # 仓位/止损/止盈/最大持仓 (方向信号模式下生效)
            "dynamic_risk_fn": self.dynamic_risk if hasattr(self, "dynamic_risk")
                             and callable(getattr(self, "dynamic_risk", None)) else None,
        }


# ───────────────── 策略加载器 ─────────────────
def load_strategy_file(filepath: str, **params) -> StrategyBase:
    """从文件加载策略。

    支持:
      1. 类式策略: 文件中定义 StrategyBase 子类, 实例化
      2. 函数式策略: 文件中定义 entry_fn/exit_fn + PARAMS (向后兼容)
    """
    spec = importlib.util.spec_from_file_location("strategy_module", filepath)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    # 方式1: 寻找 StrategyBase 子类 (仅限本文件定义的类, 排除导入的)
    for name, obj in inspect.getmembers(mod, inspect.isclass):
        if issubclass(obj, StrategyBase) and obj is not StrategyBase:
            if obj.__module__ == mod.__name__:
                return obj(**params)

    # 方式2: 向后兼容函数式策略 (如 regime_ensemble.py)
    if hasattr(mod, "build_strategy"):
        return FunctionStrategyAdapter(mod, **params)

    raise ValueError(f"策略文件 {filepath} 未找到 StrategyBase 子类或 build_strategy()")


class FunctionStrategyAdapter(StrategyBase):
    """适配旧式函数策略 (build_strategy) 到新框架。"""

    def __init__(self, mod, **params):
        self._mod = mod
        self._params = dict(getattr(mod, "PARAMS", {}))
        self._params.update(params)
        self.name = getattr(mod, "__doc__", "").split("\n")[0].strip() or "函数策略"
        self.description = getattr(mod, "__doc__", "")
        self._entry_fn, self._exit_fn, self._strat = mod.build_strategy(**self._params)
        self._state = {}
        self.params = self._params

    def signal(self, d, i) -> int:
        return self._entry_fn(d, i)

    def should_exit(self, d, i, position, entry_index) -> bool:
        return self._exit_fn(d, i, position, entry_index)

    def risk_control(self) -> dict:
        return {
            "position_fraction": self._strat.get("position_fraction", 0.22),
            "stop_loss_atr": self._strat.get("sl_atr", 3.5),
            "take_profit_atr": self._strat.get("tp_atr", 99),
            "trailing_stop_atr": self._strat.get("trail_atr", 99),
            "max_hold_days": self._strat.get("max_hold", 25),
            "leverage": self._strat.get("leverage", 10),
        }

    def to_bt_strategy(self) -> dict:
        """直接返回原始策略dict, 保留内部状态逻辑。"""
        return dict(self._strat)


# ───────────────── 代码安全检查 (沙箱预检) ─────────────────
DANGEROUS_IMPORTS = {
    "os", "sys", "subprocess", "socket", "urllib", "requests", "http",
    "ftplib", "smtplib", "telnetlib", "socketserver", "multiprocessing",
    "threading", "signal", "ctypes", "importlib", "builtins", "shutil",
    "tempfile", "pickle", "marshal", "shelve", "fcntl", "resource",
}
DANGEROUS_BUILTINS = {
    "open", "exec", "eval", "compile", "__import__", "globals", "locals",
    "vars", "dir", "getattr", "setattr", "delattr", "hasattr",
    "input", "breakpoint", "exit", "quit", "memoryview",
}


def check_strategy_safety(filepath: str) -> tuple[bool, list[str]]:
    """静态检查策略文件安全性 (AST分析)。

    返回: (是否安全, 问题列表)
    此函数仅做静态分析, 实际运行需在独立沙箱中执行。
    """
    import ast
    issues = []

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            tree = ast.parse(f.read(), filename=filepath)
    except SyntaxError as e:
        return False, [f"语法错误: {e}"]

    for node in ast.walk(tree):
        # 检查 import
        if isinstance(node, ast.Import):
            for alias in node.names:
                mod = alias.name.split(".")[0]
                if mod in DANGEROUS_IMPORTS:
                    issues.append(f"禁止导入模块: {alias.name} (第{node.lineno}行)")
        elif isinstance(node, ast.ImportFrom):
            mod = (node.module or "").split(".")[0]
            if mod in DANGEROUS_IMPORTS:
                issues.append(f"禁止从模块导入: {node.module} (第{node.lineno}行)")
        # 检查危险内置函数调用
        elif isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id in DANGEROUS_BUILTINS:
                issues.append(f"禁止调用函数: {func.id} (第{node.lineno}行)")
            # 检查 __builtins__ 访问
            elif isinstance(func, ast.Attribute) and func.attr.startswith("__"):
                issues.append(f"禁止访问双下划线属性: {func.attr} (第{node.lineno}行)")

    return len(issues) == 0, issues


# ───────────────── 示例策略 ─────────────────
class ExampleMA(StrategyBase):
    """双均线策略示例 — 金叉做多, 死叉做空。"""

    name = "双均线交叉示例"
    author = "框架内置"
    description = "MA5上穿MA20做多, MA5下穿MA20做空, ATR止损"
    version = "1.0"
    tags = ["均线", "趋势", "入门"]

    param_defs = {
        "fast_period": {"default": 5, "min": 2, "max": 50, "desc": "快线周期"},
        "slow_period": {"default": 20, "min": 5, "max": 200, "desc": "慢线周期"},
        "sl_atr": {"default": 3.0, "min": 1.0, "max": 10.0, "desc": "ATR止损倍数"},
    }

    def signal(self, d, i: int) -> int:
        if i < 60:
            return 0
        fast_col = f"ma{self.params['fast_period']}"
        slow_col = f"ma{self.params['slow_period']}"
        if fast_col not in d.columns or slow_col not in d.columns:
            return 0
        fast = d[fast_col].iloc[i]
        slow = d[slow_col].iloc[i]
        fast_prev = d[fast_col].iloc[i - 1]
        slow_prev = d[slow_col].iloc[i - 1]
        if fast_prev is None or slow_prev is None:
            return 0
        # 金叉做多
        if fast_prev <= slow_prev and fast > slow:
            return 1
        # 死叉做空
        if fast_prev >= slow_prev and fast < slow:
            return -1
        return 0

    def risk_control(self) -> dict:
        return {
            "position_fraction": 0.22,
            "stop_loss_atr": self.params["sl_atr"],
            "take_profit_atr": 99,
            "trailing_stop_atr": 99,
            "max_hold_days": 30,
            "leverage": 10,
        }

    def execution_mode(self) -> ExecutionMode:
        return ExecutionMode(mode="fixed_time", times=["16:00"])
