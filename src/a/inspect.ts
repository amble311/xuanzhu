import * as fs from "fs";
import * as path from "path";
import { Agent, type AgentEvents } from "../core/agent";
import { activeModelEntry, inspectMaxMinutes, loadConfig } from "../config/store";
import { createProvider } from "../llm";
import type { AgentMode } from "../modes";
import { getAShareHome } from "../utils/paths";
import type { ExecuteToolResult } from "../tools";
import { accountSummary, loadPaperAccount } from "./paper";
import { maxPositions, poolSize } from "./settings";
import { inWorkWindow, WORK_WINDOW_LABEL } from "./window";
import {
  fetch15mBars,
  fetchQuote,
  mapLimit,
  sessionKind,
  sessionLabel,
} from "../exchange/ashare";
import { describeTradingDay, todayTradingStatus } from "./trading-day";
import { monitorDir, orderedPool } from "./watchlist";
import { describeRule, readRules } from "./rules";
import { nextScheduledEntry, readScheduleQueue } from "./schedule";
import { isPaused } from "./pause";
import { readRiskState } from "./risk";
import { readPositionRisks } from "./risk-alerts";
import { appendAInspectEvent } from "./inspect-stream";
import { describeOrder, listOrders } from "./orders";
import { readPolicy } from "./policy";
import { loadIndicators } from "./indicators";
import { score15m } from "./deep15";

/**
 * A 股后台巡检 —— 与 btc 的 `runInspectCycle` 同构。
 *
 * 一个完整 Agent 轮次：调模型 + 用 a_* 工具 + 结束前必须排下一轮。
 * 与 btc 的差别只在**标的形态**：btc 是单标的，A 股是一小组（5 只，含持仓），
 * 所以巡检按「持仓优先」的顺序**轮询**这 5 只逐只打分、逐只决策。
 *
 * 三条硬约束（都靠代码，不靠提示词）：
 * 1. 无人值守白名单：交易、排期、规则、续期放行；写文件 / 执行命令 / 重置账本一律拒绝；
 * 2. 不写会话、不写自动记忆、不维护任务账本：巡检是独立轮次；
 * 3. 只能买池内股票（`a_order` 里由代码复核），巡检不选股。
 */

const MAX_TOOL_ROUNDS = 12;
/**
 * 空闲超时（只有这一道）。
 *
 * 以前是「空闲 3 分钟 + 总时长 15 分钟」双超时。总时长上限对**本地小模型**太苛刻：
 * 工具多（10+ 次）+ 推理慢的一轮很容易超过 15 分钟，模型刚把 `a_schedule` 排完、
 * 正在写结论就被掐断 —— 正文一个字都没有，微信只收到「模型未生成正文结论」。
 *
 * 现在只保留**空闲超时**：模型还在出思考 / 调工具 / 写正文就一直续期，多久都不打断；
 * 真正卡死（3 分钟没有任何输出）才中止。它防的是「挂住」，不是「跑得慢」。
 */
const IDLE_TIMEOUT_MS = 3 * 60_000;
const SUMMARY_LIMIT = 600;

/** 无人值守放行的工具：交易、排期、规则、续期；文件/bash/环境改动一律拒绝 */
const UNATTENDED_TOOLS = new Set([
  "a_order",
  "a_cancel_order",
  "a_renew",
  "a_orders",
  "a_schedule",
  "a_unschedule",
  "a_trigger",
  "a_remove_trigger",
  "a_clear_risk",
  "a_policy",
  "a_account",
  "a_signal",
  "a_quote",
  "a_bars",
  "a_news",
  "a_snapshot",
]);

export interface AInspectOptions {
  origin?: "inspect" | "manual";
  /**
   * 本轮是被哪条监控规则 / 市场事件叫醒的。
   * 不注入的话，模型只会看到一次莫名其妙的常规巡检，容易回一句「无变化」。
   */
  triggerNote?: string;
  /** 本轮有挂单已经过期（哪张单、什么时候到期） */
  orderNote?: string;
}

export interface AInspectResult {
  summary: string;
  toolCalls: number;
  scheduled?: string;
  error?: string;
}

function inspectLog(): string {
  return path.join(monitorDir(), "logs", "inspect.log");
}

function appendLog(text: string): void {
  try {
    const file = inspectLog();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${text}\n`, "utf8");
  } catch {
    // 日志失败不影响巡检
  }
}

function fmt(value: number | undefined, digits = 2): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function inAWorkWindow(now = new Date()): boolean {
  return inWorkWindow(now);
}

async function contextSection(): Promise<string> {
  const account = loadPaperAccount();
  const summary = accountSummary(account);
  const cap = maxPositions();
  const size = poolSize();
  const pool = orderedPool(
    account.positions.map((position) => ({ code: position.code, name: position.name })),
    undefined,
    size,
  );
  const rules = readRules();
  const queue = readScheduleQueue();

  const lines: string[] = [];
  // 交易时段必须每轮都明确告知：模型不知道「现在几点、能不能成交」时，
  // 会在午休/收盘后反复尝试下单（代码会拒，纯烧轮次），或者把收盘价当现价判断。
  const kind = sessionKind();
  const trading = kind === "continuous";
  lines.push(
    `交易时段：${WORK_WINDOW_LABEL}（工作日；节假日休市）· 当前：${sessionLabel(kind)}` +
      `${trading ? "（可成交）" : "（不可成交，只能挂 pending 等下一个连续竞价时段）"}`,
  );
  // 交易日必须用真实日历判断（`sessionKind()` 只看星期 + 时间，节假日会误判为盘中）
  const tradingDay = await todayTradingStatus();
  lines.push(`交易日：${describeTradingDay(tradingDay)}`);
  if (!tradingDay.tradingDay) {
    lines.push(
      "**今天不是交易日**：不要下单、不要挂单、不要假设「现在有成交」，" +
        "也不要按节前价格判断买卖点；本轮只做总结，并把下一轮排到 `nextTradingDay` 的 09:30。",
    );
  }
  if (!trading) {
    lines.push(
      `注意：当前不在连续竞价时段。本轮仍可分析并排期，但 \`a_order\` 直接下单会被拒；` +
        "要动手就用 `pending: true` 挂单，撮合由代码在开盘/午后第一分钟按限价执行。" +
        "下一轮请排到交易时段内（a_schedule 会自动顺延，允许跨日 —— 例如 15:00 之后排到下一个工作日 09:30）。",
    );
  }
  lines.push(
    `账户：总资产 ${fmt(summary.equity)} · 可用 ${fmt(summary.cash)} · 市值 ${fmt(summary.marketValue)}` +
      ` · 总盈亏 ${fmt(summary.totalPnl)}（${fmt(summary.totalPnlPct)}%）`,
  );
  if (account.positions.length === 0) {
    lines.push(`持仓：无（持仓上限 ${cap} 只）`);
  } else {
    lines.push(
      `持仓 ${account.positions.length}/${cap}（优先级最高，先处理卖点/风险；` +
        `持仓最多 ${cap} 只，满了只能换仓）：`,
    );
    for (const position of account.positions) {
      lines.push(
        `- ${position.code} ${position.name} ${position.qty} 股（可卖 ${position.available}）` +
          ` 成本 ${fmt(position.avgCost)} 现价 ${fmt(position.lastPrice)}` +
          ` 盈亏 ${fmt(position.pnl)}（${fmt(position.pnlPct)}%）`,
      );
    }
  }

  lines.push(
    `自选池 ${pool.length}/${size}（**巡检轮询顺序：持仓在前**；池外股票不得买入）：`,
  );
  for (const [index, item] of pool.entries()) {
    lines.push(
      `${index + 1}. ${item.code} ${item.name}${item.held ? "（持仓）" : ""}` +
        ` 评分 ${item.score}：${item.reason}`,
    );
  }

  lines.push(`监控规则 ${rules.length} 条（监控只负责叫醒你，不下单）：`);
  for (const rule of rules) lines.push(`- ${describeRule(rule)}：${rule.note}`);

  // 预检：上一轮动作是否落地 / T+1 待卖是否还挂着
  try {
    const pending = JSON.parse(
      fs.readFileSync(path.join(monitorDir(), "run", "pending-sells.json"), "utf8"),
    ) as Array<{ code: string; reason: string; since: string }>;
    if (pending.length > 0) {
      lines.push("上一轮遗留的 T+1 待卖：");
      for (const item of pending) lines.push(`- ${item.code} ${item.reason}（${item.since}）`);
    }
  } catch {
    // 没有待卖
  }
  try {
    const file = path.join(monitorDir(), "actions.jsonl");
    const text = fs.readFileSync(file, "utf8").trim().split("\n").slice(-5);
    if (text.length > 0) {
      lines.push("最近动作：");
      for (const line of text) {
        try {
          const entry = JSON.parse(line) as {
            kind?: string;
            code?: string;
            ok?: boolean;
            message?: string;
          };
          lines.push(
            `- ${entry.kind ?? "?"} ${entry.code ?? ""} ${entry.ok === false ? "失败" : "成功"} ${entry.message ?? ""}`,
          );
        } catch {
          // 坏行跳过
        }
      }
    }
  } catch {
    // 没有动作账本
  }

  const orders = listOrders().filter((order) => order.status === "open");
  if (orders.length > 0) {
    lines.push("当前挂单：");
    for (const order of orders) {
      lines.push(`- ${order.id} ${describeOrder(order)} ${order.expiresAt} ${order.reason}`);
    }
  }

  lines.push(`排期 ${queue.length} 条：`);
  for (const entry of queue.slice(0, 5)) {
    lines.push(`- ${entry.at} ${entry.reason}（${entry.slot}）`);
  }
  if (isPaused()) lines.push("注意：当前处于暂停标记，但本轮由手动/事件触发。");
  const risk = readRiskState();
  if (risk?.triggered) {
    lines.push(`账户级硬风控已触发（禁止所有买入）：${risk.reasons.join("；")}`);
  }
  if (risk && risk.locks.length > 0) {
    lines.push("单票硬风控（只禁止买入这些股票，其他股票可正常开仓）：");
    for (const lock of risk.locks) {
      lines.push(`- ${lock.code} ${lock.name} ${lock.reason}`);
    }
  }
  const positionRisks = readPositionRisks().alerts;
  if (positionRisks.length > 0) {
    lines.push("持仓风控告警（只告警，是否卖出由你决定）：");
    for (const alert of positionRisks) {
      lines.push(
        `- ${alert.code} ${alert.name} ${alert.reason}` +
          `（${alert.sellable ? `可卖 ${alert.qty} 股` : "T+1 当日不可卖，下一交易日处理"}）`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * 巡检提示词：**与 `xzh btc moni` 同构**（同一套「自主决策到底 + 结束前排期」骨架），
 * 唯一的结构差异是 A 股一次要分析一整池（池子 = 持仓 + 自选），所以要求**逐只遍历**。
 */
function inspectPrompt(): string {
  const cap = maxPositions();
  const size = poolSize();
  return `你现在处于 A 股**后台巡检 / 无人值守**：没有用户在终端前，也没有人会回答你的提问。
这一轮你必须**自主决策到底** —— 该买就买、该卖就卖、该减就减、该撤就撤，直接调用工具执行；
最终回复必须包含一段**正文结论**（不能只把内容留在思考/reasoning 里）；即使全部观望，也要写“结论：…”。
不要写「请确认」「等你回复」（没有人会回），也不要只给方案不执行。

任务：像 BTC 逐个标的巡检那样，**逐一遍历**自选池（${size} 只，含持仓，持仓排在最前）：
对每一只都要得出「方向 / 15 分钟评分 / 动作」三件事，再决定下次巡检时间。

步骤（a_* 工具可用）：
1. \`a_account\` 看账本（总资产 / 可用 / 持仓 / 可卖数量），\`a_orders\` 看挂单时效。
2. \`a_signal\`（不传 code）拿**全池速览**：每只的月 / 周 / 日三周期方向 + 15 分钟择时评分。
   需要深挖的单只再用 \`a_signal(code=…)\` 看一次明细。
3. **逐只遍历（这是本模式与 btc 唯一的差别：btc 一次看一个标的，A 股一次看一整池）**：
   按顺序（持仓优先）一只一只过，**不允许跳过**。每只给出：
   - 方向：\`side_filter\` = long / none / unknown（月 / 周 / 日各 -1/0/+1，**只做多**；
     任一 -1 或全 0 → none，不做；数据不足 → unknown，先补数据）；
   - 择时：15 分钟 \`entry\` = now（≥60 分且形态成立）/ wait（说清在等什么）/ unknown；
   - 动作：买入 / 加仓 / 持有 / 减仓 / 清仓 / 观望 —— 六选一，并写一句依据。
   - **任何一只被清仓（持仓归零）后，本轮必须做「清仓复盘」**：写清入场依据、出场原因、
     实际盈亏、与当时计划的偏差；可复用的经验用 \`a_policy\` 追加 1–3 条（不重复、不写空话），
     结论开头标「【清仓复盘】」。代码在检测到清仓时也会单独叫醒一轮做这件事。
   持有与买入的判断：
   - 持仓：三周期出现 -1、15 分钟跌破 MA20 或前 10 根低点、触及 ATR 止损 / 移动止盈 → 减或清；
     T+1 当日买入不可卖，只能记录并用 \`a_trigger\` 盯住下一交易日；
   - 买点：\`side_filter=long\` 且 \`entry=now\`、非涨停、当日涨幅 ≤5%、非停牌、消息面无硬风险；
     100 股整手；**持仓最多 ${cap} 只**（池内 ${size} 只是候选），每仓 ≤20% 权益；
     已持 ${cap} 只时只能加仓现有持仓，或先减/清一只再换（代码会拒绝超限）。
   - 结论依赖消息面时先 \`a_news\`；硬风险（立案 / 退市 / 暴雷）禁止买入，持仓则考虑减。
   - 拿不到数据就如实说「数据不足」，不要编造价格或指标；不确定时按最保守方案执行。
4. **结束前必须把「怎么再次叫醒我」注入监控**（三件事，按需使用）：
   a. \`a_schedule\`（必须有）：自己判断下次巡检时间并说明理由 ——
      信号刚触发 / 临近收盘 → 15–30 分钟；平静观望、无持仓 → 30–60 分钟；
      **必须落在交易时段内**：${WORK_WINDOW_LABEL}（集合竞价、午休、收盘后都不算）。
      可以跨日 —— 收盘后要盯就排下一个工作日 09:30，午休要复核就排 13:00；
      \`a_schedule\` 也会自动把越界时间顺延到最近的交易时段；
   b. \`a_trigger\`：本轮结论依赖某个阈值时落盘叫醒条件。**优先用能表达结构的条件**：
      - 结构破坏 / 修复 → \`ma20_break\` / \`ma20_above\`（别拿 MA20 的数值写价格，均线每天变）；
      - 组合条件 → \`formula\`（例：\`price < ma20 && rsi < 40\`、\`price > ma20 && macd > 0\`，
        变量见工具说明，含 rsi / adx / macd）；
      - 有先后顺序 → \`chain\`（例：先站上 12.45，再回踩 12.20 才叫我）；
      - 只有「明确的止损位 / 止盈位」才用 \`price_above\` / \`price_below\`。
      **不要同一只写两条纯价格规则**（一条上沿一条下沿），用 formula 或 chain 表达；
      每只最多 5 条；过时或已无意义的用 \`a_remove_trigger\` 删掉；
   c. 有未成交挂单时：判断继续等就 \`a_renew\` 续期并说明理由，不该等就 \`a_cancel_order\` 撤掉。
      **不要放任挂单过期**（过期后代码会叫醒你，但那是兜底，不是常规）。
5. 最后用一段话总结本轮结论（会写进巡检日志供复盘）：**按遍历顺序逐只列 代码 / 方向 / 15m 分 / 动作**，
   没动的写「观望」，不要只写“全部正常”。

硬约束：
- **不做选股**：禁止 \`a_select\` / \`a_screen\` 重新筛选股票，禁止买入池外股票；
  收盘后 16:00 有独立的固定选股任务，本轮只分析「已有持仓 + 已有自选池」。
- 不写文件、不执行 shell、不改环境、不重置账本（后台无人确认，这类操作会被直接拒绝）。
- **这是模拟盘**（不涉及真钱）：成交以工具返回为准，不得声称真钱交易。
- **成交时间只有 ${WORK_WINDOW_LABEL}**（工作日，且当天是交易日）：集合竞价、午休、盘前盘后、节假日
  一律不成交；非交易时段只能 \`pending: true\` 挂单。硬性风控、涨跌停、停牌、T+1、100 股整手也由代码强制：被拒绝时看懂原因再决定，不要反复重试同一条被拒的操作。
- 账户级硬风控触发时禁止买入 / 加仓，只能减仓或观望；单票硬风控只锁那一只，其他照常评估。
- 工具轮数由代码限制（约 12 轮），${size} 只要在轮次内遍历完：\`a_signal\` 一次拿全池，
  不要每只都单独拉一遍；只有需要判断止损/形态细节时才追加深挖。`;
}

/** 读一次 policy，注入提示词前半段（后台进程读不到对话里的「记住了」） */
function policySection(): string {
  const policy = readPolicy();
  return policy
    ? `\n\n## 用户设定的决策指令（必须遵守；与资金安全冲突时以安全为先）\n${policy}`
    : "";
}

/** 被监控规则 / 市场事件叫醒时，说清「谁叫的、条件是什么」 */
function triggerSection(note?: string): string {
  return note
    ? `\n\n## 本轮由监控规则 / 市场事件触发\n${note}\n` +
        "- 先确认条件**现在是否仍成立**（价格可能已经回头），再决定做不做；\n" +
        "- 被叫醒不等于必须交易：条件成立但三周期方向否决，就明确说不做并排下一次。"
    : "";
}

/** 挂单过期：必须给出「撤单 / 改价 / 继续等」的明确处理 */
/**
 * 巡检前置数据核对（对齐 btc `buildPreflight` 的位置：**调模型之前先看一遍数据**）。
 *
 * 为什么需要：以前巡检把「取数」完全交给模型 —— 本地模型经常直接拿 16:00 选股时算的旧分数、
 * 或者不复核行情时间就开始判断；而 btc 那边是先 `fetchAccountSnapshot({force:true})` +
 * `buildPreflight()` 把「上一轮动作落地没有、持仓有没有保护」摆到眼前再让模型决策。
 *
 * 这里做的是**只读核对**（不交易、不改账本）：
 * - 池内每只（持仓优先）：现价 / 涨跌幅 / 行情时间 / 15m 最新 K 线与分数 / 日线指标 asOf；
 * - 上证指数现价与时间（判断数据源是不是整体停了）；
 * - 当前挂单、T+1 待卖（上一轮的动作是否还挂着）。
 *
 * 数据缺失 / 过期时会在提示词里明确要求「先补数据再决策」，而不是让模型猜。
 */
export interface PreflightRow {
  code: string;
  name: string;
  held: boolean;
  price?: number;
  changePct?: number;
  /** 行情时间（同花顺 `updatedAt`） */
  quoteTime?: string;
  /** 15m 最新一根 K 线时间 */
  barTime?: string;
  /** 15m 分数（0–100） */
  deepScore?: number;
  /** 日线指标 asOf（最后一根日线日期） */
  indicatorAsOf?: string;
  /** 数据问题（缺行情 / 缺 15m / 指标缺失 / 时间过旧） */
  problems: string[];
}

function fmtPrice(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(2);
}

/** 把核对结果拼成提示词段落（纯函数，便于测试） */
export function formatPreflight(
  rows: PreflightRow[],
  extra: { indexLine?: string; notes?: string[] } = {},
): string {
  const lines = ["", "", "## 巡检前数据核对（代码已拉取，无需重复请求）"];
  if (extra.indexLine) lines.push(`- 大盘：${extra.indexLine}`);
  for (const row of rows) {
    const price =
      row.price === undefined
        ? "现价 —"
        : `现价 ${fmtPrice(row.price)}（${(row.changePct ?? 0) >= 0 ? "+" : ""}${fmtPrice(row.changePct)}%）`;
    const bars = row.barTime ? `15m 最新 ${row.barTime}` : "15m 无数据";
    const deep = row.deepScore === undefined ? "15m 分数 —" : `15m ${row.deepScore} 分`;
    const indicator = row.indicatorAsOf ? `日线指标 asOf ${row.indicatorAsOf}` : "日线指标缺失";
    lines.push(
      `- ${row.code} ${row.name}${row.held ? "（持仓）" : ""} ${price}` +
        ` · 行情时间 ${row.quoteTime ?? "未知"} · ${bars} · ${deep} · ${indicator}`,
    );
  }
  for (const note of extra.notes ?? []) lines.push(`- ${note}`);

  const broken = rows.filter((row) => row.problems.length > 0);
  if (broken.length > 0) {
    lines.push("", "**数据有问题，先补数据再决策：**");
    for (const row of broken) {
      lines.push(`- ${row.code} ${row.name}：${row.problems.join("；")}`);
    }
    lines.push(
      "  → 缺行情 / 时间过旧的标的**不要下单**；先用 `a_signal` / `a_bars` 重新取数，" +
        "仍取不到就在结论里写明「数据不足」，并排下一轮。",
    );
  } else {
    lines.push("", "数据检查结论：池内数据齐备，可直接判断。");
  }
  return lines.join("\n");
}

/** 采集前置数据（并发 3，避免把行情源打满） */
async function preflightSection(now = new Date()): Promise<string> {
  const account = loadPaperAccount(now);
  const pool = orderedPool(
    account.positions.map((position) => ({ code: position.code, name: position.name })),
    undefined,
    poolSize(),
  );
  if (pool.length === 0) {
    return "\n\n## 巡检前数据核对\n- 池内没有股票（无持仓、无自选），本轮只做总结。";
  }

  const indicators = await loadIndicators({ allowPartial: true }).catch(() => new Map());
  const indexQuote = await fetchQuote("1A0001").catch(() => null);
  const rows = await mapLimit(
    pool,
    async (item): Promise<PreflightRow> => {
      const [quote, bars] = await Promise.all([
        fetchQuote(item.code).catch(() => null),
        fetch15mBars(item.code, 160).catch(() => null),
      ]);
      const deep = bars ? score15m(bars) : null;
      const indicator = indicators.get(item.code);
      const problems: string[] = [];
      if (!quote) problems.push("行情取不到");
      if (!bars) problems.push("15m K 线取不到");
      if (!indicator) problems.push("日线指标缺失");
      // 行情时间不是今天 → 数据源整体没刷新（节假日 / 停牌 / 接口异常）
      const quoteDay = quote?.updatedAt?.slice(0, 10);
      const today = `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, "0")}-${`${now.getDate()}`.padStart(2, "0")}`;
      if (quote && quoteDay && quoteDay !== today) problems.push(`行情停在 ${quoteDay}`);
      return {
        code: item.code,
        name: item.name,
        held: item.held,
        price: quote?.price,
        changePct: quote?.changePct,
        quoteTime: quote?.updatedAt,
        barTime: bars?.[bars.length - 1]?.time,
        deepScore: deep?.score,
        indicatorAsOf: indicator?.asOf,
        problems,
      };
    },
    3,
  );

  const notes: string[] = [];
  const orders = listOrders().filter((order) => order.status === "open");
  notes.push(
    orders.length > 0
      ? `挂单 ${orders.length} 张：${orders.map((order) => describeOrder(order)).join("；")}`
      : "当前没有挂单",
  );
  const pendingFile = path.join(monitorDir(), "run", "pending-sells.json");
  try {
    const pending = JSON.parse(fs.readFileSync(pendingFile, "utf8")) as Array<{ code: string; reason: string }>;
    if (pending.length > 0) {
      notes.push(`T+1 待卖：${pending.map((item) => `${item.code}（${item.reason}）`).join("；")}`);
    }
  } catch {
    // 没有待卖
  }

  const indexLine = indexQuote
    ? `上证指数 ${fmtPrice(indexQuote.price)}（${(indexQuote.changePct ?? 0) >= 0 ? "+" : ""}${fmtPrice(indexQuote.changePct)}%）· 时间 ${indexQuote.updatedAt ?? "未知"}`
    : "上证指数行情取不到（数据源可能不可用）";

  return formatPreflight(rows, { indexLine, notes });
}

function orderSection(note?: string): string {
  return note
    ? `\n\n## 挂单已过期（需要你处理）\n${note}\n` +
        "- 三选一：撤单（`a_cancel_order`）、重新挂（`a_order` + pending）、或明确「继续等」并给出**新的时效**；\n" +
        "- 不要默认继续挂着 —— 过期说明当初的理由可能已经不成立。"
    : "";
}

export async function runAInspect(
  reason: string,
  options: AInspectOptions = {},
): Promise<AInspectResult> {
  appendLog(`巡检开始：${reason}`);
  appendAInspectEvent("start", reason);
  process.env.XZH_A_INSPECT = "1";
  const config = loadConfig();
  const active = activeModelEntry(config);
  if (!active) {
    appendLog("巡检失败：没有可用模型");
    return { summary: "", toolCalls: 0, error: "没有可用模型" };
  }
  const provider = createProvider(config, active);
  let text = "";
  let reasoning = "";
  let toolCalls = 0;
  /** 本轮工具调用明细（`a_order ✅`）：正文丢了也能拼出「做了什么」 */
  const toolLog: string[] = [];
  /** 中止原因（空闲超时 / 总时长上限），落日志用 */
  let abortReason = "";
  /** 有活动就续期空闲计时器（下文创建计时器后填上） */
  let touch = (): void => undefined;

  const events: AgentEvents = {
    onText: (delta) => {
      text += delta;
      touch();
    },
    onReasoning: (delta) => {
      reasoning += delta;
      touch();
    },
    onToolStart: (call) => {
      toolCalls += 1;
      touch();
      appendLog(`工具 ${call.name}`);
      appendAInspectEvent("tool", call.name);
    },
    onToolEnd: (call, result: ExecuteToolResult) => {
      touch();
      appendLog(`工具结束：${result.ok ? "成功" : "失败"}`);
      toolLog.push(`${call.name} ${result.ok ? "✅" : "❌"}`);
    },
    onStatus: () => undefined,
    onNotice: (message) => {
      appendLog(`提示 ${message}`);
      appendAInspectEvent("notice", message);
    },
    confirm: async (request) => UNATTENDED_TOOLS.has(request.tool),
    onRoundLimit: async () => false,
  };

  const agent = new Agent(provider, config, getAShareHome(), events, active, {
    mode: {
      name: "a",
      label: "A 股分析",
      home: getAShareHome(),
      cwdLocked: true,
      promptSection: "",
      startupHint: "",
    } satisfies AgentMode,
    autoMemory: false,
    taskLedger: false,
    backgroundJobs: false,
    maxToolRounds: MAX_TOOL_ROUNDS,
  });

  const controller = new AbortController();
  // 只有空闲超时：模型停止输出（思考 / 工具 / 正文）超过 3 分钟才中止。
  // **不设总时长上限** —— 本地模型慢，按总时长掐断只会把「正在写结论」的轮次变成空结论。
  const idleTimer = setTimeout(() => {
    abortReason = `空闲 ${Math.round(IDLE_TIMEOUT_MS / 60_000)} 分钟无输出`;
    controller.abort();
  }, IDLE_TIMEOUT_MS);
  touch = () => idleTimer.refresh();
  // 可选的总时长兜底（默认关闭 = 0）：本地模型慢，默认不掐；
  // 想防「一直有输出但永远跑不完」就 `xzh config inspect 60`（或临时设环境变量）。
  const maxMinutes = inspectMaxMinutes(config);
  const totalTimer =
    maxMinutes > 0
      ? setTimeout(() => {
          abortReason = `总时长超过 ${maxMinutes} 分钟（xzh config inspect 可调整）`;
          controller.abort();
        }, maxMinutes * 60_000)
      : null;
  try {
    await agent.run(
      `巡检原因：${reason}\n\n当前上下文：\n${await contextSection()}\n` +
        policySection() +
        triggerSection(options.triggerNote) +
        orderSection(options.orderNote) +
        (await preflightSection()) +
        `\n\n${inspectPrompt()}`,
      controller.signal,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog(`巡检失败：${message}`);
    appendAInspectEvent("error", message);
    return { summary: text.slice(0, SUMMARY_LIMIT), toolCalls, error: message };
  } finally {
    clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
    touch = () => undefined;
    delete process.env.XZH_A_INSPECT;
  }
  if (abortReason) {
    appendLog(`巡检中止：${abortReason}`);
  }

  // 不再在巡检结尾自动补排期：与 btc moni 一致，兜底由**后台 tick** 负责
  // （队列为空且距上次巡检满 60 分钟才跑一轮，见 `monitor.ts` 第 12 步）。
  // 模型自己漏排期时，这条兜底会接住；模型已排好期则不会凭空多跑一轮。

  let summary = text.trim().slice(0, SUMMARY_LIMIT);

  // 模型有时只输出思考、正文为空（或被超时掐断）；用一次短调用把思考与**实际动作**
  // 压成结论，避免微信/TUI 只看到“没有输出”。动作明细一定要给全 —— 以前只写
  // 「见上一轮上下文」，摘要器只能瞎猜，是「未产生动作」这种错误结论的来源。
  if (!summary) {
    const actions = toolLog.length > 0 ? toolLog.join("、") : "（本轮没有工具调用）";
    try {
      let fallback = "";
      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), 30_000);
      try {
        for await (const chunk of provider.chat({
          messages: [
            {
              role: "system",
              content:
                "你是 A 股巡检总结器。根据思考片段与工具调用明细，输出一段可执行的中文结论" +
                "（当前持仓处理 + 是否买卖 + 下一步重点），不要复述思考，不要调用工具。" +
                "只能依据给到的明细，不要臆测没有发生过的动作。",
            },
            {
              role: "user",
              content:
                `巡检原因：${reason}${abortReason ? `（本轮被中止：${abortReason}）` : ""}\n` +
                `工具调用（按顺序）：${actions}\n\n` +
                `思考片段：\n${reasoning.slice(-4_000) || "（无）"}\n\n` +
                "请直接输出结论。",
            },
          ],
          tools: [],
          temperature: 0.2,
          maxTokens: 400,
          signal: controller2.signal,
        })) {
          if (chunk.type === "text") fallback += chunk.text;
        }
      } finally {
        clearTimeout(timer2);
      }
      summary = fallback.trim().slice(0, SUMMARY_LIMIT);
    } catch {
      const lines = reasoning.trim().split(/\n+/).filter(Boolean);
      summary = lines.length > 0 ? `（自动摘要）${lines[lines.length - 1].slice(-300)}` : "";
    }
  }

  // 兜底文案必须如实反映「做了什么」：本轮可能已经下单，不能一口咬定「未产生动作」
  summary ||=
    `巡检结束（模型未输出正文结论${abortReason ? `，${abortReason}` : ""}；` +
    `本轮工具 ${toolCalls} 次${toolLog.length > 0 ? `：${toolLog.slice(0, 6).join("、")}` : ""}）`; 
  appendLog(`巡检结论：${summary}`);
  appendAInspectEvent("text", summary);
  appendAInspectEvent("end", `工具 ${toolCalls} 次`);
  return { summary, toolCalls, scheduled: nextScheduledEntry()?.at };
}
