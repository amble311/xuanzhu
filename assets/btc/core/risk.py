#!/usr/bin/env python3
"""风控模块 — 实盘交易的多层风险闸门。

风控层级:
  1. 账户级: 最大回撤止损、日内亏损熔断
  2. 策略级: 连续亏损暂停
  3. 单笔级: 风险上限、强平价距检查、仓位规模限制

用法:
    from core.risk import RiskManager
    rm = RiskManager()
    if rm.can_open_position(equity, entry_price, stop_price, qty):
        rm.on_open(...)
"""
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime, date
from core.logger import get_logger
from core.config import settings

log = get_logger("risk")


@dataclass
class RiskState:
    """风控运行时状态。"""
    peak_equity: float = 0.0          # 历史峰值权益
    consec_losses: int = 0             # 连续亏损次数
    daily_pnl: float = 0.0             # 当日已实现盈亏
    daily_pnl_date: str = ""           # 当日日期(YYYY-MM-DD)
    paused: bool = False               # 是否暂停交易
    pause_reason: str = ""             # 暂停原因
    total_trades: int = 0
    total_wins: int = 0


class RiskManager:
    """多层风控管理器。"""

    def __init__(self, max_account_dd: float = settings.max_account_dd,
                 max_risk_per_trade: float = settings.max_risk_per_trade,
                 max_consec_loss: int = settings.max_consec_loss,
                 daily_loss_limit: float = settings.daily_loss_limit,
                 leverage: int = settings.leverage):
        self.max_account_dd = max_account_dd
        self.max_risk_per_trade = max_risk_per_trade
        self.max_consec_loss = max_consec_loss
        self.daily_loss_limit = daily_loss_limit
        self.leverage = leverage
        self.state = RiskState()
        # enabled=False 时全部检查放行, 账户级风控关闭, 全权交给策略风控
        self.enabled = True

    # ─────────────── 账户级检查 ───────────────
    def check_account_dd(self, equity: float) -> bool:
        """检查账户级回撤是否超限。返回 True=安全, False=触发熔断。"""
        if equity <= 0:
            self._pause("账户权益归零")
            return False
        if self.state.peak_equity == 0:
            self.state.peak_equity = equity
            return True
        self.state.peak_equity = max(self.state.peak_equity, equity)
        dd = (self.state.peak_equity - equity) / self.state.peak_equity
        if dd >= self.max_account_dd:
            self._pause(f"账户回撤 {dd:.1%} >= {self.max_account_dd:.1%}")
            return False
        return True

    def check_daily_loss(self, equity_change: float) -> bool:
        """检查日内亏损熔断。equity_change=当日盈亏额(正=盈利,负=亏损)。"""
        today = date.today().isoformat()
        if self.state.daily_pnl_date != today:
            self.state.daily_pnl_date = today
            self.state.daily_pnl = 0.0
        self.state.daily_pnl += equity_change
        if self.state.daily_pnl < 0:
            # 需要基准权益来计算百分比
            ref = self.state.peak_equity if self.state.peak_equity > 0 else 1.0
            daily_loss_pct = abs(self.state.daily_pnl) / ref
            if daily_loss_pct >= self.daily_loss_limit:
                self._pause(f"日内亏损 {daily_loss_pct:.1%} >= {self.daily_loss_limit:.1%}")
                return False
        return True

    # ─────────────── 策略级检查 ───────────────
    def check_consec_loss(self) -> bool:
        """检查连续亏损暂停。"""
        if self.state.consec_losses >= self.max_consec_loss:
            self._pause(f"连续亏损 {self.state.consec_losses} 次 >= {self.max_consec_loss}")
            return False
        return True

    # ─────────────── 单笔级检查 ───────────────
    def can_open_position(self, equity: float, entry_price: float,
                          stop_price: float, qty: float,
                          liq_price: float | None = None) -> tuple[bool, str]:
        """综合检查是否允许开仓。返回 (允许, 原因)。"""
        # 0. 若账户级风控被关闭(risk_enabled=False), 全权交给策略风控, 直接放行
        if not self.enabled:
            return True, "账户级风控已关闭(全权交给策略)"

        # 1. 暂停状态
        if self.state.paused:
            return False, f"交易已暂停: {self.state.pause_reason}"

        # 2. 账户回撤
        if not self.check_account_dd(equity):
            return False, self.state.pause_reason

        # 3. 连续亏损
        if not self.check_consec_loss():
            return False, self.state.pause_reason

        # 4. 单笔风险 = |entry - stop| * qty / equity
        if entry_price <= 0 or stop_price <= 0 or equity <= 0:
            return False, "参数非法(价格/权益<=0)"

        risk_amount = abs(entry_price - stop_price) * qty
        risk_pct = risk_amount / equity
        if risk_pct > self.max_risk_per_trade:
            return False, f"单笔风险 {risk_pct:.2%} > {self.max_risk_per_trade:.2%}"

        # 5. 强平价距当前价过近
        if liq_price is not None and entry_price > 0:
            liq_dist = abs(entry_price - liq_price) / entry_price
            if liq_dist < 0.03:  # 强平价距入场 < 3%
                return False, f"强平价距入场仅 {liq_dist:.1%}, 过近"

        return True, "通过"

    def calc_position_size(self, equity: float, entry_price: float,
                           stop_price: float, leverage: int = 0) -> float:
        """基于风险上限计算仓位大小(币数量)。

        仓位 = (equity * max_risk_per_trade) / |entry - stop|
        """
        lev = leverage or self.leverage
        risk_budget = equity * self.max_risk_per_trade
        stop_dist = abs(entry_price - stop_price)
        if stop_dist <= 0:
            return 0.0
        # 仓位受杠杆上限约束
        max_notional = equity * lev
        risk_qty = risk_budget / stop_dist
        max_qty = max_notional / entry_price
        return min(risk_qty, max_qty)

    # ─────────────── 事件回调 ───────────────
    def on_open(self, equity: float, entry_price: float, qty: float):
        """开仓后回调。"""
        self.state.peak_equity = max(self.state.peak_equity, equity)
        log.info(f"开仓记录: entry={entry_price:.2f} qty={qty:.6f} equity={equity:.2f}")

    def on_close(self, pnl: float, equity: float):
        """平仓后回调。pnl=本笔盈亏(正=盈利,负=亏损)。"""
        self.state.total_trades += 1
        if pnl > 0:
            self.state.total_wins += 1
            self.state.consec_losses = 0
        else:
            self.state.consec_losses += 1
        self.check_daily_loss(pnl)
        self.check_account_dd(equity)
        log.info(f"平仓记录: pnl={pnl:+.2f} equity={equity:.2f} "
                 f"consec_loss={self.state.consec_losses} WR={self.state.total_wins}/{self.state.total_trades}")

    # ─────────────── 控制 ───────────────
    def _pause(self, reason: str):
        self.state.paused = True
        self.state.pause_reason = reason
        log.error(f"⛔ 风控熔断: {reason}")

    def resume(self):
        """手动恢复交易（风控解除）: 清除熔断并重置当日亏损计数。"""
        self.state.paused = False
        self.state.pause_reason = ""
        self.state.consec_losses = 0
        # 必须同时清零当日累计盈亏: 否则恢复后同一交易日内的旧亏损会立即
        # 再次触发日内亏损熔断, 表现为"点了恢复但马上又熔断"。
        self.state.daily_pnl = 0.0
        log.warning("风控已手动恢复, 交易继续")

    def status(self) -> dict:
        """返回当前风控状态摘要 (含策略级风控参数与熔断状态)。"""
        wr = self.state.total_wins / self.state.total_trades * 100 if self.state.total_trades else 0
        # 策略级风控熔断检查状态
        consec_triggered = self.state.consec_losses >= self.max_consec_loss if self.max_consec_loss > 0 else False
        return {
            # 运行时状态
            "paused": self.state.paused,
            "pause_reason": self.state.pause_reason,
            "peak_equity": self.state.peak_equity,
            "consec_losses": self.state.consec_losses,
            "daily_pnl": self.state.daily_pnl,
            "total_trades": self.state.total_trades,
            "win_rate": round(wr, 2),
            # 策略级风控参数
            "strategy_risk": {
                "enabled": self.enabled,
                "max_consec_loss": self.max_consec_loss,
                "consec_losses": self.state.consec_losses,  # 当前连亏 (实时)
                "max_risk_per_trade": self.max_risk_per_trade,
                "daily_loss_limit": self.daily_loss_limit,
                "max_account_dd": self.max_account_dd,
                # 当前是否逼近/触发熔断
                "consec_triggered": consec_triggered,
                "consec_remaining": max(self.max_consec_loss - self.state.consec_losses, 0),
                "pause_reason": self.state.pause_reason,
            },
        }


if __name__ == "__main__":
    rm = RiskManager()
    print("=== 风控测试 ===")
    print(rm.status())

    # 模拟正常开仓
    ok, msg = rm.can_open_position(equity=100000, entry_price=50000, stop_price=48000, qty=0.1)
    print(f"\n正常开仓: {ok} ({msg})")

    # 模拟单笔风险超限
    ok, msg = rm.can_open_position(equity=100000, entry_price=50000, stop_price=49000, qty=1.0)
    print(f"风险超限: {ok} ({msg})")

    # 模拟连续亏损
    for i in range(4):
        rm.on_close(pnl=-500, equity=100000 - i * 500)
    print(f"\n连续亏损后: {rm.status()}")
