import { ProxyAgent, fetch as undiciFetch } from "undici";
import { fetchBars, readCache, writeCache, type Bar } from "../exchange/ashare";
import type { WatchItem } from "./watchlist";

/**
 * 消息面微调（只作用于最终入选的 5 只，不参与选股漏斗）。
 *
 * 设计原则：
 * - **公告优先**（东财公告接口，权威、可追溯），不做泛媒体情绪；
 * - 硬风险直接否决（立案、退市、业绩暴雷、大额减持等），不参与打分；
 * - 其余按「消息 + 价格反应」微调 ±10：
 *   - 近 5 日利空且股价未收复 → -10；
 *   - 近 5 日利空但已收复 → +5（利空不跌）；
 *   - 近 5 日利好但已上涨兑付 → -5（发套），未反应 → -2；
 *   - 老利空（>60 日）且已收复 → +2；
 *   - 无公告 → +2（干净）。
 *
 * 可用 `XZH_A_NEWS=off` 关闭整层。
 */

export interface Announcement {
  /** `YYYY-MM-DD` */
  date: string;
  title: string;
}

export interface NewsAdjustment {
  veto: boolean;
  delta: number;
  reason: string;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_DAYS = 180;

/** 例行披露：标题里出现这些词不代表风险，先判中性 */
const ROUTINE: RegExp[] = [
  /汇总表/,
  /专项制度/,
  /防范.*资金占用/,
  /专项说明/,
  /专项报告/,
  /业绩说明会/,
  /投资者关系活动/,
  /董事会决议/,
  /监事会/,
  /股东大会决议/,
  /独立董事.*意见/,
];

const HARD_NEGATIVE: RegExp[] = [
  /立案/,
  /立案调查|被调查|调查通知书|立案告知/,
  /行政处罚/,
  /退市风险/,
  /暂停上市|终止上市/,
  /业绩预亏|预亏|首亏|续亏/,
  /审计.*(非标|无法表示|保留意见)/,
  /留置/,
  /质押.*(平仓|爆仓)/,
  /债务违约/,
  /重大诉讼/,
  /违规资金占用|资金占用.*(整改|归还|被占用|立案)/,
  /违规担保/,
];

const NEGATIVE: RegExp[] = [
  /减持/,
  /解禁/,
  /质押/,
  /诉讼|仲裁/,
  /预减|业绩下降|亏损/,
  /风险提示/,
  /问询函|监管函|关注函/,
  /终止|失败/,
  /减持计划/,
];

const POSITIVE: RegExp[] = [
  /回购/,
  /增持/,
  /中标/,
  /签订.*合同|重大合同/,
  /预增|扭亏|业绩增长/,
  /涨价|提价/,
  /分红/,
  /股权激励/,
  /收购/,
];

function firstProxy(): string | undefined {
  for (const key of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

async function fetchJson(url: string): Promise<unknown> {
  const headers = {
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64) xzh-ashare/1.0",
    accept: "application/json,text/plain,*/*",
  };
  const proxy = firstProxy();
  try {
    const response = await undiciFetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
      ...(proxy ? { dispatcher: new ProxyAgent(proxy) } : {}),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    if (!proxy) throw err;
    const response = await undiciFetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  }
}

function dateKey(offsetDays = 0): string {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 东财公告（近 180 天，最多 50 条），6 小时缓存 */
export async function fetchAnnouncements(code: string): Promise<Announcement[]> {
  const cached = readCache<Announcement[]>(`news-${code}.json`, CACHE_TTL_MS);
  if (cached) return cached.value;

  const url =
    "https://np-anotice-stock.eastmoney.com/api/security/ann" +
    `?sr=-1&page_size=50&page_index=1&ann_type=A&client_source=web&stock_list=${encodeURIComponent(code)}`;
  try {
    const payload = (await fetchJson(url)) as {
      data?: { list?: Array<{ notice_date?: string; title?: string }> };
    };
    const cutoff = dateKey(-MAX_DAYS);
    const items: Announcement[] = [];
    for (const row of payload.data?.list ?? []) {
      const date = (row.notice_date ?? "").slice(0, 10);
      const title = (row.title ?? "").trim();
      if (!date || !title || date < cutoff) continue;
      items.push({ date, title });
    }
    writeCache(`news-${code}.json`, items);
    return items;
  } catch {
    return [];
  }
}

export function newsTone(title: string): "hard" | "negative" | "positive" | "neutral" {
  // 先排除例行披露：否则「非经营性资金占用…汇总表」「防范大股东资金占用专项制度」
  // 会把正常公告误判成硬风险，实测会误杀一半候选。
  if (ROUTINE.some((pattern) => pattern.test(title))) return "neutral";
  if (HARD_NEGATIVE.some((pattern) => pattern.test(title))) return "hard";
  if (POSITIVE.some((pattern) => pattern.test(title))) return "positive";
  if (NEGATIVE.some((pattern) => pattern.test(title))) return "negative";
  return "neutral";
}

function daysBetween(from: string, to = dateKey()): number {
  const a = Date.parse(`${from}T00:00:00+08:00`);
  const b = Date.parse(`${to}T00:00:00+08:00`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return Math.round((b - a) / 86_400_000);
}

/** 公告日之前最后一个收盘价（作为消息前基准） */
function closeBefore(bars: Bar[], date: string): number | undefined {
  let value: number | undefined;
  for (const bar of bars) {
    if (bar.time.slice(0, 10) >= date) break;
    value = bar.close;
  }
  return value;
}

/** 单只股票的公告调整（硬否决 / ±10） */
export async function adjustByNews(code: string): Promise<NewsAdjustment> {
  const announcements = await fetchAnnouncements(code);
  if (announcements.length === 0) {
    return { veto: false, delta: 2, reason: "无公告（+2）" };
  }

  const recent = announcements.filter((item) => daysBetween(item.date) <= 5);
  const hard = announcements.find(
    (item) => daysBetween(item.date) <= 120 && newsTone(item.title) === "hard",
  );
  if (hard) {
    return { veto: true, delta: 0, reason: `硬风险：${hard.title}` };
  }

  const bars = await fetchBars(code, {
    period: "day",
    adjust: "backward",
    limit: 80,
  }).catch(() => [] as Bar[]);
  const current = bars[bars.length - 1]?.close;

  const negatives = recent.filter((item) => newsTone(item.title) === "negative");
  const positives = recent.filter((item) => newsTone(item.title) === "positive");

  let delta = 0;
  const reasons: string[] = [];

  if (negatives.length > 0) {
    const latest = negatives[0];
    const before = closeBefore(bars, latest.date);
    const recovered = current !== undefined && before !== undefined && current >= before;
    if (recovered) {
      delta += 5;
      reasons.push(`近5日利空已收复（+5）`);
    } else {
      delta -= 10;
      reasons.push(`近5日利空未收复（-10）`);
    }
  }

  if (positives.length > 0) {
    const latest = positives[0];
    const before = closeBefore(bars, latest.date);
    const gained =
      current !== undefined && before !== undefined && (current - before) / before >= 0.05;
    delta -= gained ? 5 : 2;
    reasons.push(`近5日利好${gained ? "已兑付（-5）" : "未反应（-2）"}`);
  }

  // 老利空（>60 日）且无近 60 日负面、股价已收复：只小幅回补
  const oldNegative = announcements.find(
    (item) => newsTone(item.title) === "negative" && daysBetween(item.date) > 60,
  );
  const hasRecentNegative = announcements.some(
    (item) =>
      newsTone(item.title) !== "positive" &&
      newsTone(item.title) !== "neutral" &&
      daysBetween(item.date) <= 60,
  );
  if (negatives.length === 0 && oldNegative && !hasRecentNegative) {
    const before = closeBefore(bars, oldNegative.date);
    const recovered = current !== undefined && before !== undefined && current >= before;
    if (recovered) {
      delta += 2;
      reasons.push("老利空已消化（+2）");
    }
  }

  if (reasons.length === 0) return { veto: false, delta: 2, reason: "无有效消息（+2）" };
  const clamped = Math.max(-10, Math.min(10, delta));
  return {
    veto: false,
    delta: clamped,
    reason: reasons.join("；") + `（${clamped >= 0 ? "+" : ""}${clamped}）`,
  };
}

export interface NewsOptions {
  enabled?: boolean;
  onProgress?: (message: string) => void;
}

/**
 * 对最终入选股做消息微调：硬否决的直接剔除，其余改分并重排。
 * 这里**不补位**——被否决的票不换成第 11 名。
 */
export async function applyNewsAdjustments(
  items: WatchItem[],
  options: NewsOptions = {},
): Promise<WatchItem[]> {
  const enabled =
    options.enabled ?? process.env.XZH_A_NEWS?.trim().toLowerCase() !== "off";
  if (!enabled || items.length === 0) return items;

  const adjusted: WatchItem[] = [];
  let done = 0;
  for (const item of items) {
    let result: NewsAdjustment;
    try {
      result = await adjustByNews(item.code);
    } catch {
      result = { veto: false, delta: 0, reason: "公告读取失败（0）" };
    } finally {
      done += 1;
      options.onProgress?.(`消息面检查 ${done}/${items.length}…`);
    }
    if (result.veto) {
      options.onProgress?.(`剔除 ${item.code} ${item.name}：${result.reason}`);
      continue;
    }
    adjusted.push({
      ...item,
      score: Math.max(0, Math.min(100, item.score + result.delta)),
      reason: `${item.reason} · ${result.reason}`,
    });
  }

  return adjusted.sort((a, b) => b.score - a.score);
}
