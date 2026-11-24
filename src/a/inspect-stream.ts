import * as fs from "fs";
import * as path from "path";
import { monitorDir } from "./watchlist";

/** A 股巡检过程流（JSONL，增量读取；与 btc inspect-stream 对齐） */
export interface AInspectEvent {
  ts: string;
  kind: "start" | "text" | "tool" | "notice" | "error" | "end";
  text: string;
  /**
   * 轮次 id（该轮 `start` 的时间戳）。
   *
   * 消费者（gateway 转发器 / TUI）要靠它把一轮的多段输出归组。以前只有
   * `start` / `end` 事件可以推断，跨轮边界（进程被 kill、只写了 error）时容易猜错；
   * 现在由生产者显式写入，读端不再需要「猜」。老日志没有这个字段，读端会退回
   * `start` … `end` 推断。
   */
  round?: string;
}

/** 当前轮次：由 `appendAInspectEvent` 的 `start` 开启，只在本进程内有效 */
let currentRound: string | undefined;

const MAX_BYTES = 2 * 1024 * 1024;

function streamPath(): string {
  return path.join(monitorDir(), "logs", "inspect-stream.jsonl");
}

let buffer: AInspectEvent[] = [];
let timer: NodeJS.Timeout | undefined;

/** 1.5 秒合并刷写，避免巡检高频输出把文件打碎 */
export function flushAInspectEvents(): void {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (buffer.length === 0) return;
  const events = buffer;
  buffer = [];
  try {
    const file = streamPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.rmSync(file, { force: true });
    } catch {
      // 文件不存在
    }
    fs.appendFileSync(
      file,
      events.map((event) => `${JSON.stringify(event)}\n`).join(""),
      "utf8",
    );
  } catch {
    // 过程流失败不影响巡检
  }
}

export function appendAInspectEvent(kind: AInspectEvent["kind"], text: string): void {
  const ts = new Date().toISOString();
  // `start` 开启新一轮；其余事件归属当前轮。没有 start 就自己当一轮的开头，
  // 这样即使调用方漏写 start，事件也带着可用的轮次 id。
  if (kind === "start" || !currentRound) currentRound = ts;
  buffer.push({
    ts,
    kind,
    text: text.slice(0, 2_000),
    round: currentRound,
  });
  if (!timer) {
    timer = setTimeout(() => {
      timer = undefined;
      flushAInspectEvents();
    }, 1_500);
    timer.unref?.();
  }
}

/** 事件 + 读完这条事件后的文件偏移（字节），转发器按轮聚合要用 */
export interface AInspectEventItem {
  event: AInspectEvent;
  end: number;
}

export function currentAInspectOffset(): number {
  try {
    return fs.statSync(streamPath()).size;
  } catch {
    return 0;
  }
}

/**
 * 增量读取，并给出**每条事件自己的结束偏移**。
 *
 * 与 btc 的 `readInspectEventItems` 同构：转发器要「按轮聚合、等这一轮结束
 * （`end` / `error` / 下一轮 `start`）再推」，就必须能把偏移停在一轮中间。
 * 偏移一律按 **UTF-8 字节**推进 —— 用字符下标会在中文行上停在半个汉字。
 */
export function readAInspectEventItems(sinceOffset: number): {
  items: AInspectEventItem[];
  offset: number;
} {
  flushAInspectEvents();
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(streamPath());
  } catch {
    return { items: [], offset: sinceOffset };
  }
  let start = sinceOffset;
  if (start < 0 || buffer.length < start) {
    // 轮转：从新文件开头读
    start = 0;
  }
  if (buffer.length <= start) return { items: [], offset: start };

  const lastBreak = buffer.lastIndexOf(0x0a, buffer.length - 1);
  if (lastBreak < start) return { items: [], offset: start };

  const text = buffer.toString("utf8", start, lastBreak + 1);
  const lines = text.split("\n");
  // 最后一行可能是写了一半的：`text` 已截到最后一个换行，末尾会多出一个空串
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const items: AInspectEventItem[] = [];
  let cursor = start;
  for (const line of lines) {
    const end = cursor + Buffer.byteLength(`${line}\n`, "utf8");
    cursor = end;
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as AInspectEvent;
      if (event && typeof event.text === "string" && event.kind) {
        items.push({ event, end });
      }
    } catch {
      // 坏行跳过：一条脏数据不该让整段展示失败
    }
  }
  return { items, offset: cursor };
}

export function readAInspectEvents(
  sinceOffset: number,
): { events: AInspectEvent[]; offset: number } {
  const { items, offset } = readAInspectEventItems(sinceOffset);
  return { events: items.map((item) => item.event), offset };
}
