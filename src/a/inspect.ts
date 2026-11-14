import * as fs from "fs";
import * as path from "path";
import { Agent, type AgentEvents } from "../core/agent";
import { activeModelEntry, loadConfig } from "../config/store";
import { createProvider } from "../llm";
import type { AgentMode } from "../modes";
import { getAShareHome } from "../utils/paths";
import type { ExecuteToolResult } from "../tools";
import { accountSummary, loadPaperAccount } from "./paper";
import { maxPositions, poolSize } from "./settings";
import { monitorDir, orderedPool } from "./watchlist";
import { describeRule, readRules } from "./rules";
import { nextScheduledEntry, pushSchedule, readScheduleQueue } from "./schedule";
import { isPaused } from "./pause";
import { readRiskState } from "./risk";
import { readPositionRisks } from "./risk-alerts";
import { appendAInspectEvent } from "./inspect-stream";
import { describeOrder, listOrders } from "./orders";
import { readPolicy } from "./policy";

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
const TIMEOUT_MS = 6 * 60_000;
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
  if (now.getDay() === 0 || now.getDay() === 6) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= 9 * 60 && minutes <= 15 * 60 + 30;
}

function contextSection(): string {
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
  if (!inAWorkWindow()) {
    lines.push(
      "注意：当前不在 A 股工作时段（工作日 09:00–15:30）。本轮是手动触发，不要安排夜间巡检；" +
        "下一轮请排到下一个工作日 09:05 之后（a_schedule 会自动顺延）。",
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

/** 提示词按当前配置生成：池子容量与持仓上限是用户可改的（`xzh a settings`） */
function inspectPrompt(): string {
  const cap = maxPositions();
  const size = poolSize();
  return `你现在处于 A 股**后台巡检 / 无人值守**：没有用户在终端前，也没有人会回答你的提问。
这一轮你必须**自主决策到底** —— 该卖就卖、该减就减、该买就买、该撤就撤、该观望就观望，直接调用工具执行；
最终回复必须包含一段**正文结论**（不能只把内容留在思考/reasoning 里）；即使选择观望，也要写“结论：…”。
不要写「请确认」「等你回复」（没有人会回），也不要只给方案不执行。

任务：按持仓优先的顺序轮询自选池（${size} 只，含持仓），逐只判断买卖点，并决定下次巡检时间。

步骤（a_* 工具可用）：
1. \`a_account\` 看账本（总资产 / 可用 / 持仓 / 可卖数量），\`a_orders\` 看挂单时效。
2. \`a_signal\`（不传 code）拿**全池速览**：每只股票的月 / 周 / 日三周期方向 + 15 分钟择时评分。
   池内顺序已经是持仓在前；需要深挖的单只用 \`a_signal(code=…)\` 再看一次。
   - 三周期方向只看结论（+1 / 0 / -1）：任一周期 -1 或全 0 就是 \`side_filter=none\`，**不做**；
   - 15 分钟是**择时周期**：\`entry=now\`（≥60 分且形态成立）才考虑动手，\`wait\` 就明确在等什么；
   - 数据不足（unknown）时用 \`a_bars(period=15m)\` / \`a_quote\` 自查一遍，仍不足就不做。
3. 逐只决策（**持仓股优先**，先处理风险再谈机会）：
   - 持仓：三周期出现 -1、或 15 分钟跌破 MA20/前 10 根低点、或触及 ATR 止损/移动止盈 → 减仓或清仓；
     T+1 当日买入不可卖，只能记录并用 \`a_trigger\` 盯住下一交易日；
   - 买点：\`side_filter=long\`、15 分钟 \`entry=now\`、非涨停、当日涨幅 ≤5%、非停牌、
     消息面无硬风险 → 才可买入；100 股整手，**持仓最多 ${cap} 只股票**（池内 ${size} 只是候选，
     已持 ${cap} 只时只能加仓现有持仓或先减/清一只再换股）、每仓 20% 权益；
   - 结论依赖消息面时先 \`a_news\`；硬风险（立案/退市/暴雷）禁止买入，持仓则考虑减。
   - 不确定就按最保守的方案执行，并在结论里写明理由（为什么买 / 为什么不做 / 为什么减仓）。
4. **结束前必须把「怎么再次叫醒我」注入监控**（三件事，按需使用）：
   a. \`a_schedule\`（必须有）：自己判断下一次巡检时间并说明理由 ——
      信号刚触发 / 临近收盘 → 15–30 分钟；平静观望、无持仓 → 30–60 分钟；
      非工作时段不要排夜间巡检（a_schedule 会自动顺延）；
   b. \`a_trigger\`：本轮结论**依赖某个具体价位 / 均线 / 涨跌幅**时把阈值落盘
      （例：站上 15m MA20、跌破 12.80、涨幅回落 3%）。不要只靠「等时间」；
      每只股票最多 5 条，过时或已无意义的用 \`a_remove_trigger\` 删掉；
   c. 有未成交挂单时：确认时效是否合理 —— 判断继续等就 \`a_renew\` 续期并说明理由，
      不该继续等就 \`a_cancel_order\` 撤掉。**不要放任它挂着过期**（过期后代码会叫醒你，但那是兜底）。
5. 最后用一段话总结本轮结论（会写进巡检日志供复盘）。

硬约束：
- **不做选股**：禁止调用 \`a_select\` / \`a_screen\` 重新筛选股票，禁止买入池外股票；
  收盘后 16:00 有独立的固定选股任务，本轮只做「已有持仓 + 已有自选池」的实时分析。
- 本模式下没有可用的下单工具以外的执行能力：不写文件、不执行 shell、不改环境、不重置账本。
- **这正是模拟盘**（不涉及真钱）：成交以工具返回为准，不得声称真钱交易。
- 硬性风控、涨跌停、停牌、T+1、100 股整手、**只在连续竞价时段成交**（09:30–11:30 / 13:00–15:00
  且当天是交易日）都由代码强制：被拒绝时看懂原因再决定，不要反复重试同一条被拒的操作。
  集合竞价 / 午休 / 盘前盘后 / 节假日只能 \`pending: true\` 挂单等开盘。
- 若上下文提示「账户级硬风控已触发」，本轮禁止买入/加仓，只能减仓或观望；减仓后用 \`a_clear_risk\` 解除。
- 若提示「单票硬风控」，**只禁止买入被锁的那只股票**，其他股票照常评估；该股减仓后用
  \`a_clear_risk(code=…)\` 单独解锁，不要因为一只票停掉整个账户。
- 若提示「持仓风控告警」，监控只是告警、不会自动卖；是否卖、卖多少由你判断并 \`a_order\`。
- 行情不可用 / 数据缺失时不要猜价格，明确说明并排下一次。
- 工具轮数由代码限制（约 12 轮），${size} 只股票要在轮次内分析完：能一次拿到的就别分多次。`;
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

  const events: AgentEvents = {
    onText: (delta) => {
      text += delta;
    },
    onReasoning: (delta) => {
      reasoning += delta;
    },
    onToolStart: (call) => {
      toolCalls += 1;
      appendLog(`工具 ${call.name}`);
      appendAInspectEvent("tool", call.name);
    },
    onToolEnd: (_call, result: ExecuteToolResult) => {
      appendLog(`工具结束：${result.ok ? "成功" : "失败"}`);
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
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    await agent.run(
      `巡检原因：${reason}\n\n当前上下文：\n${contextSection()}\n` +
        policySection() +
        triggerSection(options.triggerNote) +
        orderSection(options.orderNote) +
        `\n\n${inspectPrompt()}`,
      controller.signal,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog(`巡检失败：${message}`);
    appendAInspectEvent("error", message);
    return { summary: text.slice(0, SUMMARY_LIMIT), toolCalls, error: message };
  } finally {
    clearTimeout(timer);
    delete process.env.XZH_A_INSPECT;
  }

  // 模型必须自己排下一轮；漏了就兜底 30 分钟，避免巡检停摆
  const next = nextScheduledEntry();
  if (!next || Date.parse(next.at) > Date.now() + 6 * 60 * 60_000) {
    const entry = pushSchedule({
      minutes: 30,
      reason: "巡检未排期，兜底",
      slot: "next",
      origin: options.origin === "manual" ? "manual" : "inspect",
    });
    appendLog(`未发现有效排期，兜底 ${entry.at}`);
  }

  let summary = text.trim().slice(0, SUMMARY_LIMIT);

  // 模型有时只输出思考、正文为空；用一次短调用把思考与最近动作压成结论，
  // 避免微信/TUI 只看到“没有输出”。
  if (!summary) {
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
                "你是 A 股巡检总结器。根据思考片段与最近动作，输出一句可执行的中文结论（持仓/买卖/观望 + 下一步），不要复述思考，不要调用工具。",
            },
            {
              role: "user",
              content:
                `思考片段：\n${reasoning.slice(-4_000) || "（无）"}\n\n` +
                "最近动作：见上一轮上下文。请直接输出一句结论。",
            },
          ],
          tools: [],
          temperature: 0.2,
          maxTokens: 300,
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

  summary ||= "巡检完成（模型未生成正文结论，也未产生动作）";
  appendLog(`巡检结论：${summary}`);
  appendAInspectEvent("text", summary);
  appendAInspectEvent("end", `工具 ${toolCalls} 次`);
  return { summary, toolCalls, scheduled: nextScheduledEntry()?.at };
}
