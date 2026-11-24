/**
 * 只保留纯判定（`decideMarketRegime`）：实时取指数 / 快照的部分已随
 * `evaluateMarketRegime` 一起删除，避免这个模块再把交易所与快照层拖进 TUI 启动。
 */

/**
 * A 股市场环境门控。
 *
 * 目的：趋势策略在弱势里最容易被反复止损；先看「指数在不在 MA20 上方 +
 * 市场广度是否健康」，不健康时**只卖不买**。
 *
 * 刻意不刷新全市场快照：宽度的数据直接读最近一次缓存（选股/快照命令会写），
 * 避免每 15 分钟巡检都触发 5000+ 请求。指数只需要 1 次日线请求。
 */

export interface MarketRegime {
  /** 是否允许开新仓 */
  riskOn: boolean;
  /** 人话原因，写进行动日志与面板 */
  reason: string;
  indexName: string;
  indexPrice?: number;
  indexMa20?: number;
  /** 上涨家数占比（0–100），无缓存时为 undefined */
  upRatio?: number;
  /** 跌停家数，无缓存时为 undefined */
  limitDown?: number;
}

const MIN_UP_RATIO = 45;
const MAX_LIMIT_DOWN = 20;

export interface RegimeBreadth {
  up: number;
  down: number;
  flat: number;
  limitDown: number;
}

/** 纯判定（可测试）：指数在 MA20 上方 + 上涨占比 ≥45% + 跌停 <20 */
export function decideMarketRegime(
  index: { name: string; price: number; ma20: number } | null,
  breadth: RegimeBreadth | null,
): MarketRegime {
  if (!index) {
    return {
      riskOn: false,
      reason: "指数数据不可用，暂停开新仓",
      indexName: "沪深300",
    };
  }

  const total = breadth ? breadth.up + breadth.down + breadth.flat : 0;
  const upRatio = breadth && total > 0 ? (breadth.up / total) * 100 : undefined;
  const limitDown = breadth?.limitDown;
  const reasons: string[] = [];

  if (index.price <= index.ma20) reasons.push(`${index.name} 跌破 MA20`);
  if (upRatio !== undefined && upRatio < MIN_UP_RATIO) {
    reasons.push(`上涨家数 ${upRatio.toFixed(0)}% < ${MIN_UP_RATIO}%`);
  }
  if (limitDown !== undefined && limitDown >= MAX_LIMIT_DOWN) {
    reasons.push(`跌停 ${limitDown} 家 ≥ ${MAX_LIMIT_DOWN}`);
  }

  return {
    riskOn: reasons.length === 0,
    reason:
      reasons.length === 0
        ? `${index.name} 在 MA20 上方` +
          (upRatio === undefined ? "" : `，上涨家数 ${upRatio.toFixed(0)}%`)
        : reasons.join("；"),
    indexName: index.name,
    indexPrice: index.price,
    indexMa20: index.ma20,
    upRatio,
    limitDown,
  };
}
