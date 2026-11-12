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
import { runRunner } from "./python";
import { readActions } from "./actions";
import {
  describeExpiredOrders,
  findExpiredOrders,
  ORDER_TTL_CHECK_INTERVAL_MS,
  type PaperOpenOrder,
} from "./order-ttl";
import {
  MARKET_HEALTH_INTERVAL_MS,
  shouldAlertMarket,
} from "./market-health";
import {
  describeHit,
  evaluateTriggersDetailed,
  indicatorKey,
  markTriggerErrors,
  readTriggers,
  recordEvaluation,
  TRIGGER_EVAL_INTERVAL_MS,
  type TriggerHit,
} from "./triggers";
import { auditTrigger } from "./trigger-audit";
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
 * - 模型每次调用 `btc_schedule` 就往 `~/.xzh_btc/run/schedules.json` 里放一条计划；
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
  /** 上次评估叫醒条件的 5 分钟节流（tick 是 1 分钟一次） */
  let lastTriggerEvalAt = 0;
  /** 上次检查挂单时效的时间（同样 5 分钟一次，避免频繁读账户/起 python） */
  let lastOrderTtlCheckAt = 0;

  const onSignal = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`收到 ${signal}，当前轮结束后退出`);
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  /** 把队列与叫醒条件现状同步进 state（供面板 / `xzh btc status` 读） */
  const refreshQueueState = (): void => {
    const queue = readScheduleQueue(home, role);
    const next = queue[0] ?? null;
    state.queueSize = queue.length;
    state.nextCheckAt = next?.at;
    state.nextCheckReason = next ? next.reason : "队列为空（到兜底间隔会自行巡检）";

    // 叫醒条件的倒计时：面板要显示「还有多久评估下一次」。
    // lastTriggerEvalAt 为 0 表示刚启动、还没评估过 —— 那一次就是现在。
    const triggers = readTriggers(home, role);
    state.triggerCount = triggers.length;
    state.nextTriggerEvalAt =
      triggers.length === 0
        ? undefined
        : new Date(
            lastTriggerEvalAt > 0
              ? lastTriggerEvalAt + TRIGGER_EVAL_INTERVAL_MS
              : Date.now(),
          ).toISOString();

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

  /**
   * 检查用户/模型设的「叫醒条件」（`run/triggers.json`）。
   *
   * 与市场事件的分工：市场事件是代码自己认定的关键时点，这里是人给的条件。
   * 评估成本刻意压低：价格用一次 ticker，指标用本地库一次 probe；
   * **只有命中才调模型**，所以 5 分钟一次也不会烧 token。
   *
   * 命中即把条件记入状态（一次性条件直接失效），并把「谁叫醒的」带给巡检 ——
   * 否则模型只会看到一次莫名其妙的常规巡检，容易答一句「无变化」就排下一次。
   */
  const checkTriggers = async (): Promise<{
    reason: string;
    price?: number;
    triggerNote?: string;
    /** 巡检成功后才执行：写回命中（一次性条件在此失效） */
    commit: () => void;
  } | null> => {
    const now = Date.now();
    if (now - lastTriggerEvalAt < TRIGGER_EVAL_INTERVAL_MS) return null;

    const triggers = readTriggers(home, role);
    if (triggers.length === 0) return null;
    // 先占住这一轮：即使取价/算指标失败，也等到下个 5 分钟再试，
    // 否则网络抖动时会变成每分钟都起一次 python
    lastTriggerEvalAt = now;

    // 公式条件也可能引用实时价（`price` 变量），所以它也要求取一次 ticker
    const formulaTriggers = triggers.filter(
      (item) => item.kind === "formula" && typeof item.expression === "string",
    );
    const needPrice =
      triggers.some((item) => item.kind === "price") || formulaTriggers.length > 0;
    let price: number | undefined;
    if (needPrice) {
      try {
        const ticker = await activeExchange(home).exchange.fetchTicker(
          process.env.BTC_SYMBOL?.trim() || "BTC/USDT",
        );
        price = ticker.price;
      } catch {
        // 取不到价只影响价格条件；指标条件仍然可以判
        log("叫醒条件：取价失败，本轮跳过价格条件");
      }
    }

    const frames = [
      ...new Set([
        ...triggers
          .filter((item) => item.kind === "indicator")
          .map((item) => item.timeframe ?? "1h"),
        // 公式可能同时引用 1h/4h/1d，统一取三档（probe 只读本地库，成本可忽略）
        ...(formulaTriggers.length > 0 ? (["1h", "4h", "1d"] as const) : []),
      ]),
    ];
    const indicators: Record<string, number | null> = {};
    const formulas: Record<string, number> = {};
    const formulaErrors: Record<string, string> = {};
    if (frames.length > 0 || formulaTriggers.length > 0) {
      const probe = await runRunner<Record<string, unknown>>(
        "probe",
        {
          timeframes: frames,
          ...(formulaTriggers.length > 0
            ? {
                // 公式求值在计算层（AST 白名单），Node 侧只传表达式拿结果
                formulas: formulaTriggers.map((item) => ({
                  id: item.id,
                  expression: item.expression,
                })),
                price,
              }
            : {}),
        },
        { timeoutMs: 30_000 },
      );
      if (probe.ok) {
        for (const tf of frames) {
          const snap = probe.data?.[tf] as
            | (Record<string, unknown> & { error?: string })
            | undefined;
          if (!snap || snap.error) continue;
          for (const name of ["rsi", "adx", "ma_gap_pct", "macd_hist"]) {
            const value = snap[name];
            if (typeof value === "number" && Number.isFinite(value)) {
              indicators[indicatorKey(tf, name)] = value;
            }
          }
        }
        const results = (probe.data?.formulas ?? {}) as Record<
          string,
          { value?: number; error?: string }
        >;
        for (const [id, item] of Object.entries(results)) {
          if (typeof item?.value === "number") formulas[id] = item.value;
          else if (typeof item?.error === "string") formulaErrors[id] = item.error;
        }
      } else {
        log(`叫醒条件：指标探测失败（${probe.error}）`);
      }
    }
    const observation = { price, indicators, formulas, now };
    // 链式条件的进度要落盘，所以用带 states 的版本
    const evaluation = evaluateTriggersDetailed(triggers, observation);
    const hits: TriggerHit[] = evaluation.hits;

    // 求值失败要写回条件本身：否则它只是「永远不命中」，用户看不出来。
    // 必须在 recordEvaluation **之后** —— 它会按内存里的旧对象整份写回，
    // 先写 lastError 会被随后那次覆盖掉（这个顺序错了就等于没记）。
    const flushFormulaErrors = (): void => {
      if (Object.keys(formulaErrors).length > 0) {
        markTriggerErrors(home, formulaErrors, role);
      }
    };

    if (hits.length === 0) {
      // 未命中：只回写观测值（用户能看到「离条件多远」），不动条件本身
      recordEvaluation(home, triggers, observation, [], role, evaluation.states);
      flushFormulaErrors();
      refreshQueueState();
      return null;
    }

    // 命中时**先不落盘**：一次性条件一旦删除，这轮巡检失败（超时/限流）就再也不会叫了。
    // 由调用方在巡检成功后执行 commit；失败时条件原样保留，下一轮会再叫。
    const detail = hits.map((hit) => describeHit(hit)).join("；");
    log(`叫醒条件命中：${detail}`);
    return {
      reason: `叫醒条件命中：${detail}`,
      price,
      triggerNote: hits.map((hit) => describeHit(hit)).join("\n"),
      commit: () => {
        for (const hit of hits) {
          auditTrigger("hit", role, hit.trigger, {
            actor: "system",
            observed: hit.actual,
          });
        }
        recordEvaluation(home, triggers, observation, hits, role, evaluation.states);
        flushFormulaErrors();
        refreshQueueState();
      },
    };
  };

  /**
   * 检查「挂单时效」：超时且仍未成交 / 只部分成交 → 叫醒一轮巡检处理。
   *
   * 为什么要代码来管：模型把巡检定在 8 小时后，这单会一直挂在盘上等一个
   * 已经不成立的价格；「单子还在不在、成交了多少」只有实时账户知道，
   * 不能靠模型记性。叫醒只把问题摆到眼前，撤单/改价仍由模型决定。
   */
  const checkOrderTtl = async (
    snapshot: AccountSnapshot | null,
  ): Promise<{
    reason: string;
    orderNote: string;
    /** 巡检成功后才执行：把「已叫醒」落盘（失败则保留，下一轮再叫） */
    commit: () => void;
  } | null> => {
    const now = Date.now();
    if (now - lastOrderTtlCheckAt < ORDER_TTL_CHECK_INTERVAL_MS) return null;
    lastOrderTtlCheckAt = now;

    const actions = readActions(home);
    // 开仓单与平仓单都算：平仓单超时意味着「仓位还在」，更需要账户快照
    const livePending = actions.some(
      (item) =>
        (item.kind === "open" || item.kind === "close") &&
        item.status === "pending" &&
        item.expiresAt,
    );

    // 实盘必须能读到挂单，否则分不清「还在盘上」与「已成交 / 已撤销」
    if (!paper && livePending && !snapshot?.ok) return null;

    let paperOrders: PaperOpenOrder[] = [];
    if (paper) {
      const result = await runRunner<{ orders: PaperOpenOrder[] }>(
        "paper-expired",
        {},
        { timeoutMs: 20_000 },
      );
      if (result.ok) {
        paperOrders = result.data?.orders ?? [];
      } else {
        log(`挂单时效：读取模拟盘过期挂单失败（${result.error}）`);
      }
    }

    const events = readEventsState(home);
    const expired = findExpiredOrders({
      actions: paper ? [] : actions,
      paperOrders,
      snapshot: paper ? null : snapshot,
      now,
      notified: events.orderTtlNotified ?? {},
    });
    if (expired.length === 0) return null;

    const detail = describeExpiredOrders(expired);
    log(`挂单超时：${expired.length} 张\n${detail}`);
    return {
      reason: `挂单超过时效仍未成交（${expired.length} 张）`,
      orderNote: detail,
      // 先不落盘：巡检失败时保持「未叫醒」，下一轮还会再叫。
      // 落盘时顺手清掉 7 天前的键，避免文件越写越大。
      commit: () => {
        const current = readEventsState(home);
        const cutoff = now - 7 * 24 * 3_600_000;
        const marks: Record<string, string> = {};
        for (const [key, at] of Object.entries(current.orderTtlNotified ?? {})) {
          const parsed = Date.parse(at);
          if (!Number.isNaN(parsed) && parsed >= cutoff) marks[key] = at;
        }
        for (const order of expired) marks[order.key] = new Date(now).toISOString();
        current.orderTtlNotified = marks;
        writeEventsState(home, current);
      },
    };
  };

  /** 跑一轮巡检；`trigger` 说明这一轮为什么被叫醒（队列 / 市场事件 / 兜底） */
  const runInspect = async (
    trigger: {
      reason: string;
      price?: number;
      /** 叫醒条件的具体内容（注入提示词） */
      triggerNote?: string;
      /** 超时挂单的明细（注入提示词） */
      orderNote?: string;
      /** 行情获取连续失败的说明（注入提示词，要求排查原因） */
      marketNote?: string;
    } | null,
  ): Promise<boolean> => {
    lastAttemptAt = Date.now();
    log(trigger ? `触发巡检：${trigger.reason}` : "队列为空，按兜底规则巡检");

    // 风控告警只送一次：送来送去会让每轮巡检都在「重估」，反而没人做事
    const riskState = readRiskState(home);
    const riskAlert =
      riskState.triggered && !riskState.delivered
        ? { reason: riskState.reason, detail: riskState.detail }
        : undefined;

    const result = await runInspectCycle({
      log,
      paper,
      riskAlert,
      triggerNote: trigger?.triggerNote,
      orderNote: trigger?.orderNote,
      marketNote: trigger?.marketNote,
    });
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
      return true;
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
      // 失败时**不**执行 commit：一次性条件不删除、超时标记不写盘，
      // 下一轮还会再叫 —— 否则「巡检失败一次」就等于永久静音。
      return false;
    }
  };

  /**
   * 按固定间隔同步行情（**与是否巡检无关**）。
   *
   * 以前只在 `BTC_INSPECT_ENABLED=0` 时同步，等于「巡检模式下行情靠模型自觉」——
   * 而三周期打分、1h 机会评分、触发器指标全都读本地库，数据过期时这些结论全是错的
   * （典型表现：1h 停在几小时前，RSI/ADX 还是旧值）。
   *
   * 失败也节流：用独立的 `lastSyncAttemptAt`，否则网络断时会每分钟重试，
   * 也会把巡检兜底的 `lastAttemptAt` 提前，导致「队列空也不兜底」。
   */
  let lastSyncAttemptAt = 0;

  // ── 行情健康：连续失败要叫醒模型排查（用户设定：连续两次） ──
  let marketFailures = 0;
  let marketAlerted = false;
  let lastMarketHealthAt = 0;
  let lastMarketOkAt: string | undefined;
  let lastMarketError: string | undefined;

  const recordMarketOk = (): void => {
    marketFailures = 0;
    marketAlerted = false;
    lastMarketError = undefined;
    lastMarketOkAt = new Date().toISOString();
    state.marketFailures = 0;
    state.lastMarketError = undefined;
    state.lastMarketOkAt = lastMarketOkAt;
  };

  const recordMarketFail = (error: string): void => {
    marketFailures += 1;
    lastMarketError = error;
    state.marketFailures = marketFailures;
    state.lastMarketError = error;
    log(`行情获取失败（连续 ${marketFailures} 次）：${error}`);
  };

  /**
   * 每 5 分钟探一次行情（ticker）。
   *
   * 与 K 线同步共用同一个失败计数器：只盯同步的话，最坏要 30 分钟才发现故障；
   * 只盯 ticker 的话，K 线接口单独坏掉又看不出来。
   */
  const checkMarketHealth = async (now: number): Promise<void> => {
    if (now - lastMarketHealthAt < MARKET_HEALTH_INTERVAL_MS) return;
    lastMarketHealthAt = now;
    try {
      const ticker = await activeExchange(home).exchange.fetchTicker(
        process.env.BTC_SYMBOL?.trim() || "BTC/USDT",
      );
      if (!(ticker.price > 0)) throw new Error("返回的价格不是正数");
      recordMarketOk();
    } catch (err) {
      recordMarketFail(err instanceof Error ? err.message : String(err));
    }
    writeBackendState(home, state);
  };
  const runSyncIfDue = async (now: number): Promise<boolean> => {
    const last = Math.max(
      state.lastSyncAt ? Date.parse(state.lastSyncAt) : 0,
      lastSyncAttemptAt,
    );
    if (last && now - last < syncIntervalMin * 60_000) return false;

    lastSyncAttemptAt = now;
    const result = await syncMarketData({ log });
    state.cycles = (state.cycles ?? 0) + 1;
    if (result.error) {
      state.lastError = result.error;
      recordMarketFail(result.error);
      log(`同步失败：${result.error}`);
    } else {
      state.lastError = null;
      state.lastSyncAt = new Date().toISOString();
      state.lastSyncWritten = result.written;
      recordMarketOk();
      log(`同步完成，写入 ${result.written} 根`);
    }
    writeBackendState(home, state);
    return true;
  };

  /**
   * 监控叫醒的频率上限：10 分钟内最多 2 次。
   *
   * TTL 与叫醒条件各自去重，但「多条条件 + 多张挂单」可以连着叫醒，
   * 短时间多轮模型调用纯属烧钱。超限就留到下一轮 —— 条件与挂单都还在，不会丢。
   */
  let monitorWakeWindowAt = 0;
  let monitorWakeCount = 0;
  const monitorWakeAllowed = (now: number): boolean => {
    if (now - monitorWakeWindowAt > 10 * 60_000) {
      monitorWakeWindowAt = now;
      monitorWakeCount = 0;
    }
    if (monitorWakeCount >= 2) return false;
    monitorWakeCount += 1;
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

    // 同步与巡检模式无关：巡检模式下模型不一定每轮都 btc_sync，
    // 而所有指标都读本地库 —— 数据过期等于策略算错。
    await runSyncIfDue(now);
    // 行情健康与巡检模式无关：数据拉不到时，任何结论都建立在旧 K 线上
    await checkMarketHealth(now);

    if (!inspectEnabled) {
      refreshQueueState();
      return;
    }

    // 连续两次拿不到行情 → 叫醒模型排查（用户设定：不是等下一次常规巡检，
    // 那可能是几小时后，期间还可能按旧数据下单）
    if (shouldAlertMarket(marketFailures, marketAlerted)) {
      if (!monitorWakeAllowed(now)) {
        log("行情故障叫醒已达 10 分钟上限，本轮跳过");
        refreshQueueState();
        return;
      }
      running = true;
      let ok = false;
      try {
        ok = await runInspect({
          reason: `行情获取连续失败 ${marketFailures} 次`,
          marketNote:
            `连续失败 ${marketFailures} 次；最近错误：${lastMarketError ?? "未知"}\n` +
            `最后一次成功：${lastMarketOkAt ?? "启动以来没有成功过"}`,
        });
      } catch (err) {
        state.lastError = err instanceof Error ? err.message : String(err);
        log(`巡检异常：${state.lastError}`);
      } finally {
        running = false;
        refreshQueueState();
      }
      // 只有巡检真的跑成功才标记「已叫醒」；失败则下一轮再叫
      if (ok) marketAlerted = true;
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

    // 挂单时效：超时未成交/只部分成交 → 叫醒一轮，让模型决定撤单/改价/继续等
    const ttlTrigger = await checkOrderTtl(snapshot);
    if (ttlTrigger) {
      if (!monitorWakeAllowed(now)) {
        log("监控叫醒已达 10 分钟上限，本轮跳过（条件保留，下一轮再试）");
        refreshQueueState();
        return;
      }
      running = true;
      let ok = false;
      try {
        ok = await runInspect(ttlTrigger);
      } catch (err) {
        state.lastError = err instanceof Error ? err.message : String(err);
        log(`巡检异常：${state.lastError}`);
      } finally {
        running = false;
        refreshQueueState();
      }
      // 只有巡检成功才把「已叫醒」落盘；失败则保留，下一轮再叫
      if (ok) ttlTrigger.commit();
      return;
    }

    // 用户/模型设的叫醒条件：5 分钟节流，命中就立刻跑一轮（不占排期队列）
    const triggerHit = await checkTriggers();
    if (triggerHit) {
      if (!monitorWakeAllowed(now)) {
        log("监控叫醒已达 10 分钟上限，本轮跳过（条件保留，下一轮再试）");
        refreshQueueState();
        return;
      }
      running = true;
      let ok = false;
      try {
        ok = await runInspect(triggerHit);
      } catch (err) {
        state.lastError = err instanceof Error ? err.message : String(err);
        log(`巡检异常：${state.lastError}`);
      } finally {
        running = false;
        refreshQueueState();
      }
      if (ok) triggerHit.commit();
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
