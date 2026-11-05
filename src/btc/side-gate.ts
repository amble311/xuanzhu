import { getBtcHome } from "../utils/paths";
import { runRunner } from "./python";

/**
 * 三周期方向闸门（开仓前的**硬性**校验）。
 *
 * 用户的规则：周 / 日 / 4h 都 ≥0 只做多，都 ≤0 只做空，全 0 不做。
 * 这条规则如果只写在提示词里，模型完全可以「综合判断」后做反向单 ——
 * 所以必须在 `btc_order` 发请求**之前**用代码挡一次，和硬性风控同一层级。
 *
 * 与风控的分工：
 * - 风控管「还能不能开仓」（亏损阈值）；
 * - 这里管「能不能开这个方向」（三周期打分）。
 *
 * 失败策略是**拒绝**：拿不到 `btc_signal`（脚本过期、数据不足、网络异常）时
 * 不能假设「大概可以做多」，否则数据故障就变成放开限制。
 */

export type GateSide = "long" | "short" | "none" | "unknown";

export interface SideGateResult {
  side: GateSide;
  reason: string;
  score?: {
    weekly: number | null;
    daily: number | null;
    h4: number | null;
    sum: number;
  };
  asOf?: string;
  /** `btc_signal` 是否真的算出来了（false = 数据/脚本问题，不是方向问题） */
  available: boolean;
}

interface SignalEnvelope {
  side_filter?: unknown;
  side_reason?: unknown;
  score?: {
    weekly?: unknown;
    daily?: unknown;
    h4?: unknown;
    sum?: unknown;
  };
  as_of?: unknown;
}

function asScore(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 把 `btc_signal` 的返回转成闸门结论（纯函数，便于单测） */
export function gateFromSignal(data: unknown): SideGateResult {
  const raw = (data ?? {}) as SignalEnvelope;
  const side: GateSide =
    raw.side_filter === "long" ||
    raw.side_filter === "short" ||
    raw.side_filter === "none" ||
    raw.side_filter === "unknown"
      ? raw.side_filter
      : "unknown";

  const score = raw.score
    ? {
        weekly: asScore(raw.score.weekly),
        daily: asScore(raw.score.daily),
        h4: asScore(raw.score.h4),
        sum: asScore(raw.score.sum) ?? 0,
      }
    : undefined;

  return {
    side,
    reason:
      typeof raw.side_reason === "string" && raw.side_reason.trim()
        ? raw.side_reason.trim()
        : side === "unknown"
          ? "没有拿到三周期打分（btc_signal 未返回 side_filter）"
          : "（工具未给出理由）",
    score,
    asOf: typeof raw.as_of === "string" ? raw.as_of : undefined,
    available: side !== "unknown",
  };
}

const CACHE_MS = 60_000;

let cache: { home: string; at: number; value: SideGateResult } | null = null;

/** 清掉进程内缓存（下单前后需要最新判断、或测试用） */
export function resetSideGateCache(): void {
  cache = null;
}

/**
 * 取当前三周期结论（60 秒缓存）。
 *
 * 缓存理由：一次对话里可能连续做「下单 → 补保护单 → 再下单」，
 * 每次都起 python 算一遍没有必要；60 秒内方向不会变到影响判断。
 */
export async function evaluateSideGate(
  home = getBtcHome(),
  now = Date.now(),
): Promise<SideGateResult> {
  if (cache && cache.home === home && now - cache.at < CACHE_MS) {
    return cache.value;
  }

  const result = await runRunner<unknown>("signal", {}, { timeoutMs: 60_000, home });
  const value: SideGateResult = result.ok
    ? gateFromSignal(result.data)
    : {
        side: "unknown",
        reason: `无法计算三周期方向：${result.error}`,
        available: false,
      };

  cache = { home, at: now, value };
  return value;
}

export interface GateDecision {
  ok: boolean;
  gate: SideGateResult;
  /** 给模型/用户看的拒绝理由（ok 时为空） */
  message: string;
}

function describeScore(gate: SideGateResult): string {
  if (!gate.score) return "";
  const label = (value: number | null) =>
    value === null ? "?" : value > 0 ? `+${value}` : String(value);
  return `（周线 ${label(gate.score.weekly)} / 日线 ${label(gate.score.daily)} / 4h ${label(gate.score.h4)}）`;
}

/**
 * 校验某个开仓方向是否被允许。
 *
 * `none` 与 `unknown` 都拒绝：前者是三周期不同向（用户明确要求不做），
 * 后者是判不出来（默认放行等于把「数据坏了」变成「规则失效」）。
 */
export function decideSideGate(
  gate: SideGateResult,
  direction: "long" | "short",
): GateDecision {
  if (!gate.available || gate.side === "unknown") {
    return {
      ok: false,
      gate,
      message:
        `✗ 三周期方向闸门无法判定：${gate.reason}\n` +
        "  数据缺失或计算脚本异常时不允许开仓（默认放行等于让规则失效）。\n" +
        "  先 btc_status / btc_sync 补齐数据（尤其 1h），再试。",
    };
  }

  if (gate.side === "none") {
    return {
      ok: false,
      gate,
      message:
        `✗ 三周期方向闸门拒绝：${gate.reason}${describeScore(gate)}\n` +
        "  当前规则：三周期都 ≥0 只做多、都 ≤0 只做空、全 0 或方向冲突不做。",
    };
  }

  if (gate.side !== direction) {
    const allowed = gate.side === "long" ? "做多" : "做空";
    return {
      ok: false,
      gate,
      message:
        `✗ 三周期方向闸门拒绝：当前只允许${allowed}${describeScore(gate)}，不能` +
        `${direction === "long" ? "做多" : "做空"}。\n` +
        `  理由：${gate.reason}\n` +
        "  这是用户设定的硬性规则（不是建议）。要看完整依据用 btc_signal。",
    };
  }

  return { ok: true, gate, message: "" };
}
