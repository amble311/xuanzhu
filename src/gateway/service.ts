import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { VERSION } from "../utils/version";
import { gatewayHome, gatewayPaths } from "./paths";

/** 写入 `run/gateway.json` 的运行状态（面板/`status` 读它） */
export interface GatewayState {
  pid: number;
  startedAt: string;
  /** 心跳：常驻进程每 30 秒刷新一次，用来区分「活着」与「卡死」 */
  updatedAt: string;
  version: string;
  cwd: string;
  port: number;
  model?: string;
  /** 最近一次错误（模型不可用等） */
  lastError?: string;
}

export const DEFAULT_GATEWAY_PORT = 17890;

export function gatewayPort(): number {
  const raw = Number(process.env.XZH_GATEWAY_PORT);
  return Number.isFinite(raw) && raw > 0 && raw < 65_536
    ? Math.round(raw)
    : DEFAULT_GATEWAY_PORT;
}

/** pid 是否还活着（EPERM 也算活着：进程属于别人时不能当成已退出） */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readGatewayState(home = gatewayHome()): GatewayState | null {
  const { stateFile } = gatewayPaths(home);
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8")) as GatewayState;
    return typeof parsed?.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeGatewayState(state: GatewayState, home = gatewayHome()): void {
  const { stateFile, run } = gatewayPaths(home);
  fs.mkdirSync(run, { recursive: true });
  // 先写临时文件再 rename：面板/status 可能正好在读到一半，不能让它看到半个 JSON
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, stateFile);
}

export interface GatewayStatus {
  running: boolean;
  state: GatewayState | null;
  /** 有状态但 pid 不在了：残留文件，启动前会被清理 */
  stale: boolean;
  home: string;
  autostart: AutostartStatus;
}

export function gatewayStatus(home = gatewayHome()): GatewayStatus {
  const state = readGatewayState(home);
  const alive = state !== null && isPidAlive(state.pid);
  return {
    running: alive,
    state: alive ? state : null,
    stale: state !== null && !alive,
    home,
    autostart: autostartStatus(),
  };
}

function cliEntry(): string {
  return process.argv[1] ?? path.join(__dirname, "cli.js");
}

export interface StartGatewayResult {
  ok: boolean;
  /** 本次是否新拉起（已在运行时为 false） */
  started: boolean;
  state?: GatewayState;
  error?: string;
}

/**
 * 拉起常驻进程（detached）。
 *
 * 与 btc 后端同一套路：`stdio` 全部重定向到日志文件，父进程 `unref()` 后立即返回。
 * 关键差别是**不能让它跟着终端退出**：这里用 detached + 忽略 stdin，
 * 进程内还会忽略 SIGHUP（SSH 断线时 shell 会给它发 SIGHUP）。
 */
export async function startGateway(
  options: { waitMs?: number; home?: string } = {},
): Promise<StartGatewayResult> {
  const home = options.home ?? gatewayHome();
  const paths = gatewayPaths(home);
  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.logs, { recursive: true });
  fs.mkdirSync(paths.run, { recursive: true });

  const existing = readGatewayState(home);
  if (existing && isPidAlive(existing.pid)) {
    return { ok: true, started: false, state: existing };
  }
  // 残留状态（进程已死）先清掉，避免新进程写状态时被误判
  if (existing) {
    try {
      fs.rmSync(paths.stateFile, { force: true });
    } catch {
      // 读不到/删不掉都不是致命问题
    }
  }

  let logFd: number;
  try {
    logFd = fs.openSync(paths.logFile, "a");
  } catch (err) {
    return {
      ok: false,
      started: false,
      error: `无法写日志：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const child = spawn(process.execPath, [cliEntry(), "gateway", "run"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: home,
      env: { ...process.env },
    });
    child.unref();
  } catch (err) {
    return {
      ok: false,
      started: false,
      error: `拉起 gateway 失败：${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    try {
      fs.closeSync(logFd);
    } catch {
      // 子进程已继承
    }
  }

  const deadline = Date.now() + (options.waitMs ?? 4_000);
  while (Date.now() < deadline) {
    const state = readGatewayState(home);
    if (state && isPidAlive(state.pid)) {
      return { ok: true, started: true, state };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const logs = tailLog(paths.logFile, 8);
  return {
    ok: false,
    started: true,
    error: `启动后 4 秒内没有写出状态${logs ? `：\n${logs}` : ""}`,
  };
}

function tailLog(file: string, lines: number): string {
  try {
    const text = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    return text.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

export interface StopGatewayResult {
  ok: boolean;
  stopped: boolean;
  error?: string;
}

/** 停止常驻进程：SIGTERM → 等 5 秒 → SIGKILL（只对确认是自己拉起的 pid） */
export async function stopGateway(
  options: { home?: string; waitMs?: number } = {},
): Promise<StopGatewayResult> {
  const home = options.home ?? gatewayHome();
  const paths = gatewayPaths(home);
  const state = readGatewayState(home);
  if (!state) {
    return { ok: true, stopped: false };
  }
  if (!isPidAlive(state.pid)) {
    // 残留状态：清掉即可，别去 kill 一个可能被系统复用的 pid
    try {
      fs.rmSync(paths.stateFile, { force: true });
    } catch {
      // ignore
    }
    return { ok: true, stopped: false };
  }

  try {
    process.kill(state.pid, "SIGTERM");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      return {
        ok: false,
        stopped: false,
        error: `发送 SIGTERM 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const deadline = Date.now() + (options.waitMs ?? 5_000);
  while (Date.now() < deadline) {
    if (!isPidAlive(state.pid)) {
      try {
        fs.rmSync(paths.stateFile, { force: true });
      } catch {
        // ignore
      }
      return { ok: true, stopped: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  try {
    process.kill(state.pid, "SIGKILL");
    fs.rmSync(paths.stateFile, { force: true });
    return { ok: true, stopped: true };
  } catch (err) {
    return {
      ok: false,
      stopped: false,
      error: `进程 ${state.pid} 未在 5 秒内退出：${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

export async function restartGateway(
  home = gatewayHome(),
): Promise<StartGatewayResult & { stopped: boolean }> {
  const stopped = await stopGateway({ home });
  if (!stopped.ok) {
    return { ok: false, started: false, stopped: false, error: stopped.error };
  }
  const started = await startGateway({ home });
  return { ...started, stopped: stopped.stopped };
}

// ─────────────────────────── 开机自启 ───────────────────────────

export interface AutostartStatus {
  /** 当前平台是否支持自动安装 */
  supported: boolean;
  /** 配置是否已存在（不代表已经 enable） */
  installed: boolean;
  /** systemd 是否真的处于 enabled 状态（系统已装但没有 enable 时为 false） */
  enabled: boolean;
  /** 自启配置文件路径（给用户看，便于手动处理） */
  path?: string;
  /** 为什么不可用 */
  reason?: string;
}

const UNIT_NAME = "xzh-gateway.service";

export function systemdUnitPath(): string {
  return path.join(os.homedir(), ".config", "systemd", "user", UNIT_NAME);
}

/**
 * systemd user unit 内容。
 *
 * - `Restart=always` + `RestartSec=5`：gateway 崩了要自己回来，否则「开机自启」只在开机那一秒成立；
 * - `After=network-online.target`：它要连模型 API，网络没起来时启动会白失败一次；
 * - `Environment=PATH=...`：Node 走 spawn 时依赖 PATH（git/uv 之类），systemd 的环境和 shell 不同。
 */
export function systemdUnitFile(
  execPath: string,
  entry: string,
  home: string,
): string {
  return [
    "[Unit]",
    "Description=XuanZhu Gateway (headless, 常驻后台)",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${home}`,
    `Environment=PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    `ExecStart="${execPath}" "${entry}" gateway run`,
    // 退出后自动拉起：常驻服务的核心语义，`quit`/`exit` 不该让它消失
    "Restart=always",
    "RestartSec=5",
    // 不设 TimeoutStopSec 时默认 90 秒，会把 `xzh gateway stop` 拖很久
    "TimeoutStopSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function autostartStatus(): AutostartStatus {
  if (process.platform !== "linux") {
    return {
      supported: false,
      installed: false,
      enabled: false,
      reason:
        process.platform === "darwin"
          ? "macOS 需要 launchd（当前版本未自动安装，可手写 LaunchAgent）"
          : `当前平台 ${process.platform} 不支持自动安装开机自启`,
    };
  }
  const file = systemdUnitPath();
  const installed = fs.existsSync(file);
  let enabled = false;
  if (installed) {
    const result = spawnSync(
      "systemctl",
      ["--user", "is-enabled", UNIT_NAME],
      { encoding: "utf8" },
    );
    enabled = (result.stdout ?? "").trim() === "enabled";
  }
  return {
    supported: true,
    installed,
    enabled,
    path: file,
  };
}

/**
 * 安装并启用开机自启（幂等）。
 *
 * 失败**不抛错**：没有 systemd 的机器（容器、WSL1）仍然能手动 `xzh gateway`，
 * 不该因为「装不了自启」就拒绝启动服务。
 */
export function installAutostart(): {
  ok: boolean;
  path?: string;
  error?: string;
} {
  const status = autostartStatus();
  if (!status.supported) {
    return { ok: false, error: status.reason };
  }
  const file = systemdUnitPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    systemdUnitFile(process.execPath, cliEntry(), gatewayHome()),
    "utf8",
  );

  const reload = spawnSync("systemctl", ["--user", "daemon-reload"], {
    encoding: "utf8",
  });
  if (reload.error) {
    return {
      ok: false,
      path: file,
      error: `systemctl 不可用：${reload.error.message}`,
    };
  }
  const enable = spawnSync(
    "systemctl",
    ["--user", "enable", UNIT_NAME],
    { encoding: "utf8" },
  );
  if (enable.status !== 0) {
    return {
      ok: false,
      path: file,
      error:
        (enable.stderr ?? "").trim() ||
        `systemctl enable 退出码 ${enable.status}（可能需要 loginctl enable-linger $USER）`,
    };
  }
  return { ok: true, path: file };
}

export function uninstallAutostart(): { ok: boolean; error?: string } {
  const status = autostartStatus();
  if (!status.supported) return { ok: false, error: status.reason };
  spawnSync("systemctl", ["--user", "disable", UNIT_NAME], { encoding: "utf8" });
  try {
    fs.rmSync(systemdUnitPath(), { force: true });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  spawnSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
  return { ok: true };
}

export const GATEWAY_VERSION = VERSION;
