import { activeExchange, intervalMs, type KlineInterval } from "../exchange";
import { getBtcHome } from "../utils/paths";
import { btcVenvReady, ensureBtcAssets } from "./bootstrap";
import { runRunner } from "./python";

/**
 * 行情同步（工具 `btc_sync` 与常驻后端共用）。
 *
 * 抽出来的原因：同一套「查库内最后时间 → 增量拉取 → 分批写库」如果两份实现，
 * 迟早一边修了另一边没修 —— 而后端与手动同步写的是**同一个库**，口径必须一致。
 */

export interface SyncOptions {
  /** 要同步的周期；默认日线 + 小时线 */
  timeframes?: KlineInterval[];
  /** 缺失部分最多回补多少天（默认 1d=750、1h=60） */
  days?: number;
  /** 进度回调（工具用它推给界面，后端用它写日志） */
  log?: (line: string) => void;
}

export interface SyncResult {
  ok: boolean;
  written: number;
  report: string[];
  error?: string;
}

interface BtcStatusData {
  symbol: string;
  timeframes: Record<string, { bars: number; last_ts: number | null }>;
}

const DEFAULT_SYNC_DAYS: Record<KlineInterval, number> = {
  "1d": 750,
  "1h": 60,
};

export async function syncMarketData(
  options: SyncOptions = {},
): Promise<SyncResult> {
  const home = getBtcHome();
  const log = options.log ?? (() => undefined);
  const report: string[] = [];

  const assets = ensureBtcAssets(home);
  if (!assets.available) {
    return {
      ok: false,
      written: 0,
      report,
      error: `找不到 btc 计算资产（${assets.assetsDir}），无法写库。`,
    };
  }
  if (!btcVenvReady(home)) {
    return {
      ok: false,
      written: 0,
      report,
      error:
        "计算环境未安装（缺少 venv）。运行 `xzh btc setup` 后再同步。",
    };
  }

  const status = await runRunner<BtcStatusData>("status");
  if (!status.ok) {
    return { ok: false, written: 0, report, error: `读取库状态失败：${status.error}` };
  }
  const symbol = status.data.symbol;

  const { exchange, error: exchangeError } = activeExchange();
  if (exchangeError) {
    return { ok: false, written: 0, report, error: exchangeError };
  }

  const targets = options.timeframes ?? ["1d", "1h"];
  let totalWritten = 0;

  for (const timeframe of targets) {
    const days = options.days ?? DEFAULT_SYNC_DAYS[timeframe];
    const now = Date.now();
    const last = status.data.timeframes[timeframe]?.last_ts ?? null;
    const floor = now - days * 86_400_000;
    const startMs = last ? Math.max(last + intervalMs(timeframe), floor) : floor;
    const needed = Math.max(1, Math.ceil((now - startMs) / intervalMs(timeframe)));

    let rows;
    try {
      rows = await exchange.fetchKlines({
        symbol,
        interval: timeframe,
        startMs,
        limit: Math.min(needed, 3000),
      });
    } catch (err) {
      const message = `✗ ${timeframe}：拉取失败 —— ${
        err instanceof Error ? err.message : String(err)
      }`;
      report.push(message);
      log(message);
      continue;
    }

    if (rows.length === 0) {
      const message = `· ${timeframe}：已是最新`;
      report.push(message);
      log(message);
      continue;
    }

    let written = 0;
    let failed = false;
    for (let index = 0; index < rows.length; index += 1000) {
      const chunk = rows.slice(index, index + 1000);
      const saved = await runRunner<{ written: number }>("save", {
        symbol,
        timeframe,
        rows: chunk,
      });
      if (!saved.ok) {
        const message = `✗ ${timeframe}：写入失败 —— ${saved.error}`;
        report.push(message);
        log(message);
        failed = true;
        break;
      }
      written += saved.data.written;
    }
    if (failed) continue;

    totalWritten += written;
    const message =
      `✓ ${timeframe}：写入 ${written} 根，` +
      `${new Date(rows[0][0]).toISOString().slice(0, 16)} → ` +
      `${new Date(rows[rows.length - 1][0]).toISOString().slice(0, 16)}`;
    report.push(message);
    log(message);
  }

  return {
    ok: totalWritten > 0 || report.every((line) => !line.startsWith("✗")),
    written: totalWritten,
    report,
  };
}
