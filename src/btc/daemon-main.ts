import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "../config/store";
import { activeExchange } from "../exchange";
import {
  dueMarketEvent,
  readEventsState,
  volatilityDue,
  volatilityReason,
  writeEventsState,
} from "./market-events";
import { ensureBtcNetwork } from "./network";
import { getBtcHome } from "../utils/paths";
import { VERSION } from "../utils/version";
import {
  acquireBackendLock,
  releaseBackendLock,
  writeBackendState,
  type BackendRole,
  type BackendState,
} from "./daemon";
import {
  fetchAccountSnapshot,
  worstPositionLoss,
  type AccountSnapshot,
} from "./account";
import { runInspectCycle, SUMMARY_LIMIT } from "./inspect";
import { syncMarketData } from "./market-data";
import { consecutiveLosses, dailyLossPct } from "./performance";
import { readPause } from "./pause";
import {
  checkHardRisk,
  markRiskDelivered,
  readRiskSettings,
  readRiskState,
  triggerHardRisk,
} from "./risk";
import {
  DEFAULT_CHECK_MINUTES,
  nextScheduledEntry,
  pushSchedule,
  readScheduleQueue,
  takeDueSchedule,
  type ScheduleEntry,
} from "./schedule";

/**
 * btc 常驻后端（`xzh btc serve`，由 `xzh btc` 自动拉起）。
 *
 * 调度模型是**队列 + 定时器**：
 * - 模型每次调用 `btc_schedule` 就往 `~/.btc/run/schedules.json` 里放一条计划；
 * - 进程每 60 秒读一次队列，把**已到期**的条目取出来执行（取出即出队）；
 * - 不做 sleep：空闲时只是在等定时器，收到停止信号能立刻退出；
 *   前台随时可以追加计划，后台下一分钟就能看到。
 *
 * 兜底：队列为空且距上次尝试超过默认间隔（60 分钟）时，直接跑一轮——
 * 避免模型某轮忘了排期之后后台永久停摆。
 */

const DEFAULT_SYNC_INTERVAL_MIN = 15;
/** 定时器节拍：每分钟检查一次队列 */
const TICK_MS = 60_000;
const INSPECT_LOG_MAX_BYTES = 5 * 1024 * 1024;

function log(message: string): void {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 巡检日志：只追加，超过 5MB 轮转一份 */
function appendInspectLog(home: string, block: string): void {
  const file = path.join(home, "logs", "inspect.log");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > INSPECT_LOG_MAX_BYTES) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch {
      // 不存在 = 首次写入
    }
    fs.appendFileSync(
      file,
      `\n==================== ${new Date().toISOString()} ====================\n${block}\n`,
      "utf8",
    );
  } catch (err) {
    log(`⚠ 写巡检日志失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface BackendOptions {
  /** `paper` = 模拟盘后端（独立锁/状态/日志，可用 btc_paper_* 虚拟开平仓） */
  role?: BackendRole;
}

export async function runBtcBackend(
  options: BackendOptions = {},
): Promise<void> {
  const home = getBtcHome();
  const role: BackendRole = options.role ?? "live";
  const paper = role === "paper";
  // 工具（btc_schedule / btc_paper_*）据此判断操作哪个角色的队列
  process.env.XZH_BTC_ROLE = role;

  const lock = await acquireBackendLock(home, role);
  if (!lock.ok) {
    log(
      `已有 btc 后端在运行${lock.pid ? `（pid ${lock.pid}）` : ""}，本进程退出。`,
    );
    return;
  }

  // 后端是独立进程，必须自己做一次网络引导：它不在 `startChat` 的调用链里，
  // 否则界面里正常、后端一直失败，这种不一致极难排查。
  // 引导策略见 src/btc/network.ts（直连优先，不通再自动找本机代理）。
  const network = await ensureBtcNetwork({ config: loadConfig() });
  for (const note of network.notes) log(note);
  log(
    network.mode === "proxy"
      ? `网络：走代理 ${network.proxy}`
      : network.mode === "direct"
        ? "网络：直连"
        : "网络：不可用（交易所接口连不上）",
  );

  const inspectEnabled =
    (process.env.BTC_INSPECT_ENABLED ?? "1").trim() !== "0";
  // 让 btc_schedule 知道这次调用来自后台巡检（用于区分前台手动改期）
  if (inspectEnabled) process.env.XZH_BTC_INSPECT = "1";

  const syncIntervalMin = clampNumber(
    Number(process.env.BTC_SYNC_INTERVAL_MIN ?? DEFAULT_SYNC_INTERVAL_MIN),
    1,
    1440,
  );

  const state: BackendState = {
    pid: process.pid,
    role,
    startedAt: new Date().toISOString(),
    version: VERSION,
    home,
    cycles: 0,
    consecutiveFailures: 0,
    mode: inspectEnabled ? "inspect" : "sync",
    lastError: null,
  };

  let stopping = false;
  let running = false;
  /** 上次尝试巡检的时间（成功失败都算）：兜底判断用它，避免写盘失败后每分钟重试 */
  let lastAttemptAt = 0;

  const onSignal = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`收到 ${signal}，当前轮结束后退出`);
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  /** 把队列现状同步进 state（每分钟刷新一次，供 `xzh btc status` 读） */
  const refreshQueueState = (): void => {
    const queue = readScheduleQueue(home, role);
    const next = queue[0] ?? null;
    state.queueSize = queue.length;
    state.nextCheckAt = next?.at;
    state.nextCheckReason = next ? next.reason : "队列为空（到兜底间隔会自行巡检）";
    writeBackendState(home, state);
  };

  /**
   * 每轮检查一次账户浮亏：触碰硬性风控就落盘触发状态。
   *
   * 为什么放这里而不是面板里：面板可能关着、TUI 可能没开，
   * 而后端是唯一一直在跑的进程 —— 风控不能依赖「用户正好看着屏幕」。
   */
  const checkRisk = async (): Promise<AccountSnapshot | null> => {
    if (paper) return null;
    const snapshot = await fetchAccountSnapshot({ force: true });

    // 连亏只依赖本地账本：账户读不到（网络抖动、密钥临时失效）时也要判，
    // 否则「连续亏三次」这条最该生效的保护会被一次接口失败躲过去
    const settings = readRiskSettings(home);
    const equity = snapshot.ok
      ? (snapshot.wallet?.total ?? 0) + (snapshot.wallet?.unrealized ?? 0)
      : 0;
    // 三个条件一起判：只判持仓亏损的话，「当日亏 15%、连亏 5 次」这种
    // 慢性放血永远不会触发，而那才是最常见的爆仓方式
    const check = checkHardRisk(settings, {
      positionLoss: snapshot.ok ? worstPositionLoss(snapshot) : null,
      consecutiveLosses: consecutiveLosses(home),
      dailyLossPct: snapshot.ok ? dailyLossPct(equity, home) : undefined,
    });
    if (check.triggered) {
      const state = triggerHardRisk(home, check.reason ?? "硬性风控触发", check.detail);
      log(`⚠ 硬性风控触发：${state.reason}${state.detail ? `（${state.detail}）` : ""}`);
    }
    return snapshot;
  };

  /**
   * 检查「确定性的市场时点」与「价格异常波动」。
   *
   * 这两类事情的共同点：**不该等模型想起来**。模型把下次巡检排到 8 小时后，
   * 日线收盘、资金费结算、突发暴跌全错过 —— 那正是「错过行情」的具体形态。
   * 所以由后端每分钟判断一次，命中就直接跑一轮（不占排期队列，
   * 否则每天固定几条 + 持仓时每小时一条，很快把 20 条上限撑爆）。
   */
  const checkEvents = async (
    snapshot: AccountSnapshot | null,
  ): Promise<{ reason: string; price?: number } | null> => {
    const now = Date.now();
    const events = readEventsState(home);

    const hasPosition =
      (snapshot?.positions.length ?? 0) > 0 || (snapshot?.orders.length ?? 0) > 0;

    const event = dueMarketEvent(now, {
      hasPosition,
      lastHandled: events.lastHandled ?? {},
    });
    if (event) {
      // 同一时刻的多个事件（00:00 = 日线收盘 + 资金费）一起标记，
      // 否则下一分钟另一个类型又会满足条件、再烧一轮模型
      const marks: Record<string, number> = { ...(events.lastHandled ?? {}) };
      for (const kind of [event.kind, ...event.sameInstant]) {
        marks[kind] = event.at;
      }
      events.lastHandled = marks as typeof events.lastHandled;
      writeEventsState(home, events);
      log(`市场事件：${event.reason}`);
      return { reason: event.reason };
    }

    // 波动判定：与「上次巡检时的价格」比，而不是与上一分钟比（噪音太大）
    let price: number | undefined;
    try {
      const ticker = await activeExchange(home).exchange.fetchTicker(
        process.env.BTC_SYMBOL?.trim() || "BTC/USDT",
      );
      price = ticker.price;
    } catch {
      // 取不到价就跳过波动判断：网络抖动不该被当成行情异动
      return null;
    }

    const check = volatilityDue({
      price,
      lastPrice: events.lastPrice,
      lastTriggeredAt: events.lastVolatilityAt,
      now,
    });
    if (!check.due) return null;

    events.lastVolatilityAt = now;
    // 立刻把基准价推到当前值：否则价格持续偏离时会连着触发
    events.lastPrice = price;
    writeEventsState(home, events);
    log(`价格波动：${check.changePct.toFixed(2)}%，提前巡检`);
    return { reason: volatilityReason(check.changePct), price };
  };

  /** 跑一轮巡检；`trigger` 说明这一轮为什么被叫醒（队列 / 市场事件 / 兜底） */
  const runInspect = async (
    trigger: { reason: string; price?: number } | null,
  ): Promise<void> => {
    lastAttemptAt = Date.now();
    log(trigger ? `触发巡检：${trigger.reason}` : "队列为空，按兜底规则巡检");

    // 风控告警只送一次：送来送去会让每轮巡检都在「重估」，反而没人做事
    const riskState = readRiskState(home);
    const riskAlert =
      riskState.triggered && !riskState.delivered
        ? { reason: riskState.reason, detail: riskState.detail }
        : undefined;

    const result = await runInspectCycle({ log, paper, riskAlert });
    if (result.ok && riskAlert) markRiskDelivered(home);
    state.riskTriggered = riskState.triggered;
    state.riskReason = riskState.reason;
    state.cycles = (state.cycles ?? 0) + 1;

    if (result.ok) {
      state.consecutiveFailures = 0;
      state.lastInspectAt = new Date().toISOString();
      state.lastInspectSummary = result.summary.slice(0, SUMMARY_LIMIT);
      state.lastError = null;

      // 记下这一轮的价格作为下次波动比较的基准（没有价格时保留旧值）
      if (trigger?.price) {
        const events = readEventsState(home);
        events.lastPrice = trigger.price;
        writeEventsState(home, events);
      }

      const next = nextScheduledEntry(home, role);
      appendInspectLog(
        home,
        [
          `触发：${trigger?.reason ?? "兜底（队列为空）"}`,
          `工具调用：${result.toolCalls}`,
          `下次计划：${next ? `${next.at}（${next.reason}）` : "模型未排期"}`,
          "",
          "结论：",
          result.summary || "（模型没有输出文字结论）",
        ].join("\n"),
      );
      log(
        `巡检完成（${result.toolCalls} 次工具调用）；` +
          (next ? `下一条计划 ${next.at}` : "队列已空，等待兜底"),
      );
    } else {
      const failures = (state.consecutiveFailures ?? 0) + 1;
      state.consecutiveFailures = failures;
      state.lastError = result.error ?? "巡检失败";

      // 失败也要把「下次」写进队列：否则队列空 → 一分钟后就兜底重跑，会变成烧钱循环
      const backoff = Math.min(120, 15 * 2 ** Math.min(failures - 1, 3));
      const pushed = pushSchedule(
        home,
        {
        minutes: backoff,
        reason: `巡检失败（连续 ${failures} 次），退避 ${backoff} 分钟`,
        origin: "inspect",
        slot: "next",
        },
        role,
      );
      log(
        `巡检失败：${state.lastError}；${backoff} 分钟后重试（${pushed.entry.at}）`,
      );
      appendInspectLog(
        home,
        [`巡检失败（连续 ${failures} 次）：${state.lastError}`, `重试：${pushed.entry.at}`].join(
          "\n",
        ),
      );
    }
  };

  /** 仅数据同步（`BTC_INSPECT_ENABLED=0`）：按固定间隔检查是否该同步 */
  const runSyncIfDue = async (now: number): Promise<boolean> => {
    const last = state.lastSyncAt ? Date.parse(state.lastSyncAt) : 0;
    if (last && now - last < syncIntervalMin * 60_000) return false;

    lastAttemptAt = now;
    const result = await syncMarketData({ log });
    state.cycles = (state.cycles ?? 0) + 1;
    if (result.error) {
      state.lastError = result.error;
      log(`同步失败：${result.error}`);
    } else {
      state.lastError = null;
      state.lastSyncAt = new Date().toISOString();
      state.lastSyncWritten = result.written;
      log(`同步完成，写入 ${result.written} 根`);
    }
    writeBackendState(home, state);
    return true;
  };

  const tick = async (): Promise<void> => {
    if (stopping || running) return;
    const now = Date.now();

    // 对话内 `/stop`：暂停自动巡检与自动交易。进程与队列都保留，
    // 风控检查继续跑（用户可能手动开了仓，浮亏一样要监控）。
    const pause = readPause(home);
    state.paused = pause.paused;
    if (pause.paused) {
      await checkRisk();
      refreshQueueState();
      return;
    }

    // 风控与巡检模式无关：`BTC_INSPECT_ENABLED=0` 只是省 token、不做决策，
    // 不代表可以不管风险 —— 用户完全可能在前台手动交易，浮亏一样要监控。
    const snapshot = await checkRisk();

    if (!inspectEnabled) {
      await runSyncIfDue(now);
      refreshQueueState();
      return;
    }

    // 市场事件优先于队列：日线收盘/资金费/暴跌这类时刻比常规排期更该立刻看。
    // 而且这里**不能**先 takeDueSchedule —— 取出即出队，若事件又抢先跑，
    // 那条到期的计划就被吃掉了（既没执行也不会再排）。
    const eventTrigger = await checkEvents(snapshot);
    if (eventTrigger) {
      running = true;
      try {
        await runInspect(eventTrigger);
      } catch (err) {
        state.lastError = err instanceof Error ? err.message : String(err);
        log(`巡检异常：${state.lastError}`);
      } finally {
        running = false;
        refreshQueueState();
      }
      return;
    }

    const due = takeDueSchedule(home, now, role);
    if (!due) {
      // 队列里还有未到点的计划：老老实实等它，不做兜底 ——
      // 否则「设了 30 分钟后的检查点 → 重启后端」会立刻多跑一轮。
      const hasPending = nextScheduledEntry(home, role) !== null;
      const fallbackDue =
        !hasPending &&
        (lastAttemptAt === 0 ||
          now - lastAttemptAt >= DEFAULT_CHECK_MINUTES * 60_000);
      if (!fallbackDue) {
        refreshQueueState();
        return;
      }
    }

    running = true;
    try {
      await runInspect(
        due
          ? {
              reason: `${due.origin === "manual" ? "前台设置" : "巡检排期"}：${due.reason}`,
            }
          : null,
      );
    } catch (err) {
      // 这里兜住任何未预期异常：定时器不能因为一轮失败就整体停摆
      state.lastError = err instanceof Error ? err.message : String(err);
      log(`巡检异常：${state.lastError}`);
    } finally {
      running = false;
      refreshQueueState();
    }
  };

  writeBackendState(home, state);
  refreshQueueState();
  log(
    `btc ${paper ? "模拟盘" : ""}后端启动 pid=${process.pid}，角色=${role}，模式=${inspectEnabled ? "自主巡检（队列调度）" : "仅数据同步"}` +
      (inspectEnabled ? "" : `（间隔 ${syncIntervalMin} 分钟）`) +
      `，目录 ${home}`,
  );

  const timer = setInterval(() => {
    void tick();
  }, TICK_MS);

  // 启动立刻检查一次：队列里可能已经有到期的计划（上次退出时留下的）
  await tick();

  await new Promise<void>((resolve) => {
    const waiter = setInterval(() => {
      if (stopping && !running) {
        clearInterval(waiter);
        resolve();
      }
    }, 200);
  });

  clearInterval(timer);
  releaseBackendLock(home, role);
  log(`btc ${paper ? "模拟盘" : ""}后端已退出`);
}
