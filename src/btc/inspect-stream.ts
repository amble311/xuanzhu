import * as fs from "fs";
import * as path from "path";
import { getBtcHome } from "../utils/paths";

/**
 * 后台巡检的**过程流**（`~/.xzh_btc/logs/inspect-stream.log`，JSONL）。
 *
 * 为什么需要它：巡检跑在独立进程里，前端只看得到 `backend.json` 里的一条摘要 ——
 * 用户不知道它「想了什么、调了什么工具、为什么得出这个结论」。
 * 事件流把每一轮的过程按时间追加，前端按偏移增量读取并显示。
 *
 * 与 `inspect.log` 的分工：那个是**人类可读的一轮结论**（复盘用），
 * 这个是**机器可读的过程事件**（前端实时展示用），两者不互相替代。
 *
 * 格式（每行一个 JSON）：
 * ```json
 * {"ts":"2026-11-03T07:04:11.203Z","round":"2026-11-03T07:04:05.001Z","kind":"reasoning","text":"周线多头…"}
 * ```
 * `round` 是一轮的 id（该轮开始时间），前端据此把事件归组。
 */

export type InspectEventKind =
  | "round-start"
  | "reasoning"
  | "text"
  | "tool"
  | "tool-end"
  | "notice"
  | "round-end"
  | "error";

export interface InspectEvent {
  ts: string;
  /** 轮次 id（该轮开始时间） */
  round: string;
  kind: InspectEventKind;
  text: string;
}

/** 单条事件最多存这么多字符：思考可能很长，但前端一次显示不了 */
const MAX_EVENT_CHARS = 1_500;
/** 超过这个大小就轮转（保留一份 .1），避免无限增长 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 首次读取时最多回看这么多字节（不能让界面被历史刷屏） */
const MAX_BACKLOG_BYTES = 64 * 1024;

export function inspectStreamPath(home = getBtcHome()): string {
  return path.join(home, "logs", "inspect-stream.log");
}

function rotateIfNeeded(file: string): void {
  try {
    if (fs.statSync(file).size <= MAX_FILE_BYTES) return;
    fs.renameSync(file, `${file}.1`);
  } catch {
    // 文件不存在 = 首次写入
  }
}

export function appendInspectEvent(
  event: Omit<InspectEvent, "ts"> & { ts?: string },
  home = getBtcHome(),
): void {
  const file = inspectStreamPath(home);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded(file);
    const record: InspectEvent = {
      ts: event.ts ?? new Date().toISOString(),
      round: event.round,
      kind: event.kind,
      text: event.text.slice(0, MAX_EVENT_CHARS),
    };
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // 过程流写失败不该影响巡检本身：它只是展示用的旁路
  }
}

/** 当前文件末尾偏移（前端首次接入时从这里开始，不回放历史） */
export function currentInspectOffset(home = getBtcHome()): number {
  try {
    return fs.statSync(inspectStreamPath(home)).size;
  } catch {
    return 0;
  }
}

export interface ReadInspectResult {
  events: InspectEvent[];
  /** 下次从这里继续读 */
  offset: number;
}

/**
 * 从 `sinceOffset` 增量读取。
 *
 * 只消费到**最后一个换行**为止：后端可能正写到一半，把那半行当事件解析会丢内容，
 * 也会让偏移错位。文件被轮转（变小）时退回到「最后 64KB」，避免整份重读。
 */
export function readInspectEvents(
  sinceOffset: number,
  home = getBtcHome(),
): ReadInspectResult {
  const file = inspectStreamPath(home);
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { events: [], offset: sinceOffset };
  }

  let start = sinceOffset;
  if (start < 0 || start > size) {
    start = Math.max(0, size - MAX_BACKLOG_BYTES);
  }
  if (size <= start) return { events: [], offset: start };

  const length = Math.min(size - start, MAX_FILE_BYTES);
  // 用 Uint8Array 而不是 Buffer：新版 @types/node 里 readSync 的参数是
  // `ArrayBufferView`，Buffer 的底层是 SharedArrayBuffer 兼容类型，会被拒。
  const buffer = new Uint8Array(length);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }

  // 必须按**字节**找换行：偏移是字节数，而 JS 字符串索引是 UTF-16 单元，
  // 中文一条就占 3 字节 —— 用字符索引推进会让下次读取落在多字节字符中间，
  // 解码出乱码，且 offset 永远追不上文件大小。
  const bytes = Buffer.from(buffer);
  const lastBreak = bytes.lastIndexOf(0x0a);
  if (lastBreak < 0) {
    // 一整个缓冲里没有换行：说明单行异常巨大，跳过它（下次从末尾继续）
    return { events: [], offset: start + length };
  }

  const consumed = bytes.subarray(0, lastBreak).toString("utf8");
  const events: InspectEvent[] = [];
  for (const line of consumed.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as InspectEvent;
      if (parsed && typeof parsed.text === "string" && parsed.kind) {
        events.push(parsed);
      }
    } catch {
      // 坏行直接跳过：一条脏数据不该让整段展示失败
    }
  }

  return { events, offset: start + lastBreak + 1 };
}
