import { activeExchange } from "../exchange";
import {
  cancelAllOrders,
  cancelOrder,
  createOrder,
  fetchLeverage,
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
import {
  MAX_AUTO_LEVERAGE,
  maxNotionalFor,
  requiredLeverageFor,
  resolveLeverage,
} from "./leverage";
import { getSymbolFilters, quantizePrice, quantizeQty } from "./market-meta";
import { computeExpiresAt } from "./order-ttl";
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

/** 一档限价：多档 = 分批建仓，摊薄成本 */
export interface OrderLeg {
  limitPrice: number;
  /** 名义金额（USDT）；与 quantity 二选一 */
  notional?: number;
  quantity?: number;
}

export interface OpenPositionInput {
  /** `long` 买、`short` 卖 */
  side: "long" | "short";
  /**
   * 单档快捷方式（与 `orders` 二选一）。
   *
   * 开仓**统一用限价单**：不追价、不立即成交，挂到时效或主动撤单为止。
   * 数量按这个价格折算（成交价不会比限价更差）。
   */
  limitPrice?: number;
  notional?: number;
  quantity?: number;
  /** 多档限价：每档独立挂单、独立时效；适合「分批接」的策略 */
  orders?: OrderLeg[];
  /**
   * 倍率。缺省 **9x**（`BTC_LEVERAGE` 可覆盖），并由模型按「可用余额 + 本次信心」调整。
   * 缺省时也会显式设置一次，避免「按 9x 算、实际是旧杠杆」。
   */
  leverage?: number;
  stopLoss?: number;
  takeProfit?: number;
  /** 开仓依据（写进动作账本，供下一轮巡检核对） */
  reason?: string;
  /**
   * 挂单时效（分钟）。到点仍未成交 / 只部分成交，后端会叫醒一轮巡检来处理。
   * 缺省 60 分钟（`DEFAULT_ORDER_TTL_MIN`），最长 24 小时。
   */
  ttlMinutes?: number;
}

export interface OpenedLeg {
  orderId?: number;
  quantity: string;
  limitPrice: string;
  notional: number;
  expiresAt?: string;
}

export interface OpenPositionResult {
  symbol: string;
  side: "long" | "short";
  /** 总数量 */
  quantity: string;
  /** 各档加权均价 */
  limitPrice: string;
  orderId?: number;
  /** 第一档的状态；每档明细见 `legs` */
  status?: string;
  leverage?: number;
  /** 成功挂上的保护单 */
  protection: string[];
  /** 第一档的时效（每档自己的时效在 `legs[].expiresAt`） */
  expiresAt?: string;
  /** 保护单失败、部分档位失败等非致命问题 */
  warnings: string[];
  /** 动作账本 id（第一档；每档各自记一条） */
  actionId?: string;
  /** 每档明细（单档也有 1 条） */
  legs: OpenedLeg[];
  /** 保证金占用估算（开仓前核对用） */
  margin: {
    totalNotional: number;
    required: number;
    fee: number;
    available: number;
    leverage: number;
  };
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
  const legs: OrderLeg[] =
    input.orders && input.orders.length > 0
      ? input.orders
      : input.limitPrice
        ? [
            {
              limitPrice: input.limitPrice,
              notional: input.notional,
              quantity: input.quantity,
            },
          ]
        : [];
  if (legs.length === 0) {
    throw new Error(
      "开仓统一使用限价单：单档给 limitPrice，多档给 orders[]（每档 limitPrice + notional/quantity）",
    );
  }
  if (input.orders && input.limitPrice) {
    throw new Error("orders 与 limitPrice 只能二选一（单档用 limitPrice，多档用 orders）");
  }
  legs.forEach((leg, index) => {
    if (!(leg.limitPrice > 0)) {
      throw new Error(`第 ${index + 1} 档限价必须大于 0`);
    }
    if (!(leg.quantity ?? leg.notional)) {
      throw new Error(`第 ${index + 1} 档需要 notional（USDT）或 quantity`);
    }
  });

  const credential = credentialOrThrow();
  const symbol = resolveSymbol();

  // 倍率：默认 9x（用户设定），具体值由模型按「可用余额 + 本次信心」自主给。
  // 缺省时**也要显式设置一次**：否则会按 9x 算保证金、实际杠杆却还是交易所的旧值
  // （比如 5x），占用估算会偏小，平仓/强平判断全跟着错。
  let leverage = resolveLeverage(input.leverage);
  if (!(leverage >= 1 && leverage <= 125)) {
    throw new Error("杠杆必须在 1–125 之间");
  }

  // 必须在算保证金**之前**把杠杆确定下来：设置失败时要退回实际杠杆重算，
  // 否则会按 9x 估出一个偏小的占用，直到下单被交易所拒绝才发现。
  const warnings: string[] = [];
  let appliedLeverage = leverage;
  try {
    await setLeverage({ symbol, leverage }, credential);
    if (input.leverage === undefined) {
      warnings.push(`未指定倍率，按默认 ${leverage}x 设置（可用 leverage 参数覆盖）`);
    }
  } catch (err) {
    warnings.push(
      `设置 ${leverage}x 失败：${err instanceof Error ? err.message : String(err)}`,
    );
    const actual = await fetchLeverage({ symbol }, credential).catch(() => 0);
    if (actual > 0 && actual !== leverage) {
      leverage = actual;
      appliedLeverage = actual;
      warnings.push(`已按交易所实际 ${actual}x 计算保证金`);
    }
  }

  const filters = await getSymbolFilters(symbol);
  const price = await markPrice(symbol);

  // 先量化每一档，再按总额核对保证金（多档分开算会漏掉合计）
  const prepared = legs.map((leg) => {
    const rawQty =
      leg.quantity ?? (leg.notional ? leg.notional / leg.limitPrice : 0);
    const quantity = quantizeQty(rawQty, filters.stepSize);
    const limitPrice = quantizePrice(leg.limitPrice, filters.tickSize);
    assertOrderQuantity(Number(quantity), Number(limitPrice), filters.minNotional);
    return {
      quantity,
      limitPrice,
      notional: Number(quantity) * Number(limitPrice),
    };
  });
  const totalNotional = prepared.reduce((sum, leg) => sum + leg.notional, 0);

  const snapshot = await fetchAccountSnapshot({ force: true });
  if (!snapshot.ok) {
    throw new Error(
      `读取账户失败，无法核对可用保证金：${snapshot.error ?? "未知原因"}`,
    );
  }
  const available = snapshot.wallet?.available ?? 0;
  const fee = totalNotional * FEE_RATE;
  // 留 5% 缓冲：手续费、价格波动、资金费都会吃到保证金
  const budget = available * 0.95;
  let required = totalNotional / leverage;

  if (required + fee > budget) {
    // 用户设定：余额不足时允许**自动提高倍率**去够到可开仓，但硬上限 20x。
    // 只在没显式指定倍率时自动提；显式给了 5x 就说明模型想要保守，不能悄悄改成 20x。
    const need = requiredLeverageFor(totalNotional, budget, FEE_RATE);
    const canAuto = input.leverage === undefined;

    if (canAuto && need <= MAX_AUTO_LEVERAGE) {
      try {
        await setLeverage({ symbol, leverage: need }, credential);
      } catch (err) {
        throw new Error(
          `保证金不足，尝试自动把倍率提高到 ${need}x 失败：` +
            `${err instanceof Error ? err.message : String(err)}。` +
            "请手动降低名义金额或先入金。",
        );
      }
      const previous = leverage;
      leverage = need;
      appliedLeverage = need;
      required = totalNotional / leverage;
      warnings.push(
        `余额不足：倍率已从 ${previous}x 自动提高到 ${need}x（上限 ${MAX_AUTO_LEVERAGE}x）。` +
          "强平价会同步拉近，务必按新倍率重算风险。",
      );
    } else if (canAuto) {
      const maxNotional = maxNotionalFor(budget, MAX_AUTO_LEVERAGE, FEE_RATE);
      throw new Error(
        `保证金不足：这批挂单总名义 ${totalNotional.toFixed(2)} USDT，` +
          `即使按上限 ${MAX_AUTO_LEVERAGE}x 也开不了（需要 ${need}x）。` +
          `可用 ${available.toFixed(2)}，${MAX_AUTO_LEVERAGE}x 下最多可开约 ` +
          `${maxNotional.toFixed(2)} USDT 名义 —— 请减少档位/名义或先入金。`,
      );
    } else {
      const maxNotional = maxNotionalFor(budget, MAX_AUTO_LEVERAGE, FEE_RATE);
      throw new Error(
        `保证金不足：这批挂单总名义 ${totalNotional.toFixed(2)} USDT，` +
          `按你指定的 ${leverage}x 需要 ${required.toFixed(2)} + 手续费约 ${fee.toFixed(2)}，` +
          `可用 ${available.toFixed(2)}。至少需要 ${need}x（上限 ${MAX_AUTO_LEVERAGE}x）` +
          `或把名义降到 ${maxNotional.toFixed(2)} USDT 以内；显式倍率不会被自动改写。`,
      );
    }
  }

  const usage = available > 0 ? (required + fee) / available : 0;
  if (usage > 0.5) {
    // 超过一半可用余额去占保证金时，留给波动与追加的空间已经很小 ——
    // 这时候「倍率再高一点就能开」是错觉，先提醒降倍率/减名义。
    warnings.push(
      `保证金占用约 ${(usage * 100).toFixed(0)}% 可用余额` +
        `（${(required + fee).toFixed(2)}/${available.toFixed(2)}）：` +
        "已超过一半，建议降倍率或减少名义",
    );
  }

  const side: OrderSide = input.side === "long" ? "BUY" : "SELL";
  const opened: OpenedLeg[] = [];
  const actionIds: string[] = [];
  for (const [index, leg] of prepared.entries()) {
    // 限价已在现价另一侧时真实交易所会立即吃单（成交价更差），必须提前说清
    const crossed =
      input.side === "long"
        ? Number(leg.limitPrice) >= price
        : Number(leg.limitPrice) <= price;
    if (crossed) {
      warnings.push(
        `第 ${index + 1} 档限价 ${leg.limitPrice} 已越过现价 ${price.toFixed(2)}，` +
          "会立即成交（等同市价，可能有滑点）",
      );
    }

    try {
      // GTC：一直挂到时效到期或主动撤单 —— 这是「不追价、等回踩」的执行方式
      const order = await createOrder(
        {
          symbol,
          side,
          type: "LIMIT",
          quantity: leg.quantity,
          price: leg.limitPrice,
          timeInForce: "GTC",
        },
        credential,
      );

      const expiresAt = computeExpiresAt(input.ttlMinutes);
      const action = appendAction(getBtcHome(), {
        kind: "open",
        symbol,
        side: input.side,
        qty: Number(leg.quantity),
        limitPrice: Number(leg.limitPrice),
        orderId: order.orderId,
        status: "pending",
        reason:
          (input.reason ?? "") +
          (prepared.length > 1 ? `（第 ${index + 1}/${prepared.length} 档）` : ""),
        note: warnings.length > 0 ? warnings.join("；").slice(0, 300) : undefined,
        expiresAt,
      });
      actionIds.push(action.id);
      opened.push({
        orderId: order.orderId,
        quantity: leg.quantity,
        limitPrice: leg.limitPrice,
        notional: leg.notional,
        expiresAt,
      });
    } catch (err) {
      // 后面的档位大概率同样失败（参数/权限问题），不连环下单
      warnings.push(
        `第 ${index + 1} 档挂单失败（${leg.limitPrice}）：` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      break;
    }
  }
  if (opened.length === 0) {
    throw new Error(`所有档位都挂单失败：${warnings.join("；")}`);
  }

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
          // closePosition 按触发时仓位全平：多档建仓时各档成交数量不确定，
          // 锁数量会对不上；这也是限价单还没成交时挂保护单的唯一安全写法。
          closePosition: true,
          workingType: "MARK_PRICE",
        },
        credential,
      );
      protection.push(`${label} ${trigger}`);
    } catch (err) {
      warnings.push(
        `${label}单挂单失败（请手动设置）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const totalQty = opened.reduce((sum, leg) => sum + Number(leg.quantity), 0);
  const weighted =
    totalQty > 0
      ? opened.reduce(
          (sum, leg) => sum + Number(leg.quantity) * Number(leg.limitPrice),
          0,
        ) / totalQty
      : 0;

  return {
    symbol,
    side: input.side,
    quantity: String(Number(totalQty.toFixed(8))),
    limitPrice: weighted.toFixed(2),
    orderId: opened[0].orderId,
    status: "NEW",
    leverage: appliedLeverage,
    protection,
    expiresAt: opened[0].expiresAt,
    warnings,
    actionId: actionIds[0],
    legs: opened,
    margin: {
      totalNotional: Number(totalNotional.toFixed(2)),
      required: Number(required.toFixed(2)),
      fee: Number(fee.toFixed(2)),
      available: Number(available.toFixed(2)),
      leverage,
    },
  };
}

export interface ClosePositionInput {
  /**
   * `market`（默认）= 确定出场，接受滑点；`limit` = 控滑点，但可能不成交。
   *
   * 选择原则：临近止损/强平、行情快速、流动性差时用市价 —— 出场确定性优先；
   * 价格合适、只想在某个价位了结时用限价，但必须接受「没成交仓位就还在」。
   */
  mode?: "market" | "limit";
  /** 限价平仓必填 */
  limitPrice?: number;
  /** 限价平仓的时效（分钟，默认 60）：到点未成交由后端叫醒处理 */
  ttlMinutes?: number;
  reason?: string;
}

export interface ClosePositionResult {
  symbol: string;
  side: "long" | "short";
  quantity: string;
  orderId?: number;
  status?: string;
  /** 市价：成交均价；限价：委托价 */
  price?: number;
  mode: "market" | "limit";
  /** 限价单的时效（市价没有） */
  expiresAt?: string;
  /** 限价在现价的不利侧：只有价格回来才成交，仓位仍在 */
  mayNotFill?: boolean;
  warnings: string[];
  /** 市价平仓才有已实现盈亏（限价未成交时无从计算） */
  pnl?: number;
}

/**
 * 平仓（只减仓）；没有持仓时返回 null。
 *
 * 默认市价：出场要确定。限价平仓是「想在更好的价位了结」的工具，
 * 代价是**不成交时仓位与止损都还在** —— 所以限价单也带时效，
 * 超时由后端叫醒，避免「以为平了、实际还裸着」。
 */
export async function closePosition(
  input: ClosePositionInput = {},
): Promise<ClosePositionResult | null> {
  const mode = input.mode === "limit" ? "limit" : "market";
  // 参数校验放在凭据之前：缺参数是调用方的问题，不必先去读密钥
  if (mode === "limit" && !(typeof input.limitPrice === "number" && input.limitPrice > 0)) {
    throw new Error("限价平仓必须给 limitPrice（大于 0）");
  }
  const credential = credentialOrThrow();
  const symbol = resolveSymbol();
  const filters = await getSymbolFilters(symbol);
  const snapshot = await fetchAccountSnapshot({ force: true });
  if (!snapshot.ok) {
    throw new Error(`读取持仓失败：${snapshot.error ?? "未知原因"}`);
  }

  const position = snapshot.positions.find((item) => item.symbol === symbol);
  if (!position) return null;

  const side: OrderSide = position.side === "long" ? "SELL" : "BUY";
  const quantity = quantizeQty(position.qty, filters.stepSize);
  const warnings: string[] = [];

  // 已经有一张未成交的平仓挂单时，再平一次会出现「两张单抢同一批仓位」：
  // 先成交的那张把仓位吃掉，后一张变成 reduceOnly 被拒或部分成交，容易误判。
  const pendingClose = snapshot.orders.filter(
    (item) => item.reduceOnly && !item.closePosition && item.stopPrice === 0,
  );
  if (pendingClose.length > 0) {
    warnings.push(
      `已有未成交的平仓挂单 ${pendingClose
        .map((item) => `#${item.orderId}`)
        .join("、")}：建议先 btc_cancel 再平，避免两张单重复平仓`,
    );
  }

  if (mode === "limit") {
    if (!(typeof input.limitPrice === "number" && input.limitPrice > 0)) {
      throw new Error("限价平仓必须给 limit_price（大于 0）");
    }
    const price = quantizePrice(input.limitPrice, filters.tickSize);
    const order = await createOrder(
      {
        symbol,
        side,
        type: "LIMIT",
        quantity,
        price,
        timeInForce: "GTC",
        reduceOnly: true,
      },
      credential,
    );

    // 平多在「现价及以上」、平空在「现价及以下」才可能立刻成交；
    // 挂在不利侧只是排队等人接，不能当成「已经平了」。
    const mayNotFill =
      position.side === "long"
        ? Number(price) < position.markPrice
        : Number(price) > position.markPrice;
    if (mayNotFill) {
      warnings.push(
        `限价 ${price} 在现价 ${position.markPrice} 的不利侧：只有价格回到该位才成交；` +
          "未成交前仓位与止损仍然有效",
      );
    }

    const expiresAt = computeExpiresAt(input.ttlMinutes);
    appendAction(getBtcHome(), {
      kind: "close",
      symbol,
      side: position.side,
      qty: position.qty,
      orderId: order.orderId,
      status: "pending",
      reason: input.reason ?? "限价平仓",
      note: `限价 ${price}${mayNotFill ? "（需价格回到该位）" : "（可立即成交侧）"}`,
      expiresAt,
    });

    return {
      symbol,
      side: position.side,
      quantity: String(position.qty),
      orderId: order.orderId,
      status: order.status,
      price: Number(price),
      mode: "limit",
      expiresAt,
      mayNotFill,
      warnings,
    };
  }

  const order = await createOrder(
    {
      symbol,
      // 平仓方向与持仓相反；reduceOnly 保证不会反向开仓
      side,
      type: "MARKET",
      quantity,
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
    reason: input.reason ?? "市价平仓",
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
    mode: "market",
    warnings,
    pnl,
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
