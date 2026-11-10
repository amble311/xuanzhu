import * as fs from "fs";
import * as path from "path";
import { monitorDir } from "./watchlist";

/** 暂停标记：进程/队列/规则都保留，只是不触发巡检与交易 */
export interface APauseState {
  paused: boolean;
  at?: string;
  by?: string;
}

function pausePath(): string {
  return path.join(monitorDir(), "run", "paused.json");
}

export function readPause(): APauseState {
  try {
    const parsed = JSON.parse(fs.readFileSync(pausePath(), "utf8")) as APauseState;
    return { paused: parsed.paused === true, at: parsed.at, by: parsed.by };
  } catch {
    return { paused: false };
  }
}

export function isPaused(): boolean {
  return readPause().paused;
}

export function setPaused(paused: boolean, by = "/pause"): APauseState {
  const state: APauseState = {
    paused,
    ...(paused ? { at: new Date().toISOString(), by } : {}),
  };
  const file = pausePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return state;
}
