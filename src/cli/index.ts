import * as fs from "fs";
import * as path from "path";
import { activeModelEntry, configExists, loadConfig } from "../config/store";
import {
  createProvider,
  findProvider,
  validateModelEntry,
  validateProviderConfig,
} from "../llm";
import { friendlyError } from "../llm/http";
import { deviceCommand } from "./commands/device";
import { restoreTerminalSafely, TuiApp } from "../tui/app";
import { ansi } from "../utils/ansi";
import {
  expandHome,
  getConfigDir,
  getConfigPath,
  migrateLegacyConfigDir,
} from "../utils/paths";
import { VERSION } from "../utils/version";
import {
  crashLogPath,
  markSessionEnd,
  markSessionStart,
  recordCrash,
} from "../utils/crash";
import { configCommand } from "./commands/config";
import { modelCommand } from "./commands/model";
import { setupCommand } from "./commands/setup";
import { skillCommand } from "./commands/skill";

// 版本号来自构建期注入（见 utils/version.ts），全项目只此一处来源

// 当输出管道被提前关闭（例如 `xzh config | head`）时优雅退出，避免抛 EPIPE 堆栈
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
});
process.stderr.on("error", () => undefined);

// TUI 运行期间终端处于备用屏 + raw mode + 鼠标/键盘上报状态。
// 任何「非正常退出」都必须先还原，否则 shell 会残留坏状态（点鼠标吐转义码、
// 输出不换行、光标隐藏等）。SIGINT 由 TUI 自己处理，这里不接管。
for (const signal of ["SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    markSessionEnd(); // 用户/系统主动结束，不算崩溃
    restoreTerminalSafely();
    process.exit(0);
  });
}
process.on("uncaughtException", (err) => {
  // 记日志：TUI 在备用屏里，界面消失后 stderr 容易被忽略，日志才是可追溯的
  recordCrash("未捕获异常", err);
  restoreTerminalSafely();
  process.stderr.write(`\n未捕获异常：${err?.stack ?? String(err)}\n`);
  process.stderr.write(`详情已写入 ${crashLogPath()}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  recordCrash("未处理的 Promise 拒绝", reason);
  restoreTerminalSafely();
  process.stderr.write(`\n未处理的 Promise 拒绝：${String(reason)}\n`);
  process.stderr.write(`详情已写入 ${crashLogPath()}\n`);
  process.exit(1);
});

async function main(): Promise<void> {
  // 旧全局目录一次性迁移（~/.xuanzhu → ~/.xzh）。
  // 必须在任何配置读写之前执行，否则会读到空配置而丢失用户的 provider 设置。
  const migrated = migrateLegacyConfigDir();
  if (migrated.migrated) {
    process.stdout.write(
      `${ansi.gray}已将全局目录迁移至 ${getConfigDir()}` +
        `${migrated.from ? `（原 ${migrated.from}）` : ""}${ansi.reset}\n`,
    );
  }

  const argv = process.argv.slice(2);

  // 全局开关：--intent 本次启动启用意图分析，--no-intent 强制关闭。
  // 仅作用于本次运行，不写回配置文件（界面内 /intent 才会持久化）。
  let intentOverride: boolean | undefined;
  if (argv.includes("--intent")) intentOverride = true;
  else if (argv.includes("--no-intent")) intentOverride = false;

  const args = argv.filter(
    (arg) => arg !== "--intent" && arg !== "--no-intent",
  );
  const command = args[0];

  switch (command) {
    case undefined:
      await startChat(undefined, intentOverride);
      return;
    case "model":
      await modelCommand(args.slice(1));
      return;
    case "config":
      await configCommand(args.slice(1));
      return;
    case "setup":
      await setupCommand();
      return;
    case "skill":
      await skillCommand(args.slice(1));
      return;
    case "device":
      await deviceCommand(args.slice(1));
      return;
    case "help":
    case "-h":
    case "--help":
      printHelp();
      return;
    case "version":
    case "-v":
    case "--version":
      process.stdout.write(`玄猪 xzh v${VERSION}\n`);
      return;
    default: {
      if (command.startsWith("-")) {
        printHelp();
        return;
      }

      // 位置参数：作为项目目录启动，例如 `xzh /home`、`xzh .`
      const dir = resolveDirectory(command);
      if (dir) {
        await startChat(dir, intentOverride);
        return;
      }
      if (looksLikePath(command)) {
        process.stdout.write(
          `${ansi.red}目录不存在或不是目录：${command}${ansi.reset}\n`,
        );
        process.exitCode = 1;
        return;
      }

      process.stdout.write(
        `${ansi.red}未知命令：${command}${ansi.reset}\n` +
          `${ansi.gray}运行 ${ansi.reset}xzh --help${ansi.gray} 查看用法，` +
          `或运行 ${ansi.reset}xzh <目录>${ansi.gray} 指定项目目录。${ansi.reset}\n`,
      );
      process.exitCode = 1;
    }
  }
}

/** 判断参数是否"看起来像路径"，用于区分未知命令与错误路径 */
function looksLikePath(input: string): boolean {
  return (
    input.startsWith("/") ||
    input.startsWith("~") ||
    input.startsWith("./") ||
    input.startsWith("../") ||
    input === "." ||
    input === ".."
  );
}

/** 将输入解析为已存在的目录绝对路径；不是目录则返回 null */
function resolveDirectory(input: string): string | null {
  const expanded = expandHome(input);
  const target = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(process.cwd(), expanded);
  try {
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      return fs.realpathSync(target);
    }
  } catch {
    // 按不存在处理
  }
  return null;
}

async function startChat(
  cwd?: string,
  intentOverride?: boolean,
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(
      `${ansi.red}玄猪需要交互式终端（TTY）。${ansi.reset}\n` +
        `${ansi.gray}请在真实终端中运行 xzh。${ansi.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();

  // 默认使用**上次用过的**那个模型（记在 config.provider / config.model）；
  // 它已不在列表里时退回列表第一项 —— 顺序即回退优先级。
  const active = activeModelEntry(config);
  if (!active) {
    process.stdout.write(
      `${ansi.yellow}尚未配置任何模型。${ansi.reset}\n` +
        `${ansi.gray}请先运行 ${ansi.reset}xzh model add <provider> <model>${ansi.gray} 添加模型。${ansi.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }

  // 当前模型必须可用，否则无法启动
  const activeProblems = validateModelEntry(config, active);
  if (activeProblems.length > 0) {
    process.stdout.write(`${ansi.yellow}⚠ 当前模型不可用：${ansi.reset}\n`);
    for (const problem of activeProblems) {
      process.stdout.write(`  ${ansi.gray}·${ansi.reset} ${problem}\n`);
    }
    if (!configExists()) {
      process.stdout.write(
        `\n${ansi.gray}提示：运行 ${ansi.reset}xzh model${ansi.gray} 完成初始化配置。${ansi.reset}\n`,
      );
    } else {
      process.stdout.write(`\n${ansi.gray}配置文件：${getConfigPath()}${ansi.reset}\n`);
    }
    process.exitCode = 1;
    return;
  }

  // 其他模型的问题只提醒，不阻止启动（它们会在降级时被跳过）
  const otherProblems = validateProviderConfig(config).filter(
    (problem) => !activeProblems.includes(problem),
  );
  if (otherProblems.length > 0) {
    process.stdout.write(
      `${ansi.yellow}⚠ ${otherProblems.length} 个备用模型暂不可用（不影响本次启动）：${ansi.reset}\n`,
    );
    for (const problem of otherProblems) {
      process.stdout.write(`  ${ansi.gray}·${ansi.reset} ${problem}\n`);
    }
  }

  const meta = findProvider(active.provider);
  const provider = createProvider(config, active);

  const app = new TuiApp({
    provider,
    config,
    cwd: cwd ?? process.cwd(),
    providerLabel: meta?.label ?? active.provider,
    model: active.model,
    activeModel: active,
    intentEnabled:
      intentOverride !== undefined
        ? intentOverride
        : config.intent?.enabled === true,
    autoApprove: config.autoApprove,
    startupNotice: buildStartupNotice(),
  });

  await app.start();
  // 走到这里说明 TUI 是正常退出的，清掉会话标记与旧日志，
  // 这样下次启动若发现标记还在，就一定是异常退出。
  markSessionEnd();
}

/**
 * 构造 TUI 的启动提示：上次是否异常退出。
 *
 * 判断依据是「会话标记」——正常退出会删除它，所以只要还残留，
 * 就说明上次是崩溃或被强制终止。这条路径**不依赖崩溃当时能否输出**，
 * 连内存不足被系统直接杀掉（来不及执行任何 JS）也能在下次启动时被发现。
 */
function buildStartupNotice(): string | undefined {
  const previous = markSessionStart(VERSION);
  if (!previous) return undefined;

  const when = previous.startedAt ? `（开始于 ${previous.startedAt}）` : "";
  const lines = [
    `${ansi.yellow}⚠ 上次运行疑似异常退出${when}${ansi.reset}`,
  ];

  if (previous.crashLog) {
    lines.push(`${ansi.gray}  最后的记录：${ansi.reset}`);
    for (const line of previous.crashLog.trim().split("\n").slice(-10)) {
      lines.push(`${ansi.gray}    ${line}${ansi.reset}`);
    }
  } else {
    lines.push(
      `${ansi.gray}  未留下日志 —— 多为进程被强制终止（例如内存不足被系统杀掉）${ansi.reset}`,
    );
  }

  lines.push(
    `${ansi.gray}  完整日志：${crashLogPath()}${ansi.reset}`,
    "",
  );
  return lines.join("\n");
}

function printHelp(): void {
  const help = `
${ansi.brightMagenta}${ansi.bold}玄猪 XuanZhu${ansi.reset} ${ansi.gray}v${VERSION} —— 专为终端打造的 AI 编码 Agent${ansi.reset}

${ansi.bold}用法${ansi.reset}
  ${ansi.green}xzh${ansi.reset}                     在当前目录启动交互式终端界面
  ${ansi.green}xzh <目录>${ansi.reset}              在指定项目目录启动，例如 ${ansi.gray}xzh /home${ansi.reset}
  ${ansi.green}xzh --intent${ansi.reset}            本次启动启用意图分析（默认关闭）
  ${ansi.green}xzh --no-intent${ansi.reset}         本次启动强制关闭意图分析
  ${ansi.green}xzh model${ansi.reset}               交互式管理多模型（新增 / 删除 / 查看全部）
  ${ansi.green}xzh model list${ansi.reset}          列出已配置的模型（按回退顺序）
  ${ansi.green}xzh model all${ansi.reset}           列出所有内置可用的模型
  ${ansi.green}xzh model add <provider> <model> [上下文窗口] [on|off]${ansi.reset}
                            新增模型（末尾 on/off = 是否支持图片输入）
  ${ansi.green}xzh model remove <id|序号>${ansi.reset}    删除模型
  ${ansi.green}xzh model context <id|序号> [大小]${ansi.reset}
                            调整上下文窗口（留空则自动推断）
  ${ansi.green}xzh model vision <id|序号> <on|off>${ansi.reset}
                            标注是否支持图片输入
  ${ansi.green}xzh config${ansi.reset}              查看当前配置（API Key 脱敏）
  ${ansi.green}xzh config edit${ansi.reset}         使用 nano 编辑配置文件
  ${ansi.green}xzh config path${ansi.reset}         打印配置文件路径
  ${ansi.green}xzh config init${ansi.reset}         生成默认配置文件
  ${ansi.green}xzh setup${ansi.reset}               检查并安装依赖（剪贴板工具 + 技能 CLI）
  ${ansi.green}xzh skill${ansi.reset}               交互式管理技能（启用 / 禁用 / 删除，禁用的技能对模型不可见）
  ${ansi.green}xzh skill list${ansi.reset}          列出全部技能（含来源与状态）
  ${ansi.green}xzh skill enable/disable <名称>${ansi.reset}
                            启用 / 禁用技能
  ${ansi.green}xzh skill delete <名称>${ansi.reset} 删除技能（仅限用户技能；内置技能请用 disable）
  ${ansi.green}xzh device${ansi.reset}              与手机上的 AutoJs6 / AutoX.js 通信（设备桥）
  ${ansi.green}xzh device serve${ansi.reset}        等手机连过来并常驻（AutoX.js 9317 + AutoJs6 客户端模式 6347）
  ${ansi.green}xzh device connect <手机IP>${ansi.reset}  反过来连手机上的 AutoJs6（服务器模式）
  ${ansi.green}xzh device status|list${ansi.reset}  查看桥与已连接设备
  ${ansi.green}xzh device push|run <文件>${ansi.reset}   把脚本推到手机（保存 / 保存并运行）
  ${ansi.green}xzh device stop${ansi.reset}         停止手机上正在运行的脚本
  ${ansi.green}xzh device logs${ansi.reset}         查看手机上的脚本日志
  ${ansi.green}xzh device check${ansi.reset}        体检：无障碍服务是否就绪、能否操作手机
  ${ansi.green}xzh device shot [输出文件]${ansi.reset}   截取手机当前屏幕并保存为 JPEG
  ${ansi.green}xzh device apk${ansi.reset}          查看/安装手机端 AutoJs6 的安装包
  ${ansi.green}xzh --help${ansi.reset}              显示本帮助
  ${ansi.green}xzh --version${ansi.reset}           显示版本

${ansi.bold}支持的 Provider${ansi.reset}
  deepseek · anthropic · openai · gemini · glm · qwen · groq · ollama · custom

${ansi.bold}配置${ansi.reset}
  配置文件：${ansi.gray}${getConfigPath()}${ansi.reset}
  API Key 也可通过环境变量提供（如 DEEPSEEK_API_KEY / ANTHROPIC_API_KEY）。

${ansi.bold}意图分析${ansi.reset}
  默认关闭。启用后（${ansi.gray}xzh --intent${ansi.reset} 或配置中 ${ansi.gray}intent.enabled${ansi.reset}，
  也可在界面内用 ${ansi.gray}/intent on${ansi.reset}），每条消息会先用模板包裹并请求一次模型，
  返回的分析结果作为本次输入交给主流程。模板可在配置 ${ansi.gray}intent.prompt${ansi.reset} 中自定义。

${ansi.bold}多模型与回退${ansi.reset}
  默认使用**上次用过的**模型；它调用失败时按列表顺序自动切换到下一个，直到所有模型都试过。
  **列表顺序即优先级**（${ansi.gray}xzh model list${ansi.reset} 的顺序），没有权重设置。

${ansi.bold}界面内快捷键${ansi.reset}
  Enter 提交 · Alt+Enter（或 Ctrl/Shift+Enter）换行 · ↑/↓ 历史 · PgUp/PgDn 滚动
  Ctrl+A / Ctrl+E 行首 / 行尾 · Ctrl+C 中断任务 / 退出 · Ctrl+D 结束本轮对话（不退出）
  Ctrl+L 清屏 · Ctrl+V 粘贴图片 · Shift+Tab 切换右侧终端 · 输入 /help 查看内置命令
  切换项目目录：在界面中输入 ${ansi.green}/switch <目录>${ansi.reset}
  临时换模型：${ansi.green}/model${ansi.reset}（↑ ↓ 选择，Enter 确认）
`;
  process.stdout.write(help);
}

main().catch((err) => {
  process.stdout.write(
    `\n${ansi.red}玄猪运行出错：${friendlyError(err)}${ansi.reset}\n`,
  );
  process.exit(1);
});
