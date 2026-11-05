import { Agent, type AgentEvents } from "../core/agent";
import type { ExecuteToolResult } from "../tools";
import { activeModelEntry, loadConfig } from "../config/store";
import { createProvider } from "../llm";
import { ensureBtcNetwork } from "./network";
import { createBtcMode } from "../modes";
import { getBtcHome } from "../utils/paths";
import { fetchAccountSnapshot } from "./account";
import { readActions, updateAction } from "./actions";
import { appendInspectEvent } from "./inspect-stream";
import { buildPreflight } from "./preflight";
import { readPolicy } from "./policy";

/**
 * 一轮后台巡检 —— 真正让模型做决策的地方。
 *
 * 与「纯数据同步」的区别：巡检是一个完整的 agent 轮次（调模型 + 用 btc_* 工具），
 * 结束时由模型自己通过 `btc_schedule` 决定下次什么时候再看，而不是死板地每 15 分钟一次。
 *
 * 三条硬约束（都靠代码，不靠提示词）：
 * 1. `confirm: () => false` —— 后台无人值守，任何需要用户批准的操作一律拒绝。
 *    将来接入下单工具时，模型无法在半夜自己批准一笔真实交易；
 * 2. 不写会话、不写自动记忆、不维护任务账本（`sessionFile` / `autoMemory` /
 *    `taskLedger` 全关）：巡检是独立轮次，攒历史只会把上下文撑爆；
 * 3. 工具轮数有上限，避免「再查一次就好」把一轮巡检跑成几十次调用。
 */

const MAX_TOOL_ROUNDS = 12;
const DEFAULT_TIMEOUT_MS = 8 * 60_000;
/** 巡检结论写进状态/日志时截断到这个长度，避免把整段分析塞进 state */
export const SUMMARY_LIMIT = 600;

const INSPECT_PROMPT = `你现在处于**后台巡检**：没有用户在终端前，只有这一轮机会。

任务：判断当前是否有值得执行的 BTC 交易机会，并决定下次巡检时间。

步骤（btc_* 工具可用）：
1. 先 \`btc_status\` 看环境与数据新鲜度；数据落后就 \`btc_sync\`。
2. \`btc_signal\` 拿两层结论：\`side_filter\`（三周期允许的方向）与
   \`stage4_1h\`（1 小时线机会评分 / 形态 / 失效条件）。\`side_filter\` 为 none / unknown、
   或 \`stage4_1h.entry=wait\` 时不做；1h 不足会 degraded，先补 1h 再判断。
3. 需要评估参数时才用 \`btc_backtest\`，不要为了"更全面"反复回测。
4. **结束前必须把「怎么再次叫醒我」注入监控**（三件事，按需使用）：
   a. \`btc_schedule\`（必须有）：自己判断下次巡检时间并说明理由 ——
      信号刚触发/临近关键位 → 15–60 分钟；明确观望、刚同步过 → 2–8 小时；
      日线收盘等事件前 → 定在事件之前；
   b. \`btc_trigger\`：本轮结论**依赖某个具体价位或指标**时把阈值落盘
      （例：站上 81200 才追多、1h RSI 回到 40 以上再看）。不要只靠「等时间」，
      关键位到了就该看一眼 —— 但条件要具体可验证，别自己随手加一堆（上限 10 条）；
      有先后顺序的要求（先站上 81200、再等回踩 80500）用 \`kind=chain\`，\`and\` 表达不了顺序；
   c. 有未成交挂单时：确认时效是否合理 —— 判断继续等就 \`btc_renew\` 续期并说明理由，
      不该继续等就撤单。**不要放任它挂着过期**（过期后端会叫醒你，但那是兜底，不是常规）。
5. 最后用一段话总结本轮结论（会写进巡检日志供复盘）。

硬约束：
- 你**有真实下单能力**（\`btc_order\` / \`btc_close\` / \`btc_cancel\`），动的是真钱：
  没有明确信号不得开仓，也不得声称成交 —— 以工具返回为准。
- 后台无人确认，需要用户批准的操作不可用；不要尝试绕过。
- 工具轮数由代码限制（约 8 轮），不要重复取同一份数据；能一次拿到的就别分多次。
- **日线收盘、资金费结算、价格剧烈波动由代码自动触发额外巡检**，
  你排期时不必刻意去覆盖这些时点；但仍要根据信号状态决定下次时间。
- 拿不到数据就如实说，不要编造价格或指标。
- 开头有一节「上次动作的落地情况」：**先处理那里的 critical 问题**（持仓无止损、
  距强平过近、上次挂单已撤销却没跟进），再判断新机会。不要跳过它直接排期。
- 开仓一律限价（\`btc_order\` 的 \`limit_price\`），挂单不追价；用 \`btc_orders\` 看是否成交。
- 有未成交挂单时：到本轮巡检/信号变化仍未成交，判断「继续等」还是「撤单」；
  结论反向就 \`btc_cancel all=true\` 撤掉，别让旧方向的单子留在盘上。`;

/** 模拟盘巡检追加的段落：放开虚拟开平仓，但纪律与实盘一致 */
const PAPER_PROMPT_SECTION = `

**本次是模拟盘巡检**：用 \`btc_paper_status\` 看虚拟账本（权益 / 持仓 / 绩效），
需要时用 \`btc_paper_open\` / \`btc_paper_close\` 执行模拟开平仓。
纪律与实盘相同（方向、仓位、止损、依据都要讲清），但**不涉及真钱**，
不要说成实盘成交。已有持仓时先判断该持有还是该平，不要重复开同向仓。`;

export interface InspectOptions {
  log?: (line: string) => void;
  maxToolRounds?: number;
  timeoutMs?: number;
  /** 模拟盘后端：允许提示词里放开 `btc_paper_*` 的虚拟开平仓 */
  paper?: boolean;
  /**
   * 硬性风控已触发但后台还不知道：本轮必须带着它跑，让模型重估策略。
   * 传了它就意味着「用户设的硬线被击穿」，优先级高于一切策略偏好。
   */
  riskAlert?: { reason?: string; detail?: string };
  /**
   * 本轮是被哪条「叫醒条件」触发的（价格 / 指标阈值）。
   * 不注入的话，模型只会看到一次莫名其妙的常规巡检，容易回一句「无变化」。
   */
  triggerNote?: string;
  /**
   * 超时挂单的明细（哪张单、超了多久、部分成交多少）。
   * 需要模型给出「撤单 / 改价 / 继续等」的明确处理，而不是当普通巡检走过场。
   */
  orderNote?: string;
}

export interface InspectResult {
  ok: boolean;
  /** 模型最后输出的结论文本（已截断） */
  summary: string;
  /** 本轮实际执行了多少次工具调用（含 btc_schedule） */
  toolCalls: number;
  error?: string;
}

export async function runInspectCycle(
  options: InspectOptions = {},
): Promise<InspectResult> {
  const home = getBtcHome();
  const log = options.log ?? (() => undefined);

  const config = loadConfig();
  const active = activeModelEntry(config);
  if (!active) {
    return {
      ok: false,
      summary: "",
      toolCalls: 0,
      error: "尚未配置任何模型（先运行 xzh model add），后台巡检无法进行",
    };
  }

  // 后端是独立进程：没做网络引导的话，巡检里所有取数都会失败。
  // 同进程内已被 daemon-main 引导过，这里通常是缓存命中（不会每轮都探测）。
  await ensureBtcNetwork({ config });

  let provider;
  try {
    provider = createProvider(config, active);
  } catch (err) {
    return {
      ok: false,
      summary: "",
      toolCalls: 0,
      error: `创建模型客户端失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let text = "";
  let toolCalls = 0;

  // ── 过程流：前端据此实时展示「后台在想什么」 ──
  const round = new Date().toISOString();
  const emit = (
    kind: Parameters<typeof appendInspectEvent>[0]["kind"],
    body: string,
  ): void => {
    appendInspectEvent({ round, kind, text: body }, home);
  };

  let reasoningBuf = "";
  let textBuf = "";
  let lastFlush = 0;
  /**
   * 合并增量再写：`onText` 每 token 调一次，逐条落盘会产生几千行，
   * 前端滚动区会被瞬间刷爆。1.5 秒或结束时各刷一次。
   */
  const flush = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastFlush < 1_500) return;
    lastFlush = now;
    if (reasoningBuf.trim()) {
      emit("reasoning", reasoningBuf.trim());
      reasoningBuf = "";
    }
    if (textBuf.trim()) {
      emit("text", textBuf.trim());
      textBuf = "";
    }
  };

  emit("round-start", options.paper ? "模拟盘巡检开始" : "巡检开始");

  const events: AgentEvents = {
    onText: (delta) => {
      text += delta;
      textBuf += delta;
      flush();
    },
    onReasoning: (delta) => {
      reasoningBuf += delta;
      flush();
    },
    onToolStart: (call) => {
      toolCalls += 1;
      flush(true);
      log(`  · ${call.name}`);
      const args = JSON.stringify(call.arguments ?? {});
      emit("tool", `${call.name} ${args.slice(0, 200)}`);
    },
    onToolEnd: (call: unknown, result: ExecuteToolResult) => {
      const name = (call as { name?: string })?.name ?? "工具";
      const brief = (result.content ?? "").replace(/\s+/g, " ").slice(0, 200);
      emit("tool-end", `${name} → ${result.ok ? "成功" : "失败"}${brief ? `：${brief}` : ""}`);
    },
    onStatus: () => undefined,
    onNotice: (message) => {
      log(`  ${message}`);
      emit("notice", message);
    },
    // 后台无人值守：需要确认的操作一律拒绝（这是代码级闸门，不依赖提示词）
    confirm: async () => false,
    onRoundLimit: async () => false,
  };

  const agent = new Agent(provider, config, home, events, active, {
    mode: createBtcMode({ paper: options.paper === true }),
    autoMemory: false,
    taskLedger: false,
    backgroundJobs: false,
    maxToolRounds: options.maxToolRounds ?? MAX_TOOL_ROUNDS,
  });

  // ── 巡检前置核对：先确认上次动作落地了没有 ──
  // 没有这一步时，一轮巡检只往前看：上一轮挂的单成交了吗？成交后止损挂上了吗？
  // 平仓到底平掉没有？全是空白，而那正是最容易出事的环节。
  let preflightSection = "";
  if (!options.paper) {
    const snapshot = await fetchAccountSnapshot({ force: true });
    const report = buildPreflight({
      snapshot,
      actions: readActions(home),
    });
    // 把「已成交 / 已撤销」回写账本，避免下一轮重复核对同一笔
    for (const item of report.settled) {
      if (!item.status) continue;
      updateAction(home, item.id, { status: item.status, note: item.note });
    }
    preflightSection = `\n\n${report.prompt}`;
    if (report.hasCritical) {
      log("⚠ 前置核对发现需要优先处理的问题");
      for (const issue of report.issues) {
        if (issue.level === "critical") log(`  ${issue.text.replace(/\*\*/g, "")}`);
      }
    }
  }

  // 用户长期要求（btc_policy 落盘）注入本轮巡检：只在前台说一句「记住了」不会传到这里
  const policy = readPolicy(home);
  const policySection = policy
    ? `\n\n## 用户设定的决策指令（必须遵守；与资金安全冲突时以安全为先）\n${policy}`
    : "";

  const riskSection = options.riskAlert
    ? `\n\n## 硬性风控已触发（最高优先级）\n- 原因：${options.riskAlert.reason ?? "未知"}${
        options.riskAlert.detail ? `（${options.riskAlert.detail}）` : ""
      }\n- 本轮**禁止开新仓**；先判断现有持仓该持有、减仓还是平仓。\n- 必须用 \`btc_policy\` 落盘**调整后的策略**（例如降低单笔风险、只在趋势确认时才交易），\n  让接下来的巡检按新约束执行，而不是继续用原来那套。\n- 结论开头写明「已按硬性风控重估策略」。`
    : "";

  // 挂单超时要给出明确处理，不能当普通巡检走过去
  const orderSection = options.orderNote
    ? `\n\n## 挂单已超时（需要你处理）\n${options.orderNote}\n` +
      "- 三选一：撤单重挂（`btc_cancel` / `btc_paper_cancel`）、改价、或明确「继续等」并给出**新的时效**；\n" +
      "- 不要默认继续挂着 —— 超时说明当初的理由可能已经不成立；\n" +
      "- 部分成交时，剩余部分的风险比全未成交更大（方向可能已经变了）。"
    : "";

  // 被叫醒的一轮要说清「谁叫的、条件是什么」，否则模型会当成常规巡检
  const triggerSection = options.triggerNote
    ? `\n\n## 本轮由叫醒条件触发（用户/你自己设定的阈值）\n${options.triggerNote}\n` +
      "- 先确认条件**现在是否仍成立**（价格/指标可能已经回头），再决定做不做；\n" +
      "- 被叫醒不等于必须交易：条件成立但三周期打分否决，就明确说不做并排下一次。"
    : "";

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    await agent.run(
      INSPECT_PROMPT +
        (options.paper ? PAPER_PROMPT_SECTION : "") +
        preflightSection +
        orderSection +
        policySection +
        riskSection +
        triggerSection,
      controller.signal,
    );
  } catch (err) {
    flush(true);
    const message = err instanceof Error ? err.message : String(err);
    emit("error", message);
    return {
      ok: false,
      summary: text.trim().slice(-SUMMARY_LIMIT),
      toolCalls,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }

  flush(true);
  const summary = text.trim().slice(-SUMMARY_LIMIT);
  emit("round-end", summary || "（本轮没有输出结论）");

  // 计划不在这一层读：它是「队列」，由后端定时器按到期时间消费
  return {
    ok: true,
    summary,
    toolCalls,
  };
}
