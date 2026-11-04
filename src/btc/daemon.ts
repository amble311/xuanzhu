import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { getBtcHome } from "../utils/paths";
import { VERSION } from "../utils/version";
import { btcVenvReady, ensureBtcAssets } from "./bootstrap";

/**
 * btc 常驻后端（行情巡检进程）的生命周期管理。
 *
 * 两个**角色**，各自独立（锁 / 状态 / 日志分开，可同时运行）：
 * - `live`  —— `xzh btc`：只观察与记录，不产生交易；
 * - `paper` —— `xzh btc moni`：模拟盘，允许在本地虚拟账本上开平仓（`btc_paper_*`）。
 *
 * 为什么要分成两个进程：模拟盘会持续记账，而观察模式不该被模拟成交污染；
 * 原 btc 项目也是「实盘后端 1661 + 模拟盘后端 1662」两套。
 *
 * 共同点：界面退出都不停它们，下次进入复用；单实例靠**锁文件原子创建**保证，
 * 不是「先检查再创建」。
 */

export type BackendRole = "live" | "paper";

export interface BackendState {
  pid: number;
  role: BackendRole;
  startedAt: string;
  version: string;
  home: string;
  /** 完成过的轮次（巡检或数据同步） */
  cycles?: number;
  /** 当前工作模式：自主巡检 / 仅数据同步 */
  mode?: "inspect" | "sync";
  /** 最近一次巡检完成时间 */
  lastInspectAt?: string;
  /** 最近一次巡检的结论（已截断） */
  lastInspectSummary?: string;
  /** 队列里最早一条计划的时间（ISO）——由模型决定，前后台共享 */
  nextCheckAt?: string;
  /** 为什么定在那个时候 */
  nextCheckReason?: string;
  /** 排期队列长度（可能有多条：后台的下次 + 前台手动加的检查点） */
  queueSize?: number;
  /** 连续失败次数（用于退避） */
  consecutiveFailures?: number;
  /** 是否被 `/stop` 暂停（进程在、队列在，只是不自动执行） */
  paused?: boolean;
  /** 硬性风控是否处于触发状态（面板 / status 展示） */
  riskTriggered?: boolean;
  /** 触发原因 */
  riskReason?: string;
  /** 仅数据同步模式的字段 */
  lastSyncAt?: string;
  lastSyncWritten?: number;
  lastError?: string | null;
}

export interface BackendPaths {
  role: BackendRole;
  /** 运行时目录：~/.btc/run */
  dir: string;
  lockFile: string;
  stateFile: string;
  logFile: string;
}

export const BACKEND_ROLES: BackendRole[] = ["live", "paper"];

export function backendPaths(
  home = getBtcHome(),
  role: BackendRole = "live",
): BackendPaths {
  const dir = path.join(home, "run");
  const prefix = role === "paper" ? "paper" : "backend";
  return {
    role,
    dir,
    lockFile: path.join(dir, `${prefix}.lock`),
    stateFile: path.join(dir, `${prefix}.json`),
    logFile: path.join(home, "logs", `${prefix}.log`),
  };
}

/** 进程是否存活（`EPERM` 也表示活着，只是没权限发信号） */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readBackendState(
  home = getBtcHome(),
  role: BackendRole = "live",
): BackendState | null {
  const { stateFile } = backendPaths(home, role);
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8")) as BackendState;
    return typeof parsed?.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeBackendState(home: string, state: BackendState): void {
  const paths = backendPaths(home, state.role ?? "live");
  fs.mkdirSync(paths.dir, { recursive: true });
  const tmp = `${paths.stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, paths.stateFile);
}

/** 删掉状态与锁文件（只在确认属于自己 / 已死时调用） */
export function clearBackendFiles(
  home = getBtcHome(),
  role: BackendRole = "live",
): void {
  const paths = backendPaths(home, role);
  for (const file of [paths.stateFile, paths.lockFile]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // 删不掉不影响判断：下次会按 pid 存活情况再判一次
    }
  }
}

/**
 * 当前活着的后端；顺手清掉「进程已死但文件还在」的残留。
 *
 * 不做这步清理的话，崩溃/被强杀之后会一直以为后端在跑，永远不再拉起。
 */
export function liveBackend(
  home = getBtcHome(),
  role: BackendRole = "live",
): BackendState | null {
  const state = readBackendState(home, role);
  if (!state) return null;
  if (isProcessAlive(state.pid)) return state;
  clearBackendFiles(home, role);
  return null;
}

export interface AcquireResult {
  ok: boolean;
  /** 拿不到锁时，正在运行的那个后端 pid */
  pid?: number;
}

/**
 * 后端进程启动时抢锁（原子创建）。
 *
 * `wx` 保证同一时刻只有一个进程能创建成功；失败时如果原 pid 已死，
 * 说明是上次异常退出留下的残留，删掉重试。
 */
export async function acquireBackendLock(
  home = getBtcHome(),
  role: BackendRole = "live",
): Promise<AcquireResult> {
  const paths = backendPaths(home, role);
  fs.mkdirSync(paths.dir, { recursive: true });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(paths.lockFile, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return { ok: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        return { ok: false };
      }

      let holder = Number.NaN;
      try {
        holder = Number(fs.readFileSync(paths.lockFile, "utf8").trim());
      } catch {
        // 读不到的瞬间对方可能刚删锁，重试即可
      }
      if (Number.isInteger(holder) && isProcessAlive(holder)) {
        return { ok: false, pid: holder };
      }
      if (!Number.isInteger(holder)) {
        // 锁文件刚被创建、pid 还没写进去（open 与 write 之间）：等一拍重读，
        // 不能直接当残留删掉 —— 那会把活着的后端放进来第二个。
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      // 确认持有者已死：清掉残留锁再抢
      fs.rmSync(paths.lockFile, { force: true });
    }
  }
  return { ok: false };
}

/** 后端退出时释放：只删属于自己的锁，避免误删别的进程刚建的锁 */
export function releaseBackendLock(
  home = getBtcHome(),
  role: BackendRole = "live",
): void {
  const paths = backendPaths(home, role);
  try {
    const holder = Number(fs.readFileSync(paths.lockFile, "utf8").trim());
    if (holder === process.pid) fs.rmSync(paths.lockFile, { force: true });
  } catch {
    // 锁文件不存在 = 已经清理过
  }
  const state = readBackendState(home, role);
  if (!state || state.pid === process.pid) {
    try {
      fs.rmSync(paths.stateFile, { force: true });
    } catch {
      // 忽略
    }
  }
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** 打开后端日志（追加）；超过 5MB 先轮转一份，避免无限增长 */
export function openLogFile(file: string): number {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    // 不存在 = 首次写入
  }
  return fs.openSync(file, "a");
}

/** 当前 CLI 的可执行入口（detached 子进程用它重新拉起自己） */
function cliEntry(): string {
  return process.argv[1] ?? path.join(__dirname, "cli.js");
}

export interface EnsureBackendResult {
  running: boolean;
  /** 本次是否新拉起 */
  started: boolean;
  state?: BackendState;
  error?: string;
}

export interface EnsureBackendOptions {
  role?: BackendRole;
  /** 等待后端写出状态文件的上限（毫秒） */
  waitMs?: number;
}

/**
 * 确保指定角色的后端在跑：活着就复用，没有就拉一个 detached 进程。
 *
 * 注意它**不阻塞界面启动太久**：最多等 3 秒拿状态文件，拿不到也返回（带 error），
 * 由调用方决定只提示不阻断。
 */
export async function ensureBtcBackend(
  options: EnsureBackendOptions = {},
): Promise<EnsureBackendResult> {
  const home = getBtcHome();
  const role: BackendRole = options.role ?? "live";
  const existing = liveBackend(home, role);
  if (existing) return { running: true, started: false, state: existing };

  const assets = ensureBtcAssets(home);
  if (!assets.available) {
    return { running: false, started: false, error: "计算脚本缺失，无法启动后端" };
  }
  if (!btcVenvReady(home)) {
    return {
      running: false,
      started: false,
      error: "计算环境未就绪（缺 venv），后端暂不启动",
    };
  }

  const paths = backendPaths(home, role);
  let logFd: number;
  try {
    logFd = openLogFile(paths.logFile);
  } catch (err) {
    return {
      running: false,
      started: false,
      error: `无法写后端日志：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const args = [cliEntry(), "btc", "serve"];
    if (role === "paper") args.push("--paper");
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: home,
      env: { ...process.env },
    });
    child.unref();
  } catch (err) {
    return {
      running: false,
      started: false,
      error: `拉起后端失败：${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    try {
      fs.closeSync(logFd);
    } catch {
      // 父进程关不关都行，子进程已继承
    }
  }

  const waitMs = options.waitMs ?? 3_000;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const state = liveBackend(home, role);
    if (state) return { running: true, started: true, state };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return {
    running: false,
    started: true,
    error: `后端未在 ${Math.round(waitMs / 1000)}s 内就绪，查看日志：${paths.logFile}`,
  };
}

export interface StopBackendResult {
  stopped: boolean;
  pid?: number;
  role: BackendRole;
  error?: string;
}

/** 停某个角色的后端：SIGTERM 等 5s，仍在就 SIGKILL */
export async function stopBtcBackend(
  role: BackendRole = "live",
): Promise<StopBackendResult> {
  const home = getBtcHome();
  const state = liveBackend(home, role);
  if (!state) return { stopped: false, role };

  const { pid } = state;
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    clearBackendFiles(home, role);
    return {
      stopped: false,
      role,
      pid,
      error: `发送停止信号失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      clearBackendFiles(home, role);
      return { stopped: true, role, pid };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 已经死了
  }
  clearBackendFiles(home, role);
  return { stopped: true, role, pid };
}

/** 停所有角色（`xzh btc stop` 的默认行为） */
export async function stopAllBackends(): Promise<StopBackendResult[]> {
  const results: StopBackendResult[] = [];
  for (const role of BACKEND_ROLES) {
    results.push(await stopBtcBackend(role));
  }
  return results;
}
