import type { ChatMessage } from "./types";

/**
 * 模型上下文窗口（token）的推断。
 *
 * 为什么需要推断：没有任何统一接口能查询这个值 ——
 * OpenAI 兼容端点的 `/models` 只返回 id 与 owner，Anthropic / Gemini 也没有对应字段。
 * 因此采用「精确模型名 → 关键词 → 保守默认值」三级回退，结果只是参考上限，
 * 用户可在 `xzh model add` 时手填覆盖。
 */

/** 完全无法判断时使用的保守默认值（宁小勿大，避免发出去被服务端拒绝） */
export const DEFAULT_CONTEXT_WINDOW = 32_000;

/**
 * 输入预算占窗口的比例。
 *
 * 留出的 20% 用于容纳：本次回复的输出 token、字符估算的误差、
 * 以及各 provider 对消息结构额外添加的开销。宁可略早裁剪，也不要撞上窗口上限
 * —— 撞上会直接 400，且当前实现会把它误判为模型故障而白扣权重。
 */
export const INPUT_BUDGET_RATIO = 0.8;

/**
 * 预算下限：保证至少能带上一条消息（而不是把会话裁成空）。
 * 注意它不是硬下限 —— 实际取值会被窗口本身封顶，见 resolveConversationBudget。
 */
export const MIN_CONVERSATION_BUDGET = 1_000;

/** 每条消息的固定开销（role 标记、分隔符等） */
const PER_MESSAGE_OVERHEAD = 4;
/** 每个 tool_call 的固定开销（id / type / function 外壳） */
const PER_TOOL_CALL_OVERHEAD = 10;

/** 老旧工具输出被压缩后的上限（token） */
const STALE_TOOL_OUTPUT_TOKENS = 600;
/** 压缩时保留的头部占比（其余留给尾部 —— 报错信息常出现在末尾） */
const SQUEEZE_HEAD_RATIO = 0.6;
/** 最近这么多条消息不参与压缩：模型可能正在使用其中的内容 */
const RECENT_MESSAGES_PROTECTED = 6;

/**
 * 估算文本占用的 token 数。
 *
 * 按字符类型分段估算，因为差异极大：ASCII（英文 / 代码 / 标点）约 4 字符/token，
 * CJK 等宽字符约 1 字符/token。若统一按一个系数算，
 * 纯中文内容会被低估好几倍，裁剪就会失效。
 *
 * 两侧都取保守值（ASCII 按 3.5、CJK 按 1），即**宁可高估**。
 * 不引入 tokenizer 是因为各 provider 分词各不相同，而通用 tokenizer
 * （如 gpt-tokenizer）仅 BPE 表就有约 1MB，对当前约 200KB 的包是数量级的膨胀。
 * 估算误差由 INPUT_BUDGET_RATIO 与真实 usage 回填共同吸收。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let wide = 0;
  for (const char of text) {
    if (char.codePointAt(0)! < 0x80) ascii++;
    else wide++;
  }
  return Math.ceil(ascii / 3.5) + wide;
}

/** 估算单条消息的 token 数（正文 + 工具调用） */
export function estimateMessageTokens(message: ChatMessage): number {
  let tokens = PER_MESSAGE_OVERHEAD + estimateTokens(message.content ?? "");
  if (message.toolCalls) {
    for (const call of message.toolCalls) {
      tokens +=
        PER_TOOL_CALL_OVERHEAD +
        estimateTokens(call.name) +
        estimateTokens(call.arguments);
    }
  }
  return tokens;
}

/** 把文本裁剪到不超过 maxTokens（与 estimateTokens 采用同一口径，避免裁完仍超） */
export function sliceToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  let ascii = 0;
  let wide = 0;
  let end = 0;
  for (const char of text) {
    // 先判断「加上这个字符后是否会超」，会超就不纳入 ——
    // 若先累加再判断，end 会包含那个越界字符，结果比预算多出一个字符。
    const isAscii = char.codePointAt(0)! < 0x80;
    const nextAscii = ascii + (isAscii ? 1 : 0);
    const nextWide = wide + (isAscii ? 0 : 1);
    if (Math.ceil(nextAscii / 3.5) + nextWide > maxTokens) break;
    ascii = nextAscii;
    wide = nextWide;
    end += char.length;
  }
  return text.slice(0, end);
}

/**
 * 截断单条消息的正文以适配预算。无法处理时返回 null（连外壳都超预算）。
 *
 * 只动 `content`，**绝不动 `toolCalls.arguments`** —— 那是 JSON，截断会产出非法结构，
 * 而 assistant 与其 tool 结果的配对完整性一旦破坏，下一次请求会直接 400。
 */
function shrinkMessage(message: ChatMessage, budget: number): ChatMessage | null {
  const overhead = estimateMessageTokens({ ...message, content: "" });
  const reserve = 30; // 留给截断提示语
  if (overhead + reserve >= budget) return null;

  const content = message.content ?? "";
  const allow = budget - overhead - reserve;
  if (estimateTokens(content) <= allow) return message;

  const truncated = sliceToTokenBudget(content, allow);
  const dropped = content.length - truncated.length;
  return {
    ...message,
    content: `${truncated}\n\n…（内容过长，已截断 ${dropped} 字符以适配模型上下文窗口）`,
  };
}

/**
 * 压缩「老旧的大块工具输出」。
 *
 * 分层裁剪的第一步 —— 预算不够时**先压缩、再考虑丢弃整条**：
 *   - 工具输出（`ls` 结果、构建日志、文件内容）是一次性的大块信息，
 *     价值随时间迅速衰减，但「调用过它、大致看到了什么」这个事实仍有用；
 *   - 用户消息与助手结论是对话骨架，丢掉会让模型失去任务目标。
 * 所以保留头尾、砍掉中段，而不是整条丢弃。
 *
 * 只作用于本次请求的副本（调用方传入的是新数组），原始历史不被改写，
 * 因此不会出现「多轮压缩后越来越短」的累积损耗。
 */
export function squeezeStaleToolOutput(
  messages: ChatMessage[],
): ChatMessage[] {
  if (messages.length <= RECENT_MESSAGES_PROTECTED) return messages;
  const boundary = messages.length - RECENT_MESSAGES_PROTECTED;

  return messages.map((message, index) => {
    // 近期消息保持原样 —— 模型可能正在使用它们的内容
    if (index >= boundary) return message;
    if (message.role !== "tool") return message;

    const content = message.content ?? "";
    if (estimateTokens(content) <= STALE_TOOL_OUTPUT_TOKENS) return message;

    const headBudget = Math.floor(STALE_TOOL_OUTPUT_TOKENS * SQUEEZE_HEAD_RATIO);
    const tailBudget = STALE_TOOL_OUTPUT_TOKENS - headBudget;
    const head = sliceToTokenBudget(content, headBudget);
    // 尾部按偏保守的比例折算字符数（宁可多留一点，报错信息常在末尾）
    const tailChars = Math.min(
      content.length - head.length,
      Math.max(0, tailBudget) * 3,
    );
    const tail = tailChars > 0 ? content.slice(-tailChars) : "";
    const omitted = content.length - head.length - tail.length;

    return {
      ...message,
      content: `${head}\n\n…（此处省略 ${omitted} 字符的中间内容）\n\n${tail}`,
    };
  });
}

/**
 * 按 token 预算裁剪会话消息：**从最老的开始丢**，最近的对话优先保留
 * （那是当前任务真正需要的上下文）。
 *
 * 丢弃之前会先压缩老旧工具输出（见 squeezeStaleToolOutput），
 * 只有压缩后仍放不下才真正丢弃。
 *
 * 与旧实现的区别：旧实现是「保留最后 N 条」，与内容大小无关 ——
 * 一条 30000 字符的 `bash` 输出和一条「好的」占同样的份额，
 * 于是 60 条以内也可能轻松越过窗口上限，撞上 400。
 */
export function trimMessagesToBudget(
  messages: ChatMessage[],
  budget: number,
): ChatMessage[] {
  // 0. 先压缩老旧的大块工具输出 —— 压缩后可能就落进预算，从而不必丢弃整条消息
  const squeezed = squeezeStaleToolOutput(messages);

  // 1. 从尾部累加，找到预算内能覆盖到的最早位置
  let cut = squeezed.length;
  let used = 0;
  for (let i = squeezed.length - 1; i >= 0; i--) {
    const cost = estimateMessageTokens(squeezed[i]);
    // 至少保留最后一条，否则会把整轮对话裁空、请求变成「没有输入」
    if (cut < squeezed.length && used + cost > budget) break;
    used += cost;
    cut = i;
  }

  let kept = squeezed.slice(cut);

  // 2. 开头不能是孤立的 tool 消息（它必须紧跟其 assistant）
  while (kept.length > 0 && kept[0].role === "tool") kept.shift();

  // 3. 兜底：若什么都不剩（预算只够放下零散的工具结果，而它们作为孤立前缀被清掉），
  //    至少保留最后一条 user 消息。否则模型对本轮完全失忆 ——
  //    工具其实已经执行过并产生了副作用，它却会重新执行一遍。
  if (kept.length === 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        kept = [messages[i]];
        break;
      }
    }
  }

  // 4. 唯一保留的消息自身就超预算时，截断它的正文兜底
  if (kept.length === 1) {
    const cost = estimateMessageTokens(kept[0]);
    if (cost > budget) {
      const shrunk = shrinkMessage(kept[0], budget);
      if (shrunk === null) return [];
      kept[0] = shrunk;
    }
  }

  return kept;
}

/**
 * 计算当前模型可用于「会话部分」（不含 system prompt）的 token 预算。
 *
 * 窗口取模型条目的 `contextWindow`（未设置则按模型名推断），
 * 减去 system prompt 自身的占用，再乘安全系数。
 */
export function resolveConversationBudget(
  contextWindow: number | undefined,
  model: string,
  systemPrompt: string,
): number {
  const total = resolveTotalBudget(contextWindow, model);
  const systemCost = estimateTokens(systemPrompt) + PER_MESSAGE_OVERHEAD;
  const available = total - systemCost;
  // 下限用于「至少能带一条消息」，但必须被 total 封顶：
  // 若窗口本身就不足 1000 token，把预算抬到 1000 反而会发出必然超限的请求。
  return Math.max(1, Math.min(Math.max(available, MIN_CONVERSATION_BUDGET), total));
}

/** 整个请求可用的 token 上限（窗口 × 安全系数） */
function resolveTotalBudget(
  contextWindow: number | undefined,
  model: string,
): number {
  const window =
    contextWindow && contextWindow > 0 ? contextWindow : inferContextWindow(model);
  return Math.floor(window * INPUT_BUDGET_RATIO);
}

/**
 * system prompt 是否已占去窗口的一半以上。
 *
 * 项目规则（rules.md）与附加指令（systemPromptExtra）都是全文注入、无长度上限，
 * 它们可能把窗口吃光，此时裁历史毫无意义 —— 需要提示用户精简或换大窗口模型。
 */
export function isSystemPromptTight(
  contextWindow: number | undefined,
  model: string,
  systemPrompt: string,
): boolean {
  const total = resolveTotalBudget(contextWindow, model);
  const systemCost = estimateTokens(systemPrompt) + PER_MESSAGE_OVERHEAD;
  return systemCost >= total * 0.5;
}

/** 精确模型名 → 上下文窗口 */
const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  // OpenAI
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4.1": 1_000_000,
  "gpt-4": 8_192,
  "gpt-3.5-turbo": 16_385,
  o1: 200_000,
  "o1-mini": 128_000,
  "o3-mini": 200_000,
  // Anthropic
  "claude-sonnet-4-5": 200_000,
  "claude-opus-4-1": 200_000,
  "claude-3-5-haiku-latest": 200_000,
  "claude-3-5-sonnet-latest": 200_000,
  // DeepSeek
  "deepseek-chat": 64_000,
  "deepseek-reasoner": 64_000,
  // Google
  "gemini-2.0-flash": 1_000_000,
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  // 智谱
  "glm-4-plus": 128_000,
  "glm-4-air": 128_000,
  "glm-4-flash": 128_000,
  // 通义千问
  "qwen-max": 32_000,
  "qwen-plus": 128_000,
  "qwen2.5-coder-32b-instruct": 32_000,
  // Groq
  "llama-3.3-70b-versatile": 128_000,
  // Ollama（取决于本地模型，给常见的几个）
  "qwen2.5-coder": 32_000,
  "llama3.1": 128_000,
  "deepseek-coder-v2": 128_000,
};

/** 关键词 → 上下文窗口，用于模型名带日期/版本后缀等无法精确匹配的情况 */
const CONTEXT_HINTS: Array<[RegExp, number]> = [
  [/claude/i, 200_000],
  [/gemini/i, 1_000_000],
  [/deepseek/i, 64_000],
  [/gpt-4\.1|gpt-4o|gpt-4-turbo/i, 128_000],
  [/\bo[13]\b/i, 128_000],
  [/gpt-4\b/i, 8_192],
  [/gpt-3\.5/i, 16_385],
  [/qwen|glm|yi-|moonshot|kimi/i, 128_000],
  [/llama|mistral|mixtral|gemma|phi-|command-r/i, 128_000],
];

/**
 * 推断模型的上下文窗口（token）。
 *
 * 匹配顺序：精确名（忽略大小写）→ 去掉常见后缀再试 → 关键词 → 默认值。
 * 例：`claude-sonnet-4-5-20250929` 会命中 `/claude/i` 得到 200000。
 */
export function inferContextWindow(model: string): number {
  const name = model.trim();
  if (!name) return DEFAULT_CONTEXT_WINDOW;

  const lower = name.toLowerCase();
  const exact = KNOWN_CONTEXT_WINDOWS[lower];
  if (exact) return exact;

  // 去掉常见后缀再试一次：-latest / -preview / -20250929 / :7b 等
  const stripped = lower
    .replace(/[-_]?(latest|preview|stable|beta|exp)$/, "")
    .replace(/[-_]\d{6,8}$/, "")
    .replace(/[:@].*$/, "");
  const strippedExact =
    KNOWN_CONTEXT_WINDOWS[stripped] ??
    Object.entries(KNOWN_CONTEXT_WINDOWS).find(
      ([key]) => stripped.startsWith(key) || stripped === key,
    )?.[1];
  if (strippedExact) return strippedExact;

  for (const [pattern, size] of CONTEXT_HINTS) {
    if (pattern.test(stripped)) return size;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * 格式化上下文窗口大小。
 *
 * **输出完整数字**（`128000`），不做 `128k` / `1M` 之类的缩写：
 *   - 缩写会引入歧义（`1M` 究竟是 1000000 还是 1048576？`1.5k` 是 1500 还是 1536？）；
 *   - 这个值直接决定历史裁剪的预算，用户需要一眼看出确切数值。
 */
export function formatContextWindow(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "未设置";
  return String(Math.floor(tokens));
}
