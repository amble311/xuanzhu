/**
 * 市场事件（**确定性的时点** + 波动触发），用于避免「模型把巡检定在 8 小时后，
 * 结果中间收盘/结算/暴跌全错过」。
 *
 * 分工：
 * - **模型**决定常规节奏（`btc_schedule`，10 分钟–12 小时）；
 * - **代码**兜住「不管模型怎么排，这些时刻一定会看」：
 *   1. 日线收盘后（UTC 00:00，北京 08:00）—— 三阶段信号依赖日线，收盘才算新数据；
 *   2. 资金费结算后（UTC 00/08/16，北京 08/16/00）—— 持仓成本突变、常有插针；
 *   3. 小时线整点后（**仅在有持仓/挂单时**）—— 1h 确认是第三阶段，持仓时不能不看；
 *   4. 价格剧烈波动（相对上次巡检 ≥ 阈值）—— 这是唯一依赖实时数据的判定。
 *
 * 为什么不用「把这些时点写进队列」：每天 4 条固定 + 持仓时每小时 1 条，很快把
 * 20 条上限撑爆，还和模型的计划混在一起难以解释。这里改成**到点直接触发一轮巡检**
 * （不占队列），去重靠 `run/events.json` 里记录的「上次处理时间」。
 */

import * as fs from "fs";
import * as path from "path";
import { getBtcHome } from "../utils/paths";

export type MarketEventKind =
  | "daily-close"
  | "funding"
  | "hourly-close"
  | "volatility";

export interface DueEvent {
  kind: MarketEventKind;
  /** 事件时点（毫秒时间戳）；波动触发时为当下 */
  at: number;
  reason: string;
  /**
   * 同一时刻命中的**其他**事件类型。
   *
   * 必须一起标记为已处理：UTC 00:00 同时是日线收盘与资金费结算，
   * 只记 `daily-close` 的话下一分钟 `funding` 又满足条件，会再跑一轮。
   */
  sameInstant: MarketEventKind[];
}

/** 时点过后多久内还算「刚触发」（tick 每分钟一次，给 5 分钟余量足够） */
const GRACE_MS = 5 * 60_000;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 最近的 UTC 整日收盘点（今天 00:00 UTC，若当前早于它则取昨天） */
export function lastDailyClose(now: number): number {
  return Math.floor(now / DAY) * DAY;
}

/** 最近的小时线收盘点 */
export function lastHourClose(now: number): number {
  return Math.floor(now / HOUR) * HOUR;
}

/** 最近的资金费结算点（UTC 00/08/16） */
export function lastFundingSettle(now: number): number {
  const hourUtc = Math.floor((now % DAY) / HOUR);
  const slot = hourUtc >= 16 ? 16 : hourUtc >= 8 ? 8 : 0;
  return Math.floor(now / DAY) * DAY + slot * HOUR;
}

/** 北京时间展示（事件理由给用户看，UTC 直接说 00:00 会绕） */
function beijing(ms: number): string {
  const date = new Date(ms + 8 * HOUR);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

export interface EventCheckOptions {
  /** 有持仓或挂单时才关心小时线（空白账户看每小时只是烧钱） */
  hasPosition: boolean;
  /** 上次处理过的事件时点（kind → 时间戳） */
  lastHandled: Partial<Record<MarketEventKind, number>>;
}

/**
 * 是否有「刚到点且还没处理过」的市场事件。
 *
 * 顺序即优先级：日线收盘 > 资金费 > 小时线。同一分钟命中多个时只跑一轮，
 * 用最先命中的那个作为理由（一轮巡检本来就能覆盖多个检查项）。
 */
export function dueMarketEvent(
  now: number,
  options: EventCheckOptions,
): DueEvent | null {
  const candidates: Array<{ kind: MarketEventKind; at: number; reason: string }> = [
    {
      kind: "daily-close",
      at: lastDailyClose(now),
      reason: "日线收盘后复核（三阶段依赖日线）",
    },
    {
      kind: "funding",
      at: lastFundingSettle(now),
      reason: "资金费结算后复核（持仓成本变化、常见插针）",
    },
  ];

  if (options.hasPosition) {
    candidates.push({
      kind: "hourly-close",
      at: lastHourClose(now),
      reason: "小时线收盘后复核（有持仓）",
    });
  }

  const isDue = (candidate: { kind: MarketEventKind; at: number }): boolean => {
    // 早于事件点、或过了宽限期（后端停机很久后才起来，不必补跑一堆历史时点）
    if (now < candidate.at || now - candidate.at > GRACE_MS) return false;
    return options.lastHandled[candidate.kind] !== candidate.at;
  };

  const hit = candidates.find(isDue);
  if (!hit) return null;

  return {
    ...hit,
    reason: `${hit.reason} · ${beijing(hit.at)}（北京时间）`,
    // 同一时刻的其它事件（如 00:00 的日线收盘 + 资金费）一并标记
    sameInstant: candidates
      .filter((item) => item.at === hit.at && item.kind !== hit.kind)
      .map((item) => item.kind),
  };
}

/** 波动阈值：相对上次巡检的价格变动超过它就提前看一次 */
export const DEFAULT_VOLATILITY_PCT = 2.5;
/** 波动触发的最小间隔，避免剧烈行情里每 10 分钟烧一次模型 */
export const VOLATILITY_COOLDOWN_MS = 10 * 60_000;

export interface VolatilityCheckOptions {
  /** 当前价 */
  price: number;
  /** 上次巡检记录的价（没有则视为不触发） */
  lastPrice?: number;
  /** 上次因波动触发的时间 */
  lastTriggeredAt?: number;
  now: number;
  thresholdPct?: number;
}

/** 是否该因价格波动提前巡检 */
export function volatilityDue(
  options: VolatilityCheckOptions,
): { due: boolean; changePct: number } {
  const { price, lastPrice, now } = options;
  if (!(price > 0) || !(lastPrice && lastPrice > 0)) {
    return { due: false, changePct: 0 };
  }
  const changePct = ((price - lastPrice) / lastPrice) * 100;
  if (Math.abs(changePct) < (options.thresholdPct ?? DEFAULT_VOLATILITY_PCT)) {
    return { due: false, changePct };
  }
  if (options.lastTriggeredAt && now - options.lastTriggeredAt < VOLATILITY_COOLDOWN_MS) {
    return { due: false, changePct };
  }
  return { due: true, changePct };
}

/** 事件状态（`run/events.json`）：记录已处理的时点、上次巡检价、上次波动触发时间 */
export interface EventsState {
  lastHandled?: Partial<Record<MarketEventKind, number>>;
  /** 上次巡检完成时的价格（波动比较基准） */
  lastPrice?: number;
  lastVolatilityAt?: number;
}

export function eventsStatePath(home = getBtcHome()): string {
  return path.join(home, "run", "events.json");
}

export function readEventsState(home = getBtcHome()): EventsState {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(eventsStatePath(home), "utf8"),
    ) as EventsState;
    return {
      lastHandled: parsed.lastHandled ?? {},
      lastPrice: parsed.lastPrice,
      lastVolatilityAt: parsed.lastVolatilityAt,
    };
  } catch {
    return { lastHandled: {} };
  }
}

export function writeEventsState(home: string, state: EventsState): void {
  const file = eventsStatePath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export function volatilityReason(changePct: number): string {
  const sign = changePct >= 0 ? "+" : "";
  return `价格较上次巡检 ${sign}${changePct.toFixed(2)}%，提前复核`;
}
