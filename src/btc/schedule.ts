import * as fs from "fs";
import * as path from "path";
import { getBtcHome } from "../utils/paths";

/**
 * 巡检排期队列（`~/.btc/run/schedules.json`）。
 *
 * 模型每次调用 `btc_schedule` 就往队列里放一条计划；后台每 60 秒检查一次，
 * 把**已到期**的条目取出来执行（取出即出队）。
 *
 * 条目分两种「槽位」——这是「改期」能否成立的关键：
 * - `next`：唯一的下一跳。新的一定顶掉旧的，所以「本来 1 小时后，改成 30 分钟后」
 *   只要再写一条 next 就行，不会出现两条都跑；
 * - `extra`：额外检查点，可并存（例如用户想在某个事件前额外看一眼）。
 *
 * 谁写的记在 `origin`（`inspect` / `manual`），只用于展示与撤销筛选，
 * **不影响去重规则** —— 前后台都能改写 `next`，否则前台永远改不掉后台的计划。
 */

/** 允许的最短间隔（分钟）：再短就变成连续调模型 */
export const MIN_CHECK_MINUTES = 10;
/** 允许的最长间隔（分钟）：再长可能错过一次日线级别的机会 */
export const MAX_CHECK_MINUTES = 12 * 60;
/** 模型没给出计划时的默认间隔（分钟） */
export const DEFAULT_CHECK_MINUTES = 60;
/** 队列上限：防止反复写入把文件撑大；超出丢弃最远的那条 */
export const MAX_QUEUE_SIZE = 20;

export type ScheduleSlot = "next" | "extra";
export type ScheduleOrigin = "inspect" | "manual";

export interface ScheduleEntry {
  /** 队列内唯一 id（撤销时用它定位） */
  id: string;
  /** 计划巡检时间（ISO） */
  at: string;
  /** 为什么定这个时间 */
  reason: string;
  /** 写入时附带的结论（可选） */
  decision?: string;
  /** `next` = 唯一的下一跳；`extra` = 额外检查点 */
  slot: ScheduleSlot;
  /** 谁放进来的 */
  origin: ScheduleOrigin;
  /** 写入时间（ISO） */
  createdAt: string;
  /** 时间是否被夹到允许区间 */
  clamped?: boolean;
}

interface QueueFile {
  version: number;
  entries: ScheduleEntry[];
}

/** 队列归属：观察模式与模拟盘各一份，避免两个后端抢同一条计划 */
export type ScheduleRole = "live" | "paper";

/** 当前进程属于哪个角色（CLI 在进入模式 / 拉起后端时设置） */
export function currentScheduleRole(): ScheduleRole {
  return process.env.XZH_BTC_ROLE === "paper" ? "paper" : "live";
}

/** `live` → schedules.json；`paper` → schedules-paper.json */
export function scheduleQueuePath(
  home = getBtcHome(),
  role: ScheduleRole = "live",
): string {
  const name = role === "paper" ? "schedules-paper.json" : "schedules.json";
  return path.join(home, "run", name);
}

/** 旧版单条计划的文件（早期版本写过），读到就迁移进队列 */
function legacySchedulePath(home: string): string {
  return path.join(home, "run", "schedule.json");
}

function sortByTime(entries: ScheduleEntry[]): ScheduleEntry[] {
  return [...entries].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id),
  );
}

/**
 * 兼容旧条目：早期只记了 `plannedBy`，没有 `slot`。
 * 巡检写的视作 next（每轮只有一个「下次」），手动加的视作 extra。
 */
function normalize(entry: unknown): ScheduleEntry | null {
  const raw = entry as Partial<ScheduleEntry> & { plannedBy?: ScheduleOrigin };
  if (typeof raw?.id !== "string" || typeof raw?.at !== "string") return null;
  if (Number.isNaN(Date.parse(raw.at))) return null;
  const origin: ScheduleOrigin = raw.origin ?? raw.plannedBy ?? "inspect";
  const slot: ScheduleSlot = raw.slot ?? (origin === "inspect" ? "next" : "extra");
  return {
    id: raw.id,
    at: raw.at,
    reason: raw.reason ?? "（无理由）",
    decision: raw.decision,
    slot,
    origin,
    createdAt: raw.createdAt ?? new Date().toISOString(),
    clamped: raw.clamped,
  };
}

export function readScheduleQueue(
  home = getBtcHome(),
  role: ScheduleRole = "live",
): ScheduleEntry[] {
  try {
    const raw = fs.readFileSync(scheduleQueuePath(home, role), "utf8");
    const parsed = JSON.parse(raw) as Partial<QueueFile>;
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    return sortByTime(
      entries.map(normalize).filter((entry): entry is ScheduleEntry => entry !== null),
    );
  } catch {
    return role === "live" ? migrateLegacy(home) : [];
  }
}

function migrateLegacy(home: string): ScheduleEntry[] {
  try {
    const raw = fs.readFileSync(legacySchedulePath(home), "utf8");
    const old = JSON.parse(raw) as {
      nextCheckAt?: string;
      reason?: string;
      decision?: string;
      plannedBy?: ScheduleOrigin;
      at?: string;
      clamped?: boolean;
    };
    if (!old?.nextCheckAt || Number.isNaN(Date.parse(old.nextCheckAt))) return [];
    const entry: ScheduleEntry = {
      id: `legacy-${Date.parse(old.nextCheckAt)}`,
      at: old.nextCheckAt,
      reason: old.reason ?? "（旧版计划迁移）",
      decision: old.decision,
      slot: "next",
      origin: old.plannedBy ?? "inspect",
      createdAt: old.at ?? new Date().toISOString(),
      clamped: old.clamped,
    };
    writeScheduleQueue(home, [entry]);
    fs.rmSync(legacySchedulePath(home), { force: true });
    return [entry];
  } catch {
    return [];
  }
}

export function writeScheduleQueue(
  home: string,
  entries: ScheduleEntry[],
  role: ScheduleRole = "live",
): void {
  const file = scheduleQueuePath(home, role);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body: QueueFile = { version: 1, entries: sortByTime(entries) };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export interface PlanInput {
  /** 多少分钟后再巡检 */
  minutes?: number;
  /** 或指定一个时间点（ISO / 可被 Date.parse 解析） */
  at?: string;
  now?: number;
}

export interface PlanOutput {
  nextCheckAt: Date;
  clamped: boolean;
}

/**
 * 计算下次巡检时间并夹到允许区间。
 *
 * 非法/缺失输入退回默认间隔；`at` 解析失败也退回默认（并标记 clamped，
 * 让模型知道它给的时间没被采纳）。
 */
export function computeNextCheck(input: PlanInput = {}): PlanOutput {
  const now = input.now ?? Date.now();
  const minMs = MIN_CHECK_MINUTES * 60_000;
  const maxMs = MAX_CHECK_MINUTES * 60_000;
  const defaultMs = DEFAULT_CHECK_MINUTES * 60_000;

  let target = now + defaultMs;
  let clamped = false;

  if (input.at) {
    const parsed = Date.parse(input.at);
    if (Number.isNaN(parsed)) {
      clamped = true;
    } else {
      target = parsed;
    }
  } else if (
    typeof input.minutes === "number" &&
    Number.isFinite(input.minutes) &&
    input.minutes > 0
  ) {
    target = now + input.minutes * 60_000;
  }

  const delta = target - now;
  if (delta < minMs) {
    target = now + minMs;
    clamped = true;
  } else if (delta > maxMs) {
    target = now + maxMs;
    clamped = true;
  }

  return { nextCheckAt: new Date(target), clamped };
}

export interface PushInput {
  minutes?: number;
  at?: string;
  reason: string;
  decision?: string;
  /** 默认 next：改写「下一跳」，会顶掉旧的 next */
  slot?: ScheduleSlot;
  origin: ScheduleOrigin;
  now?: number;
}

export interface PushResult {
  entry: ScheduleEntry;
  /** 被顶掉的条数（改写 next 时通常是 1） */
  replaced: number;
  /** 被顶掉的是哪几条（便于告诉用户「原来那条已取消」） */
  replacedEntries: ScheduleEntry[];
  /** 因队列上限被丢弃的条数 */
  dropped: number;
  /** 入队后队列长度 */
  size: number;
}

/**
 * 把一条计划放进队列。
 *
 * - `slot: "next"`（默认）：顶掉队列里所有 next，保证「下一跳」唯一 ——
 *   这样「1 小时后改成 30 分钟后」只需要再写一条，不会两条都跑；
 * - `slot: "extra"`：追加；同一分钟内的重复会合并。
 */
export function pushSchedule(
  home: string,
  input: PushInput,
  role: ScheduleRole = "live",
): PushResult {
  const now = input.now ?? Date.now();
  const { nextCheckAt, clamped } = computeNextCheck({
    minutes: input.minutes,
    at: input.at,
    now,
  });

  const slot: ScheduleSlot = input.slot ?? "next";
  const entry: ScheduleEntry = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: nextCheckAt.toISOString(),
    reason: input.reason,
    decision: input.decision,
    slot,
    origin: input.origin,
    createdAt: new Date(now).toISOString(),
    clamped,
  };

  const existing = readScheduleQueue(home, role);
  const replacedEntries: ScheduleEntry[] = [];
  const kept = existing.filter((item) => {
    if (slot === "next") {
      if (item.slot !== "next") return true;
      replacedEntries.push(item);
      return false;
    }
    // extra：同一分钟只留一条
    if (item.slot !== "extra") return true;
    const sameMinute =
      Math.floor(Date.parse(item.at) / 60_000) ===
      Math.floor(Date.parse(entry.at) / 60_000);
    if (!sameMinute) return true;
    replacedEntries.push(item);
    return false;
  });

  let next = sortByTime([...kept, entry]);
  let dropped = 0;
  while (next.length > MAX_QUEUE_SIZE) {
    // 从最远的开始丢：近的计划更可能有价值
    next = next.slice(0, MAX_QUEUE_SIZE);
    dropped += 1;
  }

  writeScheduleQueue(home, next, role);
  return {
    entry,
    replaced: replacedEntries.length,
    replacedEntries,
    dropped,
    size: next.length,
  };
}

/** 取出最早一条**已到期**的计划（取出即出队）；没有则返回 null */
export function takeDueSchedule(
  home = getBtcHome(),
  now = Date.now(),
  role: ScheduleRole = "live",
): ScheduleEntry | null {
  const entries = readScheduleQueue(home, role);
  const index = entries.findIndex((entry) => Date.parse(entry.at) <= now);
  if (index < 0) return null;

  const [due] = entries.splice(index, 1);
  writeScheduleQueue(home, entries, role);
  return due;
}

/** 队列里最早一条（不管是否到期），供状态展示 */
export function nextScheduledEntry(
  home = getBtcHome(),
  role: ScheduleRole = "live",
): ScheduleEntry | null {
  return readScheduleQueue(home, role)[0] ?? null;
}

export interface RemoveOptions {
  /** 按 id 撤销（优先于 scope） */
  id?: string;
  /** 没给 id 时撤销哪一类；默认 next（「取消下次巡检」是最常见诉求） */
  scope?: ScheduleSlot | "all";
}

export interface RemoveResult {
  removed: ScheduleEntry[];
  remaining: number;
}

/** 撤销队列里的计划（按 id 或按槽位） */
export function removeSchedules(
  home = getBtcHome(),
  options: RemoveOptions = {},
  role: ScheduleRole = "live",
): RemoveResult {
  const entries = readScheduleQueue(home, role);
  const wantedId = options.id?.trim();
  const scope = options.scope ?? "next";

  const removed: ScheduleEntry[] = [];
  const kept = entries.filter((entry) => {
    const match = wantedId
      ? entry.id === wantedId
      : scope === "all"
        ? true
        : entry.slot === scope;
    if (match) removed.push(entry);
    return !match;
  });

  if (removed.length > 0) writeScheduleQueue(home, kept, role);
  return { removed, remaining: kept.length };
}
