import * as fs from "fs";
import * as path from "path";
import { monitorDir } from "./watchlist";

/** A 股巡检过程流（JSONL，增量读取；与 btc inspect-stream 对齐） */
export interface AInspectEvent {
  ts: string;
  kind: "start" | "text" | "tool" | "notice" | "error" | "end";
  text: string;
}

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
  buffer.push({
    ts: new Date().toISOString(),
    kind,
    text: text.slice(0, 2_000),
  });
  if (!timer) {
    timer = setTimeout(() => {
      timer = undefined;
      flushAInspectEvents();
    }, 1_500);
    timer.unref?.();
  }
}

export function currentAInspectOffset(): number {
  try {
    return fs.statSync(streamPath()).size;
  } catch {
    return 0;
  }
}

export function readAInspectEvents(
  sinceOffset: number,
): { events: AInspectEvent[]; offset: number } {
  flushAInspectEvents();
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(streamPath());
  } catch {
    return { events: [], offset: sinceOffset };
  }
  if (buffer.length < sinceOffset) {
    // 轮转：从新文件开头读
    sinceOffset = 0;
  }
  const text = buffer.toString("utf8", sinceOffset);
  const lines = text.split("\n");
  const complete = lines.slice(0, -1); // 最后一行可能写了一半
  const events: AInspectEvent[] = [];
  for (const line of complete) {
    try {
      const event = JSON.parse(line) as AInspectEvent;
      if (event && typeof event.text === "string") events.push(event);
    } catch {
      // 坏行跳过
    }
  }
  const offset = sinceOffset + Buffer.byteLength(complete.join("\n") + (complete.length ? "\n" : ""));
  return { events, offset };
}
