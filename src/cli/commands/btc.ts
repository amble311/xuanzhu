import { btcVenvReady } from "../../btc/bootstrap";
import { formatLocalTime } from "../../utils/time";
import {
  credentialManager,
  credentialStatusLine,
} from "../../btc/credential-prompt";
import {
  credentialPromptSkipped,
  hasCredential,
} from "../../btc/credentials";
import {
  BACKEND_ROLES,
  liveBackend,
  stopAllBackends,
  stopBtcBackend,
  type BackendRole,
  type BackendState,
} from "../../btc/daemon";
import { readScheduleQueue, type ScheduleEntry } from "../../btc/schedule";
import {
  activeExchange,
  DEFAULT_EXCHANGE_ID,
  EXCHANGES,
  findExchange,
} from "../../exchange";
import {
  PLANNED_EXCHANGES,
  platformPath,
  setPlatformSetting,
} from "../../exchange/platform";
import {
  clearHardRisk,
  readRiskSettings,
  readRiskState,
  writeRiskSettings,
  type HardRiskSettings,
} from "../../btc/risk";
import { promptConfirm, promptInput, promptSelect } from "../prompt";
import { setupBtcEnv } from "../../btc/setup";
import { ansi } from "../../utils/ansi";
import { getBtcHome } from "../../utils/paths";

/**
 * `xzh btc` 的子命令。
 *
 * - `setup`：手动准备 / 修复计算环境（首次进入会自动跑）；
 * - `moni`：进入模拟盘（由 CLI 主流程处理，这里没有对应函数）；
 * - `stop`：停常驻后端（默认两个角色都停，`--paper` 只停模拟盘）。
 *   界面退出**不会**停它们，所以这是唯一的关闭入口；
 * - `status`：看两个后端的状态与排期队列。
 */

export async function btcSetupCommand(args: string[] = []): Promise<void> {
  const result = await setupBtcEnv({ force: args.includes("--force") });

  if (!result.ok) {
    process.stdout.write(
      `${ansi.red}✗ 环境准备未完成${ansi.reset}\n` +
        `${ansi.gray}  ${(result.error ?? "未知原因").split("\n").join("\n  ")}${ansi.reset}\n\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (result.skipped) {
    process.stdout.write(
      `${ansi.gray}无需重复准备。重装请加 --force。${ansi.reset}\n\n`,
    );
    return;
  }
  process.stdout.write(
    `${ansi.gray}接下来：${ansi.reset}xzh btc${ansi.gray} 进入模式，先让 agent 同步行情（btc_sync）。${ansi.reset}\n\n`,
  );
}

/** 实盘启动前的凭据检测：没有就进交互菜单（跳过过 / 非 TTY 时不再打扰） */
export async function btcEnsureCredential(): Promise<boolean> {
  if (hasCredential("binance")) return true;
  if (credentialPromptSkipped()) return false;

  if (!process.stdin.isTTY) {
    process.stdout.write(
      `${ansi.yellow}⚠ 未配置币安凭据${ansi.reset}` +
        `${ansi.gray}（当前不是交互终端，跳过配置；需要时在终端运行 ${ansi.reset}xzh btc apikey${ansi.gray}）${ansi.reset}\n\n`,
    );
    return false;
  }

  const result = await credentialManager({
    reason:
      "未检测到币安凭据。实盘下单需要它；只想看行情与信号可以跳过（之后用 xzh btc apikey 配置）。",
  });
  return result === "configured";
}

/** `xzh btc apikey`：随时进入交互式凭据管理 */
export async function btcApikeyCommand(args: string[] = []): Promise<void> {
  if (!process.stdin.isTTY) {
    process.stdout.write(
      `${ansi.red}✗ 凭据管理需要交互终端${ansi.reset}\n` +
        `${ansi.gray}  请在终端里直接运行 ${ansi.reset}xzh btc apikey${ansi.gray}。${ansi.reset}\n\n`,
    );
    process.exitCode = 1;
    return;
  }

  // 允许 `xzh btc apikey binance` 直达某平台（以后加平台时省一次选择）
  const platform = args.find((arg) => !arg.startsWith("-"));
  const result = await credentialManager({ platform });
  process.stdout.write("\n");
  if (result === "configured") {
    process.stdout.write(
      `${ansi.green}✓ 凭据就绪${ansi.reset}${ansi.gray}（${credentialStatusLine()}）${ansi.reset}\n\n`,
    );
    return;
  }
  process.stdout.write(
    `${ansi.gray}当前凭据：${credentialStatusLine()}${ansi.reset}\n\n`,
  );
}

/**
 * `xzh btc fk` —— 硬性风控设置。
 *
 * 用户交互式设定阈值，**由代码执行**：达到阈值就停止开新仓，并让后台下一轮巡检
 * 带着「风控已触发、重新评估策略」的上下文跑。与 `btc_policy`（agent 级、软约束）
 * 分开：这里的是硬线，模型无权放宽。
 */
export async function btcFkCommand(): Promise<void> {
  const home = getBtcHome();
  let settings = readRiskSettings(home);
  const state = readRiskState(home);

  const pct = (value: number) => `${value}%`;

  if (!process.stdin.isTTY) {
    process.stdout.write(
      `\n${ansi.bold}硬性风控${ansi.reset}\n` +
        `  状态：${state.triggered ? `${ansi.red}已触发${ansi.reset}` : `${ansi.green}正常${ansi.reset}`}\n` +
        `  单持仓亏损阈值：${pct(settings.maxPositionLossPct)}\n` +
        `  当日亏损阈值：${pct(settings.maxDailyLossPct)}\n` +
        `  连续亏损次数：${settings.maxConsecutiveLosses}\n` +
        `${ansi.gray}  修改需要在交互终端里运行 xzh btc fk${ansi.reset}\n\n`,
    );
    return;
  }

  let dirty = false;

  while (true) {
    process.stdout.write(`\n${ansi.bold}硬性风控${ansi.reset}\n`);
    process.stdout.write(
      `  状态：${
        state.triggered
          ? `${ansi.red}已触发${ansi.reset}`
          : `${ansi.green}正常${ansi.reset}`
      }\n`,
    );
    if (state.triggered) {
      process.stdout.write(
        `${ansi.gray}  触发于 ${state.at ?? "?"} · ${state.reason ?? "原因未知"}` +
          `${state.detail ? ` · ${state.detail}` : ""}${ansi.reset}\n`,
      );
    }

    const items = [
      {
        label: "单持仓亏损阈值",
        value: "loss",
        hint: pct(settings.maxPositionLossPct),
      },
      {
        label: "当日亏损阈值",
        value: "daily",
        hint: pct(settings.maxDailyLossPct),
      },
      {
        label: "连续亏损次数",
        value: "consec",
        hint: `${settings.maxConsecutiveLosses} 次`,
      },
      {
        label: "触发后禁止开仓",
        value: "pause",
        hint: settings.haltTradingOnTrigger ? "是" : "否",
      },
    ];
    if (state.triggered) {
      items.push({ label: "解除触发", value: "clear", hint: "确认后恢复" });
    }
    items.push({
      label: dirty ? "保存并返回" : "返回",
      value: "done",
      hint: dirty ? "写入 risk.json" : "未修改",
    });

    const picked = await promptSelect("选择要修改的项", items);
    if (!picked || picked === "done") break;

    if (picked === "clear") {
      const ok = await promptConfirm("确认解除硬性风控触发？解除后允许重新开仓", false);
      if (!ok) continue;
      // 解除是即时动作，不依赖「保存」
      writeRiskSettings(home, settings);
      const cleared = clearHardRisk(home);
      process.stdout.write(
        `${ansi.green}✓${ansi.reset} 已解除${
          cleared.triggered ? "" : "，当前状态：正常"
        }\n`,
      );
      // 重新读取，避免上面 const 的快照过期
      Object.assign(state, readRiskState(home));
      continue;
    }

    if (picked === "pause") {
      settings = {
        ...settings,
        haltTradingOnTrigger: await promptConfirm(
          "触发硬性风控后禁止开新仓（巡检照常，用来重估策略）？",
          settings.haltTradingOnTrigger,
        ),
      };
      dirty = true;
      continue;
    }

    const current: Record<string, number> = {
      loss: settings.maxPositionLossPct,
      daily: settings.maxDailyLossPct,
      consec: settings.maxConsecutiveLosses,
    };
    const labels: Record<string, string> = {
      loss: "单持仓亏损阈值（%）",
      daily: "当日亏损阈值（%）",
      consec: "连续亏损次数",
    };

    const answer = await promptInput(
      `  ${labels[picked]}`,
      String(current[picked]),
    );
    const parsed = Number(answer);
    const valid =
      picked === "consec"
        ? Number.isFinite(parsed) && parsed >= 1 && parsed <= 100
        : Number.isFinite(parsed) && parsed > 0 && parsed <= 100;
    if (!valid) {
      process.stdout.write(
        `${ansi.yellow}  无效值（${picked === "consec" ? "1–100" : "0–100 的百分比"}），已保持原值。${ansi.reset}\n`,
      );
      continue;
    }

    settings = {
      ...settings,
      ...(picked === "loss" ? { maxPositionLossPct: Math.round(parsed * 100) / 100 } : {}),
      ...(picked === "daily" ? { maxDailyLossPct: Math.round(parsed * 100) / 100 } : {}),
      ...(picked === "consec" ? { maxConsecutiveLosses: Math.round(parsed) } : {}),
    } as HardRiskSettings;
    dirty = true;
  }

  if (dirty) {
    writeRiskSettings(home, settings);
    process.stdout.write(
      `${ansi.green}✓${ansi.reset} 硬性风控已保存，立即对后台巡检生效\n` +
        `${ansi.gray}  持仓亏损 ${pct(settings.maxPositionLossPct)} · ` +
        `当日亏损 ${pct(settings.maxDailyLossPct)} · ` +
        `连亏 ${settings.maxConsecutiveLosses} 次${ansi.reset}\n\n`,
    );
    return;
  }
  process.stdout.write("\n");
}

const SOURCE_LABEL: Record<string, string> = {
  env: "环境变量 BTC_EXCHANGE",
  config: "platform.json（xzh btc platform 设置）",
  default: `默认值（${DEFAULT_EXCHANGE_ID}）`,
};

/** 打印当前平台与来源 */
function printPlatformStatus(home: string): void {
  const active = activeExchange(home);
  process.stdout.write(`\n${ansi.bold}交易平台${ansi.reset}\n`);
  process.stdout.write(
    `  当前：${ansi.green}${active.exchange.label}${ansi.reset}` +
      `${ansi.gray}（${active.exchange.id}）· 来源：${SOURCE_LABEL[active.source]}${ansi.reset}\n`,
  );
  if (active.error) {
    process.stdout.write(`${ansi.red}  ✗ ${active.error}${ansi.reset}\n`);
  }
  process.stdout.write(
    `  标的：${process.env.BTC_SYMBOL?.trim() || "BTC/USDT"}` +
      `${ansi.gray}（BTC_SYMBOL 可改）${ansi.reset}\n`,
  );
  process.stdout.write(
    `  已接入：${EXCHANGES.map((exchange) => exchange.id).join(" / ")}` +
      `${ansi.gray}；开发中：${PLANNED_EXCHANGES.map((item) => item.id).join(" / ")}${ansi.reset}\n`,
  );
  if (active.source === "env") {
    process.stdout.write(
      `${ansi.yellow}  注意：环境变量 BTC_EXCHANGE 优先于 platform.json，` +
        `它会在所有进程里覆盖这里的设置。${ansi.reset}\n`,
    );
  }
  process.stdout.write("\n");
}

/** 切换成功后的提示（含「环境变量会覆盖」的警告） */
function printSwitched(id: string, home: string): void {
  const active = activeExchange(home);
  process.stdout.write(
    `\n${ansi.green}✓${ansi.reset} 已切换为 ${ansi.bold}${active.exchange.label}${ansi.reset}` +
      `${ansi.gray}（写入 ${platformPath(home)}）${ansi.reset}\n`,
  );
  if (process.env.BTC_EXCHANGE?.trim()) {
    process.stdout.write(
      `${ansi.yellow}⚠ 但环境变量 BTC_EXCHANGE=${process.env.BTC_EXCHANGE.trim()} 优先级更高，` +
        `实际仍在使用 ${active.exchange.label}。取消该变量后才生效。${ansi.reset}\n`,
    );
  } else {
    process.stdout.write(
      `${ansi.gray}  下次工具调用与后台巡检即生效（无需重启）。${ansi.reset}\n`,
    );
  }
  process.stdout.write("\n");
}

/**
 * `xzh btc platform [id]` —— 选择交易平台。
 *
 * - 不带参数：交互式选择（TTY），非交互时只打印当前值与来源；
 * - 带 id：直接写入（脚本友好），例如 `xzh btc platform binance`。
 *
 * 平台列表来自 `EXCHANGES` 注册表：新增平台只需加适配器，命令与菜单自动跟着长。
 */
export async function btcPlatformCommand(args: string[] = []): Promise<void> {
  const home = getBtcHome();
  const requested = args.find((arg) => !arg.startsWith("-"));

  if (requested) {
    const wanted = requested.trim().toLowerCase();
    const found = findExchange(wanted);
    if (!found) {
      const planned = PLANNED_EXCHANGES.find((item) => item.id === wanted);
      process.stdout.write(
        `\n${ansi.red}✗ ${
          planned ? `${planned.label} 尚未接入` : `未知平台：${requested}`
        }${ansi.reset}\n` +
          `${ansi.gray}  已接入：${EXCHANGES.map((exchange) => exchange.id).join(" / ")}${ansi.reset}\n\n`,
      );
      process.exitCode = 1;
      return;
    }
    setPlatformSetting(found.id, home);
    printSwitched(found.id, home);
    return;
  }

  if (!process.stdin.isTTY) {
    printPlatformStatus(home);
    return;
  }

  const active = activeExchange(home);
  const options = EXCHANGES.map((exchange) => ({
    label: exchange.label,
    value: exchange.id,
    hint: exchange.id === active.exchange.id ? "当前" : undefined,
  }));
  const plannedValues = new Set<string>();
  for (const planned of PLANNED_EXCHANGES) {
    const value = `planned:${planned.id}`;
    plannedValues.add(value);
    options.push({ label: planned.label, value, hint: "开发中，不可选" });
  }

  const picked = await promptSelect("选择交易平台", options);
  if (!picked) {
    process.stdout.write(`${ansi.gray}已取消，仍使用 ${active.exchange.label}。${ansi.reset}\n\n`);
    return;
  }
  if (plannedValues.has(picked)) {
    process.stdout.write(
      `${ansi.yellow}${picked.replace("planned:", "")} 尚未接入${ansi.reset}` +
        `${ansi.gray} —— 需要新增一个适配器（src/exchange/）+ 一份口径 references。${ansi.reset}\n\n`,
    );
    return;
  }

  setPlatformSetting(picked, home);
  printSwitched(picked, home);
}

export async function btcStopCommand(args: string[] = []): Promise<void> {
  const paperOnly = args.includes("--paper");
  const results = paperOnly
    ? [await stopBtcBackend("paper")]
    : await stopAllBackends();

  const stopped = results.filter((item) => item.stopped);
  const failed = results.filter((item) => item.error);

  if (stopped.length === 0 && failed.length === 0) {
    process.stdout.write(
      `${ansi.gray}btc 常驻后端未在运行${
        paperOnly ? "（模拟盘）" : ""
      }。${ansi.reset}\n\n`,
    );
    return;
  }

  for (const item of stopped) {
    process.stdout.write(
      `${ansi.green}✓${ansi.reset} btc ${roleLabel(item.role)}后端已停止（pid ${item.pid}）\n`,
    );
  }
  for (const item of failed) {
    process.stdout.write(
      `${ansi.red}✗${ansi.reset} btc ${roleLabel(item.role)}后端停止失败：${item.error}\n`,
    );
  }
  process.stdout.write("\n");
  if (failed.length > 0) process.exitCode = 1;
}

function roleLabel(role: BackendRole): string {
  // `live` 是内部标识（表示「对着真实行情」），展示名用「实盘」：
  // 它和模拟盘是一对，不是「只看不做」的观察者。
  return role === "paper" ? "模拟盘" : "实盘";
}

function printQueue(
  queue: ScheduleEntry[],
  indent: string,
  limit = 5,
): void {
  for (const entry of queue.slice(0, limit)) {
    const waitMin = Math.max(
      0,
      Math.round((Date.parse(entry.at) - Date.now()) / 60_000),
    );
    const tag = entry.slot === "next" ? "下一跳" : "额外";
    const who = entry.origin === "manual" ? "前台" : "巡检";
    process.stdout.write(
      `${indent}#${entry.id.slice(-6)} ${formatLocalTime(entry.at, "monthday")}（约 ${waitMin} 分钟后）` +
        `[${tag}/${who}] ${entry.reason}\n`,
    );
  }
  if (queue.length > limit) {
    process.stdout.write(`${indent}…… 还有 ${queue.length - limit} 条\n`);
  }
}

function printRoleBlock(
  role: BackendRole,
  state: BackendState | null,
  queue: ScheduleEntry[],
): void {
  const label = roleLabel(role);
  if (!state) {
    const hint =
      role === "paper" ? "xzh btc moni 会自动拉起" : "xzh btc 会自动拉起";
    process.stdout.write(`  ${ansi.bold}[${label}]${ansi.reset} ${ansi.yellow}未运行${ansi.reset}（${hint}）\n`);
    if (queue.length > 0) {
      process.stdout.write(`    待执行计划：${queue.length} 条\n`);
      printQueue(queue, "      ");
    }
    return;
  }

  const modeText =
    state.mode === "sync" ? "仅数据同步" : "自主巡检（队列调度）";
  const pausedText = state.paused
    ? ` · ${ansi.yellow}已暂停${ansi.reset}${ansi.gray}（/stop resume 恢复）${ansi.reset}`
    : "";
  process.stdout.write(
    `  ${ansi.bold}[${label}]${ansi.reset} ${ansi.green}运行中${ansi.reset}（pid ${state.pid}）` +
      ` · ${modeText} · 已完成 ${state.cycles ?? 0} 轮${pausedText}\n`,
  );
  if (state.mode !== "sync") {
    process.stdout.write(
      `    最近巡检：${state.lastInspectAt ?? "尚未完成"} · 队列 ${queue.length} 条\n`,
    );
    printQueue(queue, "    ");
    if (state.lastInspectSummary) {
      process.stdout.write(
        `    最近结论：${ansi.gray}${state.lastInspectSummary.replace(/\s+/g, " ")}${ansi.reset}\n`,
      );
    }
  } else {
    process.stdout.write(
      `    最近同步：${state.lastSyncAt ?? "尚未完成"}` +
        `${state.lastSyncWritten !== undefined ? `（写入 ${state.lastSyncWritten} 根）` : ""}\n`,
    );
  }
  process.stdout.write(
    `    最近错误：${state.lastError ? `${ansi.yellow}${state.lastError}${ansi.reset}` : "无"}\n`,
  );
}

export async function btcStatusCommand(): Promise<void> {
  const home = getBtcHome();

  process.stdout.write(`\n${ansi.bold}btc 常驻后端${ansi.reset}\n`);
  for (const role of BACKEND_ROLES) {
    // 直接读队列文件而不是只信 state：state 每分钟才刷新一次，
    // 前台刚加的计划要能立刻看到
    printRoleBlock(
      role,
      liveBackend(home, role),
      readScheduleQueue(home, role),
    );
  }

  process.stdout.write(
    `  日志：${ansi.gray}${home}/logs/{backend,paper}.log${ansi.reset}\n`,
  );
  const active = activeExchange(home);
  process.stdout.write(
    `  交易平台：${active.exchange.label}${ansi.gray}（${active.exchange.id} · ` +
      `${SOURCE_LABEL[active.source]}）${ansi.reset}` +
      (active.error ? ` ${ansi.red}✗ 配置无效${ansi.reset}` : "") +
      "\n",
  );
  process.stdout.write(
    `  计算环境：${
      btcVenvReady(home)
        ? `${ansi.green}已就绪${ansi.reset}`
        : `${ansi.yellow}未安装${ansi.reset}（xzh btc setup）`
    }\n\n`,
  );
}
