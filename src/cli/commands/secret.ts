import { spawn } from "child_process";
import {
  appendGlobalTopicEntry,
  DEFAULT_GLOBAL_MEMORY_MAX_CHARS,
} from "../../workspace";
import { ansi } from "../../utils/ansi";
import { runWithSudo } from "../../secrets/sudo";
import {
  deleteSecret,
  hasSecret,
  listSecretNames,
  readSecret,
  saveSecret,
  secretsDir,
} from "../../secrets/store";

/**
 * 从终端读取一行敏感文本。
 *
 * TTY 下关闭回显（raw mode），非 TTY（管道 / 脚本）直接读第一行。
 * 密码绝不通过命令行参数传入 —— 那会进 shell history 与进程列表。
 */
function readHiddenInput(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let data = "";
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        process.stdin.off("data", onData);
        process.stdin.off("end", onEnd);
        fn();
      };
      const onData = (chunk: string): void => {
        data += chunk;
      };
      const onEnd = (): void => {
        finish(() => resolve(data.split(/\r?\n/)[0] ?? ""));
      };
      // 防止非交互环境（例如模型通过 bash 调用）把 stdin 一直开着导致挂起
      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              "当前不是交互式终端，无法安全读取密码。请在真实终端运行 xzh secret set。",
            ),
          ),
        );
      }, 5_000);
      timer.unref?.();
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", onData);
      process.stdin.on("end", onEnd);
      process.stdin.resume();
    });
  }

  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("已取消"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** 写入 sudo 指针到全局记忆（只写「怎么用」，绝不写密码） */
function rememberSudoPointer(): void {
  try {
    appendGlobalTopicEntry(
      "本机环境",
      "- sudo 密码存放在 `~/.xzh/secrets/sudo`；使用 `xzh sudo <命令>` 执行提权命令，" +
        "不要读取或输出密码文件。",
      DEFAULT_GLOBAL_MEMORY_MAX_CHARS,
    );
  } catch {
    // 记忆写不进去不影响凭据保存
  }
}

export async function secretCommand(args: string[]): Promise<void> {
  const sub = (args[0] ?? "").toLowerCase();

  if (!sub || sub === "list" || sub === "ls") {
    const names = listSecretNames();
    if (names.length === 0) {
      process.stdout.write(
        `${ansi.gray}本地凭据库为空（${secretsDir()}）。${ansi.reset}\n`,
      );
    } else {
      process.stdout.write(
        `${ansi.bold}本地凭据（${secretsDir()}）${ansi.reset}\n` +
          names.map((name) => `  ${name}`).join("\n") +
          `\n${ansi.gray}只显示名称，不显示内容。${ansi.reset}\n`,
      );
    }
    process.stdout.write(
      `${ansi.gray}用法：xzh secret set <名称> / remove <名称> / path${ansi.reset}\n`,
    );
    return;
  }

  if (sub === "path") {
    process.stdout.write(`${secretsDir()}\n`);
    return;
  }

  if (sub === "set" || sub === "add") {
    const name = args[1]?.trim();
    if (!name) {
      process.stdout.write(`${ansi.red}缺少凭据名称，例如：xzh secret set sudo${ansi.reset}\n`);
      process.exitCode = 1;
      return;
    }
    try {
      const first = await readHiddenInput(`请输入 ${name} 的密码（输入不回显）: `);
      if (!first) {
        process.stdout.write(`${ansi.red}密码为空，未保存。${ansi.reset}\n`);
        process.exitCode = 1;
        return;
      }
      if (process.stdin.isTTY) {
        const second = await readHiddenInput(`请再次输入 ${name} 的密码: `);
        if (first !== second) {
          process.stdout.write(`${ansi.red}两次输入不一致，未保存。${ansi.reset}\n`);
          process.exitCode = 1;
          return;
        }
      }
      const file = saveSecret(name, first);
      process.stdout.write(
        `${ansi.green}✓ 已保存凭据 ${name}${ansi.reset}\n` +
          `${ansi.gray}  文件：${file}（权限 600）${ansi.reset}\n` +
          `${ansi.gray}  密码不会进入对话上下文；在玄猪里用 xzh sudo <命令> 使用。${ansi.reset}\n`,
      );
      if (name.toLowerCase() === "sudo") rememberSudoPointer();
    } catch (err) {
      process.stdout.write(
        `${ansi.red}${err instanceof Error ? err.message : String(err)}${ansi.reset}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (sub === "remove" || sub === "rm" || sub === "delete" || sub === "del") {
    const name = args[1]?.trim();
    if (!name) {
      process.stdout.write(`${ansi.red}缺少凭据名称。${ansi.reset}\n`);
      process.exitCode = 1;
      return;
    }
    if (!hasSecret(name)) {
      process.stdout.write(`${ansi.red}凭据不存在：${name}${ansi.reset}\n`);
      process.exitCode = 1;
      return;
    }
    const removed = deleteSecret(name);
    process.stdout.write(
      removed
        ? `${ansi.green}✓ 已删除凭据 ${name}${ansi.reset}\n`
        : `${ansi.red}删除失败：${name}${ansi.reset}\n`,
    );
    if (!removed) process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `${ansi.yellow}未知用法：xzh secret ${args.join(" ")}${ansi.reset}\n` +
      `${ansi.gray}  xzh secret set <名称>      保存密码（输入不回显）\n` +
      `  xzh secret list            列出名称（不显示内容）\n` +
      `  xzh secret remove <名称>   删除\n` +
      `  xzh secret path            打印凭据目录${ansi.reset}\n`,
  );
  process.exitCode = 1;
}

/** `xzh sudo <命令>`：密码只从 0600 凭据文件读取，经 stdin 交给 sudo */
export async function sudoCommand(args: string[]): Promise<void> {
  const command = args[0] === "--" ? args.slice(1) : args;
  if (command.length === 0) {
    process.stdout.write(
      `${ansi.yellow}用法：xzh sudo <命令> [参数...]${ansi.reset}\n` +
        `${ansi.gray}先运行 xzh secret set sudo 保存密码；密码不会出现在命令行或对话里。${ansi.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }

  // root 下不需要 sudo，也不需要密码
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    const child = spawn(command[0], command.slice(1), {
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", (err) => {
      process.stderr.write(`执行失败：${err.message}\n`);
      process.exitCode = 1;
    });
    child.on("close", (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }

  const password = readSecret("sudo");
  if (password === null) {
    process.stdout.write(
      `${ansi.red}未找到 sudo 凭据。${ansi.reset}\n` +
        `${ansi.gray}先运行 ${ansi.reset}xzh secret set sudo${ansi.gray} 保存密码；` +
        `如果系统已配置 NOPASSWD，可直接使用 sudo -n。${ansi.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const result = await runWithSudo(password, command);
  if (result.error) {
    process.stderr.write(`${result.error}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.code ?? 1;
}
