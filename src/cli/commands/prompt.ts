import * as fs from "fs";
import {
  loadConfig,
  saveConfig,
  type XuanZhuConfig,
} from "../../config/store";
import { getConfigPath } from "../../utils/paths";
import { autonomyModeOf } from "../../core/autonomy";
import {
  buildSystemPrompt,
  defaultPartText,
  OVERRIDABLE_PARTS,
  promptDefaultsHash,
  resolvePromptOverrides,
  type PromptPartKey,
} from "../../core/prompt";
import { ansi } from "../../utils/ansi";
import {
  loadProjectRules,
  readGlobalMemory,
  readProjectMemory,
} from "../../workspace";

/**
 * `xzh prompt` —— 查看与覆盖系统提示词的**段落**。
 *
 * 为什么不做成「整份提示词可编辑」：整份覆盖之后，升级带来的改进全部失效，
 * 而且用户改的那份会悄悄漂移。分段的取舍是：只改你想改的那段，
 * 其余继续跟随内置文本；内置文本变了会用指纹提示你。
 */

const USAGE = `${ansi.bold}用法${ansi.reset}
  ${ansi.green}xzh prompt${ansi.reset}                 列出所有可覆盖的段落（字数 / 是否被覆盖）
  ${ansi.green}xzh prompt show${ansi.reset}            打印当前实际发给模型的系统提示词
  ${ansi.green}xzh prompt show <段落>${ansi.reset}     打印某段的「内置原文」与「当前生效」
  ${ansi.green}xzh prompt set <段落> <文件|->${ansi.reset}
                           用文件内容（或 stdin：-）覆盖该段；空内容等于删掉该段
  ${ansi.green}xzh prompt reset <段落>${ansi.reset}    取消该段的覆盖
  ${ansi.green}xzh prompt reset --all${ansi.reset}     取消全部覆盖
  ${ansi.green}xzh prompt path${ansi.reset}            打印配置文件路径

${ansi.gray}可覆盖的段落：${OVERRIDABLE_PARTS.map((part) => part.key).join(" / ")}${ansi.reset}`;

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** 组装一次与运行时一致的提示词（用于 show） */
function compose(config: XuanZhuConfig): string {
  const cwd = process.cwd();
  return buildSystemPrompt(
    cwd,
    config.systemPromptExtra,
    loadProjectRules(cwd),
    readProjectMemory(cwd),
    config.memoryMaxChars,
    false,
    false,
    readGlobalMemory(),
    config.globalMemoryMaxChars,
    Boolean(
      config.network?.proxy &&
        config.network.enabled !== false &&
        config.network.lastCheckOk !== false,
    ),
    { overrides: config.promptOverrides, autonomy: autonomyModeOf(config) },
  );
}

function isValidKey(key: string): key is PromptPartKey {
  return OVERRIDABLE_PARTS.some((part) => part.key === key);
}

export async function promptCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const config = loadConfig();
  const { overrides, unknown } = resolvePromptOverrides(config.promptOverrides);

  if (unknown.length > 0) {
    process.stdout.write(
      `${ansi.yellow}⚠ 配置里有 ${unknown.length} 个未知段落 key，已忽略：${unknown.join(
        "、",
      )}${ansi.reset}\n`,
    );
  }

  // 无参数：列出段落
  if (!action || action === "list") {
    process.stdout.write(`${ansi.bold}系统提示词段落${ansi.reset}\n`);
    for (const part of OVERRIDABLE_PARTS) {
      const text = defaultPartText(part.key);
      const overridden = Object.prototype.hasOwnProperty.call(overrides, part.key);
      const current = overridden ? (overrides[part.key] ?? "") : text;
      const mark = overridden
        ? current.trim()
          ? `${ansi.green}已覆盖${ansi.reset}`
          : `${ansi.yellow}已删除${ansi.reset}`
        : `${ansi.gray}内置${ansi.reset}`;
      process.stdout.write(
        `  ${ansi.bold}${part.key}${ansi.reset}  ${part.title}  ` +
          `${ansi.gray}${current.length} 字符${ansi.reset}  ${mark}\n`,
      );
    }
    const base = config.promptOverridesBase;
    const now = promptDefaultsHash();
    if (Object.keys(overrides).length > 0) {
      if (!base) {
        process.stdout.write(
          `${ansi.gray}\n提示：覆盖保存时没有记录内置指纹（旧版本写入的），无法判断内置原文是否已更新。${ansi.reset}\n`,
        );
      } else if (base !== now) {
        process.stdout.write(
          `${ansi.yellow}\n⚠ 内置提示词已升级（指纹 ${base} → ${now}）：` +
            `你覆盖的段落可能已与新版默认不一致，可用 xzh prompt show <段落> 对比。${ansi.reset}\n`,
        );
      }
    }
    process.stdout.write(
      `${ansi.gray}\n配置文件：${getConfigPath()}${ansi.reset}\n`,
    );
    return;
  }

  if (action === "path") {
    process.stdout.write(`${getConfigPath()}\n`);
    return;
  }

  if (action === "show") {
    const key = rest[0];
    if (!key) {
      process.stdout.write(`${compose(config)}\n`);
      return;
    }
    if (!isValidKey(key)) {
      process.stdout.write(
        `${ansi.red}未知段落：${key}${ansi.reset}\n可用：${OVERRIDABLE_PARTS.map(
          (part) => part.key,
        ).join(" / ")}\n`,
      );
      process.exitCode = 1;
      return;
    }
    const builtin = defaultPartText(key);
    const overridden = Object.prototype.hasOwnProperty.call(overrides, key);
    process.stdout.write(`${ansi.bold}── 内置原文（${key}）${ansi.reset}\n`);
    process.stdout.write(`${builtin || "（该段在未连接设备时不出现）"}\n\n`);
    process.stdout.write(
      `${ansi.bold}── 当前生效${overridden ? "（已被覆盖）" : "（内置）"}${ansi.reset}\n`,
    );
    process.stdout.write(`${overridden ? overrides[key] : builtin}\n`);
    return;
  }

  if (action === "set") {
    const key = rest[0];
    const source = rest[1];
    if (!key || !source) {
      process.stdout.write(USAGE + "\n");
      process.exitCode = 1;
      return;
    }
    if (!isValidKey(key)) {
      process.stdout.write(
        `${ansi.red}未知段落：${key}${ansi.reset}\n可覆盖：${OVERRIDABLE_PARTS.map(
          (part) => part.key,
        ).join(" / ")}\n`,
      );
      process.exitCode = 1;
      return;
    }
    let text: string;
    try {
      text = source === "-" ? readStdin() : fs.readFileSync(source, "utf8");
    } catch (err) {
      process.stdout.write(
        `${ansi.red}读取失败：${err instanceof Error ? err.message : String(err)}${ansi.reset}\n`,
      );
      process.exitCode = 1;
      return;
    }
    config.promptOverrides = {
      ...(config.promptOverrides ?? {}),
      [key]: text.trimEnd(),
    };
    config.promptOverridesBase = promptDefaultsHash();
    saveConfig(config);
    process.stdout.write(
      text.trim()
        ? `${ansi.green}✓ 已覆盖 ${key}${ansi.reset}（${text.trim().length} 字符）\n`
        : `${ansi.yellow}✓ 已删除 ${key}${ansi.reset}（该段不再出现在提示词里）\n`,
    );
    process.stdout.write(
      `${ansi.gray}  生效于**下一次启动**；界面内重启后即可看到。取消：xzh prompt reset ${key}${ansi.reset}\n`,
    );
    return;
  }

  if (action === "reset") {
    const key = rest[0];
    if (!key) {
      process.stdout.write(USAGE + "\n");
      process.exitCode = 1;
      return;
    }
    if (key === "--all") {
      delete config.promptOverrides;
      delete config.promptOverridesBase;
      saveConfig(config);
      process.stdout.write(`${ansi.green}✓ 已取消全部段落覆盖${ansi.reset}\n`);
      return;
    }
    if (!isValidKey(key)) {
      process.stdout.write(`${ansi.red}未知段落：${key}${ansi.reset}\n`);
      process.exitCode = 1;
      return;
    }
    if (config.promptOverrides) {
      delete config.promptOverrides[key];
      if (Object.keys(config.promptOverrides).length === 0) {
        delete config.promptOverrides;
        delete config.promptOverridesBase;
      }
    }
    saveConfig(config);
    process.stdout.write(`${ansi.green}✓ 已取消 ${key} 的覆盖${ansi.reset}\n`);
    return;
  }

  process.stdout.write(USAGE + "\n");
  process.exitCode = 1;
}
