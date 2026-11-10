import * as fs from "fs";
import * as path from "path";
import { monitorDir } from "./watchlist";

/**
 * A 股巡检排期队列（对齐 btc 的 schedule）：
 * - `next` 唯一，新顶旧；`extra` 可并存（同一分钟去重）；
 * - 时间夹到工作日 09:00–15:30；越界顺延到下一个工作时段；
 * - 巡检结束前由 Agent 调 `a_schedule` 决定下一轮；代码只消费到期条目。
 */

export type ScheduleSlot = "next" | "extra";
export type ScheduleOrigin = "inspect" | "manual";

export interface ScheduleEntry {
  id: string;
  at: string;
  reason: string;
  slot: ScheduleSlot;
  origin: ScheduleOrigin;
  createdAt: string;
  clamped?: boolean;
}

interface QueueFile {
  version: number;
  entries: ScheduleEntry[];
}

const QUEUE_FILE = "run/schedules.json";
const MIN_CHECK_MINUTES = 5;
const MAX_QUEUE_SIZE = 20;

function queuePath(): string {
  return path.join(monitorDir(), QUEUE_FILE);
}

function readQueue(): QueueFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(queuePath(), "utf8")) as QueueFile;
    return {
      version: parsed.version ?? 1,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch {
    return { version: 1, entries: [] };
  }
}

function writeQueue(queue: QueueFile): void {
  const file = queuePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(queue, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

const WORK_START = 9 * 60;
const WORK_END = 15 * 60 + 30;

/** 把时间夹到工作日 09:00–15:30；越界顺延到下一个工作时段 */
export function clampToWorkTime(at: Date, now = new Date()): { at: Date; clamped: boolean } {
  const result = new Date(at);
  let clamped = false;
  for (let guard = 0; guard < 14; guard += 1) {
    const day = result.getDay();
    const minutes = result.getHours() * 60 + result.getMinutes();
    if (day === 0 || day === 6) {
      result.setDate(result.getDate() + (day === 6 ? 2 : 1));
      result.setHours(9, 5, 0, 0);
      clamped = true;
      continue;
    }
    if (minutes < WORK_START) {
      result.setHours(9, 5, 0, 0);
      clamped = true;
      continue;
    }
    if (minutes > WORK_END) {
      result.setDate(result.getDate() + 1);
      result.setHours(9, 5, 0, 0);
      clamped = true;
      continue;
    }
    break;
  }
  // 不允许排到过去：至少 now + 1 分钟
  if (result.getTime() < now.getTime() + 60_000) {
    result.setTime(now.getTime() + 60_000);
    clamped = true;
  }
  return { at: result, clamped };
}

export function readScheduleQueue(): ScheduleEntry[] {
  return readQueue().entries;
}

export function pushSchedule(input: {
  minutes?: number;
  at?: string;
  reason: string;
  slot?: ScheduleSlot;
  origin?: ScheduleOrigin;
}): ScheduleEntry {
  const now = new Date();
  const requested = input.at
    ? new Date(input.at)
    : new Date(
        now.getTime() +
          Math.max(MIN_CHECK_MINUTES, Math.min(12 * 60, input.minutes ?? 60)) * 60_000,
      );
  const { at, clamped } = clampToWorkTime(requested, now);
  const entry: ScheduleEntry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    at: at.toISOString(),
    reason: input.reason.trim() || "巡检",
    slot: input.slot ?? "next",
    origin: input.origin ?? (process.env.XZH_A_INSPECT === "1" ? "inspect" : "manual"),
    createdAt: now.toISOString(),
    ...(clamped ? { clamped: true } : {}),
  };

  const queue = readQueue();
  if (entry.slot === "next") {
    queue.entries = queue.entries.filter((item) => item.slot !== "next");
  } else {
    const sameMinute = queue.entries.find(
      (item) =>
        item.slot === "extra" &&
        Math.abs(Date.parse(item.at) - Date.parse(entry.at)) < 60_000,
    );
    if (sameMinute) return sameMinute;
  }
  queue.entries.push(entry);
  queue.entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (queue.entries.length > MAX_QUEUE_SIZE) {
    queue.entries = queue.entries.slice(-MAX_QUEUE_SIZE);
  }
  writeQueue(queue);
  return entry;
}

/** 取出最早到期的一条（取出即出队） */
export function takeDueSchedule(now = new Date()): ScheduleEntry | null {
  const queue = readQueue();
  const index = queue.entries.findIndex((entry) => Date.parse(entry.at) <= now.getTime());
  if (index < 0) return null;
  const [entry] = queue.entries.splice(index, 1);
  writeQueue(queue);
  return entry;
}

export function nextScheduledEntry(): ScheduleEntry | null {
  const entries = readQueue().entries;
  return entries.length > 0 ? entries[0] : null;
}

export function removeSchedules(id?: string): number {
  const queue = readQueue();
  const before = queue.entries.length;
  queue.entries = id
    ? queue.entries.filter((entry) => entry.id !== id)
    : [];
  writeQueue(queue);
  return before - queue.entries.length;
}
