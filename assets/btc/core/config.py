#!/usr/bin/env python3
"""统一配置与密钥管理 — 从 .env / 环境变量加载。

用法:
    from core.config import settings
    print(settings.api_key)
    print(settings.symbol)

密钥通过 .env 文件或环境变量注入，避免硬编码。
.env 模板见项目根目录 .env.example。
"""
from __future__ import annotations
import os
from dataclasses import dataclass, field
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _load_env(env_path: Path | None = None):
    """轻量 .env 加载器（不依赖 python-dotenv）。"""
    path = env_path or _PROJECT_ROOT / ".env"
    if not path.exists():
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip().strip("\"'")
            if key and key not in os.environ:
                os.environ[key] = val


_load_env()


@dataclass
class Settings:
    """全局配置（可通过环境变量覆盖）。"""

    # ── 交易标的 ──
    symbol: str = field(default_factory=lambda: os.getenv("BTC_SYMBOL", "BTC/USDT"))
    timeframe: str = field(default_factory=lambda: os.getenv("BTC_TIMEFRAME", "1d"))
    leverage: int = field(default_factory=lambda: int(os.getenv("BTC_LEVERAGE", "10")))

    # ── API 密钥 (从 .env 注入，切勿硬编码) ──
    api_key: str = field(default_factory=lambda: os.getenv("BINANCE_API_KEY", ""))
    api_secret: str = field(default_factory=lambda: os.getenv("BINANCE_API_SECRET", ""))
    use_futures: bool = field(default_factory=lambda: os.getenv("BTC_USE_FUTURES", "1") == "1")

    # ── 代理 (大陆服务器访问币安需要, 留空则直连) ──
    proxy: str = field(default_factory=lambda: os.getenv("BTC_PROXY", ""))

    # ── 数据 ──
    days_back: int = field(default_factory=lambda: int(os.getenv("BTC_DAYS_BACK", "750")))
    # 回测起始日期(北京时间, YYYY-MM-DD): 回测窗口 = [该日期, 最新]; 同时决定数据同步范围
    start_date: str = field(default_factory=lambda: os.getenv("BTC_START_DATE", "2023-01-01"))
    db_path: str = field(default_factory=lambda: str(_PROJECT_ROOT / "data" / "btc.db"))
    cache_path: str = field(default_factory=lambda: str(_PROJECT_ROOT / "cache" / ".btc_daily_cache.json"))

    # ── 风控 ──
    max_account_dd: float = field(default_factory=lambda: float(os.getenv("BTC_MAX_ACCOUNT_DD", "0.50")))  # 账户级最大回撤 50%
    max_risk_per_trade: float = field(default_factory=lambda: float(os.getenv("BTC_MAX_RISK_PER_TRADE", "0.5")))  # 单笔最大风险 50%
    max_consec_loss: int = field(default_factory=lambda: int(os.getenv("BTC_MAX_CONSEC_LOSS", "3")))  # 连续亏损暂停
    daily_loss_limit: float = field(default_factory=lambda: float(os.getenv("BTC_DAILY_LOSS_LIMIT", "0.5")))  # 日内亏损上限 50%

    # ── 执行 ──
    paper_trading: bool = field(default_factory=lambda: os.getenv("BTC_PAPER_TRADING", "1") == "1")  # 默认模拟盘

    # ── 路径 ──
    project_root: str = field(default_factory=lambda: str(_PROJECT_ROOT))


settings = Settings()


if __name__ == "__main__":
    print("=== 当前配置 ===")
    for k, v in settings.__dict__.items():
        if "secret" in k.lower() or "api_key" in k.lower():
            v = "***" + v[-4:] if v else "(未设置)"
        print(f"  {k}: {v}")
