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
import { applyProxyConfig } from "../network/proxy";
import { deviceCommand } from "./commands/device";
import { restoreTerminalSafely, TuiApp } from "../tui/app";
import { ansi } from "../utils/ansi";
import {
  expandHome,
  getAShareHome,
  getBtcHome,
  getConfigDir,
  getConfigPath,
  migrateConfigLayout,
  migrateLegacyConfigDir,
} from "../utils/paths";
import { VERSION } from "../utils/version";
import {
  crashLogPath,
  markSessionEnd,
  markSessionStart,
  recordCrash,
} from "../utils/crash";
import { aCommand } from "./commands/a";
import { configCommand } from "./commands/config";
import { errorsCommand } from "./commands/errors";
import { initCommand } from "./commands/init";
import { modelCommand } from "./commands/model";
import { promptCommand } from "./commands/prompt";
import { autonomyCommand } from "./commands/autonomy";
import { setupCommand } from "./commands/setup";
import { vpnCommand } from "./commands/vpn";
import { gatewayCommand } from "./gateway";
import { skillCommand } from "./commands/skill";
import { recordErrorReport } from "../utils/error-reports";
import {
  A_MODE_NAME,
  allModes,
  BTC_MODE_NAME,
  createBtcMode,
  findMode,
  modeForHome,
  type AgentMode,
} from "../modes";
import {
  btcApikeyCommand,
  btcEnsureCredential,
  btcFkCommand,
  btcPlatformCommand,
  btcSetupCommand,
  btcStatusCommand,
  btcStopCommand,
} from "./commands/btc";
import { runBtcBackend } from "../btc/daemon-main";
import { ensureBtcNetwork } from "../btc/network";

// 版本号来自构建期注入（见 utils/version.ts），全项目只此一处来源

// 当输出管道被提前关闭（例如 `xzh config | head`）时优雅退出，避免抛 EPIPE 堆栈
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
});
process.stderr.on("error", () => undefined);

// TUI 运行期间终端处于备用屏 + raw mode + 鼠标/键盘上报状态。
// 任何「非正常退出」都必须先还原，否则 shell 会残留坏状态（点鼠标吐转义码、
// 输出不换行、光标隐藏等）。SIGINT 由 TUI 自己处理，这里不接管。
//
// SIGTERM / SIGHUP —— SSH 断线时 sshd 关闭 pty，内核会向会话的前台进程组发 SIGHUP，
// 所以这条路径**必须**走界面的正常退出流程（`requestShutdown`）而不是直接 exit：
// 右侧终端里的命令是以 detached 进程组起的，直接 exit 会把它们留成孤儿进程。
let activeApp: TuiApp | undefined;
for (const signal of ["SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (activeApp) {
      activeApp.requestShutdown(signal === "SIGHUP" ? "终端连接已断开" : `收到 ${signal}`);
      // 兜底：界面清理卡住（例如设备桥在关连接）时强制退出，不能挂在这里
      setTimeout(() => {
        markSessionEnd();
        restoreTerminalSafely();
        process.exit(0);
      }, 1500).unref();
      return;
    }
    markSessionEnd(); // 用户/系统主动结束，不算崩溃
    restoreTerminalSafely();
    process.exit(0);
  });
}
process.on("uncaughtException", (err) => {
  // 记日志：TUI 在备用屏里，界面消失后 stderr 容易被忽略，日志才是可追溯的
  recordCrash("未捕获异常", err);
  const report = recordErrorReport({
    kind: "uncaught-exception",
    category: "bug",
    error: err,
    cwd: process.cwd(),
  });
  restoreTerminalSafely();
  process.stderr.write(`\n未捕获异常：${err?.stack ?? String(err)}\n`);
  process.stderr.write(`详情已写入 ${crashLogPath()}\n`);
  if (report) process.stderr.write(`错误报告：${report}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  recordCrash("未处理的 Promise 拒绝", reason);
  const report = recordErrorReport({
    kind: "unhandled-rejection",
    category: "bug",
    error: reason,
    cwd: process.cwd(),
  });
  restoreTerminalSafely();
  process.stderr.write(`\n未处理的 Promise 拒绝：${String(reason)}\n`);
  process.stderr.write(`详情已写入 ${crashLogPath()}\n`);
  if (report) process.stderr.write(`错误报告：${report}\n`);
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
  // 全局目录内部布局（config / data / state / runtime）一次性整理。
  // 同样必须早于任何配置读写；幂等，已整理过时是 11 次 stat。
  const layout = migrateConfigLayout();
  if (layout.migrated) {
    process.stdout.write(
      `${ansi.gray}已整理全局目录布局（config / data / state / runtime）${ansi.reset}\n`,
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

  // 专用模式（`xzh btc`）：模式名优先于「同名目录」——
  // 想打开当前目录下名为 btc 的文件夹请写 `xzh ./btc`。
  const mode = findMode(command);
  if (mode) {
    const sub = args[1];
    // A 股：有子命令交给数据探针（quote / bars / snapshot / screen / sync …），
    // 没有则进入模式本体。模式内的工具与提示词在 src/modes/a.ts。
    if (mode.name === A_MODE_NAME) {
      if (sub) {
        await aCommand(args.slice(1));
        return;
      }
      await startChat(mode.home, intentOverride, mode);
      return;
    }
    if (mode.name === BTC_MODE_NAME) {
      if (sub === "setup") {
        await btcSetupCommand(args.slice(2));
        return;
      }
      if (sub === "stop") {
        await btcStopCommand();
        return;
      }
      if (sub === "status") {
        await btcStatusCommand();
        return;
      }
      if (sub === "apikey") {
        await btcApikeyCommand(args.slice(2));
        return;
      }
      if (sub === "fk") {
        await btcFkCommand();
        return;
      }
      if (sub === "platform") {
        await btcPlatformCommand(args.slice(2));
        return;
      }
      // 隐藏子命令：由 `xzh btc` / `xzh btc moni` 以 detached 方式拉起，手动运行用于前台调试
      if (sub === "serve") {
        await runBtcBackend({
          role: args.includes("--paper") ? "paper" : "live",
        });
        return;
      }
      // 模拟盘：同一套模式，换成 paper 角色（独立后端 + 虚拟账本）
      if (sub === "moni") {
        process.env.XZH_BTC_ROLE = "paper";
        await startChat(mode.home, intentOverride, createBtcMode({ paper: true }));
        return;
      }
      if (sub) {
        process.stdout.write(
          `${ansi.red}未知子命令：${command} ${sub}${ansi.reset}\n` +
            `${ansi.gray}${command} 模式目前支持：` +
            `${command}${ansi.gray}（进入模式）、${command} moni（模拟盘）、${command} apikey（凭据管理）、` +
            `${command} fk（硬性风控）、${command} platform（交易平台）、${command} setup、` +
            `${command} stop、${command} status${ansi.reset}\n`,
        );
        process.exitCode = 1;
        return;
      }
      // 实盘启动前确认凭据：没有就进交互式管理（用户选过「跳过」就不再问）
      await btcEnsureCredential();
      await startChat(mode.home, intentOverride, mode);
      return;
    }
    // 其他模式（将来新增）：有子命令就报未知，没有就进入模式
    if (sub) {
      process.stdout.write(
        `${ansi.red}未知子命令：${command} ${sub}${ansi.reset}\n` +
          `${ansi.gray}${command} 模式暂不支持子命令${ansi.reset}\n`,
      );
      process.exitCode = 1;
      return;
    }
    await startChat(mode.home, intentOverride, mode);
    return;
  }

  switch (command) {
    case undefined:
      await startChat(undefined, intentOverride);
      return;
    // A 股：数据/巡检子命令走 aCommand（serve / watch / monitor / quote / bars / …），
    // 无子命令时进入模式本体（工具与提示词在 src/modes/a.ts）。
    case "a":
      await aCommand(args.slice(1));
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
    case "init":
      await initCommand(args.slice(1));
      return;
    case "skill":
      await skillCommand(args.slice(1));
      return;
    case "prompt":
      await promptCommand(args.slice(1));
      return;
    case "autonomy":
      autonomyCommand(args.slice(1));
      return;
    case "errors":
      await errorsCommand(args.slice(1));
      return;
    case "vpn":
      await vpnCommand(args.slice(1));
      return;
    case "gateway":
      await gatewayCommand(args.slice(1));
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
      // 目录正好是某个模式的固定目录时（`xzh ~/.xzh_btc`），进入对应模式，
      // 保证「同一个目录不管从哪条路径进来，约束都一样」。
      const dir = resolveDirectory(command);
      if (dir) {
        await startChat(dir, intentOverride, modeForHome(dir));
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
  mode?: AgentMode,
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(
      `${ansi.red}玄猪需要交互式终端（TTY）。${ansi.reset}\n` +
        `${ansi.gray}请在真实终端中运行 xzh。${ansi.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }

  // 模式的固定目录必须存在：首次 `xzh btc` 时 `~/.xzh_btc` 还没有。
  // 这里只建空目录（记忆与会话会在启动流程里初始化），不联网、不落业务数据 ——
  // 计算脚本与行情库由模式自己的 bootstrap 负责，不能拖慢每次启动。
  /** 常驻服务的启动结果，稍后并进界面顶部提示 */
  let serviceNotice: string | undefined;

  if (mode) {
    fs.mkdirSync(mode.home, { recursive: true });
    try {
      // 释放随包资产（毫秒级、无网络）；失败只影响该模式的功能，不该拦住启动
      mode.bootstrap?.(mode.home);
    } catch {
      // 忽略：工具层会给出更具体的错误（缺脚本 / 缺 venv）
    }

    // 首次进入就把环境装好 —— 新手不该先读一段「请手动运行 setup」的提示。
    // 必须在这里而不是更晚：TUI 一旦接管终端进入备用屏，pip 的进度就看不见了。
    // 失败**不拦启动**：用户仍能进界面看行情，可稍后重试 `xzh btc setup`。
    // XZH_SKIP_AUTO_SETUP=1 可跳过（CI / 离网 / 自己管环境的场景）。
    if (mode.autoSetup && !process.env.XZH_SKIP_AUTO_SETUP?.trim()) {
      const prepared = await mode.autoSetup();
      if (!prepared.ok) {
        process.stdout.write(
          `${ansi.yellow}⚠ 环境准备未完成：${prepared.error ?? "未知原因"}${ansi.reset}\n` +
            `${ansi.gray}  仍会进入界面；行情 / 回测暂不可用，可稍后重试 ${ansi.reset}xzh btc setup${ansi.gray}。${ansi.reset}\n\n`,
        );
      }
    }

    // 网络引导：先试直连，不通再自动找本机代理（策略见 src/btc/network.ts）。
    // 必须在 ensureService 之前 —— 后端是独立进程，会自己做一次；这里做是为了
    // 让**当前会话**的工具调用也能立刻取到行情，并把结论告诉用户。
    if (mode.name === BTC_MODE_NAME) {
      const network = await ensureBtcNetwork({ config: loadConfig() });
      for (const note of network.notes) {
        process.stdout.write(`${ansi.gray}${note}${ansi.reset}\n`);
      }
      if (network.notes.length > 0) process.stdout.write("\n");
    }

    // 常驻服务（btc 的行情巡检后端）：没有就拉起，已在跑就复用。
    // 界面退出**不**停它 —— 下次进入时这里会拿到「复用」而不是再启动一个。
    if (mode.ensureService) {
      try {
        serviceNotice = (await mode.ensureService()).message;
      } catch (err) {
        serviceNotice = `⚠ 常驻服务启动失败：${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }
  }

  const config = loadConfig();

  // 全局代理：先于 Provider 创建生效，让模型请求与 bash 子进程都走同一代理
  const proxy = applyProxyConfig(config);
  if (proxy.error) {
    process.stdout.write(
      `${ansi.yellow}⚠ 代理配置无效，已忽略：${proxy.error}${ansi.reset}\n`,
    );
  }

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

  const notices = [mode?.startupHint, serviceNotice, buildStartupNotice()].filter(
    (item): item is string => Boolean(item),
  );

  const app = new TuiApp({
    provider,
    config,
    cwd: cwd ?? process.cwd(),
    mode,
    providerLabel: meta?.label ?? active.provider,
    model: active.model,
    activeModel: active,
    intentEnabled:
      intentOverride !== undefined
        ? intentOverride
        : config.intent?.enabled === true,
    autoApprove: config.autoApprove,
    startupNotice: notices.length > 0 ? notices.join("\n") : undefined,
  });

  activeApp = app;
  await app.start();
  activeApp = undefined;
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
  ${ansi.green}xzh btc${ansi.reset}                进入 BTC 量化交易模式：工作目录固定为 ${ansi.gray}${getBtcHome()}${ansi.reset}
                            （${ansi.gray}XZH_BTC_HOME${ansi.reset} 可重定向、不可 /switch、只加载交易相关技能）
  ${ansi.green}xzh btc setup${ansi.reset}          重建 btc 计算环境（首次进入模式时自动执行；此处用于修复 / ${ansi.gray}--force${ansi.reset} 重装）
  ${ansi.green}xzh btc moni${ansi.reset}           进入 BTC 模拟盘：虚拟账本开平仓，不涉及真钱（独立后端）
  ${ansi.green}xzh btc apikey${ansi.reset}         管理交易所 API 凭据（录入 / 更新 / 删除 / 查看别名）
  ${ansi.green}xzh btc fk${ansi.reset}             硬性风控阈值（持仓亏损 / 当日亏损 / 连亏）
  ${ansi.green}xzh btc platform${ansi.reset}       选择交易平台（默认币安；已接入的只有币安）
  ${ansi.green}xzh btc stop${ansi.reset}           停止 btc 常驻后端（退出界面不会停它；${ansi.gray}--paper${ansi.reset} 只停模拟盘）
  ${ansi.green}xzh btc status${ansi.reset}         查看观察 / 模拟盘两个后端与排期队列
  ${ansi.green}xzh a${ansi.reset}                   进入 A 股分析模式：工作目录固定为 ${ansi.gray}${getAShareHome()}${ansi.reset}（不可 /switch）
  ${ansi.green}xzh a serve [status|stop]${ansi.reset} A 股独立巡检与监控：盘中每 15 分钟选股 / 监控 / 模拟买卖
  ${ansi.green}xzh a start|stop${ansi.reset}         启动 / 停止 A 股巡检（简写）
  ${ansi.green}xzh a watch [add|remove]${ansi.reset}  自选股（≤10，持仓强制保留）
  ${ansi.green}xzh a quote <代码...>${ansi.reset}    实时快照；指数写 1A0001
  ${ansi.green}xzh a bars <代码>${ansi.reset}        K 线（--period / --adjust / --limit / --from）
  ${ansi.green}xzh a snapshot${ansi.reset}           全市场温度（涨跌家数 / 涨跌停 / 成交额 / 分布）
  ${ansi.green}xzh a screen${ansi.reset}             横截面筛选（--pct-min / --amount-min / --above-ma20 …）
  ${ansi.green}xzh a market${ansi.reset}             主要指数一览
  ${ansi.green}xzh a sync|status${ansi.reset}        建股票池 + 预计算指标 / 查看缓存状态
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
  ${ansi.green}xzh vpn${ansi.reset}                 交互式设置 / 探测 / 测试全局 HTTP(S)/SOCKS5 代理
  ${ansi.green}xzh gateway${ansi.reset}             启动常驻 gateway（stop / restart / status / autostart）
  ${ansi.green}xzh setup${ansi.reset}               检查并安装依赖（剪贴板工具 + 技能 CLI）
  ${ansi.green}xzh init${ansi.reset}                搭建 AGENTS.md 与 docs/ 初始框架（确定性，不调用模型）
  ${ansi.green}xzh init --dry-run${ansi.reset}      只预览将生成的内容，不写文件
  ${ansi.green}xzh init --force${ansi.reset}        整体覆盖已有规范文件（覆盖前备份）
  ${ansi.green}xzh skill${ansi.reset}               交互式管理技能（启用 / 禁用 / 删除，禁用的技能对模型不可见）
  ${ansi.green}xzh skill list${ansi.reset}          列出全部技能（含来源与状态）
  ${ansi.green}xzh skill enable/disable <名称>${ansi.reset}
                            启用 / 禁用技能
  ${ansi.green}xzh skill delete <名称> [--yes]${ansi.reset}
                            删除技能（仅限用户技能；内置技能请用 disable）
  ${ansi.green}xzh prompt${ansi.reset}              查看系统提示词的段落（可分段覆盖，不必整份重写）
  ${ansi.green}xzh prompt show [段落]${ansi.reset}   打印当前提示词 / 某段的内置原文与生效内容
  ${ansi.green}xzh prompt set <段落> <文件|->${ansi.reset}  用文件（或 stdin）覆盖某一段
  ${ansi.green}xzh prompt reset <段落|--all>${ansi.reset}   取消覆盖
  ${ansi.green}xzh autonomy${ansi.reset}           查看自治等级（ask / observe / auto）与最近拦截记录
  ${ansi.green}xzh autonomy <档位>${ansi.reset}    切换自治等级；observe = 只观察、改动一律拦截并记账
  ${ansi.green}xzh autonomy log [N]${ansi.reset}   打印观察日志（.xuanzhu/state/observe.log）
  ${ansi.green}xzh errors${ansi.reset}              查看玄猪记录的错误报告（~/.xzh/state/errors/，等价 errors list）
  ${ansi.green}xzh errors list${ansi.reset}         列出全部报告（最近的在前）
  ${ansi.green}xzh errors show <序号|签名>${ansi.reset}  查看一份报告的完整内容
  ${ansi.green}xzh errors path${ansi.reset}         打印报告目录
  ${ansi.green}xzh errors clear [--yes]${ansi.reset} 清空错误报告
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
  ${ansi.gray}  · device 通用参数：--port <端口>（默认 9317）· --device <名称> 只对某台设备下发${ansi.reset}
  ${ansi.green}xzh help${ansi.reset}                显示本帮助（同 --help）
  ${ansi.green}xzh version${ansi.reset}             显示版本（同 --version）
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
