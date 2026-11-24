import * as fs from "fs";
import * as path from "path";
import {
  currentInspectOffset,
  readInspectEventItems,
  type InspectEvent,
  type InspectEventItem,
} from "../btc/inspect-stream";
import { aActionsPath } from "../a/monitor";
import { loadWatchlist } from "../a/watchlist";
import {
  currentAInspectOffset,
  readAInspectEventItems,
  type AInspectEvent,
  type AInspectEventItem,
} from "../a/inspect-stream";
import { getAShareHome, getBtcHome } from "../utils/paths";

/**
 * gateway → 微信的**巡检内容转发器**。
 *
 * btc 的独立后端把思考 / 结论写进 `inspect-stream.log`（JSONL，按字节偏移增量读），
 * A 股巡检把选股 / 买卖写进 `actions.jsonl`。两边都是文件，gateway 用一个 30 秒的
 * 定时器增量读取，把**重要内容**（结论 / 错误 / 买卖动作）推给最近联系的对端。
 *
 * 刻意的取舍：
 * - 首次接入只从「当前文件末尾」开始，不回放历史（避免用户被积压内容刷屏）；
 * - btc 的 reasoning / tool 过程**不转发**（那是 TUI /feed 的职责），只推结论 / 错误；
 * - **按轮聚合 + 一轮一条气泡**：btc 按 `round`、A 股按 `start`…`end` 分轮，等这一轮
 *   结束（`round-end` / `end` / `error` / 下一轮开始 / 超过 `ROUND_STALE_MS`）才整轮推一次，
 *   标题带轮次开始时间。以前按「每次读到 4 条事件」切批 + 超长分片，一轮能变成 3–5 条
 *   `1/2`、`2/2`，既像跑了三轮，又白耗 iLink 极小的推送额度（实测多一条就更容易被
 *   `ret=-2` 拒收）；
 * - 发送失败（微信未绑定 / 网络抖动 / 服务端拒收）时不丢内容、也不推进偏移：
 *   下一轮从同一位置整轮重推（`btc-batch` / `a-stream-batch` 仅为兼容旧数据保留，恒 0）。
 */

/** A 股动作账本单次推送里最多带几条，多的拆成多条消息 */
const MAX_EVENTS_PER_PUSH = 4;
/**
 * 单条推送的字符上限：**一轮只发一个气泡**。
 *
 * 以前是 900 字并允许拆 5 条（`· 1/2`、`· 2/2`）。2026-11-24 实测 iLink 的主动推送
 * 会整段被拒收（`ret=-2`），每次能发出去的额度只有几条 —— 气泡越少，一轮结论
 * 越有机会完整送达。微信文本气泡本身能装几千字，2000 字远在安全范围内。
 */
const MAX_PUSH_CHARS = 2_000;
/** 标题（标签 + 轮次时间）预留的字符数，正文按剩余长度切 */
const HEADER_RESERVE = 40;
/** 超长时省略中间部分，保留开头与结尾（结论通常在最后）；完整内容在巡检日志里 */
const OMIT_MARK = "…（中间省略 {n} 字，完整内容见巡检日志）…";
/**
 * 一轮超过这么久没有任何新事件，就当作「已结束」。
 *
 * 正常收尾会写 `round-end`，报错会写 `error`，下一轮开始也能判定上一轮结束；
 * 这个超时只兜「进程被 kill、两个事件都没写」的情况 —— 否则那轮的结论会永远扣着不推。
 */
const ROUND_STALE_MS = 15 * 60_000;

export type FeedOffsets = Record<string, number>;

/**
 * 「当前这一轮已经送达几条气泡」的偏移键。
 *
 * 一轮可能被拆成多条气泡（正文 > 900 字）。若第 2 条发送失败，只回退文件偏移的话，
 * 下个 tick 会把第 1 条**重新发一遍**——用户看到的就是重复内容。所以进度要记两层：
 * `btc` = 从哪个字节继续读（= 已完整送达的轮次末尾），`btc-batch` = 从该位置
 * 开始的那一轮里，前几条气泡已经送达。整轮送达后 `btc-batch` 归零。
 */
const BTC_BATCH_KEY = "btc-batch";

/**
 * A 股巡检结论的气泡进度键（与 `btc-batch` 同义）。
 *
 * 结论正文放宽到 2000 字后，一条推送可能被切成多条气泡；第 2 条失败时若不记进度，
 * 下个 tick 会把第 1 条重发一遍。这里同样记「这一批已送达几条」。
 */
const A_STREAM_BATCH_KEY = "a-stream-batch";

export function feedOffsetsPath(gatewayHome: string): string {
  return path.join(gatewayHome, "run", "feed-offsets.json");
}

export function readFeedOffsets(file: string): FeedOffsets {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as FeedOffsets;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function writeFeedOffsets(file: string, offsets: FeedOffsets): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(offsets, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/** btc 事件里「值得推给微信」的部分：结论 / 提示 / 错误（思考与工具过程不推） */
export function pickBtcImportant(events: InspectEvent[]): InspectEvent[] {
  return events.filter(
    (event) =>
      (event.kind === "text" || event.kind === "notice" || event.kind === "error") &&
      event.text.trim().length > 0,
  );
}

/** 一轮巡检在事件流里的一段（同一 `round` 的连续事件） */
export interface RoundBlock {
  /** 轮次 id（该轮开始时间，ISO） */
  round: string;
  events: InspectEvent[];
  /** 这一块最后一条事件读完后的文件偏移 */
  end: number;
}

/** 按 `round` 把增量事件切成轮次块（后端是串行巡检，同一轮的事件一定连续） */
export function groupInspectRounds(items: InspectEventItem[]): RoundBlock[] {
  const blocks: RoundBlock[] = [];
  for (const item of items) {
    const last = blocks[blocks.length - 1];
    if (last && last.round === item.event.round) {
      last.events.push(item.event);
      last.end = item.end;
      continue;
    }
    blocks.push({ round: item.event.round, events: [item.event], end: item.end });
  }
  return blocks;
}

/**
 * 这一轮是否已经结束（可以推了）。
 *
 * 判定顺序：有下一块（下一轮已开始）→ 有 `round-end` → 有 `error`（巡检异常时只写 error，
 * 不写 round-end）→ 最后一条事件已经放了很久（进程被 kill，两个标记都没写）。
 */
export function isRoundFinished(
  block: RoundBlock,
  next: RoundBlock | undefined,
  now = Date.now(),
): boolean {
  if (next) return true;
  if (block.events.some((event) => event.kind === "round-end" || event.kind === "error")) {
    return true;
  }
  const last = block.events[block.events.length - 1];
  const at = Date.parse(last?.ts ?? "");
  return Number.isFinite(at) && now - at > ROUND_STALE_MS;
}

/**
 * 把一轮里的重要事件拼成一段正文。
 *
 * `text` 事件是**流式增量**（后端每 1.5 秒刷一段），所以直接接续拼接才是完整回复；
 * 提示 / 错误另起一行加 `·`，与正文区分开。
 */
export function composeRoundText(events: InspectEvent[]): string {
  let body = "";
  for (const event of pickBtcImportant(events)) {
    const text = event.text.trim();
    if (event.kind === "text") {
      body = appendDelta(body, text);
      continue;
    }
    const line = `· ${text}`;
    body = body ? `${body.replace(/\n+$/, "")}\n${line}` : line;
  }
  return body.trim();
}

/** 接续两段流式增量（增量已被 trim，英文单词之间可能粘连，句末则另起一行） */
function appendDelta(body: string, delta: string): string {
  if (!delta) return body;
  if (!body) return delta;
  if (/[A-Za-z0-9]$/.test(body) && /^[A-Za-z0-9]/.test(delta)) return `${body} ${delta}`;
  // 上一段已经收句、下一段从头开始 → 视为另一个段落，换行避免粘成一句
  if (/[。！？!?]$/.test(body) && !/^[，。；：、）】」』,.;:)\]}]/.test(delta)) {
    return `${body}\n${delta}`;
  }
  return `${body}${delta}`;
}

/**
 * 一段正文 → **一个**带标题的气泡（超长时省略中间，保留开头与结尾）。
 *
 * 为什么不再拆成 `· 1/2`、`· 2/2`：iLink 的主动推送额度很少（实测每次会话
 * 刷新后只能连发几条），一条结论拆成 2 条就多占一次额度、更多机会撞 `ret=-2`。
 * 因此一轮 = 一次 `sendmessage`。
 *
 * 内容取舍：2000 字以内**逐字保留**；超长时保留开头与最后一屏（结论、排期、
 * 监控规则都在末尾），中间用一行说明省略了多少字并指向巡检日志 ——
 * 不再出现「只剩半张表 + 一个孤零零的 `6`」这种无提示截断。
 */
export function formatStreamPush(title: string, body: string): string[] {
  return singleBubble(title, body);
}

function singleBubble(title: string, body: string): string[] {
  const text = body.trim();
  if (!text) return [];
  const limit = Math.max(200, MAX_PUSH_CHARS - HEADER_RESERVE - title.length);
  if (text.length <= limit) return [`[${title}]\n${text}`];

  const omitted = text.length - limit;
  const note = `\n${OMIT_MARK.replace("{n}", String(omitted))}\n`;
  const keep = limit - note.length;
  // 结论通常在末尾：尾部占 40%，至少 200 字
  const tailLen = Math.max(200, Math.floor(keep * 0.4));
  const headLen = Math.max(0, keep - tailLen);
  const head = text.slice(0, headLen).replace(/\n+$/, "");
  const tail = text.slice(text.length - tailLen).replace(/^\n+/, "");
  return [`[${title}]\n${head}${note}${tail}`];
}

/**
 * A 股巡检结论正文：text 事件按时间顺序拼接，错误另起一行加 `·`。
 *
 * A 股这边 `text` 事件是一整段结论（不是 btc 那种 1.5 秒一段的流式增量），
 * 所以直接按段落拼接即可，**不逐条截断**。
 */
export function composeAStreamText(events: AInspectEvent[]): string {
  const parts: string[] = [];
  for (const event of events) {
    const text = event.text.trim();
    if (!text) continue;
    if (event.kind === "error") {
      parts.push(`· 巡检异常：${text}`);
      continue;
    }
    parts.push(text);
  }
  return parts.join("\n\n").trim();
}

/** 超长正文只保留开头与结尾（见 `singleBubble`），因此不再需要分片函数 */

/**
 * A 股一轮巡检在事件流里的一段。
 *
 * A 股的过程流没有 btc 的 `round` 字段，只有 `start` / `end` 包裹：
 * 巡检开始时写 `start`，正常收尾写 `end`，异常只写 `error`。
 * 因此「一轮」= 一个 `start` 到 `end`（或下一轮 `start`）之间的事件。
 */
export interface ARoundBlock {
  /** 轮次开始时间（`start` 事件的 ts） */
  round: string;
  events: AInspectEvent[];
  /** 这一块最后一条事件读完后的文件偏移 */
  end: number;
}

export function groupARounds(items: AInspectEventItem[]): ARoundBlock[] {
  // 新生产者显式写 `round`：直接按它归组，跨轮边界不会被 kill / error 打断猜错
  if (items.some((item) => Boolean(item.event.round))) {
    const blocks: ARoundBlock[] = [];
    for (const item of items) {
      const round = item.event.round ?? item.event.ts;
      const last = blocks[blocks.length - 1];
      if (last && last.round === round) {
        last.events.push(item.event);
        last.end = item.end;
        continue;
      }
      blocks.push({ round, events: [item.event], end: item.end });
    }
    return blocks;
  }

  // 老日志（没有 round 字段）：`start` 开启一轮，其余事件续到最后一块
  const blocks: ARoundBlock[] = [];
  for (const item of items) {
    const last = blocks[blocks.length - 1];
    if (last && item.event.kind !== "start") {
      last.events.push(item.event);
      last.end = item.end;
      continue;
    }
    blocks.push({ round: item.event.ts, events: [item.event], end: item.end });
  }
  return blocks;
}

/** 这一轮是否已经结束（`end` / `error` / 下一轮开始 / 静默超时） */
export function isARoundFinished(
  block: ARoundBlock,
  next: ARoundBlock | undefined,
  now = Date.now(),
): boolean {
  if (next) return true;
  if (block.events.some((event) => event.kind === "end" || event.kind === "error")) {
    return true;
  }
  const last = block.events[block.events.length - 1];
  const at = Date.parse(last?.ts ?? "");
  return Number.isFinite(at) && now - at > ROUND_STALE_MS;
}

/** 一轮 A 股巡检结论 → 一条微信消息（标题带轮次开始时间） */
export function formatARoundPush(block: ARoundBlock, now = Date.now()): string[] {
  const body = composeAStreamText(
    block.events.filter((event) => event.kind === "text" || event.kind === "error"),
  );
  if (!body) return [];
  const stamp = roundStamp(block.round, now);
  return singleBubble(stamp ? `A 股巡检结论 ${stamp}` : "A 股巡检结论", body);
}

/** 轮次时间标签（本地时间 HH:mm；跨天补 MM-DD），让用户看出「这是哪一轮」 */
export function roundStamp(round: string, now = Date.now()): string {
  const at = Date.parse(round);
  if (!Number.isFinite(at)) return "";
  const date = new Date(at);
  const today = new Date(now);
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/**
 * 一轮巡检 → **一条**微信消息。
 *
 * 标题带**轮次开始时间**（`BTC 模拟盘巡检 20:03`）。一轮只占一次 `sendmessage`：
 * iLink 主动推送额度很小，分片会让一轮占掉 2–5 次额度，反而整轮发不出去。
 */
export function formatRoundPush(
  label: string,
  block: RoundBlock,
  now = Date.now(),
): string[] {
  const body = composeRoundText(block.events);
  if (!body) return [];
  const stamp = roundStamp(block.round, now);
  const title = stamp ? `${label} ${stamp}` : label;
  return singleBubble(title, body);
}

export interface AActionEntry {
  kind?: string;
  code?: string;
  ok?: boolean;
  message?: string;
  codes?: string[];
}

/**
 * 账本条目 → 一行推送文案。
 *
 * `nameOf` 用于把只有代码的老记录补上名称（微信里单看 `600519` 认不出是哪只）。
 * 名称来源是自选池 `watchlist.json`；池外的代码保持原样，不编造。
 */
export function formatAEntry(
  entry: AActionEntry,
  nameOf?: (code: string) => string | undefined,
): string | null {
  if (entry.kind === "select") {
    // 新版选股会写详情（名称 / 分数 / 理由 / 换入换出）；老记录只有 codes，退回代码列表
    const message = entry.message?.trim();
    if (message && message.includes("\n")) return message;
    const codes = entry.codes ?? [];
    if (codes.length === 0) return message ?? null;
    const labeled = codes.map((code) => {
      const name = nameOf?.(code);
      return name && name !== code ? `${code} ${name}` : code;
    });
    return `选股 ${codes.length} 只：${labeled.join("、")}`;
  }
  if (entry.kind === "buy" || entry.kind === "sell") {
    const verb = entry.kind === "buy" ? "买入" : "卖出";
    const name = entry.code ? nameOf?.(entry.code) : undefined;
    if (entry.ok === false) {
      const message = entry.message ?? "";
      if (!message) return null;
      return `${verb}失败：${withName(message, entry.code, name)}`;
    }
    const text = entry.message ?? null;
    return text ? withName(text, entry.code, name) : null;
  }
  return null;
}

/** 文案里只出现代码时补上名称（`买入 600519 100 股` → `买入 600519 贵州茅台 100 股`） */
function withName(
  message: string,
  code?: string,
  name?: string,
): string {
  if (!code || !name || name === code) return message;
  if (message.includes(name)) return message;
  if (!message.includes(code)) return message;
  return message.replace(code, `${code} ${name}`);
}

interface JsonlTail {
  entries: AActionEntry[];
  offset: number;
}

/** 按字节偏移增量读 JSONL（只消费到最后一个完整行；文件变小视为轮转，跳到末尾） */
function readJsonlTail(file: string, sinceOffset: number): JsonlTail {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { entries: [], offset: sinceOffset };
  }
  let start = sinceOffset;
  if (start < 0 || start > size) start = size;
  if (size <= start) return { entries: [], offset: start };

  let text = "";
  try {
    const buf = fs.readFileSync(file);
    const length = Math.min(buf.length - start, 2 * 1024 * 1024);
    text = buf.toString("utf8", start, start + length);
  } catch {
    return { entries: [], offset: sinceOffset };
  }
  const cut = text.lastIndexOf("\n");
  if (cut < 0) return { entries: [], offset: sinceOffset };

  const entries: AActionEntry[] = [];
  for (const line of text.slice(0, cut).split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as AActionEntry);
    } catch {
      // 坏行跳过
    }
  }
  // `cut` 是**字符**下标，而 start 是**字节**偏移。中文 JSON 里 1 字符 = 3 字节，
  // 直接 `start + cut + 1` 会把偏移推进到行中间，下一轮从半个汉字开始解析，
  // 表现为「动作偶尔漏推 / 重复推」。必须按 UTF-8 字节数推进。
  return {
    entries,
    offset: start + Buffer.byteLength(text.slice(0, cut + 1), "utf8"),
  };
}

export interface FeedTickDeps {
  /**
   * 投递一条消息。
   *
   * `kind` 决定投递策略（见 `outbox.ts`）：成交 / 风控是 `trade`（必达），
   * 巡检结论与选股是 `inspect`（窗口关闭时可降级成摘要）。默认 `inspect`。
   *
   * 返回 false 表示**这一条没有被接收**（队列满 / 未登录），此时不推进偏移，
   * 下一轮重试。
   */
  send: (text: string, kind?: "inspect" | "trade") => Promise<boolean>;
  offsetsFile: string;
  log?: (message: string) => void;
}

/** 跑一轮转发（gateway 每 30 秒调用；测试可直接调） */
export async function runFeedTick(deps: FeedTickDeps): Promise<void> {
  const offsets = readFeedOffsets(deps.offsetsFile);
  const updates: FeedOffsets = {};
  let failed = false;

  {
    // 只转发「当前激活角色」的后端流：inspect-stream 是按 home 一份，
    // live / paper 同时各推一份会重复。
    const role: "live" | "paper" = process.env.XZH_BTC_ROLE === "paper" ? "paper" : "live";
    const key = "btc";
    const label = role === "paper" ? "BTC 模拟盘巡检" : "BTC 实盘巡检";
    if (!(key in offsets)) {
      // 首次接入：从当前末尾开始，不回放历史
      updates[key] = currentInspectOffset(getBtcHome());
      updates[BTC_BATCH_KEY] = 0;
      deps.log?.(`巡检转发：${label} 首次接入，从当前末尾开始（不回放历史）`);
    } else {
      const { items } = readInspectEventItems(offsets[key], getBtcHome());
      const blocks = groupInspectRounds(items);
      // 上次停在这一轮的第几条气泡（0 = 这一轮还没开始推）
      const resume = Math.max(0, Math.floor(offsets[BTC_BATCH_KEY] ?? 0));
      // consumed 只推进到「整轮送达」的末尾；未送达的轮次仍然从原偏移重读
      let consumed = offsets[key];
      let batch = resume;
      let ok = true;
      /** 本轮 tick 实际入队了几轮 / 几条气泡（日志用：没有这条，用户问「微信怎么没收到」时无从查起） */
      let rounds = 0;
      let bubbles = 0;
      for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        // 还在进行的轮次先不推：模型是分段输出结论的，读到一半就推会让同一轮
        // 变成好几条「巡检」消息（每段还各自重新编号）。等它 round-end 再整轮推一次。
        if (!isRoundFinished(block, blocks[index + 1])) break;
        const messages = formatRoundPush(label, block);
        // 只有「紧接上次未送达位置」的那一轮要跳过已送达的气泡，后面的轮次从头推
        batch = index === 0 ? Math.min(resume, messages.length) : 0;
        const from = batch;
        for (let at = batch; at < messages.length; at += 1) {
          if (!(await deps.send(messages[at]))) {
            ok = false;
            break;
          }
          batch = at + 1;
        }
        if (!ok) break;
        rounds += 1;
        bubbles += messages.length - from;
        consumed = block.end;
        batch = 0;
      }
      if (rounds > 0) {
        deps.log?.(`巡检转发：${label} ${rounds} 轮 / ${bubbles} 条已入队`);
      }
      // 失败也要落进度：已完整送达的轮次推进偏移，当前轮记住已发到第几条 ——
      // 否则下一个 tick 会把已经送达的气泡全部重发，用户看到重复内容。
      updates[key] = consumed;
      updates[BTC_BATCH_KEY] = batch;
      if (!ok) failed = true;
    }
  }

  const aKey = "a";
  const aFile = aActionsPath();
  if (!(aKey in offsets)) {
    try {
      updates[aKey] = fs.statSync(aFile).size;
    } catch {
      updates[aKey] = 0;
    }
  } else {
    const { entries, offset } = readJsonlTail(aFile, offsets[aKey]);
    // 老账本里只有代码：用自选池补名称，微信里才认得出是哪只（池外的原样保留）
    const names = new Map(
      loadWatchlist().items.map((item) => [item.code, item.name] as const),
    );
    const formatted = entries
      .map((entry) => {
        const line = formatAEntry(entry, (code) => names.get(code));
        if (line === null) return null;
        // 买卖是「钱动了」，不能降级成摘要；选股等可延迟
        const kind: "inspect" | "trade" =
          entry.kind === "buy" || entry.kind === "sell" ? "trade" : "inspect";
        return { line, kind };
      })
      .filter((item): item is { line: string; kind: "inspect" | "trade" } => item !== null);
    if (formatted.length === 0) {
      updates[aKey] = offset;
    } else {
      const total = Math.ceil(formatted.length / MAX_EVENTS_PER_PUSH);
      let ok = true;
      let bubbles = 0;
      for (let index = 0; index < total && ok; index += 1) {
        const chunk = formatted.slice(
          index * MAX_EVENTS_PER_PUSH,
          (index + 1) * MAX_EVENTS_PER_PUSH,
        );
        const title = total > 1 ? `A 股巡检 ${index + 1}/${total}` : "A 股巡检";
        const messages = formatStreamPush(title, chunk.map((item) => `- ${item.line}`).join("\n"));
        // 一条消息里只要掺了成交，就整条按必达处理
        const kind = chunk.some((item) => item.kind === "trade") ? "trade" : "inspect";
        for (const message of messages) {
          if (!(await deps.send(message, kind))) {
            ok = false;
            break;
          }
          bubbles += 1;
        }
      }
      if (ok) {
        updates[aKey] = offset;
        deps.log?.(`巡检转发：A 股动作 ${formatted.length} 条 / ${bubbles} 条已入队`);
      } else failed = true;
    }
  }

  // A 股巡检结论（过程流里的 text / error；工具调用不推）
  //
  // **按轮聚合**：A 股一次巡检会写多段 text（模型分段输出）+ 一条总结，
  // 以前每 30 秒读到什么就推什么，一次巡检能变成 3–5 条「A 股巡检结论」，
  // 既刷屏又白耗 iLink 的推送额度。现在等这一轮 `end`（或 error / 下一轮 start /
  // 静默 15 分钟）之后再整轮推一条。
  const aStreamKey = "a-stream";
  if (!(aStreamKey in offsets)) {
    updates[aStreamKey] = currentAInspectOffset();
    updates[A_STREAM_BATCH_KEY] = 0;
  } else {
    const { items } = readAInspectEventItems(offsets[aStreamKey]);
    const blocks = groupARounds(items);
    // 一轮一条气泡，失败后从同一偏移重读整轮即可，不需要记「已发到第几条」
    let consumed = offsets[aStreamKey];
    let pushed = 0;
    let ok = true;
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (!isARoundFinished(block, blocks[index + 1])) break;
      const messages = formatARoundPush(block);
      for (const message of messages) {
        if (!(await deps.send(message))) {
          ok = false;
          break;
        }
        pushed += 1;
      }
      if (!ok) break;
      consumed = block.end;
    }
    updates[aStreamKey] = consumed;
    updates[A_STREAM_BATCH_KEY] = 0;
    if (!ok) failed = true;
    else if (pushed > 0) deps.log?.(`巡检转发：A 股巡检结论 ${pushed} 轮已入队`);
  }

  const merged: FeedOffsets = { ...offsets, ...updates };
  writeFeedOffsets(deps.offsetsFile, merged);
  if (failed) deps.log?.("巡检推送未完成（微信不可用），稍后重试");
}

export interface FeedForwarder {
  stop: () => void;
}

/** gateway 启动一个 30 秒的转发定时器（微信未登录时静默跳过） */
export function startFeedForwarder(options: {
  gatewayHome: string;
  send: (text: string, kind?: "inspect" | "trade") => Promise<boolean>;
  log?: (message: string) => void;
  intervalMs?: number;
}): FeedForwarder {
  const deps: FeedTickDeps = {
    send: options.send,
    offsetsFile: feedOffsetsPath(options.gatewayHome),
    log: options.log,
  };
  const timer = setInterval(() => void runFeedTick(deps), options.intervalMs ?? 30_000);
  timer.unref?.();
  void runFeedTick(deps);
  return {
    stop: () => clearInterval(timer),
  };
}
