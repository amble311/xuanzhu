import { activeExchange, type KlineInterval } from "../exchange";
import {
  btcPythonPath,
  btcScriptsReady,
  btcVenvReady,
  ensureBtcAssets,
} from "../btc/bootstrap";
import { fetchAccountSnapshot } from "../btc/account";
import { syncMarketData } from "../btc/market-data";
import {
  cancelOrders,
  closePosition,
  openPosition,
  transferProfitToSpot,
} from "../btc/trading";
import { runRunner } from "../btc/python";
import {
  currentScheduleRole,
  pushSchedule,
  removeSchedules,
} from "../btc/schedule";
import {
  appendPolicy,
  clearPolicy,
  readPolicy,
  replacePolicy,
} from "../btc/policy";
import {
  addTrigger,
  describeTrigger,
  readTriggers,
  removeTriggers,
  type TriggerKind,
  type TriggerOp,
} from "../btc/triggers";
import { readRiskSettings } from "../btc/risk";
import { decideSideGate, evaluateSideGate } from "../btc/side-gate";
import { resetPaperLedger } from "../btc/paper-reset";
import { readActions, renewActionTtls } from "../btc/actions";
import { readEventsState, writeEventsState } from "../btc/market-events";
import { getBtcHome } from "../modes";
import type { ToolDefinition, ToolResult } from "./types";

/**
 * btc 模式的交易工具。
 *
 * 分工（这也是「xzh 当常驻后端」的落地方式）：
 * - **Node 侧**：网络（交易所行情，经 `src/exchange` 适配层）、分页、时间窗口、错误归类；
 * - **Python 侧**：指标、三周期打分 / 1h 择时、回测（pandas），只依赖 numpy + pandas；
 * - **数据**：`~/.btc/data/btc.db`，只由 Python 读写（时间戳口径集中在一处）。
 *
 * 所有工具都标了 `modes: ["btc"]`：普通 xzh 会话看不到、也执行不了它们。
 */

const BTC_MODES = ["btc"];

interface BtcStatusData {
  symbol: string;
  db_path: string;
  python: string;
  pandas: string;
  start_date: string;
  timeframes: Record<
    string,
    { bars: number; last_ts: number | null; last_utc: string | null }
  >;
  risk: Record<string, unknown>;
}

interface BacktestData {
  symbol: string;
  bars: number;
  first: string;
  last: string;
  params: Record<string, unknown>;
  overrides: Record<string, unknown>;
  metrics: Record<string, number | null>;
  targets: Record<string, boolean>;
  recent_trades: Array<Record<string, unknown>>;
  trade_count: number;
}

function describeEnv(home: string): string[] {
  const lines = [`工作目录：${home}`];
  if (!btcScriptsReady(home)) {
    lines.push("计算脚本：✗ 未释放（assets 缺失）");
  } else if (!btcVenvReady(home)) {
    lines.push(
      `计算脚本：✓ 已释放\n计算环境：✗ 未安装（${btcPythonPath(home)} 不存在）\n` +
        "  → 运行 `xzh btc setup` 创建 venv 并安装 numpy + pandas",
    );
  } else {
    lines.push("计算脚本：✓ 已释放\n计算环境：✓ 已就绪");
  }
  return lines;
}

function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toFixed(digits);
}

/**
 * 模拟盘用的实时标记价。
 *
 * 必须和 `paper-status` 里算浮盈的价格一致：曾经面板顶部用实时价、浮盈用库内收盘价，
 * 用户看到「价格 79359，空单却浮亏」（因为库内还是 80532）。取不到就返回 undefined，
 * 由计算层回落库内收盘价，并在输出里标明价格来源。
 */
async function fetchMarkPrice(): Promise<number | undefined> {
  const { exchange, error } = activeExchange();
  if (error) return undefined;
  try {
    const ticker = await exchange.fetchTicker(activeSymbol());
    return ticker.price > 0 ? ticker.price : undefined;
  } catch {
    return undefined;
  }
}

function formatSignal(data: unknown): string {
  const payload = JSON.stringify(data, null, 2);
  const clipped =
    payload.length > 12_000
      ? `${payload.slice(0, 12_000)}\n…（已截断，完整快照可再看一次或查库）`
      : payload;
  return (
    "三周期打分 + 1 小时线择时（周线 / 日线 / 4h 判势，1h 定时）：\n\n" +
    `${clipped}\n\n` +
    "判读：`side_filter` 是方向结论（long / short / none / unknown）—— " +
    "none（全横盘或方向冲突）与 unknown（数据不足）都不得开仓；" +
    "`stage4_1h` 是 **1 小时线机会评估**：`score`（0–100，≥60 且形态成立才 `entry=now`）、" +
    "`opportunity`（pullback / breakout / none）、`levels`、`invalidation`。" +
    "`degraded=true` 时结论必须写「1 小时线未确认，不做」。\n" +
    "`btc_order` 会按同一套结论做方向闸门：反向、none、unknown 都会被直接拒绝。"
  );
}

function formatBacktest(data: BacktestData): string {
  const m = data.metrics;
  const targetLine = Object.entries(data.targets)
    .map(([key, passed]) => `${key} ${passed ? "✓" : "✗"}`)
    .join(" · ");
  const trades = data.recent_trades
    .map(
      (trade) =>
        `  · ${String(trade.entry_date ?? trade.entry_ts ?? "?")} → ${String(
          trade.exit_date ?? trade.exit_ts ?? "?",
        )}  pnl=${formatNumber(Number(trade.pnl), 0)}  ${
          trade.win ? "盈" : "亏"
        }`,
    )
    .join("\n");

  return [
    `回测结果（${data.symbol}，${data.bars} 根日线，${data.first.slice(0, 10)} → ${data.last.slice(0, 10)}）`,
    "",
    `  累计收益率    ${formatNumber(m.return_pct as number)}%`,
    `  最大回撤      ${formatNumber(m.max_drawdown_pct as number)}%`,
    `  胜率          ${formatNumber(m.win_rate as number)}%`,
    `  盈亏比        ${formatNumber(m.pl_ratio as number, 3)}`,
    `  夏普比率      ${formatNumber(m.sharpe as number, 3)}`,
    `  有效信号率    ${formatNumber(m.signal_rate as number)}%`,
    `  交易次数      ${data.trade_count}（平均持仓 ${formatNumber(
      m.avg_holding_days as number,
      1,
    )} 天）`,
    `  期末权益      $${formatNumber(m.final_equity as number, 0)}`,
    "",
    `目标达成：${targetLine}`,
    "",
    `参数：${JSON.stringify(data.params)}`,
    Object.keys(data.overrides).length > 0
      ? `本次覆盖：${JSON.stringify(data.overrides)}`
      : "本次覆盖：（无）",
    trades ? `\n最近成交：\n${trades}` : "",
    "\n口径：T 日收盘价成交，手续费 0.05%，资金费 0.01%/8h，无滑点（收益偏乐观）。",
    "\n⚠ 回测跑的是内置融合策略（FUSION_PARAMS），与实盘的「三周期打分 + 1h 机会评分」" +
      "**不是同一套逻辑**；回测结论只代表那套参数的历史表现，不能当成实盘策略已验证。",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** 行情标的：与 Python 侧 `config.settings.symbol` 读同一个环境变量，避免两边不一致 */
function activeSymbol(): string {
  return process.env.BTC_SYMBOL?.trim() || "BTC/USDT";
}

// ─────────────────────────── btc_price ───────────────────────────

const priceTool: ToolDefinition = {
  name: "btc_price",
  modes: BTC_MODES,
  description:
    "查交易所的最新价、24h 涨跌幅与成交额（实时接口，不读本地库，也不下单）。" +
    "默认币安永续；标的默认 BTC/USDT，可用环境变量 BTC_SYMBOL 改（平台用 BTC_EXCHANGE）。" +
    "判断「现在价格多少」时用它，" +
    "判断「趋势与买卖点」用 btc_signal（后者基于本地库，需要先 btc_sync）。",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(): Promise<ToolResult> {
    const { exchange, error } = activeExchange();
    if (error) return { ok: false, content: `✗ ${error}` };
    const symbol = activeSymbol();
    try {
      const ticker = await exchange.fetchTicker(symbol);
      return {
        ok: true,
        content: [
          `${ticker.symbol} 最新价：${ticker.price}`,
          `24h 涨跌：${ticker.changePct > 0 ? "+" : ""}${ticker.changePct.toFixed(2)}%`,
          `24h 区间：${ticker.low24h} — ${ticker.high24h}`,
          `24h 成交额：${(ticker.quoteVolume / 1e8).toFixed(2)} 亿 USDT`,
        ].join("\n"),
        summary: `${ticker.symbol} ${ticker.price}`,
      };
    } catch (err) {
      return {
        ok: false,
        content: `✗ 获取行情失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

// ─────────────────────────── btc_status ───────────────────────────

const statusTool: ToolDefinition = {
  name: "btc_status",
  modes: BTC_MODES,
  description:
    "查看 btc 模式的运行环境与本地行情库状态：计算环境是否装好、日线/4 小时线各多少根、" +
    "最新数据时间、交易标的与风控参数。**任何交易判断之前先调它**，以免拿着过期数据下结论。",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(): Promise<ToolResult> {
    const home = getBtcHome();
    const assets = ensureBtcAssets(home);
    const lines = describeEnv(home);

    if (!assets.available) {
      lines.push(
        `✗ 找不到 btc 计算资产（应为 ${assets.assetsDir}）。` +
          "若通过 npm 安装，请重新安装或运行 `xzh btc setup`。",
      );
      return { ok: false, content: lines.join("\n") };
    }
    if (!btcVenvReady(home)) {
      const db = `${home}/data/btc.db`;
      return {
        ok: true,
        content: `${lines.join("\n")}\n数据库：${db}（尚未创建，需先装环境再同步）`,
        summary: "btc 环境未就绪",
      };
    }

    const result = await runRunner<BtcStatusData>("status");
    if (!result.ok) {
      return {
        ok: false,
        content: `${lines.join("\n")}\n✗ 读取状态失败：${result.error}${
          result.detail ? `\n${result.detail}` : ""
        }`,
      };
    }

    const data = result.data;
    const hardRisk = readRiskSettings(getBtcHome());
    const active = activeExchange();
    const exchangeLine = active.error
      ? `交易所配置：✗ ${active.error}`
      : `交易所：${active.exchange.label}（${active.exchange.toNativeSymbol(data.symbol)}）`;
    const tfLines = ["1d", "1h"].map((tf) => {
      const item = data.timeframes[tf];
      if (!item || item.bars === 0) return `  ${tf}：0 根（还没同步，先 btc_sync）`;
      return `  ${tf}：${item.bars} 根，最新 ${item.last_utc ?? "?"}`;
    });

    return {
      ok: true,
      content: [
        ...lines,
        `标的：${data.symbol}`,
        exchangeLine,
        `数据库：${data.db_path}`,
        `Python：${data.python} · pandas ${data.pandas}`,
        `回测起点：${data.start_date}`,
        "行情：",
        ...tfLines,
        "风控（实际生效 · 代码强制）：",
        `  单持仓亏损 ${hardRisk.maxPositionLossPct}% · 当日 ${hardRisk.maxDailyLossPct}% · ` +
          `连亏 ${hardRisk.maxConsecutiveLosses} 次`,
        // Python 侧那套是回测/策略参数，不参与实盘拦截；混在一起会让人以为单笔风险 2% 在生效
        `  计算层参数（仅回测/参考）：${JSON.stringify(data.risk)}`,
      ].join("\n"),
      summary: "btc 环境与数据状态",
    };
  },
};

// ─────────────────────────── btc_sync ───────────────────────────

const syncTool: ToolDefinition = {
  name: "btc_sync",
  modes: BTC_MODES,
  description:
    "从交易所同步 K 线到本地行情库（增量：从库内最后一根之后开始拉）。" +
    "首次使用、或 btc_status 显示数据过期时先调它。1d 默认拉 750 天、1h 默认 60 天，" +
    "可用 days 覆盖。同步只写本地库，不涉及任何交易。",
  parameters: {
    type: "object",
    properties: {
      timeframe: {
        type: "string",
        enum: ["1d", "1h", "all"],
        description: "要同步的周期，默认 all（日线 + 4 小时线）",
      },
      days: {
        type: "number",
        description: "缺失部分最多回补多少天；默认 1d=750、1h=60",
      },
    },
    required: [],
  },
  async execute(args): Promise<ToolResult> {
    const requested = String(args.timeframe ?? "all");
    const targets: KlineInterval[] =
      requested === "1d" ? ["1d"] : requested === "1h" ? ["1h"] : ["1d", "1h"];
    const days =
      typeof args.days === "number" && Number.isFinite(args.days) && args.days > 0
        ? Math.floor(args.days)
        : undefined;

    // 与常驻后端共用同一套同步实现（见 src/btc/market-data.ts）：两边写同一个库，
    // 口径必须一致，不能各写一份「查最后时间 → 增量拉 → 分批写」。
    const result = await syncMarketData({ timeframes: targets, days });
    if (result.error) {
      return { ok: false, content: `✗ ${result.error}` };
    }

    return {
      ok: result.ok,
      content:
        `行情同步（${activeExchange().exchange.label}）：
${result.report.join("\n")}
` +
        (result.written > 0
          ? `\n共写入 ${result.written} 根。`
          : "\n本次没有新增数据。"),
      summary: `同步 ${result.written} 根 K 线`,
    };
  },
};

// ─────────────────────────── btc_signal ───────────────────────────

const signalTool: ToolDefinition = {
  name: "btc_signal",
  modes: BTC_MODES,
  description:
    "两层判断：周线 / 日线 / 4h 各给 -1（下跌）/ 0（横盘）/ +1（上涨），" +
    "都 ≥0 只做多、都 ≤0 只做空、全 0 或方向冲突不做（只决定方向）；" +
    "1 小时线再做技术分析给出 0–100 的机会评分与形态（回调/突破），" +
    "≥60 分且形态成立才是 `entry=now`。" +
    "返回 `side_filter`（方向）、`score`（三周期打分）、`stage4_1h`（机会评分/关键位/失效条件/" +
    "止损/目标）与建议动作（long/short/wait/stand_aside）。" +
    "数据来自本地库：先 btc_status 确认数据新鲜，必要时 btc_sync 补齐（尤其 1h）。" +
    "`side_filter` 为 none / unknown，或 `stage4_1h.entry=wait` 时不得下单（btc_order 也会拒绝）。",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(): Promise<ToolResult> {
    ensureBtcAssets(getBtcHome());
    const result = await runRunner<unknown>("signal", {}, { timeoutMs: 60_000 });
    if (!result.ok) {
      return {
        ok: false,
        content: `✗ 三周期信号计算失败：${result.error}${
          result.detail ? `\n${result.detail}` : ""
        }`,
      };
    }
    return {
      ok: true,
      content: formatSignal(result.data),
      summary: "三周期打分 + 1h 择时",
    };
  },
};

// ─────────────────────────── btc_backtest ───────────────────────────

const backtestTool: ToolDefinition = {
  name: "btc_backtest",
  modes: BTC_MODES,
  description:
    "用内置融合策略在本地日线上做全量回测，返回收益/回撤/胜率/盈亏比/夏普等指标。" +
    "overrides 可临时覆盖策略参数做对比实验（不写回源码，例如 {\"leverage\": 5}）。" +
    "对比不同参数时必须保证数据窗口与成本一致，否则结论无效。",
  parameters: {
    type: "object",
    properties: {
      overrides: {
        type: "object",
        description: "临时覆盖的策略参数，如 {\"leverage\": 5, \"sl_atr\": 2.0}",
      },
      start_date: {
        type: "string",
        description: "回测起始日期（北京时间 YYYY-MM-DD）；缺省用配置里的起点",
      },
    },
    required: [],
  },
  async execute(args): Promise<ToolResult> {
    ensureBtcAssets(getBtcHome());
    const overrides =
      typeof args.overrides === "object" && args.overrides !== null
        ? (args.overrides as Record<string, unknown>)
        : {};
    const startDate =
      typeof args.start_date === "string" && args.start_date.trim()
        ? args.start_date.trim()
        : undefined;

    const result = await runRunner<BacktestData>(
      "backtest",
      { overrides, start_date: startDate },
      { timeoutMs: 180_000 },
    );
    if (!result.ok) {
      return {
        ok: false,
        content: `✗ 回测失败：${result.error}${result.detail ? `\n${result.detail}` : ""}`,
      };
    }
    return {
      ok: true,
      content: formatBacktest(result.data),
      summary: `回测 ${result.data.trade_count} 笔`,
    };
  },
};

// ─────────────────────────── btc_schedule ───────────────────────────

const scheduleTool: ToolDefinition = {
  name: "btc_schedule",
  modes: BTC_MODES,
  description:
    "安排巡检时间。默认 **mode=replace：改写「下一跳」**——原来排在后面的巡检会被取消，" +
    "所以「本来 1 小时后，改成 30 分钟后」直接调一次即可，不会两条都跑。" +
    "mode=add 是额外加一个检查点（不改原有的下一跳）。" +
    "后台每分钟检查一次队列，到点就执行。**后台巡检时必须在结束前调用**，" +
    "间隔由你自己判断：信号刚触发或临近关键位 15–60 分钟；明确观望 2–8 小时；" +
    "预计日线收盘/数据更新前需确认则定在那之前。生效范围 10 分钟–12 小时。",
  parameters: {
    type: "object",
    properties: {
      next_check_minutes: {
        type: "number",
        description: "多少分钟后再巡检（与 next_check_at 二选一）",
      },
      next_check_at: {
        type: "string",
        description: "指定时间点（ISO，如 2026-11-03T15:00:00+08:00）",
      },
      reason: {
        type: "string",
        description: "为什么定这个时间（一句话，会显示在 xzh btc status）",
      },
      decision: {
        type: "string",
        description: "本轮巡检结论（一句话，可选）",
      },
      mode: {
        type: "string",
        enum: ["replace", "add"],
        description:
          "replace（默认）= 改写下一跳，旧的会被取消；add = 额外检查点，不影响下一跳",
      },
    },
    required: ["reason"],
  },
  async execute(args): Promise<ToolResult> {
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (!reason) {
      return {
        ok: false,
        content: "错误：必须给 reason，说明为什么把下次巡检定在这个时间。",
      };
    }

    const minutes =
      typeof args.next_check_minutes === "number" &&
      Number.isFinite(args.next_check_minutes)
        ? args.next_check_minutes
        : undefined;
    const at =
      typeof args.next_check_at === "string" ? args.next_check_at.trim() : undefined;
    const slot = args.mode === "add" ? "extra" : "next";

    const result = pushSchedule(
      getBtcHome(),
      {
      minutes,
      at,
      reason,
      decision:
        typeof args.decision === "string" && args.decision.trim()
          ? args.decision.trim()
          : undefined,
        slot,
        origin: process.env.XZH_BTC_INSPECT === "1" ? "inspect" : "manual",
      },
      currentScheduleRole(),
    );

    const waitMin = Math.max(
      1,
      Math.round((Date.parse(result.entry.at) - Date.now()) / 60_000),
    );
    const cancelled = result.replacedEntries
      .map(
        (entry) =>
          `  · 已取消 ${entry.at}（${entry.reason}）`,
      )
      .join("\n");

    return {
      ok: true,
      content:
        `${slot === "next" ? "已改写下一跳" : "已加入额外检查点"}：` +
        `${result.entry.at}（约 ${waitMin} 分钟后，id ${result.entry.id}）\n` +
        `理由：${reason}` +
        (cancelled ? `\n${cancelled}` : "") +
        `\n队列现有 ${result.size} 条` +
        (result.dropped > 0 ? `（超过上限，丢弃了 ${result.dropped} 条最远的）` : "") +
        (result.entry.clamped
          ? `\n（你给的时间超出 10 分钟–12 小时的允许范围，已调整）`
          : ""),
      summary:
        slot === "next"
          ? `${waitMin} 分钟后巡检（已改写下一跳）`
          : `${waitMin} 分钟后额外巡检`,
    };
  },
};

// ─────────────────────────── btc_unschedule ───────────────────────────

const unscheduleTool: ToolDefinition = {
  name: "btc_unschedule",
  modes: BTC_MODES,
  description:
    "撤销巡检计划。默认撤销「下一跳」（后台的下次巡检）；scope=extra 只撤额外检查点；" +
    "all 全部撤销。也可以用 id 精确撤销（id 从 btc_schedule 的返回或 xzh btc status 里拿）。" +
    "注意：全部撤销后后端**不是永久停止**，队列空且超过 60 分钟没巡检时会自行兜底跑一轮；" +
    "要彻底停后台请让用户执行 xzh btc stop。",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "要撤销的计划 id（优先于 scope）" },
      scope: {
        type: "string",
        enum: ["next", "extra", "all"],
        description: "没给 id 时撤销哪一类，默认 next",
      },
    },
    required: [],
  },
  async execute(args): Promise<ToolResult> {
    const id = typeof args.id === "string" ? args.id.trim() : undefined;
    const rawScope = typeof args.scope === "string" ? args.scope : "next";
    const scope =
      rawScope === "extra" || rawScope === "all" ? rawScope : "next";

    const result = removeSchedules(
      getBtcHome(),
      { id, scope },
      currentScheduleRole(),
    );

    if (result.removed.length === 0) {
      return {
        ok: true,
        content: id
          ? `没有找到 id 为 ${id} 的巡检计划（可能已被执行或已撤销）。`
          : "当前队列里没有可撤销的计划。",
      };
    }

    const removed = result.removed
      .map((entry) => `  · ${entry.at}（${entry.reason}）`)
      .join("\n");
    return {
      ok: true,
      content:
        `已撤销 ${result.removed.length} 条计划：\n${removed}\n` +
        `队列剩余 ${result.remaining} 条` +
        (result.remaining === 0
          ? "；队列已空，后端会在 60 分钟兜底再巡检一次（要彻底停请用 xzh btc stop）"
          : ""),
      summary: `撤销 ${result.removed.length} 条计划`,
    };
  },
};

// ─────────────────────────── 真实交易（只做合约） ───────────────────────────

const orderTool: ToolDefinition = {
  name: "btc_order",
  modes: BTC_MODES,
  danger: true,
  description:
    "**真实挂单**（币安 U 本位合约，**限价 GTC**）。需要先配置凭据（xzh btc apikey）。" +
    "必须给 limit_price：不追价、不立即成交，没成交就一直挂着，直到下一次买卖点或主动撤单。" +
    "按 notional（USDT 名义，按限价折算数量）或 quantity 二选一；可带 stop_loss / take_profit，" +
    "它们会作为 closePosition 条件单挂在交易所（触发时按当时仓位全平）。" +
    "硬性风控已触发时本工具会被拒绝；**三周期方向闸门**也会校验方向：" +
    "周线/日线/4h 都 ≥0 只允许做多、都 ≤0 只允许做空，全 0 或方向冲突时不允许开仓。" +
    "开仓前必须说清方向、限价、仓位、止损与依据。",
  parameters: {
    type: "object",
    properties: {
      side: { type: "string", enum: ["long", "short"], description: "方向" },
      orders: {
        type: "array",
        description:
          "多档限价建仓（与 limit_price 二选一）：每档独立挂单、独立时效。" +
          "分批接单时用它 —— 一次调用就把 2–3 档挂好，不必分多次",
        items: {
          type: "object",
          properties: {
            limit_price: { type: "number", description: "该档限价" },
            notional: { type: "number", description: "该档名义金额（USDT）" },
            quantity: {
              type: "number",
              description: "该档数量（与 notional 二选一）",
            },
          },
          required: ["limit_price"],
        },
      },
      limit_price: {
        type: "number",
        description: "单档限价（与 orders 二选一）：挂单等待成交，不追价",
      },
      notional: { type: "number", description: "名义金额（USDT）" },
      quantity: { type: "number", description: "币数量（与 notional 二选一）" },
      leverage: {
        type: "number",
        description:
          "杠杆 1–125：**建仓前必须考虑倍数**（保证金 ≈ 总名义 / 杠杆）。" +
          "不传则读交易所当前杠杆",
      },
      stop_loss: { type: "number", description: "止损触发价（可选）" },
      take_profit: { type: "number", description: "止盈触发价（可选）" },
      reason: { type: "string", description: "下单依据（一句话）" },
      expires_min: {
        type: "number",
        description:
          "挂单时效（分钟，默认 60，最长 1440）：到点仍未成交或只部分成交，" +
          "后端会叫醒一轮巡检决定撤单/改价/继续等",
      },
    },
    required: ["side", "reason"],
  },
  async execute(args): Promise<ToolResult> {
    const side = String(args.side ?? "").toLowerCase();
    if (side !== "long" && side !== "short") {
      return { ok: false, content: "错误：side 只能是 long 或 short。" };
    }

    // 多档：orders[] 每档 limit_price + notional/quantity；单档仍可用 limit_price 快捷
    const rawLegs = Array.isArray(args.orders) ? args.orders : [];
    const legs = rawLegs
      .map((item) => {
        const raw = (item ?? {}) as Record<string, unknown>;
        const price = Number(raw.limit_price ?? raw.limitPrice);
        const notional =
          raw.notional === undefined ? undefined : Number(raw.notional);
        const quantity =
          raw.quantity === undefined ? undefined : Number(raw.quantity);
        return { limitPrice: price, notional, quantity };
      })
      .filter((leg) => Number.isFinite(leg.limitPrice));

    if (legs.length === 0) {
      const limitPrice =
        typeof args.limit_price === "number" ? args.limit_price : undefined;
      if (!(limitPrice && limitPrice > 0)) {
        return {
          ok: false,
          content:
            "错误：开仓统一使用限价单，必须给 limit_price（单档）或 orders[]（多档）。",
        };
      }
      legs.push({
        limitPrice,
        notional: typeof args.notional === "number" ? args.notional : undefined,
        quantity: typeof args.quantity === "number" ? args.quantity : undefined,
      });
    }
    if (legs.some((leg) => !(leg.limitPrice > 0))) {
      return { ok: false, content: "错误：每档限价都必须大于 0。" };
    }
    if (legs.some((leg) => !(leg.notional ?? leg.quantity))) {
      return { ok: false, content: "错误：每档都要有 notional 或 quantity。" };
    }

    // 三周期方向闸门（用户设定的硬规则）：方向不符直接拒绝，连请求都不发
    const gate = await evaluateSideGate(getBtcHome());
    const gateDecision = decideSideGate(gate, side);
    if (!gateDecision.ok) {
      return { ok: false, content: gateDecision.message, summary: "方向闸门拒绝" };
    }

    try {
      const result = await openPosition({
        side,
        orders: legs,
        leverage: typeof args.leverage === "number" ? args.leverage : undefined,
        stopLoss: typeof args.stop_loss === "number" ? args.stop_loss : undefined,
        takeProfit:
          typeof args.take_profit === "number" ? args.take_profit : undefined,
        reason: String(args.reason ?? ""),
        ttlMinutes:
          typeof args.expires_min === "number" ? args.expires_min : undefined,
      });

      const lines = [
        `✓ 已挂${side === "long" ? "买入" : "卖出"}限价单 ${result.legs.length} 档：` +
          `合计 ${result.quantity} @ 加权 ${result.limitPrice}`,
      ];
      for (const [index, leg] of result.legs.entries()) {
        const clock = leg.expiresAt
          ? new Date(leg.expiresAt).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })
          : "—";
        lines.push(
          `  ${index + 1}. 订单 ${leg.orderId ?? "?"} · ${leg.quantity} @ ${leg.limitPrice}` +
            `（名义 ${formatNumber(leg.notional, 0)}）· 时效到 ${clock}`,
        );
      }
      lines.push(
        `  杠杆 ${result.margin.leverage}x · 占用保证金约 ${formatNumber(
          result.margin.required,
        )} + 手续费 ${formatNumber(result.margin.fee)} · 可用 ${formatNumber(
          result.margin.available,
        )}`,
        "  **未成交前不算持仓**；成交与否用 btc_orders 查，撤单用 btc_cancel all=true。",
        `  依据：${String(args.reason ?? "")}`,
      );
      if (result.protection.length > 0) {
        lines.push(`  保护单：${result.protection.join(" · ")}（按触发时总仓位全平）`);
      }
      if (result.warnings.length > 0) {
        lines.push(`  ⚠ ${result.warnings.join("\n  ⚠ ")}`);
      }
      return {
        ok: true,
        content: lines.join("\n"),
        summary: `开${side === "long" ? "多" : "空"} ${result.legs.length} 档 ${result.quantity}`,
      };
    } catch (err) {
      return {
        ok: false,
        content: `✗ 下单失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

const ordersTool: ToolDefinition = {
  name: "btc_orders",
  modes: BTC_MODES,
  description:
    "列出当前合约挂单（含限价开仓单与止损/止盈条件单）与持仓。" +
    "限价单挂出后用它确认是否成交；到下一次买卖点仍未成交时，应先判断是否撤单（btc_cancel）。",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(): Promise<ToolResult> {
    const snapshot = await fetchAccountSnapshot({ force: true });
    if (!snapshot.ok) {
      return {
        ok: false,
        content: `✗ 读取账户失败：${snapshot.error ?? "未知原因"}`,
      };
    }

    const lines: string[] = [];
    // 挂单剩余时效：账本里有 expiresAt，按 orderId 对上就能显示
    const ttlByOrder = new Map<number, string>();
    for (const item of readActions(getBtcHome())) {
      if (item.orderId && item.expiresAt) ttlByOrder.set(item.orderId, item.expiresAt);
    }
    const ttlText = (orderId: number): string => {
      const iso = ttlByOrder.get(orderId);
      if (!iso) return "";
      const left = Date.parse(iso) - Date.now();
      if (Number.isNaN(left)) return "";
      if (left <= 0) return " · 已过期待处理";
      const minutes = Math.ceil(left / 60_000);
      return ` · ${minutes} 分钟后过期`;
    };

    if (snapshot.positions.length === 0) {
      lines.push("持仓：无");
    } else {
      lines.push("持仓：");
      for (const position of snapshot.positions) {
        lines.push(
          `  ${position.symbol} ${position.side === "long" ? "多" : "空"} ${position.qty} ` +
            `@ ${position.entryPrice}（浮盈 ${position.unrealized.toFixed(2)}，${position.roePct.toFixed(2)}%）`,
        );
      }
    }

    if (snapshot.orders.length === 0) {
      lines.push("挂单：无");
    } else {
      lines.push(`挂单 ${snapshot.orders.length} 条：`);
      for (const order of snapshot.orders) {
        const tags = [
          order.reduceOnly ? "只减仓" : "",
          order.closePosition ? "触发全平" : "",
          order.stopPrice > 0 ? `触发价 ${order.stopPrice}` : "",
          `#${order.orderId}`,
        ]
          .filter(Boolean)
          .join(" · ");
        lines.push(
          `  ${order.symbol} ${order.side === "buy" ? "买" : "卖"} ${order.type} ` +
            `${order.qty} @ ${order.price}（${tags}）${ttlText(order.orderId)}`,
        );
      }

      const protective = snapshot.orders.filter(
        (order) =>
          order.closePosition ||
          order.type.toUpperCase().startsWith("STOP") ||
          order.type.toUpperCase().startsWith("TAKE_PROFIT"),
      );
      if (snapshot.positions.length > 0) {
        lines.push(
          protective.length > 0
            ? `保护单：${protective.length} 张（止损/止盈已挂）`
            : "⚠ **没有任何止损/止盈单**：这笔持仓在裸奔，先补挂或平仓",
        );
      }
      if (snapshot.marginRatio > 0) {
        lines.push(`保证金率：${snapshot.marginRatio.toFixed(1)}%（接近 100 会强平）`);
      }
    }

    return { ok: true, content: lines.join("\n"), summary: "查询挂单与持仓" };
  },
};

const closeTool: ToolDefinition = {
  name: "btc_close",
  modes: BTC_MODES,
  danger: true,
  description:
    "**真实平仓**（只减仓 reduceOnly，全部平掉）。两种模式由你判断：" +
    "`market`（默认）= 确定出场、接受滑点；`limit` = 控滑点，但**不成交时仓位与止损都还在**，" +
    "所以必须给 limit_price 与 expires_min（超时后端会叫醒处理）。" +
    "临近止损/强平、行情快速、流动性差时用市价 —— 出场确定性优先；" +
    "价格合适、只想在某价位了结时用限价。没有持仓时会提示。" +
    "平仓不受硬性风控限制（降低风险的方向）。平仓后回报成交价与盈亏；" +
    "若用户要求锁利，用 btc_transfer_profit 把约定比例划到现货。",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["market", "limit"],
        description: "market（默认，确定出场）/ limit（控滑点，可能不成交）",
      },
      limit_price: {
        type: "number",
        description:
          "限价平仓的委托价（mode=limit 必填）：平多挂在现价及以上、平空挂在现价及以下才可能立即成交",
      },
      expires_min: {
        type: "number",
        description: "限价平仓的时效（分钟，默认 60）：到点未成交会叫醒处理",
      },
      reason: { type: "string", description: "平仓原因（一句话）" },
    },
    required: ["reason"],
  },
  async execute(args): Promise<ToolResult> {
    const mode = args.mode === "limit" ? "limit" : "market";
    if (mode === "limit" && !(typeof args.limit_price === "number" && args.limit_price > 0)) {
      return {
        ok: false,
        content: "错误：限价平仓必须给 limit_price（大于 0）。",
      };
    }
    try {
      const result = await closePosition({
        mode,
        limitPrice:
          typeof args.limit_price === "number" ? args.limit_price : undefined,
        ttlMinutes:
          typeof args.expires_min === "number" ? args.expires_min : undefined,
        reason: String(args.reason ?? ""),
      });
      if (!result) {
        return { ok: true, content: "当前没有可平的合约持仓。" };
      }

      const lines =
        result.mode === "limit"
          ? [
              `✓ 已挂${result.side === "long" ? "卖出" : "买入"}限价平仓单 ` +
                `${result.symbol} ${result.quantity} @ ${result.price}`,
              `  订单 ${result.orderId ?? "?"} · 状态 ${result.status ?? "?"}（NEW = 等待成交）`,
              `  **未成交前仓位还在**，止损单也仍然有效；成交与否用 btc_orders 查。`,
            ]
          : [
              `✓ 已平仓 ${result.symbol} ${result.side === "long" ? "多" : "空"} ${result.quantity}`,
              `  订单 ${result.orderId ?? "?"} · 状态 ${result.status ?? "?"}` +
                `${result.price ? ` · 均价 ${result.price}` : ""}` +
                `${typeof result.pnl === "number" ? ` · 盈亏约 ${result.pnl}` : ""}`,
            ];
      if (result.expiresAt) {
        const clock = new Date(result.expiresAt).toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        lines.push(`  时效：${clock} 前未成交会叫醒我处理（或改市价平）。`);
      }
      if (result.warnings.length > 0) {
        lines.push(`  ⚠ ${result.warnings.join("\n  ⚠ ")}`);
      }
      lines.push(`  依据：${String(args.reason ?? "")}`);
      return {
        ok: true,
        content: lines.join("\n"),
        summary:
          result.mode === "limit" ? `挂限价平仓 ${result.price}` : `平仓 ${result.symbol}`,
      };
    } catch (err) {
      return {
        ok: false,
        content: `✗ 平仓失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

const cancelTool: ToolDefinition = {
  name: "btc_cancel",
  modes: BTC_MODES,
  description:
    "撤单：给 order_id 撤单笔，给 all=true 撤掉该交易对全部挂单（含止损/止盈条件单）。" +
    "撤掉保护单后仓位就没有止损了，务必提醒用户。",
  parameters: {
    type: "object",
    properties: {
      order_id: { type: "string", description: "要撤的订单号" },
      all: { type: "boolean", description: "撤掉当前交易对的全部挂单" },
    },
    required: [],
  },
  async execute(args): Promise<ToolResult> {
    const orderId =
      typeof args.order_id === "string" && args.order_id.trim()
        ? args.order_id.trim()
        : undefined;
    const all = args.all === true;
    if (!orderId && !all) {
      return { ok: false, content: "错误：需要 order_id 或 all=true。" };
    }
    try {
      const result = await cancelOrders({ orderId, all });
      return {
        ok: true,
        content:
          result.cancelled === "all"
            ? `✓ 已撤掉 ${result.symbol} 的全部挂单`
            : `✓ 已撤单 ${result.orderId}（${result.symbol}）`,
        summary: "已撤单",
      };
    } catch (err) {
      return {
        ok: false,
        content: `✗ 撤单失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

const transferTool: ToolDefinition = {
  name: "btc_transfer_profit",
  modes: BTC_MODES,
  danger: true,
  description:
    "把合约账户的 USDT **划转到现货账户**（单向，用于锁定已实现收益）。" +
    "上限是可用余额的 95%（留保证金）。这是本项目唯一的划转能力：" +
    "不能反向（现货→合约），也不能提到外部地址。" +
    "用户说「把每笔收益的 10% 转出来」时，按平仓金额算出具体 USDT 数再调用。",
  parameters: {
    type: "object",
    properties: {
      amount: { type: "number", description: "划转金额（USDT），必须大于 0" },
      reason: { type: "string", description: "划转依据（如「锁定本轮收益 10%」）" },
    },
    required: ["amount", "reason"],
  },
  async execute(args): Promise<ToolResult> {
    const amount =
      typeof args.amount === "number" ? args.amount : Number.NaN;
    if (!(Number.isFinite(amount) && amount > 0)) {
      return { ok: false, content: "错误：amount 必须是大于 0 的数字。" };
    }
    try {
      const result = await transferProfitToSpot(amount);
      return {
        ok: true,
        content:
          `✓ 已划转 ${result.amount} USDT 到现货账户\n` +
          `  划转前可用 ${result.availableBefore.toFixed(2)} USDT` +
          `${result.tranId ? ` · 流水 ${result.tranId}` : ""}\n` +
          `  依据：${String(args.reason ?? "")}`,
        summary: `划转 ${result.amount} USDT 到现货`,
      };
    } catch (err) {
      return {
        ok: false,
        content: `✗ 划转失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

// ─────────────────────────── 模拟盘（虚拟账本，不涉及真钱） ───────────────────────────

interface PaperPosition {
  side: string;
  qty: number;
  entry_price: number;
  notional: number;
  stop_price: number | null;
  unrealized: number;
  unrealized_pct: number;
  entry_ts?: string;
}

interface PaperStatusData {
  initial_capital: number;
  /** 未成交的限价挂单（收盘价到达限价才成交） */
  open_orders?: Array<{
    id: number;
    side: string;
    qty: number;
    limit_price: number;
    notional: number;
    reason: string;
    /** 挂单时效（ISO）；到点未成交后端会叫醒巡检 */
    expires_at?: string | null;
  }>;
  cash: number;
  equity: number;
  return_pct: number;
  price: number;
  /** mark = 实时标记价；close = 库内最新收盘价（计算脚本旧版时可能缺这个字段） */
  price_source?: "mark" | "close";
  /** 本次读取状态时刚撮合成交的挂单 */
  just_filled?: Array<{
    order_id: number;
    side: string;
    qty: number;
    limit_price?: number;
    fill_price: number;
    price?: number;
    slipped?: boolean;
    partial?: boolean;
  }>;
  position: PaperPosition | null;
  trades: number;
  wins: number;
  win_rate: number;
  realized_pnl: number;
  fees_paid: number;
  /** 只有 btc_paper_status 会带明细；开平仓返回的 status 可能没有 */
  recent_trades?: Array<{
    side: string;
    qty: number;
    entry_price: number;
    exit_price: number;
    pnl: number;
    exit_reason: string | null;
  }>;
}

function formatPaperStatus(data: PaperStatusData): string {
  const priceNote =
    data.price_source === "close" ? "（库内收盘价，可能滞后）" : "";
  const lines = [
    `模拟盘（虚拟账本，不涉及真钱）· 现价 ${formatNumber(data.price)}${priceNote}`,
    `  初始资金 ${formatNumber(data.initial_capital, 0)} · 现金 ${formatNumber(
      data.cash,
    )} · 权益 ${formatNumber(data.equity)}（${data.return_pct >= 0 ? "+" : ""}${formatNumber(
      data.return_pct,
    )}%）`,
  ];

  const pending = data.open_orders ?? [];
  if (pending.length > 0) {
    lines.push("  挂单（未成交）：");
    for (const order of pending) {
      lines.push(
        `    · #${order.id} ${order.side === "long" ? "买" : "卖"} ` +
          `${order.qty} @ ${formatNumber(order.limit_price)}（${order.reason || "无理由"}）`,
      );
    }
  }

  if (data.position) {
    const p = data.position;
    lines.push(
      `  持仓：${p.side === "long" ? "多" : "空"} ${p.qty} @ ${formatNumber(p.entry_price)}` +
        `（名义 ${formatNumber(p.notional, 0)}）· 浮盈 ${p.unrealized >= 0 ? "+" : ""}${formatNumber(
          p.unrealized,
        )}（${formatNumber(p.unrealized_pct)}%）` +
        (p.stop_price ? ` · 止损 ${formatNumber(p.stop_price)}` : ""),
    );
  } else {
    lines.push("  持仓：无");
  }

  lines.push(
    `  已平仓 ${data.trades} 笔 · 胜率 ${formatNumber(data.win_rate)}% · ` +
      `实现盈亏 ${data.realized_pnl >= 0 ? "+" : ""}${formatNumber(data.realized_pnl)} · ` +
      `手续费 ${formatNumber(data.fees_paid)}`,
  );

  const recent = data.recent_trades ?? [];
  if (recent.length > 0) {
    lines.push("  最近成交：");
    for (const trade of recent) {
      lines.push(
        `    · ${trade.side === "long" ? "多" : "空"} ${trade.qty} ` +
          `${formatNumber(trade.entry_price)} → ${formatNumber(trade.exit_price)}  ` +
          `pnl ${trade.pnl >= 0 ? "+" : ""}${formatNumber(trade.pnl)}` +
          (trade.exit_reason ? `（${trade.exit_reason}）` : ""),
      );
    }
  }
  return lines.join("\n");
}

const paperStatusTool: ToolDefinition = {
  name: "btc_paper_status",
  modes: BTC_MODES,
  description:
    "查看模拟盘状态：虚拟账本的初始资金、现金、持仓、浮动盈亏、权益、收益率、历史绩效与最近成交。" +
    "**模拟盘不涉及真钱**，用于验证策略与决策，不要把它当成实盘账户。",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(): Promise<ToolResult> {
    ensureBtcAssets(getBtcHome());
    const mark = await fetchMarkPrice();
    const result = await runRunner<PaperStatusData>("paper-status", {
      mark_price: mark,
    });
    if (!result.ok) {
      return {
        ok: false,
        content: `✗ 读取模拟盘失败：${result.error}${result.detail ? `\n${result.detail}` : ""}`,
      };
    }
    return {
      ok: true,
      content: formatPaperStatus(result.data),
      summary: `模拟盘权益 ${formatNumber(result.data.equity)}`,
    };
  },
};

const paperOpenTool: ToolDefinition = {
  name: "btc_paper_open",
  modes: BTC_MODES,
  description:
    "在模拟盘（虚拟账本）**挂限价单**：价格到达限价即视为全部成交（扣 0.05%）。" +
    "**限价已在市场另一侧时会挂出即成交**（真实交易所的吃单行为），成交价取限价与市价中更优者，" +
    "工具返回会明确区分「已成交」与「已挂单」。" +
    "**不涉及真钱**。同一时间只允许一个持仓、一张未成交挂单；开仓前说清方向、限价、名义金额、止损与依据。",
  parameters: {
    type: "object",
    properties: {
      side: { type: "string", enum: ["long", "short"], description: "方向" },
      limit_price: {
        type: "number",
        description: "限价（必填）：收盘价到达即成交",
      },
      notional: {
        type: "number",
        description: "名义金额（USDT），不能超过可用现金",
      },
      stop_price: { type: "number", description: "止损价（可选，仅记录）" },
      reason: { type: "string", description: "开仓依据（一句话）" },
      expires_min: {
        type: "number",
        description:
          "挂单时效（分钟，默认 60，最长 1440）：到点仍未成交会叫醒一轮巡检处理",
      },
      leverage: {
        type: "number",
        description:
          "杠杆（默认 1x）：模拟盘按「名义/杠杆」占用现金，与实盘保证金口径一致",
      },
    },
    required: ["side", "limit_price", "notional", "reason"],
  },
  async execute(args): Promise<ToolResult> {
    const side = String(args.side ?? "").toLowerCase();
    if (side !== "long" && side !== "short") {
      return { ok: false, content: "错误：side 只能是 long 或 short。" };
    }
    const notional = Number(args.notional);
    if (!Number.isFinite(notional) || notional <= 0) {
      return { ok: false, content: "错误：notional 必须是大于 0 的数字。" };
    }
    const limitPrice = Number(args.limit_price);
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
      return { ok: false, content: "错误：limit_price 必须是大于 0 的数字。" };
    }

    // 模拟盘不拦方向（它本来就是用来验证想法的），但要指出「实盘会被闸门拒绝」
    const gate = await evaluateSideGate(getBtcHome());
    const gateDecision = decideSideGate(gate, side);
    const gateWarning = gateDecision.ok
      ? ""
      : `\n\n⚠ 与三周期方向闸门不符（实盘会被拒绝）：${gateDecision.message.split("\n")[0]}\n` +
        "  模拟盘照常放行，用于验证想法；真钱下单前请先让三周期同向。";

    const result = await runRunner<{
      order_id: number;
      side: string;
      qty: number;
      limit_price: number;
      expires_at?: string;
      status: PaperStatusData;
    }>("paper-open", {
      side,
      notional,
      limit_price: limitPrice,
      stop_price: typeof args.stop_price === "number" ? args.stop_price : undefined,
      reason: String(args.reason ?? ""),
      expires_min:
        typeof args.expires_min === "number" ? args.expires_min : undefined,
      leverage: typeof args.leverage === "number" ? args.leverage : undefined,
      mark_price: await fetchMarkPrice(),
    });

    if (!result.ok) {
      return {
        ok: false,
        content: `✗ 模拟开仓失败：${result.error}${result.detail ? `\n${result.detail}` : ""}`,
      };
    }

    const data = result.data;
    const fills = data.status?.just_filled ?? [];
    const fill = fills.find((item) => item.order_id === data.order_id);
    const lines: string[] = [];
    if (fill) {
      // 限价已在市场另一侧：真实交易所就是立即吃单，文案不能再说「已挂单」
      lines.push(
        `模拟盘${fill.side === "long" ? "买入" : "卖出"}**已成交** #${fill.order_id}：` +
          `${fill.qty} @ ${formatNumber(fill.fill_price)}` +
          (fill.slipped
            ? `（限价 ${formatNumber(fill.limit_price)} 已被穿越，按更优价成交）`
            : ""),
      );
      if (fill.partial) {
        lines.push("  ⚠ 现金不足，已按可用现金缩量成交。");
      }
      lines.push("  这是**挂出即成交**，不是等价格回到限价；已计入持仓与现金。");
    } else {
      lines.push(
        `模拟盘已挂${data.side === "long" ? "买" : "卖"}单 #${data.order_id}：` +
          `${data.qty} @ ${formatNumber(data.limit_price)}`,
        "  未成交前不算持仓；价格到达限价即视为全部成交（下次查看状态时结算）。",
      );
      if (data.expires_at) {
        const clock = new Date(data.expires_at).toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        lines.push(`  时效：${clock} 前未成交会叫醒我重新评估（也可 btc_paper_cancel）。`);
      }
    }
    if (data.status?.price_source === "close") {
      lines.push(
        "  ⚠ 未取到实时标记价，本次按库内最新收盘价撮合（可能滞后，先 btc_sync）。",
      );
    }
    return {
      ok: true,
      content: `${lines.join("\n")}\n\n${formatPaperStatus(data.status)}${gateWarning}`,
      summary: fill
        ? `模拟已成交 @ ${formatNumber(fill.fill_price)}`
        : `模拟挂单 ${data.limit_price}`,
    };
  },
};

const paperCloseTool: ToolDefinition = {
  name: "btc_paper_close",
  modes: BTC_MODES,
  description:
    "在模拟盘（虚拟账本）平仓：按实时标记价结算（取不到时用库内最新收盘价），" +
    "扣 0.05% 手续费，记录一笔成交。**不涉及真钱**。平仓后应回报盈亏与权益变化。",
  parameters: {
    type: "object",
    properties: {
      reason: { type: "string", description: "平仓原因（一句话）" },
    },
    required: ["reason"],
  },
  async execute(args): Promise<ToolResult> {
    const result = await runRunner<{
      side: string;
      entry_price: number;
      exit_price: number;
      pnl: number;
      fee: number;
      cash_after: number;
      status: PaperStatusData;
    }>("paper-close", {
      reason: String(args.reason ?? ""),
      mark_price: await fetchMarkPrice(),
    });

    if (!result.ok) {
      return {
        ok: false,
        content: `✗ 模拟平仓失败：${result.error}${result.detail ? `\n${result.detail}` : ""}`,
      };
    }

    const data = result.data;
    return {
      ok: true,
      content:
        `模拟盘已平仓：${data.side === "long" ? "多" : "空"} ` +
        `${formatNumber(data.entry_price)} → ${formatNumber(data.exit_price)}，` +
        `盈亏 ${data.pnl >= 0 ? "+" : ""}${formatNumber(data.pnl)}（手续费 ${formatNumber(
          data.fee,
        )}）\n\n` +
        formatPaperStatus(data.status),
      summary: `模拟平仓 pnl ${formatNumber(data.pnl)}`,
    };
  },
};

const paperCancelTool: ToolDefinition = {
  name: "btc_paper_cancel",
  modes: BTC_MODES,
  description:
    "撤掉模拟盘未成交的限价单（不传 order_id 撤全部）。**不涉及真钱**。" +
    "到下一次买卖点仍未成交、或信号已经变了，就撤掉重挂。",
  parameters: {
    type: "object",
    properties: {
      order_id: { type: "number", description: "要撤的挂单 id（不传则撤全部）" },
    },
    required: [],
  },
  async execute(args): Promise<ToolResult> {
    const orderId =
      typeof args.order_id === "number" ? args.order_id : undefined;
    const result = await runRunner<{
      cancelled: number;
      status: PaperStatusData;
    }>("paper-cancel", {
      ...(orderId === undefined ? {} : { order_id: orderId }),
      mark_price: await fetchMarkPrice(),
    });

    if (!result.ok) {
      return {
        ok: false,
        content: `✗ 撤单失败：${result.error}${result.detail ? `\n${result.detail}` : ""}`,
      };
    }
    return {
      ok: true,
      content:
        `已撤销 ${result.data.cancelled} 张挂单\n\n` +
        formatPaperStatus(result.data.status),
      summary: `撤单 ${result.data.cancelled}`,
    };
  },
};

const paperResetTool: ToolDefinition = {
  name: "btc_paper_reset",
  requiresConfirmation: true,
  modes: BTC_MODES,
  description:
    "清空模拟盘账本（成交记录、挂单与持仓全部删除，资金恢复初始值），" +
    "并**把重置前的状态写进项目记忆**（多少笔成交、实现盈亏、原持仓与挂单、资金变化），" +
    "让下一轮对话知道发生过什么。**仅在用户明确要求时使用**；" +
    "后台巡检里该操作会被自动拒绝（无人确认）。",
  parameters: {
    type: "object",
    properties: {
      capital: {
        type: "number",
        description:
          "新的初始资金；不传则回落 BTC_PAPER_CAPITAL 或 100000（不是沿用上次的值）",
      },
    },
    required: [],
  },
  async execute(args): Promise<ToolResult> {
    ensureBtcAssets(getBtcHome());
    const result = await resetPaperLedger({
      home: getBtcHome(),
      capital: typeof args.capital === "number" ? args.capital : undefined,
      source: "tool",
    });
    if (!result.ok) {
      return {
        ok: false,
        content: `✗ 重置模拟盘失败：${result.error}${
          result.detail ? `\n${result.detail}` : ""
        }`,
      };
    }

    const cleared = result.data.cleared;
    const lines = [
      `模拟盘账本已重置，初始资金 ${formatNumber(result.data.capital, 0)}。`,
      `清空：${cleared.trades} 笔已平仓成交` +
        (cleared.trades > 0
          ? `（胜率 ${formatNumber(cleared.win_rate)}%，实现盈亏 ${formatNumber(
              cleared.realized_pnl,
            )}）`
          : "") +
        `、${cleared.open_orders} 张挂单、` +
        (cleared.position ? "1 个持仓" : "无持仓") +
        "。",
    ];
    if (result.memoryFile) {
      lines.push(`已记入项目记忆：${result.memoryFile}`);
    }
    if (result.memoryWarning) {
      lines.push(`⚠ ${result.memoryWarning}`);
    }
    return {
      ok: true,
      content: lines.join("\n"),
      summary: "模拟盘已重置（含记忆）",
    };
  },
};

// ─────────────────────────── btc_renew（挂单续期） ───────────────────────────

const renewTool: ToolDefinition = {
  name: "btc_renew",
  modes: BTC_MODES,
  description:
    "给**未成交的挂单续期**（判断「继续等」时用）：只改时效，不动订单 —— " +
    "撤单重挂会丢队列位置，也可能在撤与挂之间错过成交。" +
    "不传 order_id 就续期全部未成交挂单（开仓与平仓单都算）。续期后该单的「已叫醒」记录会被清掉，" +
    "到新时效仍未成交会**再次**叫醒。模拟盘同样适用。",
  parameters: {
    type: "object",
    properties: {
      order_id: {
        type: "number",
        description: "只续期这一张（交易所订单号 / 模拟盘订单号）",
      },
      expires_min: {
        type: "number",
        description: "续期多少分钟（默认 60，最长 1440）",
      },
      reason: { type: "string", description: "为什么继续等（一句话，便于复盘）" },
    },
    required: [],
  },
  async execute(args): Promise<ToolResult> {
    const home = getBtcHome();
    const role = currentScheduleRole();
    const minutes =
      typeof args.expires_min === "number" && args.expires_min > 0
        ? args.expires_min
        : 60;
    const orderId =
      typeof args.order_id === "number" ? args.order_id : undefined;

    let keys: string[] = [];
    let expiresAt = "";
    let renewed = 0;

    if (role === "paper") {
      const result = await runRunner<{ ids: number[]; expires_at: string }>(
        "paper-renew",
        {
          expires_min: minutes,
          ...(orderId === undefined ? {} : { order_id: orderId }),
        },
      );
      if (!result.ok) {
        return {
          ok: false,
          content: `✗ 续期失败：${result.error}${
            result.detail ? `\n${result.detail}` : ""
          }`,
        };
      }
      renewed = result.data.ids.length;
      expiresAt = result.data.expires_at;
      keys = result.data.ids.map((id) => `paper:${id}`);
    } else {
      const result = renewActionTtls(home, { orderId, minutes });
      renewed = result.renewed.length;
      expiresAt = result.expiresAt;
      keys = result.renewed.map((item) => `action:${item.id}`);
    }

    if (renewed === 0) {
      return {
        ok: true,
        content: "没有可续期的未成交挂单（可能已成交或已撤销）。",
      };
    }

    // 清掉「已叫醒」标记：不清的话，到新时效也不会再叫一次
    const events = readEventsState(home);
    const marks = { ...(events.orderTtlNotified ?? {}) };
    for (const key of keys) delete marks[key];
    events.orderTtlNotified = marks;
    writeEventsState(home, events);

    const clock = new Date(expiresAt).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return {
      ok: true,
      content:
        `已续期 ${renewed} 张挂单到 ${clock}（${minutes} 分钟）；` +
        "到点仍未成交会再次叫醒。",
      summary: `续期 ${renewed} 张挂单`,
    };
  },
};

// ─────────────────────────── btc_policy（决策指令） ───────────────────────────

const policyTool: ToolDefinition = {
  name: "btc_policy",
  modes: BTC_MODES,
  description:
    "查看 / 追加 / 替换 / 清空用户的**决策指令**。指令会注入后台每一轮巡检，" +
    "用来落实「以后别逆势」「单笔最多 1%」「只看日线」这类**长期要求**。" +
    "用户在对话里提出的长期偏好必须用本工具落盘 —— 只说一句「记住了」不会传给后台巡检。" +
    "写法要具体可验证（阈值、周期、禁止的动作）；上限 4000 字符，超出按最旧条目丢弃。",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["show", "append", "replace", "clear"],
        description:
          "show 查看 / append 追加一条 / replace 整份替换 / clear 清空（仅用户明确要求时）",
      },
      content: {
        type: "string",
        description: "append 写一条指令；replace 写完整策略。show / clear 不需要",
      },
    },
    required: ["action"],
  },
  async execute(args): Promise<ToolResult> {
    const home = getBtcHome();
    const action = String(args.action ?? "").trim().toLowerCase();
    const content = typeof args.content === "string" ? args.content : "";

    if (action === "show") {
      const text = readPolicy(home);
      return {
        ok: true,
        content: text
          ? `当前决策指令（${text.length} 字符）：\n\n${text}`
          : "当前还没有设定任何决策指令。用户提出长期要求时用 btc_policy append 落盘。",
        summary: "查看决策指令",
      };
    }

    if (action === "append") {
      if (!content.trim()) {
        return { ok: false, content: "错误：append 需要 content（一条具体、可验证的要求）。" };
      }
      const result = appendPolicy(home, content);
      return {
        ok: true,
        content:
          `已追加一条决策指令（当前 ${result.text.length} 字符` +
          (result.dropped > 0 ? `，丢弃 ${result.dropped} 条最旧的` : "") +
          `）：\n\n${result.text}\n\n` +
          "这条指令会注入后台每一轮巡检，下一轮开始生效。",
        summary: "已追加决策指令",
      };
    }

    if (action === "replace") {
      if (!content.trim()) {
        return {
          ok: false,
          content: "错误：replace 需要 content。若想清空请用 action=clear。",
        };
      }
      const result = replacePolicy(home, content);
      return {
        ok: true,
        content:
          `决策指令已整份替换（${result.text.length} 字符` +
          (result.truncated ? "，超出上限已截断最前面的部分" : "") +
          `）：\n\n${result.text}`,
        summary: "已替换决策指令",
      };
    }

    if (action === "clear") {
      clearPolicy(home);
      return {
        ok: true,
        content: "决策指令已清空。后台巡检将回到默认纪律（三周期打分 + 风控红线）。",
        summary: "已清空决策指令",
      };
    }

    return {
      ok: false,
      content: "错误：action 只能是 show / append / replace / clear。",
    };
  },
};

// ─────────────────────────── btc_trigger（叫醒条件） ───────────────────────────

/** 宽容地把参数转成数字（模型偶尔把阈值写成字符串） */
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const triggerTool: ToolDefinition = {
  name: "btc_trigger",
  modes: BTC_MODES,
  description:
    "设置**叫醒条件**：价格或技术指标到什么值时把后台巡检叫醒。用户说「到 8 万提醒我」" +
    "「RSI 跌破 30 就看一眼」「跌破 MA20 叫我」时用。条件落在 `~/.btc/run/triggers.json`，" +
    "常驻后端**每 5 分钟评估一次**（纯计算，不调模型），命中才跑一轮巡检。" +
    "**它只叫醒、绝不下单** —— 下单仍要走三周期打分与风控。" +
    "默认一次性（命中即失效）；要持续监控设 once=false 并给 cooldown_min。" +
    "价格用实时标记价；指标来自本地行情库（1h/4h/1d，可能落后于刚收盘的那根）。" +
    "**kind=chain 表示「先 A 再 B」**（有先后顺序）：给 steps 数组（2–3 步），" +
    "前一步满足**不叫醒**、只记住进度，最后一步也满足才叫醒；" +
    "前一步满足后超过 chain_expire_min（默认 240 分钟）还没等到下一步，就退回第一步。" +
    "「到 80000 之后跌破 79500 叫我」这类要求只能用 chain，`and` 表达不了顺序。" +
    "**kind=formula 是受限公式**（不是任意代码）：只能用白名单变量 + 四则运算 + abs/min/max，" +
    "适合「RSI 与 ADX 加权」「价格偏离 MA20 的 ATR 倍数」这类组合条件；" +
    "求值在计算层按 AST 白名单执行，导入/属性/下标/函数定义一律拒绝。" +
    "可用 window_start_hour / window_end_hour 限定**北京时间**时段（例如只在 21–24 点评估，" +
    "对应美盘开盘的高波动窗口），窗口外条件保留但不评估。" +
    "最多同时 10 条，默认 72 小时后失效。",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "list", "remove", "clear"],
        description: "add 新增 / list 查看 / remove 删除（给 id）/ clear 全清",
      },
      kind: {
        type: "string",
        enum: ["price", "indicator", "formula", "chain"],
        description:
          "price = 价格条件；indicator = 单个指标阈值；formula = 受限公式（多指标组合）；" +
          "chain = 链式条件（先 A 再 B，有先后顺序）",
      },
      steps: {
        type: "array",
        description:
          "kind=chain 时必填：2–3 步，按顺序满足。前一步满足不叫醒，最后一步也满足才叫醒",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["price", "indicator"] },
            op: { type: "string", enum: [">=", "<=", ">", "<"] },
            value: { type: "number", description: "该步阈值" },
            name: {
              type: "string",
              enum: ["rsi", "adx", "ma_gap_pct", "macd_hist"],
              description: "kind=indicator 时必填",
            },
            timeframe: { type: "string", enum: ["1h", "4h", "1d"] },
          },
          required: ["kind", "op", "value"],
        },
      },
      chain_expire_min: {
        type: "number",
        description:
          "链式条件前一步满足后的有效期（分钟，默认 240）：过期就退回第一步，避免拿几小时前的信号拼成假信号",
      },
      expression: {
        type: "string",
        description:
          "kind=formula 时必填的公式，例如 `rsi_1h * 0.6 + adx_1h * 0.4`、" +
          "`(close_1h - ma20_1h) / atr_1h`。只能用变量 + - * / % ( ) 、比较与 and/or/not、" +
          "以及 abs/min/max；变量形如 `rsi_1h`、`ma20_4h`、`vol_ratio_1d`、`price`" +
          "（字段：close/rsi/adx/macd_hist/ma_gap_pct/atr/ma20/ma50/vol_ratio；周期 1h/4h/1d）。" +
          "表达式应算出**数值**，阈值仍由 op/value 给（若写了比较，结果是 1/0，阈值写 0.5 或 1）",
      },
      op: {
        type: "string",
        enum: [">=", "<=", ">", "<"],
        description: "比较方式，如 >= 表示「达到或超过」",
      },
      value: {
        type: "number",
        description: "阈值：价格（USDT）或指标数值",
      },
      name: {
        type: "string",
        enum: ["rsi", "adx", "ma_gap_pct", "macd_hist"],
        description:
          "指标名（kind=indicator 时必填）：rsi / adx / ma_gap_pct（收盘价相对 MA20 的偏离%）/ macd_hist",
      },
      timeframe: {
        type: "string",
        enum: ["1h", "4h", "1d"],
        description: "指标周期，默认 1h",
      },
      side_hint: {
        type: "string",
        enum: ["long", "short"],
        description: "命中时的方向倾向（只是给巡检的上下文，不是下单指令）",
      },
      note: {
        type: "string",
        description: "用户原话或设这个条件的理由，命中时会注入巡检提示词",
      },
      once: {
        type: "boolean",
        description: "是否一次性（默认 true：命中后自动失效）；false = 持续监控",
      },
      cooldown_min: {
        type: "number",
        description: "持续型的最短触发间隔（分钟，默认 30；once=true 时无效）",
      },
      expires_hours: {
        type: "number",
        description: "多少小时后自动失效（默认 72，最长 168）",
      },
      window_start_hour: {
        type: "number",
        description:
          "时段窗口起（北京时间整点 0–23，含）；与 window_end_hour 必须一起给",
      },
      window_end_hour: {
        type: "number",
        description:
          "时段窗口止（北京时间整点 0–23，不含）；0 表示 24:00，小于起表示跨午夜",
      },
      id: {
        type: "string",
        description: "remove 时要删除的条件 id（从 list 或添加时的返回里拿）",
      },
    },
    required: ["action"],
  },
  async execute(args): Promise<ToolResult> {
    const home = getBtcHome();
    const role = currentScheduleRole();
    const action = String(args.action ?? "list").trim().toLowerCase();

    if (action === "list") {
      const list = readTriggers(home, role);
      if (list.length === 0) {
        return {
          ok: true,
          content:
            "当前没有叫醒条件。用户说「到某个价位/指标值时叫我」时用 action=add 设置。",
          summary: "查看叫醒条件",
        };
      }
      const lines = list.map((item, index) => {
        const seen =
          typeof item.lastSeenValue === "number"
            ? `（最近观测 ${item.lastSeenValue}，${item.lastSeenAt?.slice(0, 16).replace("T", " ") ?? ""}）`
            : "";
        return `${index + 1}. ${item.id}  ${describeTrigger(item)}${seen}`;
      });
      return {
        ok: true,
        content: `当前 ${list.length} 条叫醒条件：\n${lines.join("\n")}`,
        summary: `${list.length} 条叫醒条件`,
      };
    }

    if (action === "clear") {
      const result = removeTriggers(home, { all: true }, role);
      return {
        ok: true,
        content:
          result.removed.length === 0
            ? "当前没有叫醒条件可清空。"
            : `已清空 ${result.removed.length} 条叫醒条件。后台将只按排期与市场事件巡检。`,
        summary: "已清空叫醒条件",
      };
    }

    if (action === "remove") {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) {
        return {
          ok: false,
          content: "错误：remove 需要 id（先用 action=list 查）。要全清用 action=clear。",
        };
      }
      const result = removeTriggers(home, { id }, role);
      if (result.removed.length === 0) {
        return { ok: true, content: `没有找到 id 为 ${id} 的条件（可能已触发失效）。` };
      }
      return {
        ok: true,
        content:
          `已删除：${describeTrigger(result.removed[0])}\n` +
          `剩余 ${result.remaining} 条。`,
        summary: "已删除叫醒条件",
      };
    }

    if (action === "add") {
      const kind = String(args.kind ?? "").trim().toLowerCase();
      if (
        kind !== "price" &&
        kind !== "indicator" &&
        kind !== "formula" &&
        kind !== "chain"
      ) {
        return {
          ok: false,
          content: "错误：add 需要 kind=price / indicator / formula / chain。",
        };
      }
      const isChain = kind === "chain";
      if (isChain && !Array.isArray(args.steps)) {
        return {
          ok: false,
          content:
            "错误：kind=chain 需要 steps（2–3 步，每步 {kind, op, value}，indicator 还要 name）。",
        };
      }
      if (kind === "formula" && typeof args.expression !== "string") {
        return {
          ok: false,
          content:
            "错误：kind=formula 时需要 expression，例如 `rsi_1h * 0.6 + adx_1h * 0.4`。",
        };
      }
      // 链式条件不用单值 op/value：阈值写在每一步里
      const op = isChain ? ">=" : String(args.op ?? "").trim();
      if (!isChain && ![">=", "<=", ">", "<"].includes(op)) {
        return {
          ok: false,
          content: "错误：add 需要 op，取值 >= / <= / > / <。",
        };
      }
      const value = isChain ? 0 : toNumber(args.value);
      if (!isChain && value === null) {
        return { ok: false, content: "错误：add 需要数字 value（阈值）。" };
      }

      const result = addTrigger(
        home,
        {
          kind: kind as TriggerKind,
          op: op as TriggerOp,
          value: value ?? 0,
          name: typeof args.name === "string" ? args.name : undefined,
          timeframe: typeof args.timeframe === "string" ? args.timeframe : undefined,
          expression:
            typeof args.expression === "string" ? args.expression : undefined,
          steps: Array.isArray(args.steps) ? args.steps : undefined,
          chainExpireMin: toNumber(args.chain_expire_min) ?? undefined,
          sideHint: typeof args.side_hint === "string" ? args.side_hint : undefined,
          note: typeof args.note === "string" ? args.note : undefined,
          once: args.once !== false,
          cooldownMin: toNumber(args.cooldown_min) ?? undefined,
          expiresHours: toNumber(args.expires_hours) ?? undefined,
          windowStartHour: toNumber(args.window_start_hour) ?? undefined,
          windowEndHour: toNumber(args.window_end_hour) ?? undefined,
        },
        role,
      );
      if (!result.ok) return { ok: false, content: `错误：${result.error}` };

      if (result.duplicate) {
        return {
          ok: true,
          content:
            `这条条件已经存在（id ${result.trigger.id}），没有重复添加：\n` +
            `  ${describeTrigger(result.trigger)}`,
          summary: "条件已存在",
        };
      }

      return {
        ok: true,
        content:
          `已添加叫醒条件（id ${result.trigger.id}，当前共 ${result.size} 条）：\n` +
          `  ${describeTrigger(result.trigger)}\n\n` +
          "后台每 5 分钟评估一次，命中后才跑一轮巡检；**它只叫醒，不下单**。" +
          "要立刻生效不必重启后端（下一轮读取就会看到）。",
        summary: "已添加叫醒条件",
      };
    }

    return {
      ok: false,
      content: "错误：action 只能是 add / list / remove / clear。",
    };
  },
};

export const btcTools: ToolDefinition[] = [
  priceTool,
  statusTool,
  syncTool,
  signalTool,
  backtestTool,
  scheduleTool,
  unscheduleTool,
  policyTool,
  triggerTool,
  renewTool,
  paperStatusTool,
  paperOpenTool,
  paperCloseTool,
  paperCancelTool,
  paperResetTool,
  orderTool,
  ordersTool,
  closeTool,
  cancelTool,
  transferTool,
];
