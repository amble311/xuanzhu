import { spawn } from "child_process";
import {
  currentPlatform,
  getSkillRequirements,
  type Platform,
  type SkillRequirement,
} from "./dependencies";

const CHECK_TIMEOUT = 15_000;
const INSTALL_TIMEOUT = 900_000;
const MAX_OUTPUT = 20_000;

export interface CommandResult {
  ok: boolean;
  output: string;
  timedOut: boolean;
}

/** 以非交互方式执行 shell 命令 */
export function runShell(
  command: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd.exe" : process.env.SHELL || "bash";
    const args = isWindows ? ["/d", "/s", "/c", command] : ["-lc", command];

    const child = spawn(shell, args, {
      env: process.env,
      windowsHide: true,
      // 独立进程组：安装脚本（npm install / curl|bash）常派生子进程，
      // 只杀 shell 会留下孤儿继续占用网络与磁盘。与 tools/bash.ts 的做法一致。
      detached: !isWindows,
    });

    let output = "";
    let timedOut = false;
    let settled = false;

    const append = (data: Buffer) => {
      if (output.length < MAX_OUTPUT) output += data.toString();
    };

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    /** 终止整棵进程树：优先按进程组，失败则退回单个进程 */
    const killTree = () => {
      if (!isWindows && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // 进程组已消失 / 权限问题，退回单进程
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // 忽略
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeout);

    const onAbort = () => {
      killTree();
      finish({ ok: false, output: output + "\n[已取消]", timedOut: false });
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      finish({ ok: false, output: output + String(err), timedOut });
    });
    child.on("close", (code) => {
      finish({
        ok: code === 0 && !timedOut,
        output: timedOut ? `${output}\n[执行超时 ${timeout}ms]` : output,
        timedOut,
      });
    });
  });
}

/** 检测某依赖是否已安装 */
export async function isRequirementMet(
  requirement: SkillRequirement,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await runShell(requirement.check, CHECK_TIMEOUT, signal);
  return result.ok;
}

export interface InstallResult {
  ok: boolean;
  log: string;
}

/** 安装单个依赖（含 postInstall 与安装后复核） */
export async function installRequirement(
  requirement: SkillRequirement,
  platform: Platform = currentPlatform(),
  signal?: AbortSignal,
  onOutput?: (message: string) => void,
): Promise<InstallResult> {
  const installCommand = requirement.install[platform];
  if (!installCommand) {
    return {
      ok: false,
      log: `当前平台（${platform}）没有可用的自动安装命令。`,
    };
  }

  const logs: string[] = [];
  const emit = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    logs.push(trimmed);
    onOutput?.(trimmed);
  };

  emit(`$ ${installCommand}`);
  const install = await runShell(installCommand, INSTALL_TIMEOUT, signal);
  for (const line of tailLines(install.output, 12)) emit(line);
  if (!install.ok) {
    return { ok: false, log: logs.join("\n") };
  }

  const postCommand = requirement.postInstall?.[platform];
  if (postCommand) {
    emit(`$ ${postCommand}`);
    const post = await runShell(postCommand, INSTALL_TIMEOUT, signal);
    for (const line of tailLines(post.output, 12)) emit(line);
    if (!post.ok) {
      return { ok: false, log: logs.join("\n") };
    }
  }

  const verified = await isRequirementMet(requirement, signal);
  if (!verified) {
    emit(
      `⚠ 安装命令已执行，但 “${requirement.check}” 仍未通过；可能是 PATH 尚未刷新，请重新打开终端后再试。`,
    );
    return { ok: false, log: logs.join("\n") };
  }

  emit(`✓ ${requirement.name} 已就绪`);
  return { ok: true, log: logs.join("\n") };
}

export interface SkillDependencyReport {
  installed: string[];
  skipped: string[];
  failed: string[];
}

export interface EnsureOptions {
  platform?: Platform;
  signal?: AbortSignal;
  /** 实时输出安装日志 */
  onOutput?: (message: string) => void;
  /** 安装前确认（返回 false 则跳过） */
  confirm?: (
    requirement: SkillRequirement,
    command: string,
  ) => Promise<boolean>;
}

/** 确保某技能的依赖均已安装 */
export async function ensureSkillRequirements(
  skillName: string,
  options: EnsureOptions = {},
): Promise<SkillDependencyReport> {
  const platform = options.platform ?? currentPlatform();
  const report: SkillDependencyReport = {
    installed: [],
    skipped: [],
    failed: [],
  };

  for (const requirement of getSkillRequirements(skillName)) {
    if (await isRequirementMet(requirement, options.signal)) continue;

    const command = requirement.install[platform];
    if (!command) {
      report.skipped.push(`${requirement.name}（当前平台无自动安装命令）`);
      continue;
    }

    const approved = options.confirm
      ? await options.confirm(requirement, command)
      : false;
    if (!approved) {
      report.skipped.push(`${requirement.name}`);
      continue;
    }

    options.onOutput?.(`正在安装 ${requirement.name} …（可能需要数分钟）`);
    const result = await installRequirement(
      requirement,
      platform,
      options.signal,
      options.onOutput,
    );

    if (result.ok) {
      report.installed.push(requirement.name);
    } else {
      const tail = result.log.split("\n").slice(-2).join(" ");
      report.failed.push(`${requirement.name} → ${tail}`);
    }
  }

  return report;
}

function tailLines(text: string, count: number): string[] {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return lines.slice(-count);
}
