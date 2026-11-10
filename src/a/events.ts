import * as fs from "fs";
import * as path from "path";
import { monitorDir } from "./watchlist";

/**
 * 确定性市场事件（对齐 btc market-events）：到点唤醒巡检，不依赖模型自己想起来。
 * 每个事件每天只触发一次；失败时由 tick 另排退避。
 */

interface EventState {
  date: string;
  handled: string[];
}

const FILE = "run/events.json";

interface EventDef {
  id: string;
  minute: number;
  reason: string;
}

const EVENTS: EventDef[] = [
  { id: "open", minute: 9 * 60, reason: "开盘准备：确认持仓与自选股，检查隔夜公告" },
  { id: "midday", minute: 11 * 60 + 30, reason: "午间复盘：上午走势与持仓风险" },
  { id: "tail", minute: 14 * 60 + 45, reason: "尾盘决策：持仓去留与次日计划" },
  { id: "close", minute: 15 * 60 + 25, reason: "收盘总结：更新计划与监控规则" },
];

function statePath(): string {
  return path.join(monitorDir(), FILE);
}

function today(now: Date): string {
  return `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, "0")}-${`${now.getDate()}`.padStart(2, "0")}`;
}

function readState(now: Date): EventState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), "utf8")) as EventState;
    if (parsed.date === today(now)) return parsed;
  } catch {
    // 首次/坏文件
  }
  return { date: today(now), handled: [] };
}

function writeState(state: EventState): void {
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/** 取当前应触发的事件（每天一次）；返回 null 表示没有 */
export function takeMarketEvent(now = new Date()): { id: string; reason: string } | null {
  if (now.getDay() === 0 || now.getDay() === 6) return null;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const state = readState(now);
  const due = EVENTS.filter(
    (event) => event.minute <= minutes && !state.handled.includes(event.id),
  ).at(-1);
  if (!due) return null;
  state.handled.push(due.id);
  writeState(state);
  return { id: due.id, reason: due.reason };
}
