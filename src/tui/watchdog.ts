import { Worker } from "worker_threads";
import * as path from "path";
import { getErrorsDir } from "../utils/paths";
import type { WatchdogControl, WatchdogStatus } from "../tools/types";

/**
 * TUI 卡死看门狗。
 *
 * 为什么不能用普通 `setTimeout`：2026-11-22 的卡死是**同步死循环**
 * （`hasCredentialAssignment` 的正则漏了 `g`），事件循环被占满，
 * 同进程里的定时器根本不会触发。只有另一个线程（Worker）才能在主线程
 * 完全停住时继续计时。
 *
 * 机制：
 * - 主线程每 1s 用 `Atomics.add` 给 SharedArrayBuffer 的心跳 +1；
 * - Worker 每秒检查心跳是否变化；连续 `timeoutMs` 没变化即判定卡死；
 * - `timeoutMs` 也放在共享内存里，模型可以通过 `watchdog` 工具**临时**放宽
 *   （只影响当前进程，且带租约自动回退；不能关闭）；
 * - 先恢复终端（退出备用屏 / 显示光标 / 关闭鼠标与括号粘贴 / `stty sane`），
 *   写一条 `state/errors/watchdog.log`，再 `SIGKILL` 主进程。
 *
 * 这只能兜底「同步卡死」。模型慢、网络挂起不会触发 —— 那些场景事件循环是活的，
 * 心跳照常，已有 idle timeout / 中断机制处理。
 */

export interface WatchdogHandle extends WatchdogControl {
  stop(): void;
}

export interface WatchdogOptions {
  /** 连续多久没有心跳就强制退出（毫秒）；<=0 表示关闭 */
  timeoutMs: number;
}

/** 共享状态：0 = 心跳计数，1 = 当前超时（毫秒） */
const STATE_LENGTH = 2;
/** 临时放宽的租约：到期后自动恢复默认，避免模型忘记 restore */
const LEASE_MARGIN_MS = 60_000;

/** Worker 代码内联，保证打包后仍是单文件（不依赖额外资源文件） */
const WORKER_SOURCE = `
const { workerData } = require("worker_threads");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { shared, pid, logFile } = workerData;
const state = new Int32Array(shared, 0, 2);
let last = Atomics.load(state, 0);
let stalledMs = 0;

const timer = setInterval(() => {
  const now = Atomics.load(state, 0);
  if (now === last) {
    stalledMs += 1000;
  } else {
    last = now;
    stalledMs = 0;
  }
  // 超时值由主线程通过 watchdog 工具动态修改（临时放宽 / restore）
  const timeoutMs = Atomics.load(state, 1);
  if (!(timeoutMs > 0)) return;
  if (stalledMs < timeoutMs) return;
  clearInterval(timer);

  // 1) 尽量把终端还原到可用状态（主线程若还活着，它的 exitTerminal 也来不及跑）
  try {
    fs.writeSync(1, "\\x1b[?1049l\\x1b[?25h\\x1b[?1000l\\x1b[?1002l\\x1b[?1006l\\x1b[?2004l\\x1b[?7h\\r\\n");
    if (process.platform !== "win32") {
      spawnSync("stty", ["sane"], { stdio: [0, 1, 2] });
    }
    fs.writeSync(
      2,
      "\\n[xzh watchdog] 检测到界面无响应 " +
        Math.round(timeoutMs / 1000) +
        " 秒，已强制退出。\\n" +
        "[xzh watchdog] 本轮未提交的对话不会保存；可重新运行 xzh 继续。\\n",
    );
  } catch {
    // 终端已经没了也不能挡住退出
  }

  // 2) 记一条日志，方便事后定位（不写对话内容，避免敏感信息）
  try {
    fs.mkdirSync(require("path").dirname(logFile), { recursive: true });
    fs.appendFileSync(
      logFile,
      JSON.stringify({
        at: new Date().toISOString(),
        pid,
        stalledSeconds: Math.round(timeoutMs / 1000),
        note: "event loop blocked; watchdog killed process",
      }) + "\\n",
    );
  } catch {
    // 日志失败不影响退出
  }

  // 3) 强杀主进程：它卡在同步代码里，SIGTERM 的处理函数同样跑不到
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 已经退出
  }
  process.exit(0);
}, 1000);
// 注意：worker 里的定时器**不能 unref** —— 它没有别的 ref 句柄，unref 后 worker 会立刻退出。
// 主线程那边已经 worker.unref()，不会因为看门狗而阻止 xzh 正常退出。
`;

/**
 * 启动看门狗；timeoutMs <= 0、显式关闭、或调试器附加时返回 null。
 *
 * 调试器附加时必须关闭：断点会让主线程暂停，心跳停止，看门狗会把被调试进程杀掉。
 */
export function startHangWatchdog(
  options: WatchdogOptions,
): WatchdogHandle | null {
  if (!(options.timeoutMs > 0)) return null;
  if (process.env.XZH_DISABLE_WATCHDOG === "1") return null;
  if (process.execArgv.some((arg) => arg.startsWith("--inspect"))) return null;

  const shared = new SharedArrayBuffer(4 * STATE_LENGTH);
  const state = new Int32Array(shared, 0, STATE_LENGTH);
  const defaultMs = options.timeoutMs;
  Atomics.store(state, 1, defaultMs);

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      shared,
      pid: process.pid,
      logFile: path.join(getErrorsDir(), "watchdog.log"),
    },
  });
  // 不能阻止主进程正常退出
  worker.unref();

  const heartbeat = setInterval(() => {
    Atomics.add(state, 0, 1);
  }, 1000);
  heartbeat.unref();

  let leaseTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  const clearLease = (): void => {
    if (leaseTimer) {
      clearTimeout(leaseTimer);
      leaseTimer = undefined;
    }
  };

  const status = (): WatchdogStatus => {
    const timeoutMs = stopped ? defaultMs : Atomics.load(state, 1);
    return {
      active: !stopped,
      timeoutSeconds: Math.round(timeoutMs / 1000),
      defaultSeconds: Math.round(defaultMs / 1000),
      extended: !stopped && timeoutMs > defaultMs,
    };
  };

  const restore = (): WatchdogStatus => {
    clearLease();
    if (!stopped) Atomics.store(state, 1, defaultMs);
    return status();
  };

  return {
    status,
    restore,
    extend(seconds: number): WatchdogStatus {
      if (stopped) return status();
      const targetMs = Math.max(defaultMs, Math.round(seconds * 1000));
      Atomics.store(state, 1, targetMs);
      clearLease();
      // 租约：模型忘了 restore 时，targetMs 之后自动回到默认；
      // 若主线程正被同步代码卡住，定时器会在恢复后立即执行，不影响本次判定。
      leaseTimer = setTimeout(() => {
        leaseTimer = undefined;
        Atomics.store(state, 1, defaultMs);
      }, targetMs + LEASE_MARGIN_MS);
      leaseTimer.unref();
      return status();
    },
    stop() {
      stopped = true;
      clearLease();
      clearInterval(heartbeat);
      void worker.terminate();
    },
  };
}
