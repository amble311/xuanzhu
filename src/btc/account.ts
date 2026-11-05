import { privateGet } from "../exchange/binance-private";
import { getCredential } from "./credentials";

/**
 * 合约账户快照（余额 / 持仓 / 挂单）。
 *
 * 只用于**展示与风控判断**：这里的值不进入模型的工具返回，也不落库 ——
 * 账户金额属于隐私，写进会话或日志没有收益，只会扩大泄露面。
 *
 * 缓存 5 秒：右侧面板会定时刷新，而 `openOrders` 在币安的权重不低（40），
 * 每个渲染帧都拉一次会被限频。
 */

export interface AccountPosition {
  symbol: string;
  /** `long` / `short` */
  side: "long" | "short";
  /** 持仓数量（绝对值） */
  qty: number;
  entryPrice: number;
  markPrice: number;
  unrealized: number;
  /** 相对保证金的收益率（%） */
  roePct: number;
  leverage: number;
  liquidationPrice: number;
}

export interface AccountOrder {
  /** 币安订单号：用来核对「账本里那笔挂单现在怎么样了」 */
  orderId: number;
  symbol: string;
  side: "buy" | "sell";
  type: string;
  price: number;
  qty: number;
  /** 已成交数量：0 < filledQty < qty 表示部分成交（挂单时效检查要看它） */
  filledQty: number;
  reduceOnly: boolean;
  /** 条件单的触发价（保护单识别用；普通单为 0） */
  stopPrice: number;
  /** 触发后平掉全部仓位（我们挂的止损/止盈就是这种） */
  closePosition: boolean;
}

export interface AccountSnapshot {
  ok: boolean;
  error?: string;
  updatedAt: string;
  wallet: {
    /** 钱包余额（不含浮盈） */
    total: number;
    available: number;
    unrealized: number;
  } | null;
  positions: AccountPosition[];
  orders: AccountOrder[];
  /**
   * 维持保证金 / 保证金余额（0–100）。接近 100 意味着即将强平。
   *
   * 币安不直接给这个比例，用 `totalMaintMargin / totalMarginBalance` 算；
   * 拿不到就返回 0（视为未知，不报警）。
   */
  marginRatio: number;
}

interface RawAccount {
  totalWalletBalance?: string;
  availableBalance?: string;
  totalUnrealizedProfit?: string;
  totalMaintMargin?: string;
  totalMarginBalance?: string;
}

interface RawPosition {
  symbol?: string;
  positionAmt?: string;
  entryPrice?: string;
  markPrice?: string;
  unRealizedProfit?: string;
  leverage?: string;
  liquidationPrice?: string;
}

interface RawOrder {
  orderId?: number;
  symbol?: string;
  side?: string;
  type?: string;
  price?: string;
  origQty?: string;
  /** 已成交数量（部分成交判断用） */
  executedQty?: string;
  stopPrice?: string;
  reduceOnly?: boolean;
  closePosition?: boolean;
}

const CACHE_TTL_MS = 5_000;

let cache: { at: number; snapshot: AccountSnapshot } | null = null;

function num(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function emptySnapshot(error: string): AccountSnapshot {
  return {
    ok: false,
    error,
    updatedAt: new Date().toISOString(),
    wallet: null,
    positions: [],
    orders: [],
    marginRatio: 0,
  };
}

/** 拉一次账户快照（5 秒内复用上次结果；`force` 跳过缓存） */
export async function fetchAccountSnapshot(
  options: { force?: boolean } = {},
): Promise<AccountSnapshot> {
  if (!options.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.snapshot;
  }

  const credential = getCredential("binance");
  if (!credential) {
    const snapshot = emptySnapshot("未配置币安凭据");
    cache = { at: Date.now(), snapshot };
    return snapshot;
  }

  try {
    const [account, positions, orders] = await Promise.all([
      privateGet<RawAccount>("account", {}, credential),
      privateGet<RawPosition[]>("positions", {}, credential),
      privateGet<RawOrder[]>("openOrders", {}, credential),
    ]);

    const snapshot: AccountSnapshot = {
      ok: true,
      updatedAt: new Date().toISOString(),
      wallet: {
        total: num(account.totalWalletBalance),
        available: num(account.availableBalance),
        unrealized: num(account.totalUnrealizedProfit),
      },
      positions: positions
        .filter((item) => Math.abs(num(item.positionAmt)) > 0)
        .map((item) => {
          const qty = num(item.positionAmt);
          return {
            symbol: item.symbol ?? "",
            side: qty > 0 ? "long" : "short",
            qty: Math.abs(qty),
            entryPrice: num(item.entryPrice),
            markPrice: num(item.markPrice),
            unrealized: num(item.unRealizedProfit),
            roePct: num(item.entryPrice) > 0
              ? ((num(item.markPrice) - num(item.entryPrice)) / num(item.entryPrice)) *
                100 *
                (qty > 0 ? 1 : -1)
              : 0,
            leverage: num(item.leverage),
            liquidationPrice: num(item.liquidationPrice),
          };
        }),
      orders: orders.map((item) => ({
        orderId: Number(item.orderId) || 0,
        symbol: item.symbol ?? "",
        side: item.side === "SELL" ? "sell" : "buy",
        type: item.type ?? "",
        price: num(item.price),
        qty: num(item.origQty),
        filledQty: num(item.executedQty),
        reduceOnly: item.reduceOnly === true,
        stopPrice: num(item.stopPrice),
        closePosition: item.closePosition === true,
      })),
      marginRatio:
        num(account.totalMarginBalance) > 0
          ? (num(account.totalMaintMargin) / num(account.totalMarginBalance)) * 100
          : 0,
    };

    cache = { at: Date.now(), snapshot };
    return snapshot;
  } catch (err) {
    // 失败也要缓存一小会儿：面板每 8 秒重试一次就够了，没必要每次渲染都打网络
    const snapshot = emptySnapshot(
      err instanceof Error ? err.message : String(err),
    );
    cache = { at: Date.now(), snapshot };
    return snapshot;
  }
}

/** 配置变更（换凭据）后清缓存，否则面板会继续显示旧账户 */
export function invalidateAccountCache(): void {
  cache = null;
}

/** 当前持仓里「亏损百分比」最严重的一个（供硬风控判定），无持仓返回 null */
export function worstPositionLoss(
  snapshot: AccountSnapshot,
): { symbol: string; lossPct: number } | null {
  if (!snapshot.ok || snapshot.positions.length === 0) return null;
  let worst: { symbol: string; lossPct: number } | null = null;
  for (const position of snapshot.positions) {
    const lossPct = -position.roePct;
    if (!worst || lossPct > worst.lossPct) {
      worst = { symbol: position.symbol, lossPct };
    }
  }
  return worst;
}
