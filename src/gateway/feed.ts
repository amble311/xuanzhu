import * as fs from "fs";
import * as path from "path";
import { currentInspectOffset, readInspectEvents, type InspectEvent } from "../btc/inspect-stream";
import { aActionsPath } from "../a/monitor";
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
 * - 发送失败（微信未绑定 / 网络抖动）时不推进偏移，下一轮重试。
 */

/** 单次推送里最多带几条事件，多的折叠成条数说明 */
const MAX_EVENTS_PER_PUSH = 4;
/** 单条推送的字符上限：尽量压进一个微信气泡，避免多块发送时丢后一条 */
const MAX_PUSH_CHARS = 900;

export type FeedOffsets = Record<string, number>;

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

export function formatBtcBatch(label: string, events: InspectEvent[]): string | null {
  if (events.length === 0) return null;
  const shown = events.slice(-MAX_EVENTS_PER_PUSH);
  const lines = shown.map((event) => `- ${event.text.trim().slice(0, 180)}`);
  if (events.length > shown.length) {
    lines.push(`…（本轮还有 ${events.length - shown.length} 条）`);
  }
  let message = `[${label}]\n${lines.join("\n")}`;
  if (message.length > MAX_PUSH_CHARS) {
    message = `${message.slice(0, MAX_PUSH_CHARS - 1)}…`;
  }
  return message;
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
  /** 发送成功返回 true；返回 false（微信未绑定 / 发送失败）时不推进偏移 */
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
    } else {
      const { events, offset } = readInspectEvents(offsets[key], getBtcHome());
      const important = pickBtcImportant(events);
      if (important.length === 0) {
        updates[key] = offset;
      } else {
        const message = formatBtcBatch(label, important);
        if (message) {
          const ok = await deps.send(message);
          if (ok) updates[key] = offset;
          else failed = true;
        } else {
          updates[key] = offset;
        }
      }
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
      const shown = formatted.slice(-MAX_EVENTS_PER_PUSH);
      const lines = shown.map((line) => `- ${line.slice(0, 300)}`);
      if (formatted.length > shown.length) {
        lines.push(`…（本轮还有 ${formatted.length - shown.length} 条）`);
      }
      const ok = await deps.send(`[A 股巡检]\n${lines.join("\n")}`);
      if (ok) updates[aKey] = offset;
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
