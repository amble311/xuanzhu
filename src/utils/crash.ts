import * as fs from "fs";
import * as path from "path";
import { getConfigDir } from "./paths";

/**
 * 异常退出诊断。
 *
 * 背景：TUI 运行在**备用屏**里，一旦发生未捕获异常、或进程被 OOM Killer / 信号杀掉，
 * 界面会直接消失回到 shell，用户只看到"突然终止"，拿不到任何线索。
 *
 * 做法是「会话标记 + 崩溃日志」两个文件：
 *   - 启动时写 `session.lock`（含启动时间与版本）；
 *   - 正常退出时删除它；
 *   - 崩溃时把错误写入 `crash.log`。
 * 于是下次启动只要发现 `session.lock` 还在，就能断定**上次是异常退出**，
 * 并把日志内容提示给用户 —— 这条路径不依赖崩溃当时能否写 stdout，
 * 连 OOM 这种来不及执行任何 JS 的终止也能被下一次启动发现。
 */

function lockPath(): string {
  return path.join(getConfigDir(), "session.lock");
}

function logPath(): string {
  return path.join(getConfigDir(), "crash.log");
}

export interface PreviousExit {
  /** 上次启动的时间（ISO 字符串），读取失败时为 undefined */
  startedAt?: string;
  /** 上次的版本 */
  version?: string;
  /** 崩溃日志内容（存在时） */
  crashLog?: string;
}

/**
 * 标记会话开始，并返回「上次是否异常退出」的信息。
 *
 * 必须在 TUI 进入备用屏**之前**调用：一旦进入备用屏，崩溃时的输出就容易被忽略。
 */
export function markSessionStart(version: string): PreviousExit | null {
  const previous: PreviousExit | null = readPrevious();
  try {
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), version }),
      { mode: 0o600 },
    );
  } catch {
    // 写不了锁文件不影响运行，只是失去这次诊断能力
  }
  return previous;
}

/** 读取上次异常退出的信息；若上次是正常退出则返回 null */
function readPrevious(): PreviousExit | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath(), "utf8");
  } catch {
    return null; // 没有锁文件 = 上次正常退出，或首次运行
  }

  const info: PreviousExit = {};
  try {
    const parsed = JSON.parse(raw) as { startedAt?: string; version?: string };
    info.startedAt = parsed.startedAt;
    info.version = parsed.version;
  } catch {
    // 锁文件损坏也算异常退出
  }

  try {
    // 只保留最近一段，避免日志无限增长
    const log = fs.readFileSync(logPath(), "utf8");
    info.crashLog = log.slice(-4000);
  } catch {
    // 没有日志（例如被 OOM 直接杀掉，来不及写）
  }

  return info;
}

/** 记录崩溃信息（供 uncaughtException / unhandledRejection 调用） */
export function recordCrash(kind: string, error: unknown): void {
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  const entry =
    `\n[${new Date().toISOString()}] ${kind}\n` +
    `  版本: ${process.version}  平台: ${process.platform}  PID: ${process.pid}\n` +
    detail
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n") +
    "\n";
  try {
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.appendFileSync(logPath(), entry, "utf8");
  } catch {
    // 尽力而为
  }
}

/** 正常退出时清除标记与旧日志 */
export function markSessionEnd(): void {
  try {
    fs.rmSync(lockPath(), { force: true });
    fs.rmSync(logPath(), { force: true });
  } catch {
    // 忽略
  }
}

/** 崩溃日志路径（用于提示用户） */
export function crashLogPath(): string {
  return logPath();
}
