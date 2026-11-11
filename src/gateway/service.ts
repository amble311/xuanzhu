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

// ─────────────────────── Windows 登录自启 ───────────────────────
//
// Windows 没有 systemd：用 HKCU\...\Run 注册一个 **wscript 隐藏启动器**。
// 不直接注册 node.exe —— 控制台程序会弹黑窗口；wscript 以 `//B` 后台运行，
// 由 VBS 用 `sh.Run(..., 0, True)` 等待 node 退出，崩了 3 秒后重拉，
// 与 systemd 的 `Restart=always` 对齐。
//
// 停止时写 `run/autostart.stop`：VBS 看到它就退出循环，不会把刚停掉的服务又拉起来；
// 下次自启/手动启动时删除该文件。

const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WINDOWS_RUN_VALUE = "XuanZhuGateway";

export function windowsLauncherPath(home = gatewayHome()): string {
  return path.join(gatewayPaths(home).run, "autostart.vbs");
}

export function windowsStopFilePath(home = gatewayHome()): string {
  return path.join(gatewayPaths(home).run, "autostart.stop");
}

/** 注册表 Run 项里保存的启动命令 */
export function windowsAutostartCommand(home = gatewayHome()): string {
  return `wscript.exe //B //Nologo "${windowsLauncherPath(home)}"`;
}

function vbsString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** 隐藏启动器脚本（UTF-16LE + BOM 写入，避免中文用户名路径被按 ANSI 解析） */
export function windowsLauncherScript(
  execPath: string,
  entry: string,
  home: string,
): string {
  return [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = ${vbsString(home)}`,
    `stopFile = ${vbsString(windowsStopFilePath(home))}`,
    `nodeExe = ${vbsString(execPath)}`,
    `entry = ${vbsString(entry)}`,
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'If fso.FileExists(stopFile) Then fso.DeleteFile stopFile, True',
    'cmd = Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & entry & Chr(34) & " gateway run"',
    "Do",
    "  sh.Run cmd, 0, True",
    "  WScript.Sleep 3000",
    "Loop While Not fso.FileExists(stopFile)",
    "",
  ].join("\r\n");
}

function windowsRunValue(): string | undefined {
  const result = spawnSync(
    "reg",
    ["query", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) return undefined;
  const match = /REG_SZ\s+(.+)\s*$/m.exec(result.stdout ?? "");
  return match?.[1].trim();
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
  // 注意：Windows 的 `autostart.stop` 是**锁存**标记，只在下次登录时由启动器清除。
  // 这里不能删它 —— 否则 `stop` 后立刻 `restart` 时，尚未退出的 VBS 循环会看到
  // 标记消失，再拉起第二个 node（端口冲突、反复重试）。

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
      // Windows 上 detached 会分配新控制台；stdio 已重定向，隐藏即可
      windowsHide: true,
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

  // 先让 Windows 自启启动器退出循环，否则 SIGTERM 后 3 秒它会把 gateway 又拉起来
  if (process.platform === "win32") {
    try {
      fs.mkdirSync(paths.run, { recursive: true });
      fs.writeFileSync(windowsStopFilePath(home), new Date().toISOString(), "utf8");
    } catch {
      // 写不了也只影响「停完又被拉起」，不阻断停止
    }
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

// ─────────────────────── 对话内模式命令 ───────────────────────

export type GatewayCommand =
  | { kind: "btc"; paper: boolean }
  | { kind: "a" }
  | { kind: "xzh" }
  | { kind: "help" }
  | { kind: "info" }
  | { kind: "raw"; name: string; arg: string }
  | { kind: "usage"; message: string };

/**
 * 解析 gateway 收到的 `/` 命令（微信消息与 HTTP `/message` 共用）。
 *
 * 只认以 `/` 开头的整条消息；返回 null 表示「这是普通对话」，应交给模型。
 * 命令不进入对话历史 —— 切模式本身不该被模型当成用户需求去执行。
 */
export function parseGatewayCommand(text: string): GatewayCommand | null {
  const trimmed = text.trim();
  // 全角斜杠（中文输入法常见）也认作命令
  if (!/^[／/]/.test(trimmed)) return null;
  const body = trimmed.replace(/^／/, "/").slice(1).trim();
  const parts = body.length > 0 ? body.split(/\s+/) : [];
  const name = (parts.shift() ?? "").toLowerCase();
  // 参数保留原始大小写：/switch 的目录在大小写敏感文件系统上不能被 toLowerCase 破坏
  const arg = parts.join(" ").trim();
  const lower = arg.toLowerCase();

  if (!name || name === "help") return { kind: "help" };
  if (name === "xzh") return { kind: "xzh" };
  if (name === "info") return { kind: "info" };
  if (name === "a") {
    if (!arg) return { kind: "a" };
    if (lower === "off" || lower === "exit") return { kind: "xzh" };
    return { kind: "usage", message: "用法：/a（进入 A 股分析）· /xzh（回到普通模式）" };
  }
  if (name === "btc") {
    if (!arg || lower === "start" || lower === "live") return { kind: "btc", paper: false };
    if (lower === "moni" || lower === "paper") return { kind: "btc", paper: true };
    if (lower === "off" || lower === "exit") return { kind: "xzh" };
    return {
      kind: "usage",
      message: "用法：/btc（实盘）· /btc moni（模拟盘）· /xzh（回到普通模式）",
    };
  }
  // 其余命令交给 gateway 的命令路由（与终端同一套 /help 列表）；
  // 真正不认识的由路由返回用法提示。
  return { kind: "raw", name, arg };
}

export interface GatewayModeState {
  name: "btc" | "a";
  /** 仅 btc：模拟盘 */
  paper?: boolean;
}

export function gatewayModeFile(home = gatewayHome()): string {
  return path.join(gatewayPaths(home).run, "mode.json");
}

/** 读取持久化的模式（gateway 重启后仍保持在 btc / a） */
export function readGatewayMode(home = gatewayHome()): GatewayModeState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(gatewayModeFile(home), "utf8")) as Partial<GatewayModeState>;
    if (parsed?.name !== "btc" && parsed?.name !== "a") return null;
    return {
      name: parsed.name,
      ...(parsed.name === "btc" ? { paper: parsed.paper === true } : {}),
    };
  } catch {
    return null;
  }
}

export function writeGatewayMode(
  state: GatewayModeState | null,
  home = gatewayHome(),
): void {
  const file = gatewayModeFile(home);
  try {
    if (!state) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // 写不了只影响重启后恢复模式，不阻断本次切换
  }
}

export interface PeerModeState {
  lastPeer?: string;
  modes: Record<string, GatewayModeState>;
}

export function peerModeFile(home = gatewayHome()): string {
  return path.join(gatewayPaths(home).run, "peer-modes.json");
}

export function readPeerModes(home = gatewayHome()): PeerModeState {
  try {
    const parsed = JSON.parse(fs.readFileSync(peerModeFile(home), "utf8")) as Partial<PeerModeState>;
    const modes: Record<string, GatewayModeState> = {};
    for (const [peer, value] of Object.entries(parsed.modes ?? {})) {
      if (value?.name === "btc") modes[peer] = { name: "btc", paper: value.paper === true };
      else if (value?.name === "a") modes[peer] = { name: "a" };
    }
    return { lastPeer: typeof parsed.lastPeer === "string" ? parsed.lastPeer : undefined, modes };
  } catch {
    return { modes: {} };
  }
}

export function writePeerMode(
  peer: string,
  mode: GatewayModeState | null,
  home = gatewayHome(),
): void {
  const state = readPeerModes(home);
  state.lastPeer = peer;
  if (mode) {
    state.modes[peer] = {
      name: mode.name,
      ...(mode.name === "btc" ? { paper: mode.paper === true } : {}),
    };
  } else {
    delete state.modes[peer];
  }
  const file = peerModeFile(home);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // 写不了只影响重启恢复
  }
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
  if (process.platform === "win32") {
    const file = windowsLauncherPath();
    const installed = fs.existsSync(file);
    const enabled = installed && windowsRunValue() === windowsAutostartCommand();
    return { supported: true, installed, enabled, path: file };
  }
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
  if (process.platform === "win32") {
    const home = gatewayHome();
    const file = windowsLauncherPath(home);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // UTF-16LE + BOM：WSH 对无 BOM 的 UTF-8 会按 ANSI 解析，中文用户名路径会乱码
      fs.writeFileSync(
        file,
        `\uFEFF${windowsLauncherScript(process.execPath, cliEntry(), home)}`,
        "utf16le",
      );
    } catch (err) {
      return {
        ok: false,
        path: file,
        error: `写入启动器失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const added = spawnSync(
      "reg",
      [
        "add",
        WINDOWS_RUN_KEY,
        "/v",
        WINDOWS_RUN_VALUE,
        "/t",
        "REG_SZ",
        "/d",
        windowsAutostartCommand(home),
        "/f",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (added.error || added.status !== 0) {
      return {
        ok: false,
        path: file,
        error:
          added.error?.message ||
          (added.stderr ?? "").trim() ||
          `reg add 退出码 ${added.status}`,
      };
    }
    return { ok: true, path: file };
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
  if (process.platform === "win32") {
    const home = gatewayHome();
    // 先写 stop 文件：正在跑的 VBS 循环会在 node 退出后读到它并结束
    try {
      fs.mkdirSync(gatewayPaths(home).run, { recursive: true });
      fs.writeFileSync(windowsStopFilePath(home), new Date().toISOString(), "utf8");
    } catch {
      // 写不了也只影响「停完又被拉起」
    }
    spawnSync("reg", ["delete", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE, "/f"], {
      encoding: "utf8",
      windowsHide: true,
    });
    try {
      fs.rmSync(windowsLauncherPath(home), { force: true });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return { ok: true };
  }
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
