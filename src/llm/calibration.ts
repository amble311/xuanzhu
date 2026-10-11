/**
 * 真实 usage 对估算的**回填校正** —— token 估算闭环的收敛端。
 *
 * 背景：玄猪不引入 tokenizer（各 provider 分词不同，通用 BPE 表对当前体量是数量级膨胀，
 * 详见 `context.ts` 的 `estimateTokens`），只用「ASCII 3.5 字符/token、CJK 1 字符/token」
 * 的保守估算来裁剪历史。估算是**单侧保守**的：宁可高估、让历史早一点被裁。
 *
 * 但保守不等于安全：一旦某些模型的真实用量比估算还大（比如服务端把工具 schema、
 * 消息结构开销也计入，或该模型对中文切分更碎），估算就会失效 —— 裁剪后的请求仍然超限，
 * 撞上 400。这类误差是**系统性**的，同一模型几乎每次都会重现，因此可以被观测并纠正。
 *
 * 闭环做法：每次请求结束后，拿 provider 返回的**真实 prompt token 数**与本次估算相比，
 * 得到比值 `real / estimate`，做指数加权平均（EWMA）后，下一次计算会话预算时用它收紧。
 *
 * 刻意的不对称：**只收紧、不放宽**。
 * 放宽（factor < 1 时把预算调大）会破坏 `estimateTokens`「宁可高估」的安全前提 ——
 * 估算本来偏高时把预算还回去，等于把 20% 余量取消，反而更容易撞上窗口。
 *
 * 状态在**进程内按模型共享**（见 `calibratorFor`）：主代理与并行子代理拿到的是同一个
 * 校正器，观测样本因此可以互相累积、收敛更快；且不落盘 —— 它是运行时自适应量，
 * 换个会话从 1 重新开始，一两次请求即可重新收敛，没必要引入一个新的配置文件。
 */

/** 未观测到足够样本时的默认比值（不校正） */
export const DEFAULT_TOKEN_FACTOR = 1;

/** 校正后允许的比值上限：最多把真实用量当成估算的 4 倍 */
const MAX_FACTOR = 4;

/**
 * 观测到该次数后才开始校正。
 *
 * 取 2 而非 1：首个样本可能是**缓存命中**（Anthropic 的 `input_tokens` 不含
 * cache read、部分网关也有类似行为）导致真实值骤降，或恰好是异常短/长的请求；
 * 等第二个样本进来再动手，避免一次噪声把预算砍半。
 */
const MIN_SAMPLES = 2;

/** EWMA 平滑系数（新样本权重）。取 0.3：既跟得上变化，又不被单次抖动带偏 */
const EWMA_ALPHA = 0.3;

/**
 * 单次样本的合理区间。落在区间外的样本直接丢弃：
 * - 上界 8：真实用量是估算的 8 倍以上，几乎只能是观测口径不同（如把缓存也算了进去、
 *   或本次估算的 message 与实际发送的不一致），拿它去校正会把预算压到不可用；
 * - 下界 0.1：反向同理。
 */
const MIN_PLAUSIBLE_SAMPLE = 0.1;
const MAX_PLAUSIBLE_SAMPLE = 8;

/** 估算误差的自适应校正器（按模型维度使用） */
export class TokenCalibrator {
  private ratio = DEFAULT_TOKEN_FACTOR;
  private samples = 0;

  /**
   * 记录一次「估算 vs 真实」的观测。
   *
   * 两个入参都必须是**输入侧**的 token 数（真实值取 `usage.inputTokens`）——
   * 输出 token 不参与，因为历史裁剪只约束输入。
   */
  observe(estimated: number, actual: number): void {
    if (!Number.isFinite(estimated) || !Number.isFinite(actual)) return;
    if (estimated <= 0 || actual <= 0) return;

    const sample = actual / estimated;
    if (sample < MIN_PLAUSIBLE_SAMPLE || sample > MAX_PLAUSIBLE_SAMPLE) return;

    this.ratio =
      this.samples === 0
        ? sample
        : this.ratio * (1 - EWMA_ALPHA) + sample * EWMA_ALPHA;
    this.samples++;
  }

  /**
   * 供预算使用的收紧系数：**恒 >= 1**。
   *
   * 估算偏高（ratio < 1）时返回 1，即不做任何放宽 —— 保守余量必须留住。
   */
  factor(): number {
    if (this.samples < MIN_SAMPLES) return DEFAULT_TOKEN_FACTOR;
    return Math.min(Math.max(this.ratio, DEFAULT_TOKEN_FACTOR), MAX_FACTOR);
  }

  /** 已累计的有效观测次数（供测试 / 诊断） */
  get observationCount(): number {
    return this.samples;
  }

  reset(): void {
    this.ratio = DEFAULT_TOKEN_FACTOR;
    this.samples = 0;
  }
}

/**
 * 按 `budget / factor` 收紧会话预算。
 *
 * 为什么是「除」：`budget` 处于**估算 token 空间**，而裁剪用的是同一套估算。
 * 若真实用量恒为估算的 f 倍，要让真实用量不超过窗口，就必须让估算不超过 `窗口 / f`。
 */
export function calibrateBudget(budget: number, factor: number): number {
  if (!(factor > DEFAULT_TOKEN_FACTOR)) return budget;
  return Math.max(1, Math.floor(budget / factor));
}

/** 进程内按模型共享的校正器表（key 为 `<provider>/<model>` 或裸模型名） */
const registry = new Map<string, TokenCalibrator>();

/** 取某个模型的校正器；不存在时创建。空 key 也有一份共享实例。 */
export function calibratorFor(key: string): TokenCalibrator {
  const normalized = key || "";
  const existing = registry.get(normalized);
  if (existing) return existing;
  const created = new TokenCalibrator();
  registry.set(normalized, created);
  return created;
}

/** 清空全部校正状态（测试用） */
export function resetCalibrators(): void {
  registry.clear();
}
