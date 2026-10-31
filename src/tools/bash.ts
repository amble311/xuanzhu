import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { expandHome } from "../utils/paths";
import { isProxyActive } from "../network/proxy";
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
  /** 输出是否因为超过 MAX_OUTPUT 而被丢弃了一部分 */
  truncated: boolean;
}

/** 终止后等待管道冲刷 / 强杀兜底的时间 */
const KILL_GRACE_MS = 1500;

/**
 * 输出被截断时的提示（放在正文**最前面**，见 execute 里的说明）。
 *
 * 为什么必须让它可见：早期只是静默丢弃超限部分，于是「正常日志把上限占满、
 * 真正的报错在末尾被丢掉」时，模型看到的是一段没有错误的输出 + 退出码 0，
 * 会直接误判成功。
 */
const TRUNCATED_NOTE =
  `[输出被截断] 单条命令的捕获上限为 ${MAX_OUTPUT} 字符，**超出部分已丢弃** —— ` +
  `下面的内容并不完整（结尾的报错也可能在里面）。` +
  `需要完整内容时请把命令拆小，或先重定向到文件再用 read_file / grep 定位。`;

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
        truncated: false,
      });
      return;
    }

    const isWindows = process.platform === "win32";
    // XZH_SHELL 可指定 POSIX shell（Windows 上常用 Git Bash / WSL 的 bash），
    // 用于绕过 cmd.exe 与技能命令不兼容的问题；默认仍按平台选择。
    const customShell = process.env.XZH_SHELL?.trim();
    const shell =
      customShell || (isWindows ? "cmd.exe" : process.env.SHELL || "bash");
    const args = customShell
      ? ["-lc", command]
      : isWindows
        ? ["/d", "/s", "/c", command]
        : ["-lc", command];

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
    let truncated = false;
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
      resolve({ stdout, stderr, code, timedOut, aborted, truncated });
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

    // 超限后**必须记下「被截断」这件事**：早期只是静默丢弃后续输出，
    // 于是命令前面的正常日志把上限占满、真正的报错在末尾被丢掉时，
    // 模型看到的就是一段「没有错误的输出 + 退出码 0」，直接误判成功。
    child.stdout?.on("data", (data: Buffer) => {
      if (stdout.length >= MAX_OUTPUT) {
        truncated = true;
        return;
      }
      stdout += data.toString();
      if (stdout.length >= MAX_OUTPUT) truncated = true;
    });
    child.stderr?.on("data", (data: Buffer) => {
      if (stderr.length >= MAX_OUTPUT) {
        truncated = true;
        return;
      }
      stderr += data.toString();
      if (stderr.length >= MAX_OUTPUT) truncated = true;
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

/**
 * 明显需要交互式输入的命令。
 *
 * xzh 的 bash 是**非交互 shell**（没有 TTY）：`su` / `passwd` / `vim` 这类命令会
 * 一直等密码或按键，直到工具超时才被杀掉 —— 用户看到的就是「命令超时」+
 * 一段 `Password:`，既浪费时间又容易误判成网络/工具故障（2026-10-25 实测）。
 * 这里在启动前直接拒绝，并给出非交互的替代做法。
 */
export function interactiveCommandName(command: string): string | undefined {
  // 按 shell 分隔符切段，只看每段的第一个词（避免把 `echo su` / `grep passwd` 也拦掉）
  const segments = command.split(/(?:&&|\|\||[;|\n(){}])/);
  for (const raw of segments) {
    const segment = raw
      .trim()
      // 去掉前置的环境变量赋值（FOO=bar sudo ...）
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)+/, "");
    const name = /^([A-Za-z0-9_.-]+)/.exec(segment)?.[1]?.toLowerCase();
    if (!name) continue;
    if (
      ["su", "passwd", "vim", "vi", "nano", "less", "more", "top", "htop"].includes(
        name,
      )
    ) {
      return name;
    }
    // sudo 在无 TTY 时会等密码直到超时。允许 -n（NOPASSWD）和 -S（自己喂 stdin），
    // 其余情况直接拒绝，避免白等到超时。
    if (
      name === "sudo" &&
      !/(^|\s)(-n|--non-interactive|-S|--stdin)(\s|$)/.test(segment)
    ) {
      return "sudo";
    }
  }
  return undefined;
}

/**
 * 判断输出是否像「外网不可达」。
 *
 * 只做提示，不自动改命令：git/npm/curl 的报错格式随版本变化，
 * 这里宁可漏报也不误判成本地命令失败。
 */
export function looksLikeNetworkFailure(output: string): boolean {
  const text = output.toLowerCase();
  return [
    "could not resolve host",
    "name or service not known",
    "temporary failure in name resolution",
    "getaddrinfo",
    "network is unreachable",
    "connection timed out",
    "connection reset",
    "failed to connect",
    "ssl connect error",
    "proxy connect",
    "econnreset",
    "etimedout",
    "无法解析主机",
    "连接超时",
  ].some((keyword) => text.includes(keyword));
}

/**
 * 把超长输出完整落盘，上下文里只留摘要。
 *
 * 为什么不能直接丢掉：测试/构建日志的真正报错常在末尾，截断后模型容易误判成功。
 * 落盘后给模型一个路径，需要时用 read_file / grep 回查，既不占窗口也不丢证据。
 */
function saveOutputArtifact(
  dir: string | undefined,
  command: string,
  stdout: string,
  stderr: string,
  truncated = false,
): string | undefined {
  if (!dir) return undefined;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(
      dir,
      `${stamp}-bash-${Math.random().toString(36).slice(2, 8)}.log`,
    );
    fs.writeFileSync(
      file,
      `$ ${command}\n\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}\n` +
        (truncated ? "\n[note] 原始输出超过单次捕获上限，artifact 也只含已捕获的部分。\n" : ""),
      "utf8",
    );
    return file;
  } catch {
    return undefined;
  }
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

    // 交互式命令没有 TTY，会一直等到超时（如 `su` 等密码）。提前失败并给出替代方案。
    const interactive = interactiveCommandName(command);
    if (interactive) {
      if (interactive === "sudo") {
        return {
          ok: false,
          content:
            `错误：\`sudo\` 在非交互 shell 中会等待密码直到超时。\n` +
            `若系统已配置 NOPASSWD，请直接用 \`sudo -n <命令>\`；` +
            `否则请在真实终端中执行，或让用户配置 NOPASSWD。`,
        };
      }
      return {
        ok: false,
        content:
          `错误：\`${interactive}\` 需要交互式输入（密码 / 按键），而 xzh 的 bash 是` +
          `非交互 shell，会一直等待直到超时。\n` +
          `请在终端里手动执行；需要提权时改用已配置 NOPASSWD 的 \`sudo -n <命令>\`，` +
          `不要依赖 xzh 输入密码。`,
      };
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

    const limit = Math.max(1000, ctx.limits?.maxOutputChars ?? MAX_OUTPUT);
    const stdout = result.stdout.trimEnd();
    const stderr = result.stderr.trimEnd();
    const full = [stdout, stderr ? `[stderr]\n${stderr}` : ""]
      .filter(Boolean)
      .join("\n\n");

    const artifact =
      full.length > limit
        ? saveOutputArtifact(
            ctx.limits?.artifactDir,
            command,
            stdout,
            stderr,
            result.truncated,
          )
        : undefined;

    const parts: string[] = [];
    if (artifact) {
      // 大输出只给摘要 + 路径：既保住报错证据，又不占上下文
      const shorten = (line: string): string =>
        line.length > 200 ? `${line.slice(0, 200)}…` : line;
      const lines = stdout.split("\n");
      const head = lines.slice(0, 8).map(shorten).join("\n");
      const tail =
        lines.length > 16 ? lines.slice(-8).map(shorten).join("\n") : "";
      parts.push(
        `[完整输出已保存] ${full.length} 字符 → ${artifact}\n` +
          `[摘要]\n${head}${tail ? `\n…\n${tail}` : ""}`,
      );
      if (stderr) {
        parts.push(
          `[stderr 摘要]\n${stderr.split("\n").slice(0, 4).map(shorten).join("\n")}`,
        );
      }
      if (result.truncated) {
        parts.push("[捕获上限] 原始输出超过单次捕获上限，artifact 也只含已捕获部分。");
      }
    } else {
      if (stdout) parts.push(stdout);
      if (stderr) parts.push(`[stderr]\n${stderr}`);
    }
    if (result.aborted) {
      parts.push("[中断] 命令已被用户中断，其进程组已终止。");
    }
    if (result.timedOut) {
      parts.push(`[警告] 命令在 ${timeout}ms 后超时并被终止。`);
    }
    if (result.code !== 0 && looksLikeNetworkFailure(full)) {
      parts.push(
        isProxyActive()
          ? "[网络提示] 已启用 xzh vpn 全局代理，但命令仍然外网失败。先运行 " +
              "`xzh vpn` 菜单中测试代理；代理正常时不要重复 load_skill v2ray。"
          : "[网络提示] 命令看起来因外网不可达而失败。若本机已有 v2ray / Clash / sing-box，" +
              "请先 load_skill v2ray，按指南探测本地代理后重试；" +
              "用代理时只对当前命令临时设置 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY，" +
              "并设置 NO_PROXY=127.0.0.1,localhost。",
      );
    }
    parts.push(`[退出码] ${result.code ?? "未知"}`);

    const output = parts.join("\n\n");
    return {
      ok: result.code === 0 && !result.timedOut && !result.aborted,
      // 截断提示必须放在**最前面**：正文本身已经顶到上限，
      // 放在末尾会被下面的 slice 直接切掉，等于没提示。
      content:
        (!artifact && result.truncated ? `${TRUNCATED_NOTE}\n\n` : "") +
        output.slice(0, artifact ? limit : MAX_OUTPUT),
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
