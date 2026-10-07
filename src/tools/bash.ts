import { spawn } from "child_process";
import * as path from "path";
import { expandHome } from "../utils/paths";
import type { ToolDefinition, ToolResult } from "./types";

const MAX_OUTPUT = 30000;
const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
}

/** 终止后等待管道冲刷 / 强杀兜底的时间 */
const KILL_GRACE_MS = 1500;

/**
 * 在子进程中执行命令。
 *
 * 三个必须处理的点：
 * 1. **可中断**：监听 `ctx.signal`，abort 时整组终止（此前完全忽略中断，
 *    用户 Ctrl+C 后命令仍会跑完，长命令等同无法中断）。
 * 2. **整组终止**：以 `detached: true` 启动成为独立进程组，用 `process.kill(-pid)`
 *    杀掉 shell 及其派生的全部子进程，避免留下孤儿。
 * 3. **不会永久挂起**：`close` 事件要等所有 stdio（含孙进程继承的管道）关闭才触发，
 *    管道/后台进程场景下可能永不触发。因此用 `exit` 事件 + 短延迟兜底 resolve。
 */
function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RunResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({
        stdout: "",
        stderr: "命令已被中断（在执行前）。",
        code: null,
        timedOut: false,
        aborted: true,
      });
      return;
    }

    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd.exe" : process.env.SHELL || "bash";
    const args = isWindows ? ["/d", "/s", "/c", command] : ["-lc", command];

    const child = spawn(shell, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      // 独立进程组：超时或中断时可以整组终止
      detached: !isWindows,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let idleTimer: NodeJS.Timeout | undefined;

    const killGroup = (sig: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, sig); // 负号表示进程组
      } catch {
        try {
          child.kill(sig);
        } catch {
          // 进程可能已退出
        }
      }
    };

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, code, timedOut, aborted });
    };

    /** 终止后若 close 迟迟不来，兜底 resolve，避免整个 Agent/TUI 卡死 */
    const forceFinishSoon = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(null), KILL_GRACE_MS);
    };

    const onAbort = (): void => {
      aborted = true;
      killGroup("SIGKILL");
      forceFinishSoon();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGKILL");
      forceFinishSoon();
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (data: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += data.toString();
    });
    child.on("error", (err) => {
      stderr += String(err);
      finish(-1);
    });
    // exit 先于 close 触发；给它一个很短的窗口冲刷管道后就结束，
    // 不再无限等待可能永不触发的 close。
    child.on("exit", (code) => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(code), 120);
    });
    child.on("close", (code) => finish(code));
  });
}

export const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "在终端中执行 shell 命令并返回输出。适用于运行测试、构建、安装依赖、git 操作等。" +
    "命令在非交互式 shell 中执行，长时间运行的命令请设置 timeout。",
  requiresConfirmation: true,
  danger: true,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的 shell 命令" },
      timeout: {
        type: "integer",
        description: "超时时间（毫秒，默认 120000，最大 600000）",
      },
      cwd: {
        type: "string",
        description: "命令执行目录（可选，默认当前工作目录）",
      },
    },
    required: ["command"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const command = typeof args.command === "string" ? args.command : "";
    if (!command.trim()) {
      return { ok: false, content: "错误：command 不能为空" };
    }

    let cwd = ctx.cwd;
    if (typeof args.cwd === "string" && args.cwd) {
      const expanded = expandHome(args.cwd);
      cwd = path.isAbsolute(expanded) ? expanded : path.resolve(ctx.cwd, expanded);
    }

    const rawTimeout =
      typeof args.timeout === "number" ? args.timeout : DEFAULT_TIMEOUT;
    const timeout = Math.min(Math.max(1000, rawTimeout), MAX_TIMEOUT);

    const result = await runCommand(command, cwd, timeout, ctx.signal);

    const parts: string[] = [];
    if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
    if (result.stderr.trim()) {
      parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
    }
    if (result.aborted) {
      parts.push("[中断] 命令已被用户中断，其进程组已终止。");
    }
    if (result.timedOut) {
      parts.push(`[警告] 命令在 ${timeout}ms 后超时并被终止。`);
    }
    parts.push(`[退出码] ${result.code ?? "未知"}`);

    const output = parts.join("\n\n");
    return {
      ok: result.code === 0 && !result.timedOut && !result.aborted,
      content: output.slice(0, MAX_OUTPUT),
      summary: result.aborted
        ? "已中断"
        : result.timedOut
          ? "超时"
          : result.code === 0
            ? "执行成功"
            : `退出码 ${result.code}`,
    };
  },
};
