import { spawnSync } from "child_process";
import * as fs from "fs";
import {
  configExists,
  DEFAULT_CONFIG,
  loadConfig,
  redactConfig,
  saveConfig,
} from "../../config/store";
import { ansi } from "../../utils/ansi";
import { ensureDir, getConfigDir, getConfigPath } from "../../utils/paths";

/**
 * `xzh config`        查看配置（脱敏）
 * `xzh config edit`   使用 nano 编辑配置文件
 * `xzh config path`   打印配置文件路径
 * `xzh config init`   生成默认配置文件
 */
export async function configCommand(args: string[]): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case "edit":
      return openInEditor();
    case "path":
      process.stdout.write(`${getConfigPath()}\n`);
      return;
    case "init": {
      ensureDir(getConfigDir());
      if (configExists()) {
        process.stdout.write(
          `${ansi.yellow}配置文件已存在：${getConfigPath()}${ansi.reset}\n`,
        );
        return;
      }
      saveConfig({ ...DEFAULT_CONFIG });
      process.stdout.write(`${ansi.green}✓ 已生成默认配置：${getConfigPath()}${ansi.reset}\n`);
      return;
    }
    case undefined:
      return showConfig();
    default:
      process.stdout.write(
        `${ansi.red}未知子命令：${sub}${ansi.reset}\n` +
          `${ansi.gray}用法：xzh config [edit|path|init]${ansi.reset}\n`,
      );
      process.exitCode = 1;
      return;
  }
}

function showConfig(): void {
  if (!configExists()) {
    process.stdout.write(
      `${ansi.yellow}尚未创建配置文件。${ansi.reset}\n` +
        `${ansi.gray}运行 ${ansi.reset}xzh model${ansi.gray} 进行配置，或运行 ${ansi.reset}xzh config init${ansi.gray} 生成默认配置。${ansi.reset}\n`,
    );
    return;
  }
  const config = loadConfig();
  const redacted = redactConfig(config);
  process.stdout.write(`${ansi.bold}玄猪配置${ansi.reset} ${ansi.gray}(${getConfigPath()})${ansi.reset}\n\n`);
  process.stdout.write(JSON.stringify(redacted, null, 2) + "\n");
  process.stdout.write(
    `\n${ansi.gray}提示：API Key 已脱敏显示；使用 ${ansi.reset}xzh config edit${ansi.gray} 编辑完整配置。${ansi.reset}\n`,
  );
}

function openInEditor(): void {
  ensureDir(getConfigDir());
  const file = getConfigPath();
  if (!fs.existsSync(file)) {
    saveConfig({ ...DEFAULT_CONFIG });
  }

  // 优先使用 nano（用户既定约定），其次 EDITOR / vi
  const candidates = [
    process.env.XUANZHU_EDITOR,
    "nano",
    process.env.EDITOR,
    "vi",
    "vim",
    "code --wait",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const [command, ...rest] = candidate.split(" ");
    const result = spawnSync(command, [...rest, file], { stdio: "inherit" });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      process.stdout.write(
        `${ansi.red}编辑器启动失败：${result.error.message}${ansi.reset}\n`,
      );
      return;
    }
    return;
  }

  process.stdout.write(
    `${ansi.yellow}未找到可用的文本编辑器，请手动编辑：${file}${ansi.reset}\n`,
  );
}
