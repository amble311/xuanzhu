import * as fs from "fs";
import * as path from "path";
import { Agent, type AgentEvents } from "../core/agent";
import { activeModelEntry, loadConfig } from "../config/store";
import { createProvider } from "../llm";
import type { AgentMode } from "../modes";
import { getAShareHome } from "../utils/paths";
import type { ExecuteToolResult } from "../tools";
import { accountSummary, loadPaperAccount } from "./paper";
import { loadWatchlist } from "./watchlist";
import { describeRule, readRules } from "./rules";
import { nextScheduledEntry, pushSchedule, readScheduleQueue } from "./schedule";
import { isPaused } from "./pause";
import { readRiskState } from "./risk";
import { appendAInspectEvent } from "./inspect-stream";
import { describeOrder, listOrders } from "./orders";
import { monitorDir } from "./watchlist";

/**
 * A 股后台巡检（对齐 btc inspect）：
 * - 一个完整 Agent 轮次，可用 a_* / a_order / a_schedule / a_trigger；
 * - 结束前必须调 a_schedule 决定下一轮；
 * - 只分析持仓 + 自选，不选股（选股由收盘后 16:00 固定任务负责）；
 * - 失败时由调用方安排退避，不让巡检静默消失。
 */

const MAX_TOOL_ROUNDS = 12;
const TIMEOUT_MS = 6 * 60_000;
const SUMMARY_LIMIT = 600;

/** 无人值守放行的工具：交易、排期、规则；文件/bash/环境改动一律拒绝 */
const UNATTENDED_TOOLS = new Set([
  "a_order",
  "a_schedule",
  "a_unschedule",
  "a_trigger",
  "a_remove_trigger",
  "a_clear_risk",
  "a_account",
  "a_quote",
  "a_bars",
  "a_snapshot",
]);

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
  const watch = loadWatchlist();
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
    lines.push("持仓：无");
  } else {
    lines.push("持仓（优先级最高，先处理卖点/风险）：");
    for (const position of account.positions) {
      lines.push(
        `- ${position.code} ${position.name} ${position.qty} 股（可卖 ${position.available}）` +
          ` 成本 ${fmt(position.avgCost)} 现价 ${fmt(position.lastPrice)}` +
          ` 盈亏 ${fmt(position.pnl)}（${fmt(position.pnlPct)}%）`,
      );
    }
  }

  lines.push(`自选股 ${watch.items.length}/10（巡检唯一可选池；不在此池的股票不得买入）：`);
  for (const item of watch.items) {
    lines.push(`- ${item.code} ${item.name} 评分 ${item.score}：${item.reason}`);
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
          const entry = JSON.parse(line) as { kind?: string; code?: string; ok?: boolean; message?: string };
          lines.push(`- ${entry.kind ?? "?"} ${entry.code ?? ""} ${entry.ok === false ? "失败" : "成功"} ${entry.message ?? ""}`);
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
    for (const order of orders) lines.push(`- ${describeOrder(order)} ${order.reason}`);
  }

  lines.push(`排期 ${queue.length} 条：`);
  for (const entry of queue.slice(0, 5)) {
    lines.push(`- ${entry.at} ${entry.reason}（${entry.slot}）`);
  }
  if (isPaused()) lines.push("注意：当前处于暂停标记，但本轮由手动/事件触发。");
  const risk = readRiskState();
  if (risk?.triggered) {
    lines.push(`硬风控已触发（禁止开新仓）：${risk.reasons.join("；")}`);
  }

  return lines.join("\n");
}

const INSPECT_PROMPT = `你现在处于 A 股**后台巡检 / 无人值守**：没有用户在终端前，也没有人会回答你的提问。
这一轮必须自主决策到底：该卖就卖、该减就减、该买就买、该观望就观望，直接调用工具执行。

## 本轮职责（严格按顺序）

1. **持仓股（最高优先级）**
   - 先看止损 / 移动止盈 / 分批止盈 / 跌破 MA20 / 30 分钟走弱 / T+1 可卖数量；
   - 需要减仓或清仓时，直接 a_order；T+1 当日买入不可卖，只能记录。
2. **自选股（唯一可选池）**
   - 只允许从当前自选股里找买点；**不得买入池外股票**；
   - 买点：日线评分 ≥70、30 分钟站上 MA20 + 突破前 10 根高点 + 放量、非涨停、当日涨幅 ≤5%；
   - 最多 5 仓、每仓 20% 权益、100 股整手。
3. **监控规则**
   - 用 a_trigger 给持仓 / 自选股设置具体、可执行的条件（价格、涨跌幅、跌破/站上 MA20）；
   - 过时或已无意义的规则用 a_remove_trigger 删除；
   - 监控命中只会唤醒下一轮巡检，不会自动交易。
4. **下一轮巡检**
   - 结束前必须调用 a_schedule（分钟或 at），这是硬性要求；
   - 有持仓 / 临近收盘看紧一点（5–15 分钟），无持仓 / 平静时 30–60 分钟；
   - 当前不在工作日 09:00–15:30 时不要排夜间巡检，交给 a_schedule 顺延。

## 明确禁止

- **不做选股**：禁止调用 a_select / a_screen 重新筛选股票，禁止把池外股票加入自选；
  收盘后 16:00 有独立的固定选股任务，本轮只做“已有持仓 + 已有自选”的实时分析。
- 不允许写文件、执行 shell、修改环境、重置账本；不要声称真钱交易（这是模拟盘）。
- 若上下文提示“硬风控已触发”，本轮禁止买入/加仓，只能减仓或观望；减仓后可用 a_clear_risk 解除。
- 行情不可用 / 数据缺失时不要猜价格，明确说明并排下一次。

## 输出要求

先给一句正文结论（卖 / 买 / 持有 / 观望 + 下一步），再给依据；即使不操作也要写“结论：…”。
最后必须调用 a_schedule。`;
export async function runAInspect(reason: string, options: { origin?: "inspect" | "manual" } = {}): Promise<AInspectResult> {
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
      `巡检原因：${reason}\n\n当前上下文：\n${contextSection()}\n\n${INSPECT_PROMPT}`,
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

  // 模型必须自己排下一轮；漏了就兜底 60 分钟，避免巡检停摆
  const next = nextScheduledEntry();
  if (!next || Date.parse(next.at) > Date.now() + 6 * 60 * 60_000) {
    const entry = pushSchedule({
      minutes: 60,
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
