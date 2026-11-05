import * as fs from "fs";
import * as path from "path";
import { getBtcHome } from "../utils/paths";

/**
 * 交易动作账本（`run/actions.jsonl`）。
 *
 * 为什么需要它：巡检是**一轮一轮的独立会话**，上一轮挂了限价单、这一轮已经看不到
 * 「当时想干什么」了。没有账本时，模型只能看到「现在有张挂单」，无法回答
 * 「它是上一轮下的吗？成交了没有？成交后止损挂上了吗？」——而这些恰恰是最该先确认的事。
 *
 * 只记**我们自己发起的动作**（下单 / 平仓 / 撤单 / 划转），不试图镜像交易所全量历史：
 * 用户在币安 App 里手动做的操作不在账本里，所以判定要保守（见 preflight）。
 */

export type ActionKind = "open" | "close" | "cancel" | "transfer";

export type ActionStatus = "pending" | "filled" | "cancelled" | "unknown";

export interface BtcAction {
  id: string;
  /** 发起时间（ISO） */
  ts: string;
  kind: ActionKind;
  symbol: string;
  side?: "long" | "short";
  qty?: number;
  /** 限价开仓单的委托价 */
  limitPrice?: number;
  /** 交易所订单号（开仓/撤单） */
  orderId?: number;
  status: ActionStatus;
  /** 为什么做这个动作 */
  reason: string;
  /** 结算说明：成交价、撤销原因、失败原因 */
  note?: string;
  /** 平仓的已实现盈亏（含手续费估算）；只有 close 动作有 */
  pnl?: number;
  /**
   * 挂单时效（ISO）。到点仍未成交 / 只部分成交时，后端会叫醒一轮巡检来处理。
   * 只对 `kind=open` 有意义。
   */
  expiresAt?: string;
}

const MAX_KEEP = 200;

export function actionsPath(home = getBtcHome()): string {
  return path.join(home, "run", "actions.jsonl");
}

export function readActions(home = getBtcHome()): BtcAction[] {
  let raw: string;
  try {
    raw = fs.readFileSync(actionsPath(home), "utf8");
  } catch {
    return [];
  }

  const actions: BtcAction[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as BtcAction;
      if (parsed && typeof parsed.id === "string" && parsed.kind) {
        actions.push(parsed);
      }
    } catch {
      // 坏行跳过：一条脏数据不该让整份账本不可用
    }
  }
  return actions;
}

function writeAll(home: string, actions: BtcAction[]): void {
  const file = actionsPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 只保留最近 MAX_KEEP 条：账本是给「上一轮」用的，不是审计日志
  const kept = actions.slice(-MAX_KEEP);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    kept.map((item) => JSON.stringify(item)).join("\n") + (kept.length ? "\n" : ""),
    "utf8",
  );
  fs.renameSync(tmp, file);
}

export interface AppendActionInput {
  kind: ActionKind;
  symbol: string;
  side?: "long" | "short";
  qty?: number;
  limitPrice?: number;
  orderId?: number;
  status?: ActionStatus;
  reason: string;
  note?: string;
  pnl?: number;
  expiresAt?: string;
}

export function appendAction(
  home: string,
  input: AppendActionInput,
): BtcAction {
  const action: BtcAction = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    kind: input.kind,
    symbol: input.symbol,
    side: input.side,
    qty: input.qty,
    limitPrice: input.limitPrice,
    orderId: input.orderId,
    status: input.status ?? "pending",
    reason: input.reason,
    note: input.note,
    pnl: input.pnl,
    expiresAt: input.expiresAt,
  };
  const existing = readActions(home);
  existing.push(action);
  writeAll(home, existing);
  return action;
}

export function updateAction(
  home: string,
  id: string,
  patch: Partial<
    Pick<BtcAction, "status" | "note" | "qty" | "orderId" | "pnl" | "expiresAt">
  >,
): void {
  const actions = readActions(home);
  const target = actions.find((item) => item.id === id);
  if (!target) return;
  Object.assign(target, patch);
  writeAll(home, actions);
}

export interface RenewResult {
  renewed: BtcAction[];
  expiresAt: string;
}

/**
 * 给「还在挂着的单」续期（模型判断继续等时用）。
 *
 * 只改动作账本里的 `expiresAt`；订单本身不动（撤单重挂会丢队列位置，
 * 也可能在撤与挂之间错过成交）。
 */
export function renewActionTtls(
  home: string,
  options: { orderId?: number; minutes: number; now?: number },
): RenewResult {
  const now = options.now ?? Date.now();
  const expiresAt = new Date(now + options.minutes * 60_000).toISOString();
  const actions = readActions(home);
  const renewed = actions.filter(
    (item) =>
      (item.kind === "open" || item.kind === "close") &&
      item.status === "pending" &&
      (options.orderId === undefined || item.orderId === options.orderId),
  );
  if (renewed.length === 0) return { renewed: [], expiresAt };
  for (const item of renewed) item.expiresAt = expiresAt;
  writeAll(home, actions);
  return { renewed, expiresAt };
}

/** 还没结算的动作（主要是未成交的限价开仓单） */
export function pendingActions(home = getBtcHome()): BtcAction[] {
  return readActions(home).filter((item) => item.status === "pending");
}
