import { delay, isRetryableError } from "./http";
import type { ChatOptions, StreamChunk } from "./types";

/**
 * 统一的流式重试 / **断连续传**。
 *
 * 此前每个 Provider 各自写了一遍「重试循环」，且规则是：**只要已经向调用方输出过内容，
 * 就一律不再重试**（`emitted` 标记）。这条规则的原因是怕重复输出 —— 重跑一次，
 * 模型会把开头重新生成一遍，用户会看到两遍相同内容。
 *
 * 但它把「输出到一半网络断了」变成了**必然失败**：用户明明已经看到大半段回复，
 * 却因为最后一段没到而整轮作废，只能重新发一次。长回复（尤其推理模型的长思考）
 * 撞上这种情况的概率并不低。
 *
 * 这里的做法是**断连续传**：重跑时把「已经交付过的前缀」跳过，只把新增部分交给调用方。
 * 前提是重跑的前缀与上次一致 —— 用 `PrefixSkipper` 逐块校验，一旦不一致就放弃续传、
 * 抛回原始网络错误（退化为旧行为，绝不产生拼接错乱的内容）。
 *
 * 为什么不做「服务端续写」（把已输出内容当作 assistant 前缀再请求）：那需要改写
 * 请求消息、且三家对 prefill 的支持程度不同（OpenAI 兼容端点未必真的续写，
 * 可能直接把它当成完整的一轮），复杂度与不确定性都更高。前缀跳过是纯客户端的，
 * 对三个 Provider 完全一致。
 */

/** 单次请求（含断连续传）的最大尝试次数 */
export const MAX_ATTEMPTS = 3;

/** 默认退避：600ms / 1200ms */
const defaultBackoff = (attempt: number): number => attempt * 600;

export interface RetryConfig {
  maxAttempts?: number;
  backoffMs?: (attempt: number) => number;
}

/**
 * 重跑时的前缀与已交付内容不一致 —— 模型这次生成的和上次不同，
 * 无法安全地跳过重复前缀，只能放弃续传。
 *
 * 内部信号，不会外泄给调用方：捕获后抛回**原始网络错误**，
 * 调用方看到的行为与「不支持续传」时完全一致。
 */
export class ResumeMismatchError extends Error {
  constructor() {
    super("续传前缀与已输出内容不一致");
    this.name = "ResumeMismatchError";
  }
}

/** 已经交付给调用方的内容账本（跨重试保留） */
export class DeliveredLedger {
  text = "";
  reasoning = "";
  toolCalls = 0;

  /** 是否已经交付过正文或思考 —— 决定下次重试是「续传」还是「从头重试」 */
  get hasDeliveredContent(): boolean {
    return this.text.length > 0 || this.reasoning.length > 0;
  }
}

/**
 * 逐块校验「重跑流的前缀是否与已交付内容一致」，并只放行新增部分。
 *
 * 为什么按累计长度而不是按块比对：分块边界在两次请求之间几乎不可能对齐
 * （同一段文字可能被切成 1 块也可能切成 3 块），因此只能累积到足够长度再比对。
 */
class PrefixSkipper {
  private collected = "";
  private settled: boolean;

  constructor(private readonly previous: string) {
    this.settled = previous.length === 0;
  }

  /** 返回本次应当**新交付**的文本；前缀尚未重建完成时返回 null */
  accept(chunk: string): string | null {
    if (this.settled) return chunk;

    this.collected += chunk;
    if (this.collected.length < this.previous.length) return null;
    if (!this.collected.startsWith(this.previous)) {
      throw new ResumeMismatchError();
    }

    this.settled = true;
    const tail = this.collected.slice(this.previous.length);
    this.collected = "";
    return tail.length > 0 ? tail : null;
  }

  /** 本次尝试正常结束时的校验：前缀必须被完整重建 */
  finish(): void {
    if (!this.settled) throw new ResumeMismatchError();
  }
}

/**
 * 单次尝试的产出口。Provider 把「想输出的内容」交给它，由它决定是否真的交付。
 *
 * 说明：正文走前缀校验（必须一字不差地重建才能续上）；**思考过程在续传时直接丢弃** ——
 * 推理模型的重跑几乎必然给出不同（甚至更短）的思考，校验只会白白让续传失败，
 * 而思考本来就是一次性的中间过程，用户也已经看过第一遍了。
 */
export class StreamEmitter {
  private readonly textPrefix: PrefixSkipper;
  private readonly suppressReasoning: boolean;
  private remainingToolCallSkips: number;

  constructor(private readonly ledger: DeliveredLedger) {
    this.textPrefix = new PrefixSkipper(ledger.text);
    this.suppressReasoning = ledger.reasoning.length > 0;
    this.remainingToolCallSkips = ledger.toolCalls;
  }

  /** 记录并返回应交付的正文；返回 null 表示该块属于重复前缀（不交付） */
  text(chunk: string): string | null {
    const out = this.textPrefix.accept(chunk);
    if (out) this.ledger.text += out;
    return out;
  }

  /** 记录并返回应交付的思考内容；续传时一律丢弃 */
  reasoning(chunk: string): string | null {
    if (this.suppressReasoning) return null;
    this.ledger.reasoning += chunk;
    return chunk;
  }

  /** 返回 true 表示该工具调用应当交付（上一轮流里没有交付过） */
  toolCall(): boolean {
    if (this.remainingToolCallSkips > 0) {
      this.remainingToolCallSkips--;
      return false;
    }
    this.ledger.toolCalls++;
    return true;
  }

  /** 本次尝试正常结束（流自然走完）时的校验 */
  finish(): void {
    this.textPrefix.finish();
  }
}

/**
 * 执行一次带重试的流式请求。
 *
 * `run` 接收本次尝试的 `StreamEmitter`，必须把正文 / 思考 / 工具调用都经由它交付
 * （而不是直接 yield），否则断连续传无法知道「什么已经发出去了」。
 */
export async function* withRetry(
  options: ChatOptions,
  run: (emit: StreamEmitter) => AsyncIterable<StreamChunk>,
  config: RetryConfig = {},
): AsyncIterable<StreamChunk> {
  const maxAttempts = config.maxAttempts ?? MAX_ATTEMPTS;
  const backoff = config.backoffMs ?? defaultBackoff;
  const ledger = new DeliveredLedger();
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 每次尝试都新建 emitter —— 它持有的是「本次尝试要跳过多少」的快照。
    const emit = new StreamEmitter(ledger);

    try {
      yield* run(emit);
      // 流自然走完：若处于续传，前缀必须已完整重建，否则视为内容不一致
      emit.finish();
      return;
    } catch (error) {
      if (error instanceof ResumeMismatchError) {
        throw lastError ?? error;
      }
      lastError = error;

      // 已交付过工具调用就绝不再重跑：工具调用只在流末尾产出，重跑必然导致
      // 同一个工具被执行两次（副作用重复），这比丢掉一次回复严重得多。
      const canRetry =
        !options.signal?.aborted &&
        attempt < maxAttempts &&
        ledger.toolCalls === 0 &&
        isRetryableError(error);
      if (!canRetry) throw error;

      // 下一次尝试是否会跳过前缀（续传）—— 以**此刻**的账本为准：
      // 本次尝试已经交付过的内容，就是下次要跳过的那部分。
      const resumed = ledger.hasDeliveredContent;

      options.onRetry?.(
        attempt,
        maxAttempts,
        error instanceof Error ? error : new Error(String(error)),
        { resumed },
      );
      await delay(backoff(attempt));
    }
  }

  throw lastError;
}
