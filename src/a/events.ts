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

/**
 * 事件分钟必须落在**交易时段**内（09:30–11:30 / 13:00–15:00）：
 * 窗口外的 tick 直接 return，永远不会消费这些事件 —— 收盘总结放在 15:25 会变成死代码。
 */
const EVENTS: EventDef[] = [
  // 09:15–09:30 是开盘集合竞价与撮合间隔，没有连续成交价 —— 那时叫醒巡检只会误判，
  // 所以「开盘」事件放在 09:30 连续竞价开始之后。
  { id: "open", minute: 9 * 60 + 30, reason: "开盘后复核：确认持仓与自选股，检查隔夜公告" },
  { id: "midday", minute: 11 * 60 + 25, reason: "午间复盘：上午走势与持仓风险" },
  { id: "tail", minute: 14 * 60 + 40, reason: "尾盘决策：持仓去留与次日计划" },
  // 收盘前 5 分钟做「收盘总结」：15:00 之后不在交易时段，巡检不会再被叫醒
  { id: "close", minute: 14 * 60 + 55, reason: "收盘总结：更新计划与监控规则" },
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
