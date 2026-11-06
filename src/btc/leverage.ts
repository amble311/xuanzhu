/**
 * 开仓倍率的默认值与解析。
 *
 * 用户设定：**默认 9x**，但具体倍率由模型根据「合约钱包可用余额」与
 * 「对这次开单的信心」自主调整（1–125，实际可开范围由交易所与保证金决定）。
 *
 * 为什么不在缺省时去读交易所当前杠杆：那样「默认 9x」就不成立了 ——
 * 交易所可能还留着上次手动设的 5x，模型不传倍率就会按 5x 算保证金，
 * 而它以为是 9x。默认值必须是一个确定的数，且下单前显式设置一次。
 */
export const DEFAULT_LEVERAGE = 9;
export const MIN_LEVERAGE = 1;
export const MAX_LEVERAGE = 125;
/**
 * 余额不足时自动提倍率的上限（用户设定）。
 *
 * 提高倍率只是把保证金占用降下来，强平价会同步拉近 —— 所以必须有硬上限，
 * 不能为了「凑够一单」无限加杠杆。
 */
export const MAX_AUTO_LEVERAGE = 20;

/**
 * 为满足「保证金 + 手续费 ≤ 预算」所需的最低倍率（向上取整）。
 *
 * `budget` 是可用余额打折后的额度（调用方已留缓冲）。
 * 返回值可能超过 `MAX_AUTO_LEVERAGE` —— 由调用方决定是拒绝还是提示。
 */
export function requiredLeverageFor(
  notional: number,
  budget: number,
  feeRate: number,
): number {
  const room = budget - notional * feeRate;
  if (!(room > 0) || !(notional > 0)) return Number.POSITIVE_INFINITY;
  return Math.ceil(notional / room);
}

/** 给定倍率下，预算能开出的最大名义（含手续费） */
export function maxNotionalFor(
  budget: number,
  leverage: number,
  feeRate: number,
): number {
  if (!(budget > 0) || !(leverage > 0)) return 0;
  return budget / (1 / leverage + feeRate);
}

/**
 * 解析本次开仓倍率：显式给的优先（合法性由调用方校验），
 * 否则用 `BTC_LEVERAGE`（便于本机统一调），再否则 9x。
 */
export function resolveLeverage(
  explicit?: number,
  env: string | undefined = process.env.BTC_LEVERAGE,
): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  const fromEnv = env ? Number(env) : NaN;
  if (Number.isFinite(fromEnv) && fromEnv >= MIN_LEVERAGE && fromEnv <= MAX_LEVERAGE) {
    return Math.round(fromEnv);
  }
  return DEFAULT_LEVERAGE;
}

/** 根据信心与机会评分给出「建议倍率区间」——只用于提示，不代替模型判断 */
export function suggestLeverage(
  confidence: number | undefined,
  opportunityScore: number | undefined,
): { min: number; max: number; reason: string } {
  const conf = typeof confidence === "number" ? confidence : 0.6;
  const score = typeof opportunityScore === "number" ? opportunityScore : 60;
  if (conf >= 0.75 && score >= 75) {
    return { min: 9, max: 12, reason: "高信心 + 高机会评分：可用 9–12x" };
  }
  if (conf >= 0.6 && score >= 60) {
    return { min: 6, max: 9, reason: "中等信心：6–9x" };
  }
  return { min: 3, max: 6, reason: "信心或评分偏低：3–6x，宁可少赚也别被强平" };
}
