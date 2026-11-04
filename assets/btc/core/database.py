#!/usr/bin/env python3
"""SQLite3 历史数据存储 — 用于回测和策略探索。

提供:
  - K线数据存储与查询 (多币种/多周期)
  - 回测结果存储
  - 交易记录存储

用法:
    from core.database import BTCDatabase
    db = BTCDatabase()
    db.save_ohlcv(df, symbol='BTC/USDT', timeframe='1d')
    df = db.load_ohlcv(symbol='BTC/USDT', timeframe='1d', limit=750)
"""
from __future__ import annotations
import os
import sqlite3
import pandas as pd
from datetime import datetime
from zoneinfo import ZoneInfo

DB_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
DB_PATH = os.path.join(DB_DIR, "btc.db")
CACHE_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cache", ".btc_daily_cache.json")

# 回测数据固定起点 (UTC) — 与 bt_engine.DATA_START_DATE 保持一致。
# 数据同步由 xzh 的 btc_sync 负责（Node 侧拉取后调 runner.py save 写入），
# 本模块只做「按起点读库 + 校验」，不联网、不依赖任何交易所 SDK。
DATA_START_DATE = pd.Timestamp("2023-01-01", tz="UTC")

# 回测/数据同步统一的"指标预热"与"下载缓冲"天数
# 目标数据起点 = 回测起始日期 - WARMUP_DAYS; 实际下载天数再额外留 FETCH_BUFFER_DAYS 天缓冲
WARMUP_DAYS = 120
FETCH_BUFFER_DAYS = 30
DEFAULT_START_DATE = "2023-01-01"


def _to_utc_aware(ts) -> pd.Timestamp:
    """统一转 UTC tz-aware 时间戳: naive→tz_localize, aware→tz_convert。

    pandas 对已带时区的 Timestamp 再次 tz_localize 会抛 TypeError
    ("Cannot localize tz-aware Timestamp"), 故先判断 tzinfo 再选择转换方式。
    """
    ts = pd.Timestamp(ts)
    if ts.tzinfo is None:
        return ts.tz_localize("UTC")
    return ts.tz_convert("UTC")


def _cn_date_str(ts) -> str:
    """把时间戳按【北京时间】格式化为 YYYY-MM-DD, 仅用于日志/展示。

    内部时间一律以 UTC 存储(北京 00:00 = UTC 前一天 16:00)。若日志直接用
    `ts.date()` 取的是 UTC 日期, 会比用户配置的北京日期早一天(如配置
    2023-01-01 却打印 2022-12-31), 造成"起点与配置不一致"的误解。
    """
    return str(_to_utc_aware(ts).tz_convert("Asia/Shanghai").date())


def _resolve_target_start(days_back: int | None = None,
                          start_date: str | pd.Timestamp | None = None) -> pd.Timestamp:
    """统一计算"目标数据起点"(UTC tz-aware)。

    - 提供 start_date(回测起始日期): 目标起点 = start_date（北京时间）
    - 提供 days_back(旧口径): 目标起点 = now - days_back - WARMUP_DAYS 天
    - 都未提供: 回退固定起点 DATA_START_DATE
    """
    from datetime import datetime as _dt
    # start_date 优先 (新口径)
    if start_date:
        try:
            ts = pd.Timestamp(start_date)
            if ts.tzinfo is None:
                # 视为北京时间(与数据库加载的 ts 口径一致), 再转 UTC
                ts = ts.tz_localize("Asia/Shanghai")
            ts = ts.tz_convert("UTC")
            return ts
        except Exception:
            pass
    if days_back and int(days_back) > 0:
        now = pd.Timestamp(_dt.now(tz=ZoneInfo("UTC")))
        return now - pd.Timedelta(days=int(days_back) + WARMUP_DAYS)
    return _to_utc_aware(DATA_START_DATE)


def _days_needed_to_cover(target_start: pd.Timestamp, min_bars: int = 730) -> int:
    """从"目标数据起点"到当前, 需要下载的天数(含缓冲), 至少覆盖 min_bars 根。"""
    from datetime import datetime as _dt
    now = pd.Timestamp(_dt.now(tz=ZoneInfo("UTC")))
    days = (now - _to_utc_aware(target_start)).days + FETCH_BUFFER_DAYS
    return int(max(days, int(min_bars)))


class BTCDatabase:
    """BTC历史数据SQLite3存储。"""

    def __init__(self, db_path: str = DB_PATH):
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self.db_path = db_path
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._init_tables()
        self._migrate()

    def _migrate(self):
        """数据库迁移：处理旧表缺少新列的情况。"""
        for col, col_type in [("user_id", "INTEGER DEFAULT 0"), ("strategy", "TEXT DEFAULT ''")]:
            try:
                self.conn.execute(f"SELECT {col} FROM executor_trades LIMIT 0")
            except sqlite3.OperationalError:
                self.conn.execute(f"ALTER TABLE executor_trades ADD COLUMN {col} {col_type}")
                self.conn.commit()

    def _init_tables(self):
        """初始化数据表。"""
        self.conn.executescript("""
            -- K线数据表
            CREATE TABLE IF NOT EXISTS ohlcv (
                symbol     TEXT NOT NULL,
                timeframe  TEXT NOT NULL,
                ts         INTEGER NOT NULL,  -- 毫秒时间戳
                open       REAL,
                high       REAL,
                low        REAL,
                close      REAL,
                volume     REAL,
                PRIMARY KEY (symbol, timeframe, ts)
            );

            -- 回测结果表
            CREATE TABLE IF NOT EXISTS backtest_results (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                strategy    TEXT,
                params      TEXT,    -- JSON
                costs       TEXT,    -- JSON
                n_trades    INTEGER,
                win_rate    REAL,
                signal_rate REAL,
                return_pct  REAL,
                max_dd      REAL,
                pl_ratio    REAL,
                sharpe      REAL,
                created_at  TEXT DEFAULT (datetime('now'))
            );

            -- 交易记录表
            CREATE TABLE IF NOT EXISTS trades (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                strategy    TEXT,
                entry_date  TEXT,
                exit_date   TEXT,
                side        TEXT,
                entry_price REAL,
                exit_price  REAL,
                pnl         REAL,
                win         INTEGER,
                holding_days INTEGER,
                reason      TEXT,
                created_at  TEXT DEFAULT (datetime('now'))
            );

            -- 执行器交易日志表 (持久化, 不随项目退出清空)
            CREATE TABLE IF NOT EXISTS executor_trades (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     INTEGER DEFAULT 0,  -- 用户ID, 0=旧数据
                mode        TEXT NOT NULL,   -- 'paper' 或 'live'
                ts          TEXT NOT NULL,
                action      TEXT NOT NULL,   -- OPEN / CLOSE
                side        TEXT,
                price       REAL,
                qty         REAL,
                pnl         REAL,
                reason      TEXT,
                strategy    TEXT,
                created_at  TEXT DEFAULT (datetime('now'))
            );

            -- 用户表
            CREATE TABLE IF NOT EXISTS users (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                username          TEXT UNIQUE NOT NULL,
                password_hash     TEXT NOT NULL,
                created_at        TEXT DEFAULT (datetime('now'))
            );

            -- 用户API密钥表
            CREATE TABLE IF NOT EXISTS user_api_keys (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     INTEGER NOT NULL,
                exchange    TEXT NOT NULL DEFAULT 'binance',
                api_key     TEXT NOT NULL,
                api_secret  TEXT NOT NULL,
                proxy       TEXT DEFAULT '',
                created_at  TEXT DEFAULT (datetime('now')),
                updated_at  TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            -- 用户上传策略表
            CREATE TABLE IF NOT EXISTS user_strategies (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id       INTEGER NOT NULL,
                name          TEXT NOT NULL,
                display_name  TEXT DEFAULT '',
                description   TEXT DEFAULT '',
                file_content  TEXT NOT NULL,
                is_active     INTEGER DEFAULT 1,
                created_at    TEXT DEFAULT (datetime('now')),
                updated_at    TEXT DEFAULT (datetime('now')),
                UNIQUE(user_id, name),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            -- 用户交易/风控设置表 (每用户自主配置, 覆盖全局默认)
            -- 账户级风控与策略风控(策略源码 risk_control)同时生效;
            -- 用户可将 risk_enabled 置 0, 关闭账户级风控, 全权交给策略风控。
            CREATE TABLE IF NOT EXISTS user_settings (
                user_id           INTEGER PRIMARY KEY,
                risk_enabled      INTEGER DEFAULT 1,   -- 是否启用账户级风控 (1=启用 0=关闭, 全权交给策略)
                max_account_dd    REAL    DEFAULT 0.50, -- 账户最大回撤止损
                max_risk_per_trade REAL   DEFAULT 0.50, -- 单笔风险上限
                max_consec_loss   INTEGER DEFAULT 3,    -- 连续亏损暂停次数
                daily_loss_limit  REAL    DEFAULT 0.50, -- 日内亏损熔断
                symbol            TEXT    DEFAULT 'BTC/USDT',
                timeframe         TEXT    DEFAULT '1d',
                leverage          INTEGER DEFAULT 10,
                days_back         INTEGER DEFAULT 750,   -- (旧) 数据回看天数, 已由 start_date 取代, 保留兼容
                start_date        TEXT    DEFAULT '2023-01-01', -- 回测起始日期(北京时间 YYYY-MM-DD)
                updated_at        TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
        """)
        self.conn.commit()
        self._migrate_tables()

    def _migrate_tables(self):
        """轻量迁移: 为旧库补充新增列(不删表, 保证兼容)。

        注意: 不再把空的 start_date 强制回填为默认日期。原实现会让"未设置"与
        "设置为默认日期"无法区分, 用户清空该字段后会被悄悄改回 2023-01-01。
        空值在 get_effective_settings() 中会自然回退到全局 settings.start_date。
        """
        try:
            self.conn.execute("SELECT start_date FROM user_settings LIMIT 0")
        except sqlite3.OperationalError:
            self.conn.execute(
                f"ALTER TABLE user_settings ADD COLUMN start_date TEXT DEFAULT '{DEFAULT_START_DATE}'")
        self.conn.commit()
        self._ensure_ohlcv_unique()

    def _ensure_ohlcv_unique(self):
        """确保 ohlcv 表存在 (symbol, timeframe, ts) 唯一性约束。

        🔴 历史事故 (2026-09-13 定位): 旧版本创建的 ohlcv 表**没有主键**,
        而 `CREATE TABLE IF NOT EXISTS` 不会修改已存在的表, 因此:
          1) `INSERT OR REPLACE` 在没有唯一约束时**退化为普通 INSERT**
             → 每次增量同步(覆盖最近 2 天)都会追加重复行;
          2) 重复的时间戳使查询结果出现同一天多根K线 → 图表上"数据混杂/错乱"。
        此处检测并原地修复: 先去重(同键只保留最后写入的一条), 再补建唯一索引。
        """
        try:
            row = self.conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='ohlcv'"
            ).fetchone()
            if row is None:
                return
            table_sql = (row[0] or "").upper()
            has_pk = "PRIMARY KEY" in table_sql
            has_uniq_idx = self.conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='index' AND tbl_name='ohlcv' "
                "AND sql LIKE '%UNIQUE%' LIMIT 1"
            ).fetchone() is not None
            if has_pk or has_uniq_idx:
                return  # 结构正确
            # 去重: 同 (symbol, timeframe, ts) 仅保留 rowid 最大(最后写入)的一条
            dup = self.conn.execute(
                "SELECT COUNT(*) FROM (SELECT 1 FROM ohlcv GROUP BY symbol, timeframe, ts "
                "HAVING COUNT(*) > 1)"
            ).fetchone()[0]
            before = self.conn.execute("SELECT COUNT(*) FROM ohlcv").fetchone()[0]
            self.conn.execute(
                "DELETE FROM ohlcv WHERE rowid NOT IN "
                "(SELECT MAX(rowid) FROM ohlcv GROUP BY symbol, timeframe, ts)"
            )
            self.conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_ohlcv_symbol_tf_ts "
                "ON ohlcv(symbol, timeframe, ts)"
            )
            self.conn.commit()
            after = self.conn.execute("SELECT COUNT(*) FROM ohlcv").fetchone()[0]
            print(f"  ⚠️ 检测到 ohlcv 表缺少唯一约束(旧库结构), 已补建唯一索引并去重: "
                  f"{before} → {after} 行 (移除 {before - after} 条重复, 重复键 {dup} 组)")
        except Exception as e:
            print(f"  ⚠️ ohlcv 唯一约束校验失败: {e}")

    # ─────────────── K线数据 ───────────────
    def save_ohlcv(self, df: pd.DataFrame, symbol: str = "BTC/USDT", timeframe: str = "1d"):
        """保存K线数据 (覆盖式写入)。"""
        # 转换时间戳为毫秒
        if "ts" in df.columns:
            if pd.api.types.is_datetime64_any_dtype(df["ts"]):
                # 统一转纳秒再除以10^6, 兼容 datetime64[ns] 和 datetime64[ms]
                # 如果是时区感知的 datetime，先转换为 UTC 再转毫秒
                ts = df["ts"]
                if ts.dt.tz is not None:
                    # 有时区信息：先转换为 UTC，再转毫秒
                    ts = ts.dt.tz_convert("UTC").dt.tz_localize(None)
                ts_ms = ts.astype("datetime64[ns]").astype("int64") // 10**6
            else:
                ts_ms = df["ts"].astype("int64")
        else:
            raise ValueError("DataFrame需包含 'ts' 列")

        # 重置索引: 过滤后的 df 保留原标签索引, 直接用 iloc[_] 会越界
        df = df.reset_index(drop=True)
        ts_ms = ts_ms.reset_index(drop=True)

        # ── 时间戳对齐校验 (写入前拦截整体时区偏移) ──
        self._warn_if_ts_unaligned(ts_ms, symbol, timeframe)

        records = []
        for i in range(len(df)):
            row = df.iloc[i]
            records.append((
                symbol, timeframe, int(ts_ms.iloc[i]),
                float(row.get("open", row.get("o", 0))),
                float(row.get("high", row.get("h", 0))),
                float(row.get("low", row.get("l", 0))),
                float(row.get("close", row.get("c", 0))),
                float(row.get("volume", row.get("v", 0))),
            ))

        self.conn.executemany(
            "INSERT OR REPLACE INTO ohlcv VALUES (?,?,?,?,?,?,?,?)",
            records,
        )
        self.conn.commit()
        return len(records)

    def _warn_if_ts_unaligned(self, ts_ms: pd.Series, symbol: str, timeframe: str):
        """校验K线时间戳是否对齐周期边界; 未对齐则告警 (不自动修改)。

        历史事故 (2026-09-13 定位并修复):
          曾有代码把「北京墙上时间的 naive ts」当作 UTC 写入数据库, 使 885 条 1d 数据
          整体 +8 小时 (北京 16:00 而非 08:00), 造成日期错位与图表上"年份混杂"。
          此处主动校验, 避免再次静默写入错误数据。
        注: 1w 不对齐 Unix epoch (币安周线从周一 00:00 UTC 起), 故跳过检查。
        """
        if timeframe == "1w":
            return
        unit = self._timeframe_to_ms(timeframe)
        if unit <= 0 or len(ts_ms) == 0:
            return
        try:
            mask = (ts_ms % unit) != 0
            n_bad = int(mask.sum())
            if n_bad:
                off_h = float((ts_ms[mask].iloc[0] % unit)) / 3_600_000
                print(f"  ⚠️ 时间戳未对齐告警: {symbol} {timeframe} 有 {n_bad}/{len(ts_ms)} 条"
                      f"未对齐周期边界 (偏移 {off_h:+.1f} 小时)。疑似时区处理错误, "
                      f"可调用 db.fix_ts_alignment() 修正。")
        except Exception:
            pass  # 校验失败不影响写入

    def fix_ts_alignment(self, symbol: str = "BTC/USDT", timeframe: str = "1d",
                         offset_ms: int | None = None) -> int:
        """修正因时区处理错误而整体偏移的K线时间戳 (返回修正条数)。

        offset_ms: 需减去的偏移(毫秒); None 时按周期边界自动推断
          (对各未对齐记录的余数向下取整)。仅适用于"整体 +偏移"的情形
          (如本项目的 +8h 事故), 且存在时间戳冲突时拒绝执行。
        """
        unit = self._timeframe_to_ms(timeframe)
        rows = self.conn.execute(
            "SELECT ts FROM ohlcv WHERE symbol=? AND timeframe=?", (symbol, timeframe)
        ).fetchall()
        bad = [r["ts"] for r in rows if (r["ts"] % unit) != 0]
        if not bad:
            print(f"  {symbol} {timeframe} 时间戳均已对齐, 无需修正")
            return 0
        if offset_ms is None:
            offsets = {t % unit for t in bad}
            if len(offsets) != 1:
                print(f"  ⚠️ 偏移量不一致 {sorted(offsets)}, 拒绝自动修正")
                return 0
            offset_ms = offsets.pop()
        existing = {r["ts"] for r in rows}
        conflict = {t - offset_ms for t in bad} & (existing - set(bad))
        if conflict:
            print(f"  ⚠️ 修正后与现有 {len(conflict)} 条时间戳冲突, 拒绝自动修正")
            return 0
        cur = self.conn.execute(
            "UPDATE ohlcv SET ts = ts - ? WHERE symbol=? AND timeframe=? AND (ts % ?) != 0",
            (offset_ms, symbol, timeframe, unit),
        )
        self.conn.commit()
        print(f"  已修正 {cur.rowcount} 条 {symbol} {timeframe} 时间戳 (偏移 {-offset_ms/3_600_000:+.1f}h)")
        return cur.rowcount

    def _warn_if_incomplete(self, symbol: str, timeframe: str, target_start) -> None:
        """全量同步后校验数据完整性 (对齐/连续性/条数), 异常时告警。

        背景: 分批拉取若提前退出会造成历史数据不完整; 而后续增量同步只覆盖
        最近几根, 缺口**永远不会被自动补齐**。故此处主动校验, 尽早暴露问题。
        """
        try:
            rows = self.conn.execute(
                "SELECT ts FROM ohlcv WHERE symbol=? AND timeframe=? ORDER BY ts ASC",
                (symbol, timeframe)).fetchall()
            if len(rows) < 30:
                return
            ts = pd.Series([r[0] for r in rows])
            unit = self._timeframe_to_ms(timeframe)
            unaligned = int((ts % unit != 0).sum())
            diffs = ts.diff().dropna()
            gaps = int((diffs > unit * 1.5).sum())
            now_ms = pd.Timestamp.now(tz="UTC").timestamp() * 1000
            expected = int((now_ms - target_start.timestamp() * 1000) // unit)
            msgs = []
            if unaligned:
                msgs.append(f"{unaligned} 条时间戳未对齐周期边界(疑似时区处理错误)")
            if gaps:
                msgs.append(f"{gaps} 处时间缺口(>1.5个周期)")
            if expected > 0 and len(rows) < expected * 0.9:
                msgs.append(f"条数 {len(rows)} 明显少于预期 ~{expected}(数据不完整)")
            if msgs:
                print(f"  ⚠️ 数据完整性校验未通过: {'; '.join(msgs)}")
        except Exception:
            pass  # 校验失败不影响主流程

    def load_ohlcv(self, symbol: str = "BTC/USDT", timeframe: str = "1d",
                   limit: int = 0, start_ts: int = 0, end_ts: int = 0) -> pd.DataFrame:
        """加载K线数据。

        Args:
            limit: 返回最后N条 (0=全部)
            start_ts: 起始时间戳(毫秒), 0=不限
            end_ts: 结束时间戳(毫秒), 0=不限
        """
        sql = "SELECT ts, open, high, low, close, volume FROM ohlcv WHERE symbol=? AND timeframe=?"
        params = [symbol, timeframe]
        if start_ts:
            sql += " AND ts >= ?"
            params.append(start_ts)
        if end_ts:
            sql += " AND ts <= ?"
            params.append(end_ts)
        if limit > 0:
            # 返回最新N条 (ASC排序): 子查询 DESC 取最新, 外层 ASC 排序
            sql = f"SELECT * FROM ({sql} ORDER BY ts DESC LIMIT {limit}) sub ORDER BY ts ASC"
        else:
            sql += " ORDER BY ts ASC"

        rows = self.conn.execute(sql, params).fetchall()
        if not rows:
            return pd.DataFrame(columns=["ts", "open", "high", "low", "close", "volume"])

        df = pd.DataFrame([dict(r) for r in rows])
        # 币安原始时间戳为 UTC 毫秒，转为北京时间 (UTC+8)
        df["ts"] = pd.to_datetime(df["ts"], unit="ms").dt.tz_localize("UTC").dt.tz_convert("Asia/Shanghai")
        # 防御性去重: 旧库可能因缺少唯一约束产生重复行 (见 _ensure_ohlcv_unique),
        # 这里再兜底一次, 保证下游(指标/回测/图表)拿到的时间戳唯一且有序。
        df = df.drop_duplicates(subset=["ts"], keep="last").sort_values("ts").reset_index(drop=True)
        return df

    def get_ohlcv_count(self, symbol: str = "BTC/USDT", timeframe: str = "1d") -> int:
        """获取K线数据条数。"""
        row = self.conn.execute(
            "SELECT COUNT(*) as cnt FROM ohlcv WHERE symbol=? AND timeframe=?",
            (symbol, timeframe),
        ).fetchone()
        return row["cnt"] if row else 0

    def get_last_ts(self, symbol: str = "BTC/USDT", timeframe: str = "1d") -> int:
        """获取最新一条K线的时间戳(毫秒)。"""
        row = self.conn.execute(
            "SELECT MAX(ts) as ts FROM ohlcv WHERE symbol=? AND timeframe=?",
            (symbol, timeframe),
        ).fetchone()
        return row["ts"] if row and row["ts"] else 0

    # ─────────────── 数据质量校验 ───────────────
    def validate_ohlcv(self, symbol: str = "BTC/USDT",
                       timeframe: str = "1d") -> dict:
        """校验K线数据质量, 返回问题报告。

        检查项:
          1. OHLC 逻辑关系 (high >= max(o,c) >= min(o,c) >= low)
          2. 时间序列连续性 (缺失日期检测)
          3. 异常值 (收盘价偏离前日 > 30%)
          4. 零值/负值检测
        """
        from core.logger import get_logger
        log = get_logger("database")

        df = self.load_ohlcv(symbol, timeframe)
        n = len(df)
        report = {
            "symbol": symbol, "timeframe": timeframe, "total_rows": n,
            "issues": [], "ok": True,
        }
        if n == 0:
            report["issues"].append("无数据")
            report["ok"] = False
            return report

        # 1. OHLC 逻辑关系
        bad_ohlc = df[(df["high"] < df[["open", "close"]].max(axis=1)) |
                      (df["low"] > df[["open", "close"]].min(axis=1)) |
                      (df["high"] < df["low"])]
        if len(bad_ohlc) > 0:
            report["issues"].append(f"OHLC逻辑错误: {len(bad_ohlc)}条 (high<max(o,c) 或 low>min(o,c))")
            report["ok"] = False

        # 2. 时间连续性 (日线: 间隔应约1天, 允许周末跳空)
        ts_diff = df["ts"].diff().dropna()
        if timeframe == "1d":
            # 正常1天, 允许2-3天间隔(周末/假日), >4天算缺口
            gaps = ts_diff[ts_diff > pd.Timedelta(days=4)]
        else:
            gaps = pd.Series(dtype=float)
        if len(gaps) > 0:
            report["issues"].append(f"时间缺口: {len(gaps)}处 (>4天间隔)")
            report["ok"] = False

        # 3. 异常波动 (收盘价日变化 > 30%)
        ret = df["close"].pct_change().abs()
        outliers = ret[ret > 0.30]
        if len(outliers) > 0:
            report["issues"].append(f"异常波动: {len(outliers)}条 (日变化>30%)")
            report["ok"] = False

        # 4. 零值/负值
        bad_vals = df[(df["open"] <= 0) | (df["high"] <= 0) |
                      (df["low"] <= 0) | (df["close"] <= 0)]
        if len(bad_vals) > 0:
            report["issues"].append(f"零值/负值: {len(bad_vals)}条")
            report["ok"] = False

        # 5. 重复时间戳
        dup_ts = df["ts"].duplicated().sum()
        if dup_ts > 0:
            report["issues"].append(f"重复时间戳: {dup_ts}条")
            report["ok"] = False

        if report["ok"]:
            log.info(f"数据校验通过: {symbol} {timeframe} ({n}条)")
        else:
            log.warning(f"数据校验发现问题: {symbol} {timeframe} | " + "; ".join(report["issues"]))
        return report

    # ─────────────── 回测结果 ───────────────
    def save_backtest(self, strategy: str, params: dict, costs: dict, metrics: dict):
        """保存回测结果。"""
        import json
        self.conn.execute(
            """INSERT INTO backtest_results
               (strategy, params, costs, n_trades, win_rate, signal_rate,
                return_pct, max_dd, pl_ratio, sharpe)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (strategy, json.dumps(params), json.dumps(costs),
             metrics.get("n_trades", 0), metrics.get("win_rate", 0),
             metrics.get("signal_rate", 0), metrics.get("return_pct", 0),
             metrics.get("max_drawdown_pct", 0), metrics.get("pl_ratio", 0),
             metrics.get("sharpe", 0)),
        )
        self.conn.commit()

    def save_trades(self, strategy: str, trades: list):
        """保存交易记录。"""
        for t in trades:
            self.conn.execute(
                """INSERT INTO trades
                   (strategy, entry_date, exit_date, side, entry_price, exit_price,
                    pnl, win, holding_days, reason)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (strategy, t.get("entry_date", ""), t.get("exit_date", ""),
                 t.get("side", ""), t.get("entry", 0), t.get("exit", 0),
                 t.get("pnl", 0), int(t.get("win", False)),
                 t.get("holding_days", 0), t.get("reason", "")),
            )
        self.conn.commit()

    # ─────────────── 数据同步 ───────────────
    @staticmethod
    def _timeframe_to_ms(timeframe: str) -> int:
        """timeframe 字符串转毫秒数 (如 '1d'→86400000, '1h'→3600000)。"""
        units = {"m": 60_000, "h": 3_600_000, "d": 86_400_000, "w": 604_800_000}
        if len(timeframe) >= 2 and timeframe[-1] in units:
            try:
                return int(timeframe[:-1]) * units[timeframe[-1]]
            except ValueError:
                pass
        return 86_400_000  # 默认1天

    # ─────────────── 执行器交易日志 (持久化) ───────────────
    def save_trade_log(self, mode: str, entry: dict, strategy: str = "", user_id: int = 0):
        """保存一条执行器交易日志到数据库。"""
        self.conn.execute(
            """INSERT INTO executor_trades
               (user_id, mode, ts, action, side, price, qty, pnl, reason, strategy)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (user_id, mode, entry.get("ts", ""), entry.get("action", ""),
             entry.get("side", ""), float(entry.get("price", 0)),
             float(entry.get("qty", 0)), float(entry.get("pnl", 0)),
             entry.get("reason", ""), strategy),
        )
        self.conn.commit()

    def load_trade_logs(self, mode: str, user_id: int = 0, limit: int = 200) -> list:
        """加载指定用户和模式的交易日志 (按 id DESC, 即最新在前)。"""
        rows = self.conn.execute(
            "SELECT ts, action, side, price, qty, pnl, reason FROM executor_trades "
            "WHERE mode=? AND user_id=? ORDER BY id DESC LIMIT ?",
            (mode, user_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]

    def clear_trade_logs(self, mode: str, user_id: int = 0):
        """清除指定用户和模式的交易日志。"""
        self.conn.execute(
            "DELETE FROM executor_trades WHERE mode=? AND user_id=?",
            (mode, user_id),
        )
        self.conn.commit()

    def clear_all_ohlcv(self, symbol: str, timeframe: str):
        """清除指定币种和周期的所有K线历史数据。"""
        self.conn.execute(
            "DELETE FROM ohlcv WHERE symbol=? AND timeframe=?",
            (symbol, timeframe),
        )
        self.conn.commit()

    # ─────────────── 用户管理 ───────────────
    def create_user(self, username: str, password_hash: str) -> int:
        """创建用户，返回用户ID。"""
        try:
            cur = self.conn.execute(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                (username, password_hash),
            )
            self.conn.commit()
            return cur.lastrowid
        except sqlite3.IntegrityError:
            raise ValueError(f"用户名 '{username}' 已存在")

    def get_user_by_username(self, username: str) -> dict | None:
        """通过用户名获取用户信息。"""
        row = self.conn.execute(
            "SELECT id, username, password_hash, created_at FROM users WHERE username=?",
            (username,),
        ).fetchone()
        return dict(row) if row else None

    def get_user_by_id(self, user_id: int) -> dict | None:
        """通过用户ID获取用户信息。"""
        row = self.conn.execute(
            "SELECT id, username, created_at FROM users WHERE id=?",
            (user_id,),
        ).fetchone()
        return dict(row) if row else None

    def update_password(self, user_id: int, password_hash: str):
        """更新用户密码。"""
        self.conn.execute(
            "UPDATE users SET password_hash=? WHERE id=?",
            (password_hash, user_id),
        )
        self.conn.commit()

    # ─────────────── API密钥管理 (加密存储) ───────────────
    def save_api_key(self, user_id: int, api_key: str, api_secret: str,
                     exchange: str = "binance", proxy: str = "") -> int:
        """保存或更新用户API密钥 (自动加密存储)。"""
        from core.crypto import encrypt
        enc_key = encrypt(api_key)
        enc_secret = encrypt(api_secret)
        existing = self.conn.execute(
            "SELECT id FROM user_api_keys WHERE user_id=? AND exchange=?",
            (user_id, exchange),
        ).fetchone()
        if existing:
            self.conn.execute(
                "UPDATE user_api_keys SET api_key=?, api_secret=?, proxy=?, updated_at=datetime('now') WHERE id=?",
                (enc_key, enc_secret, proxy, existing["id"]),
            )
            self.conn.commit()
            return existing["id"]
        else:
            cur = self.conn.execute(
                "INSERT INTO user_api_keys (user_id, exchange, api_key, api_secret, proxy) VALUES (?,?,?,?,?)",
                (user_id, exchange, enc_key, enc_secret, proxy),
            )
            self.conn.commit()
            return cur.lastrowid

    def get_api_key(self, user_id: int, exchange: str = "binance") -> dict | None:
        """获取用户指定交易所的API密钥 (自动解密)。"""
        from core.crypto import decrypt
        row = self.conn.execute(
            "SELECT api_key, api_secret, proxy FROM user_api_keys WHERE user_id=? AND exchange=?",
            (user_id, exchange),
        ).fetchone()
        if not row:
            return None
        return {
            "api_key": decrypt(row["api_key"]),
            "api_secret": decrypt(row["api_secret"]),
            "proxy": row["proxy"],
        }

    def delete_api_key(self, user_id: int, exchange: str = "binance"):
        """删除用户API密钥。"""
        self.conn.execute(
            "DELETE FROM user_api_keys WHERE user_id=? AND exchange=?",
            (user_id, exchange),
        )
        self.conn.commit()

    # ─────────────── 用户交易/风控设置 ───────────────
    DEFAULT_SETTINGS = {
        "risk_enabled": 1,
        "max_account_dd": 0.50,
        "max_risk_per_trade": 0.50,
        "max_consec_loss": 3,
        "daily_loss_limit": 0.50,
        "symbol": "BTC/USDT",
        "timeframe": "1d",
        "leverage": 10,
        "days_back": 750,
        "start_date": DEFAULT_START_DATE,
    }

    def get_user_settings(self, user_id: int) -> dict:
        """获取用户设置, 未配置时返回全局默认值。"""
        row = self.conn.execute(
            "SELECT risk_enabled, max_account_dd, max_risk_per_trade, max_consec_loss,"
            " daily_loss_limit, symbol, timeframe, leverage, days_back, start_date"
            " FROM user_settings WHERE user_id=?",
            (user_id,),
        ).fetchone()
        if row:
            return dict(row)
        # 未配置: 返回默认值 (None 代表走全局 settings, 见 get_effective_settings)
        return dict(self.DEFAULT_SETTINGS)

    def save_user_settings(self, user_id: int, data: dict):
        """保存用户设置 (仅更新提供的字段, 其余保持原值)。"""
        fields = ["risk_enabled", "max_account_dd", "max_risk_per_trade",
                  "max_consec_loss", "daily_loss_limit", "symbol",
                  "timeframe", "leverage", "days_back", "start_date"]
        # 构造 INSERT ... ON CONFLICT DO UPDATE 动态列
        cols = [f for f in fields if f in data]
        if not cols:
            return
        placeholders = ", ".join(["?"] * len(cols))
        updates = ", ".join([f"{c}=excluded.{c}" for c in cols])
        sql = (f"INSERT INTO user_settings (user_id, {', '.join(cols)})"
               f" VALUES (?, {placeholders})"
               f" ON CONFLICT(user_id) DO UPDATE SET {updates}, updated_at=datetime('now')")
        self.conn.execute(sql, [user_id] + [data[c] for c in cols])
        self.conn.commit()

    def get_effective_settings(self, user_id: int, global_settings: dict) -> dict:
        """合并用户设置与全局设置, 返回该用户实际生效的参数。
        global_settings 需含: symbol, timeframe, leverage, days_back, start_date,
        max_account_dd, max_risk_per_trade, max_consec_loss, daily_loss_limit。
        用户未配置的字段回退到全局设置。
        """
        row = self.conn.execute(
            "SELECT risk_enabled, max_account_dd, max_risk_per_trade, max_consec_loss,"
            " daily_loss_limit, symbol, timeframe, leverage, days_back, start_date"
            " FROM user_settings WHERE user_id=?",
            (user_id,),
        ).fetchone()
        if not row:
            # 无用户记录: 全部用全局默认, 账户级风控默认启用
            out = dict(global_settings)
            out["risk_enabled"] = 1
            out.setdefault("start_date", DEFAULT_START_DATE)
            return out
        d = dict(row)
        eff = {
            "risk_enabled": d["risk_enabled"],
            "symbol": d["symbol"] or global_settings["symbol"],
            "timeframe": d["timeframe"] or global_settings["timeframe"],
            "leverage": d["leverage"] or global_settings["leverage"],
            "days_back": d["days_back"] or global_settings["days_back"],
            "start_date": d.get("start_date") or global_settings.get("start_date") or DEFAULT_START_DATE,
            "max_account_dd": d["max_account_dd"] or global_settings["max_account_dd"],
            "max_risk_per_trade": d["max_risk_per_trade"] or global_settings["max_risk_per_trade"],
            "max_consec_loss": d["max_consec_loss"] or global_settings["max_consec_loss"],
            "daily_loss_limit": d["daily_loss_limit"] or global_settings["daily_loss_limit"],
        }
        return eff

    # ─────────────── 用户策略管理 ───────────────
    def save_user_strategy(self, user_id: int, name: str, file_content: str,
                           display_name: str = "", description: str = "") -> int:
        """保存用户上传的策略文件内容。"""
        existing = self.conn.execute(
            "SELECT id FROM user_strategies WHERE user_id=? AND name=?",
            (user_id, name),
        ).fetchone()
        if existing:
            self.conn.execute(
                """UPDATE user_strategies SET file_content=?, display_name=?, description=?,
                   is_active=1, updated_at=datetime('now') WHERE id=?""",
                (file_content, display_name, description, existing["id"]),
            )
            self.conn.commit()
            return existing["id"]
        else:
            cur = self.conn.execute(
                """INSERT INTO user_strategies (user_id, name, display_name, description, file_content)
                   VALUES (?,?,?,?,?)""",
                (user_id, name, display_name, description, file_content),
            )
            self.conn.commit()
            return cur.lastrowid

    def get_user_strategy(self, user_id: int, name: str) -> dict | None:
        """获取用户指定策略。"""
        row = self.conn.execute(
            "SELECT id, name, display_name, description, file_content, created_at FROM user_strategies WHERE user_id=? AND name=? AND is_active=1",
            (user_id, name),
        ).fetchone()
        return dict(row) if row else None

    def list_user_strategies(self, user_id: int) -> list[dict]:
        """列出用户所有策略。"""
        rows = self.conn.execute(
            "SELECT id, name, display_name, description, created_at FROM user_strategies WHERE user_id=? AND is_active=1 ORDER BY created_at DESC",
            (user_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def delete_user_strategy(self, user_id: int, name: str):
        """软删除用户策略。"""
        self.conn.execute(
            "UPDATE user_strategies SET is_active=0 WHERE user_id=? AND name=?",
            (user_id, name),
        )
        self.conn.commit()

    def _remove_json_cache(self):
        """删除过期的JSON缓存文件。"""
        try:
            if os.path.exists(CACHE_FILE):
                os.remove(CACHE_FILE)
                print(f"  已删除过期JSON缓存: {CACHE_FILE}")
        except Exception as e:
            pass  # 删除失败不影响主流程

    def close(self):
        self.conn.close()

    def __del__(self):
        try:
            self.conn.close()
        except Exception:
            pass


if __name__ == "__main__":
    db = BTCDatabase()
    count = db.get_ohlcv_count("BTC/USDT", "1d")
    print(f"数据库: {db.db_path}")
    print(f"BTC/USDT 1d K线数: {count}")
    if count > 0:
        df = db.load_ohlcv("BTC/USDT", "1d", limit=5)
        print(f"最新5条:\n{df}")
    db.close()
