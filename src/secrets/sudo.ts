import { spawn } from "child_process";

export interface SudoRunResult {
  code: number | null;
  error?: string;
}

/**
 * 用已保存的密码执行 `sudo -S -- <命令>`。
 *
 * 关键点：
 * - 密码只通过 stdin 传给 sudo，不放进 argv / 环境变量 / 日志；
 * - `-p ""` 关掉 sudo 自己的提示，避免把 "Password:" 写进输出；
 * - `--` 之后的参数原样交给 sudo，不会把用户的命令参数当成 sudo 选项；
 * - 标准输出/错误直接转发给当前进程，调用方（CLI 或 bash 工具）看到的是命令本身的输出。
 *
 * 密码文件来自 `~/.xzh/secrets/sudo`，见 src/secrets/store.ts。
 */
export function runWithSudo(
  password: string,
  command: string[],
  options: { cwd?: string } = {},
): Promise<SudoRunResult> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      resolve({ code: null, error: "Windows 没有 sudo；请在 WSL / Linux 下使用。" });
      return;
    }
    if (command.length === 0) {
      resolve({ code: null, error: "缺少要执行的命令。" });
      return;
    }

    const child = spawn("sudo", ["-S", "-p", "", "--", ...command], {
      cwd: options.cwd,
      stdio: ["pipe", "inherit", "inherit"],
      windowsHide: true,
    });

    let settled = false;
    const finish = (result: SudoRunResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.on("error", (err) => {
      finish({
        code: null,
        error:
          err.message.includes("ENOENT")
            ? "找不到 sudo 命令。"
            : `启动 sudo 失败：${err.message}`,
      });
    });
    child.on("close", (code) => finish({ code }));

    // 只写密码 + 换行就关闭 stdin：sudo 会读走第一行，后续命令拿到 EOF。
    // 这对非交互命令足够；需要继续交互的命令不应通过 xzh sudo 执行。
    try {
      child.stdin?.end(`${password}\n`);
    } catch (err) {
      finish({
        code: null,
        error: `写入 sudo 密码失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}
