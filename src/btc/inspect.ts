import { Agent, type AgentEvents } from "../core/agent";
import type { ExecuteToolResult } from "../tools";
import { activeModelEntry, loadConfig } from "../config/store";
import { createProvider } from "../llm";
import { ensureBtcNetwork } from "./network";
import { createBtcMode } from "../modes";
import { getBtcHome } from "../utils/paths";
import { appendInspectEvent } from "./inspect-stream";
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
2. \`btc_signal\` 拿三阶段结论（若 1h 数据不足会 degraded，先补 1h 再判断）。
3. 需要评估参数时才用 \`btc_backtest\`，不要为了"更全面"反复回测。
4. **结束前必须调用 \`btc_schedule\`**，自己判断下次巡检时间并说明理由：
   - 信号刚触发、价格临近关键位或止损位 → 15–60 分钟后再看；
   - 明确 stand_aside / 观望、数据刚同步过 → 2–8 小时后再看；
   - 预计日线收盘、数据更新等事件之前需要确认 → 定在该事件之前。
5. 最后用一段话总结本轮结论（会写进巡检日志供复盘）。

硬约束：
- 你**有真实下单能力**（\`btc_order\` / \`btc_close\` / \`btc_cancel\`），动的是真钱：
  没有明确信号不得开仓，也不得声称成交 —— 以工具返回为准。
- 后台无人确认，需要用户批准的操作不可用；不要尝试绕过。
- 工具调用控制在 8 次以内，不要重复取同一份数据。
- **日线收盘、资金费结算、价格剧烈波动由代码自动触发额外巡检**，
  你排期时不必刻意去覆盖这些时点；但仍要根据信号状态决定下次时间。
- 拿不到数据就如实说，不要编造价格或指标。
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

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    await agent.run(
      INSPECT_PROMPT +
        (options.paper ? PAPER_PROMPT_SECTION : "") +
        policySection +
        riskSection,
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
