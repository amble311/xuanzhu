import { activeExchange } from "../exchange";
import {
  cancelAllOrders,
  cancelOrder,
  createOrder,
  setLeverage,
  transferContractToSpot,
  type OrderResponse,
  type OrderSide,
  type PrivateCredential,
} from "../exchange/binance-private";
import { getBtcHome } from "../utils/paths";
import { fetchAccountSnapshot } from "./account";
import { appendAction } from "./actions";
import { getCredential } from "./credentials";
import { getSymbolFilters, quantizePrice, quantizeQty } from "./market-meta";
import { readRiskSettings, readRiskState } from "./risk";

/** taker 手续费率（0.05%）：只在估算已实现盈亏时用，不改交易所实际扣费 */
const FEE_RATE = 0.0005;

/**
 * 合约交易动作（下单 / 平仓 / 撤单 / 锁利划转）。
 *
 * 与工具层分开：工具只做参数校验与文案，**所有风控闸门在这里**，
 * 这样后台巡检、前台对话、以后别的入口走的是同一条路径。
 *
 * 三条硬规则：
 * 1. 硬性风控触发且 `haltTradingOnTrigger` → **开仓直接抛错**（平仓、划转不受限，
 *    因为那两个方向是降低风险）；
 * 2. 数量与价格必须按 `stepSize` / `tickSize` 对齐，否则币安回 `-1111`；
 * 3. 划转只允许「合约 → 现货」，且不超过可用余额的 95%（留保证金余量）。
 */

export interface OpenPositionInput {
  /** `long` 买、`short` 卖 */
  side: "long" | "short";
  /**
   * 限价（必填）。
   *
   * 开仓**统一用限价单**：不追价、不立即成交，挂到下一次买卖点或主动撤单为止。
   * 数量按这个价格折算（成交价不会比限价更差）。
   */
  limitPrice: number;
  /** 名义金额（USDT）；与 quantity 二选一 */
  notional?: number;
  quantity?: number;
  leverage?: number;
  stopLoss?: number;
  takeProfit?: number;
  /** 开仓依据（写进动作账本，供下一轮巡检核对） */
  reason?: string;
}

export interface OpenPositionResult {
  symbol: string;
  side: "long" | "short";
  quantity: string;
  limitPrice: string;
  orderId?: number;
  /** `NEW` 表示挂单中（限价单不会立即成交） */
  status?: string;
  leverage?: number;
  /** 成功挂上的保护单 */
  protection: string[];
  /** 保护单失败等非致命问题 */
  warnings: string[];
  /** 动作账本 id（下一轮巡检据此核对是否成交） */
  actionId?: string;
}

function resolveSymbol(): string {
  const raw = process.env.BTC_SYMBOL?.trim() || "BTC/USDT";
  return activeExchange().exchange.toNativeSymbol(raw);
}

function credentialOrThrow(): PrivateCredential {
  const credential = getCredential("binance");
  if (!credential) {
    throw new Error(
      "未配置币安凭据。运行 `xzh btc apikey` 录入后才能下单。",
    );
  }
  return credential;
}

/** 开仓前的硬风控闸门（平仓、划转不走这里） */
function assertTradingAllowed(): void {
  const settings = readRiskSettings();
  const state = readRiskState();
  if (settings.haltTradingOnTrigger && state.triggered) {
    throw new Error(
      `硬性风控已触发（${state.reason ?? "原因未知"}），禁止开新仓。` +
        "先处理现有持仓，或在 `xzh btc fk` 里确认解除。",
    );
  }
}

async function markPrice(nativeSymbol: string): Promise<number> {
  const ticker = await activeExchange().exchange.fetchTicker(
    process.env.BTC_SYMBOL?.trim() || "BTC/USDT",
  );
  if (!(ticker.price > 0)) {
    throw new Error(`拿不到 ${nativeSymbol} 的最新价，无法计算数量`);
  }
  return ticker.price;
}

function assertOrderQuantity(
  qty: number,
  price: number,
  minNotional: number,
): void {
  if (!(qty > 0)) throw new Error("下单数量为 0：名义金额太小，低于交易对最小步长");
  if (qty * price < minNotional) {
    throw new Error(
      `名义价值 ${(qty * price).toFixed(2)} USDT 低于最小要求 ${minNotional} USDT`,
    );
  }
}

export async function openPosition(
  input: OpenPositionInput,
): Promise<OpenPositionResult> {
  assertTradingAllowed();
  // 参数校验放在凭据之前：缺参数是调用方的问题，不必先去读密钥
  if (!(input.limitPrice > 0)) {
    throw new Error("开仓统一使用限价单，必须给 limitPrice（大于 0）");
  }
  if (!(input.quantity ?? input.notional)) {
    throw new Error("请给 notional（USDT）或 quantity 其中之一");
  }
  const credential = credentialOrThrow();
  const symbol = resolveSymbol();
  const filters = await getSymbolFilters(symbol);
  const price = await markPrice(symbol);

  // 用限价折算数量：成交价不会比限价更差，按限价算不会超额
  const rawQty = input.quantity ?? (input.notional ? input.notional / input.limitPrice : 0);
  const quantity = quantizeQty(rawQty, filters.stepSize);
  assertOrderQuantity(Number(quantity), price, filters.minNotional);

  const warnings: string[] = [];
  let appliedLeverage: number | undefined;
  if (input.leverage !== undefined) {
    if (!(input.leverage >= 1 && input.leverage <= 125)) {
      throw new Error("杠杆必须在 1–125 之间");
    }
    try {
      await setLeverage({ symbol, leverage: input.leverage }, credential);
      appliedLeverage = input.leverage;
    } catch (err) {
      // 杠杆设置失败不阻断下单：可能是已有持仓不允许改，报出来让用户判断
      warnings.push(
        `设置杠杆失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const side: OrderSide = input.side === "long" ? "BUY" : "SELL";
  const limitPrice = quantizePrice(input.limitPrice, filters.tickSize);
  // GTC：一直挂到撤单为止 —— 这是「不追价、等回踩」的执行方式
  const order = await createOrder(
    {
      symbol,
      side,
      type: "LIMIT",
      quantity,
      price: limitPrice,
      timeInForce: "GTC",
    },
    credential,
  );

  const closeSide: OrderSide = input.side === "long" ? "SELL" : "BUY";
  const protection: string[] = [];
  for (const [kind, trigger, label] of [
    ["STOP_MARKET", input.stopLoss, "止损"],
    ["TAKE_PROFIT_MARKET", input.takeProfit, "止盈"],
  ] as const) {
    if (!(typeof trigger === "number" && trigger > 0)) continue;
    try {
      await createOrder(
        {
          symbol,
          side: closeSide,
          type: kind,
          stopPrice: quantizePrice(trigger, filters.tickSize),
          // 用 closePosition 而不是 reduceOnly+quantity：限价开仓可能还没成交，
          // 数量锁定会与真实仓位对不上；closePosition 在触发时按当时仓位全平。
          closePosition: true,
          workingType: "MARK_PRICE",
        },
        credential,
      );
      protection.push(`${label} ${trigger}`);
    } catch (err) {
      // 主仓已经成交，保护单失败要明确告警（用户需要手动挂）
      warnings.push(
        `${label}单挂单失败（请手动设置）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 记账：这单现在只是「挂出去了」，成交与否要等下一轮核对（见 preflight）
  const action = appendAction(getBtcHome(), {
    kind: "open",
    symbol,
    side: input.side,
    qty: Number(quantity),
    limitPrice: Number(limitPrice),
    orderId: order.orderId,
    status: "pending",
    reason: input.reason ?? "",
    note: warnings.length > 0 ? warnings.join("；").slice(0, 300) : undefined,
  });

  return {
    symbol,
    side: input.side,
    quantity,
    limitPrice,
    orderId: order.orderId,
    status: order.status,
    leverage: appliedLeverage,
    protection,
    warnings,
    actionId: action.id,
  };
}

export interface ClosePositionResult {
  symbol: string;
  side: "long" | "short";
  quantity: string;
  orderId?: number;
  status?: string;
  price?: number;
}

/** 市价平仓（只减仓）；没有持仓时返回 null */
export async function closePosition(): Promise<ClosePositionResult | null> {
  const credential = credentialOrThrow();
  const symbol = resolveSymbol();
  const filters = await getSymbolFilters(symbol);
  const snapshot = await fetchAccountSnapshot({ force: true });
  if (!snapshot.ok) {
    throw new Error(`读取持仓失败：${snapshot.error ?? "未知原因"}`);
  }

  const position = snapshot.positions.find((item) => item.symbol === symbol);
  if (!position) return null;

  const order = await createOrder(
    {
      symbol,
      // 平仓方向与持仓相反；reduceOnly 保证不会反向开仓
      side: position.side === "long" ? "SELL" : "BUY",
      type: "MARKET",
      quantity: quantizeQty(position.qty, filters.stepSize),
      reduceOnly: true,
    },
    credential,
  );

  const price = order.avgPrice ? Number(order.avgPrice) : position.markPrice;
  // 已实现盈亏（含手续费估算）：连亏判定要用它，缺了就没法算「连续亏几次」
  const direction = position.side === "long" ? 1 : -1;
  const gross = (price - position.entryPrice) * position.qty * direction;
  const fee = (position.entryPrice + price) * position.qty * FEE_RATE;
  const pnl = Number((gross - fee).toFixed(2));

  // 记 **pending** 而不是 filled：下单成功不代表仓位真的没了 ——
  // reduceOnly 单可能被拒、也可能只成交一部分。由下一轮前置核对对着快照确认。
  appendAction(getBtcHome(), {
    kind: "close",
    symbol,
    side: position.side,
    qty: position.qty,
    orderId: order.orderId,
    status: "pending",
    reason: "平仓",
    note: `成交价约 ${price}`,
    pnl,
  });

  return {
    symbol,
    side: position.side,
    quantity: String(position.qty),
    orderId: order.orderId,
    status: order.status,
    price,
  };
}

export interface CancelResult {
  cancelled: "single" | "all";
  symbol: string;
  orderId?: string;
}

export async function cancelOrders(input: {
  orderId?: string;
  all?: boolean;
}): Promise<CancelResult> {
  const credential = credentialOrThrow();
  const symbol = resolveSymbol();

  if (input.orderId) {
    await cancelOrder({ symbol, orderId: input.orderId }, credential);
    appendAction(getBtcHome(), {
      kind: "cancel",
      symbol,
      status: "cancelled",
      reason: `撤销订单 ${input.orderId}`,
      orderId: Number(input.orderId) || undefined,
    });
    return { cancelled: "single", symbol, orderId: input.orderId };
  }
  await cancelAllOrders({ symbol }, credential);
  appendAction(getBtcHome(), {
    kind: "cancel",
    symbol,
    status: "cancelled",
    reason: "撤销该交易对全部挂单",
  });
  return { cancelled: "all", symbol };
}

export interface TransferResult {
  amount: number;
  /** 划转后合约账户可用余额（估算，用于回报） */
  availableBefore: number;
  tranId?: number;
}

/**
 * 把合约账户的 USDT 划到现货（锁利）。
 *
 * 上限是可用余额的 95%：划走全部可用会把保证金掏空，一点波动就触发强平。
 */
export async function transferProfitToSpot(
  amount: number,
): Promise<TransferResult> {
  if (!(Number.isFinite(amount) && amount > 0)) {
    throw new Error("划转金额必须大于 0");
  }
  const credential = credentialOrThrow();
  const snapshot = await fetchAccountSnapshot({ force: true });
  if (!snapshot.ok || !snapshot.wallet) {
    throw new Error(`读取余额失败：${snapshot.error ?? "未知原因"}`);
  }

  const available = snapshot.wallet.available;
  const cap = Math.floor(available * 0.95 * 100) / 100;
  if (amount > cap) {
    throw new Error(
      `划转金额 ${amount} 超过上限 ${cap}（可用 ${available} 的 95%，需留保证金）`,
    );
  }

  const result = await transferContractToSpot(amount, credential);
  appendAction(getBtcHome(), {
    kind: "transfer",
    symbol: "USDT",
    qty: result.amount,
    status: "filled",
    reason: "合约 → 现货（锁利）",
    note: `划转前可用 ${available}`,
  });
  return { amount: result.amount, availableBefore: available, tranId: result.tranId };
}

/** 供工具层用的原始订单类型（避免重复 import） */
export type { OrderResponse };
