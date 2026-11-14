import * as fs from "fs";
import * as path from "path";
import {
  currentInspectOffset,
  readInspectEventItems,
  type InspectEvent,
  type InspectEventItem,
} from "../btc/inspect-stream";
import { aActionsPath } from "../a/monitor";
import { currentAInspectOffset, readAInspectEvents } from "../a/inspect-stream";
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
 * - btc 的结论**按轮聚合**：一轮巡检的结论只在 `round-end`（或该轮报错 / 下一轮开始 /
 *   超过 `ROUND_STALE_MS`）之后才推一次，标题带轮次开始时间。以前按「每次读到 4 条事件」
 *   切批，一轮里模型分段输出 3 遍结论就会变成 3 组 `1/2`、`2/2`，看起来像跑了三轮；
 * - 发送失败（微信未绑定 / 网络抖动）时不丢内容：已完整送达的轮次推进偏移，当前轮
 *   记住「已发到第几条气泡」（`BTC_BATCH_KEY`），下一轮只补发没送达的部分。
 */

/** A 股动作账本单次推送里最多带几条，多的拆成多条消息 */
const MAX_EVENTS_PER_PUSH = 4;
/** 单条推送的字符上限：尽量压进一个微信气泡，避免多块发送时丢后一条 */
const MAX_PUSH_CHARS = 900;
/** 标题（标签 + 轮次时间 + 分片序号）预留的字符数，正文按剩余长度切 */
const HEADER_RESERVE = 40;
/** 一轮最多推几条气泡：再多就省略中间部分（完整内容还在巡检日志里） */
const MAX_BUBBLES_PER_ROUND = 5;
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

/** 在标点处切分，避免把一句话从中间劈开 */
function cutAt(text: string, limit: number): number {
  const window = text.slice(0, limit);
  const point = Math.max(
    window.lastIndexOf("。"),
    window.lastIndexOf("；"),
    window.lastIndexOf("\n"),
    window.lastIndexOf("，"),
  );
  return point > limit * 0.6 ? point + 1 : limit;
}

/** 按长度切成多条气泡（优先在换行 / 标点处断开） */
export function splitWechatBody(body: string, limit: number): string[] {
  const size = Math.max(80, Math.floor(limit));
  const chunks: string[] = [];
  let buffer = "";
  for (const line of body.split("\n")) {
    const candidate = buffer ? `${buffer}\n${line}` : line;
    if (candidate.length <= size) {
      buffer = candidate;
      continue;
    }
    if (buffer) {
      chunks.push(buffer);
      buffer = "";
    }
    let rest = line;
    while (rest.length > size) {
      const cut = cutAt(rest, size);
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    buffer = rest;
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

/** 气泡太多时保留开头与结尾（结论通常在最后），中间省略并说明去处 */
function collapseChunks(chunks: string[]): string[] {
  if (chunks.length <= MAX_BUBBLES_PER_ROUND) return chunks;
  const omitted = chunks.length - MAX_BUBBLES_PER_ROUND;
  const note = `…（中间省略 ${omitted} 段，完整内容见巡检日志 inspect.log）\n`;
  const tail = chunks[chunks.length - 1].slice(0, MAX_PUSH_CHARS - note.length - HEADER_RESERVE);
  return [...chunks.slice(0, MAX_BUBBLES_PER_ROUND - 1), `${note}${tail}`];
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
 * 一轮巡检 → 一到多条微信消息。
 *
 * 标题带**轮次开始时间**（`BTC 模拟盘巡检 20:03`），只有正文确实超长时才带 `1/2`；
 * 序号是「这一轮的第几段」，不再随每次读取重新从 1 开始 —— 以前那样看起来像重复巡检。
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
  const chunks = collapseChunks(
    splitWechatBody(body, MAX_PUSH_CHARS - HEADER_RESERVE - title.length),
  );
  const total = chunks.length;
  return chunks.map((chunk, index) => {
    const head = total > 1 ? `${title} · ${index + 1}/${total}` : title;
    return `[${head}]\n${chunk}`;
  });
}

export interface AActionEntry {
  kind?: string;
  code?: string;
  ok?: boolean;
  message?: string;
  codes?: string[];
}

export function formatAEntry(entry: AActionEntry): string | null {
  if (entry.kind === "select") {
    const codes = entry.codes ?? [];
    return codes.length > 0 ? `选股 ${codes.length} 只：${codes.join("、")}` : null;
  }
  if (entry.kind === "buy" || entry.kind === "sell") {
    const verb = entry.kind === "buy" ? "买入" : "卖出";
    if (entry.ok === false) {
      const message = entry.message ?? "";
      return message ? `${verb}失败：${message}` : null;
    }
    return entry.message ?? null;
  }
  return null;
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
  return { entries, offset: start + cut + 1 };
}

export interface FeedTickDeps {
  /**
   * 发送成功返回 true；返回 false（微信未绑定 / 发送失败）时该条不算送达，
   * 下一轮从这条重试（已送达的不会重发）。
   */
  send: (text: string) => Promise<boolean>;
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
    } else {
      const { items } = readInspectEventItems(offsets[key], getBtcHome());
      const blocks = groupInspectRounds(items);
      // 上次停在这一轮的第几条气泡（0 = 这一轮还没开始推）
      const resume = Math.max(0, Math.floor(offsets[BTC_BATCH_KEY] ?? 0));
      // consumed 只推进到「整轮送达」的末尾；未送达的轮次仍然从原偏移重读
      let consumed = offsets[key];
      let batch = resume;
      let ok = true;
      for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        // 还在进行的轮次先不推：模型是分段输出结论的，读到一半就推会让同一轮
        // 变成好几条「巡检」消息（每段还各自重新编号）。等它 round-end 再整轮推一次。
        if (!isRoundFinished(block, blocks[index + 1])) break;
        const messages = formatRoundPush(label, block);
        // 只有「紧接上次未送达位置」的那一轮要跳过已送达的气泡，后面的轮次从头推
        batch = index === 0 ? Math.min(resume, messages.length) : 0;
        for (let at = batch; at < messages.length; at += 1) {
          if (!(await deps.send(messages[at]))) {
            ok = false;
            break;
          }
          batch = at + 1;
        }
        if (!ok) break;
        consumed = block.end;
        batch = 0;
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
    const formatted = entries
      .map(formatAEntry)
      .filter((line): line is string => line !== null);
    if (formatted.length === 0) {
      updates[aKey] = offset;
    } else {
      const total = Math.ceil(formatted.length / MAX_EVENTS_PER_PUSH);
      let ok = true;
      for (let index = 0; index < total; index += 1) {
        const chunk = formatted.slice(
          index * MAX_EVENTS_PER_PUSH,
          (index + 1) * MAX_EVENTS_PER_PUSH,
        );
        const title = total > 1 ? `A 股巡检 ${index + 1}/${total}` : "A 股巡检";
        ok = (await deps.send(`[${title}]\n${chunk.map((line) => `- ${line.slice(0, 300)}`).join("\n")}`)) && ok;
      }
      if (ok) updates[aKey] = offset;
      else failed = true;
    }
  }

  // A 股巡检结论（过程流里的 text / error；工具调用不推）
  const aStreamKey = "a-stream";
  if (!(aStreamKey in offsets)) {
    updates[aStreamKey] = currentAInspectOffset();
  } else {
    const { events, offset } = readAInspectEvents(offsets[aStreamKey]);
    const important = events
      .filter((event) => event.kind === "text" || event.kind === "error")
      .map((event) => `- ${event.text.trim().slice(0, 300)}`);
    if (important.length === 0) {
      updates[aStreamKey] = offset;
    } else {
      const total = Math.ceil(important.length / MAX_EVENTS_PER_PUSH);
      let ok = true;
      for (let index = 0; index < total; index += 1) {
        const chunk = important.slice(index * MAX_EVENTS_PER_PUSH, (index + 1) * MAX_EVENTS_PER_PUSH);
        const title = total > 1 ? `A 股巡检结论 ${index + 1}/${total}` : "A 股巡检结论";
        ok = (await deps.send(`[${title}]\n${chunk.join("\n")}`)) && ok;
      }
      if (ok) updates[aStreamKey] = offset;
      else failed = true;
    }
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
  send: (text: string) => Promise<boolean>;
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
