import * as fs from "fs";
import * as path from "path";
import { getBtcHome } from "../utils/paths";

/**
 * 后端「暂停」开关（`~/.xzh_btc/run/paused.json`）。
 *
 * 与 `xzh btc stop` 的区别：
 * - **暂停**（对话内 `/stop`）：进程还在、队列还在、状态还在，只是不再按队列执行巡检、
 *   也不再自动交易；恢复瞬间就能继续，不会丢掉排期。
 * - **停止**（`xzh btc stop`）：进程退出，需要重新 `xzh btc` 才回来。
 *
 * 用文件而不是信号：TUI 与后端是**两个进程**，TUI 里按 Ctrl+C 影响不到后端。
 */

export interface PauseState {
  paused: boolean;
  /** 何时暂停（ISO） */
  at?: string;
  /** 谁暂停的（`/stop` 之类，便于事后追） */
  by?: string;
}

export function pausePath(home = getBtcHome()): string {
  return path.join(home, "run", "paused.json");
}

export function readPause(home = getBtcHome()): PauseState {
  const file = pausePath(home);
  // 文件不存在 = 从未暂停过（默认就是运行）
  if (!fs.existsSync(file)) return { paused: false };

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PauseState;
    return { paused: parsed.paused === true, at: parsed.at, by: parsed.by };
  } catch {
    // 文件在但读坏了：**按暂停处理**。反过来会让「用户已经按下 /stop」
    // 变成「后端自己恢复交易」，这个方向的错误代价太高。
    return { paused: true, by: "unreadable" };
  }
}

export function isPaused(home = getBtcHome()): boolean {
  return readPause(home).paused;
}

export function setPaused(
  home: string,
  paused: boolean,
  by = "/stop",
): PauseState {
  const file = pausePath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const state: PauseState = paused
    ? { paused: true, at: new Date().toISOString(), by }
    : { paused: false };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return state;
}
