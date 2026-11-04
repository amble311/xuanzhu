import * as fs from "fs";
import * as path from "path";
import { getBtcHome } from "../utils/paths";
import { readActions } from "./actions";

/**
 * 交易绩效的**判定输入**（供硬性风控使用）。
 *
 * 为什么从动作账本算而不是再记一份：平仓时就已经把盈亏写进 `actions.jsonl` 了
 * （见 `trading.closePosition`），再维护一份 trade 表只会多一处不同步的地方。
 *
 * 已知边界：账本只含**我们自己发起的平仓**。用户在币安 App 手动平的仓不在里面，
 * 所以「连亏次数」可能偏少 —— 这是保守方向（少报比多报好），但不能当审计用。
 */

/** 连续亏损次数：从最近一笔往前数，遇到不亏的就停 */
export function consecutiveLosses(home = getBtcHome()): number {
  const closes = readActions(home).filter(
    (action) => action.kind === "close" && typeof action.pnl === "number",
  );

  let count = 0;
  for (let index = closes.length - 1; index >= 0; index--) {
    if ((closes[index].pnl ?? 0) < 0) count += 1;
    else break;
  }
  return count;
}

export interface DailyBaseline {
  /** 本地日期 `YYYY-MM-DD` */
  date: string;
  /** 当天开始时的权益（USDT） */
  startEquity: number;
  /** 何时建立的基准 */
  at: string;
}

export function dailyPath(home = getBtcHome()): string {
  return path.join(home, "run", "daily.json");
}

function localDate(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function readBaseline(file: string): DailyBaseline | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as DailyBaseline;
    if (typeof parsed.date === "string" && Number(parsed.startEquity) > 0) {
      return { ...parsed, startEquity: Number(parsed.startEquity) };
    }
  } catch {
    // 不存在或写坏了：当作今天还没基准
  }
  return null;
}

/**
 * 当日权益亏损百分比（正数 = 亏了多少）。
 *
 * 基准是**当天第一次检查时**的权益。首次启动（或跨天）会以当前权益建立基准 ——
 * 我们只能观察自己看到的变化，起手之前的历史回撤无从得知。
 */
export function dailyLossPct(
  equity: number,
  home = getBtcHome(),
): number | undefined {
  if (!(equity > 0)) return undefined;

  const file = dailyPath(home);
  const today = localDate();
  const baseline = readBaseline(file);

  if (!baseline || baseline.date !== today) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const next: DailyBaseline = {
      date: today,
      startEquity: equity,
      at: new Date().toISOString(),
    };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
    return 0;
  }

  return ((baseline.startEquity - equity) / baseline.startEquity) * 100;
}
