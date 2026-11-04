import type {
  AccountOrder,
  AccountPosition,
  AccountSnapshot,
} from "./account";
import type { ActionStatus, BtcAction } from "./actions";

/**
 * 巡检前置核对：**先确认上次动作落地了没有，再判断新机会**。
 *
 * 之前的一轮巡检从 `btc_status` 开始，只往前走 —— 上一轮挂的限价单成交了吗？
 * 成交后止损挂上了吗？平仓到底平掉没有？全是空白。最坏的情况是：
 * 限价单成交、止损单因故没挂上，而巡检继续找新机会，那笔单子在场上裸奔。
 *
 * 这里只做**核对与告警**，不自动补挂止损：补挂涉及真实资金，必须由模型（或用户）
 * 明确决定。代码负责「把事情摆到眼前」，不替人动手。
 */

export interface PreflightIssue {
  level: "critical" | "warn" | "info";
  text: string;
}

export interface SettledAction {
  id: string;
  text: string;
  /** 需要回写账本的状态（没有变化就不写） */
  status?: ActionStatus;
  note?: string;
}

export interface PreflightReport {
  issues: PreflightIssue[];
  settled: SettledAction[];
  /** 注入巡检提示词的整段文字 */
  prompt: string;
  /** 有没有需要优先处理的严重问题 */
  hasCritical: boolean;
  /** 持仓是否缺少保护单（面板也用这个） */
  unprotected: boolean;
}

/** 距强平价小于这个百分比就报警 */
export const LIQUIDATION_WARN_PCT = 5;
/** 维持保证金率超过这个百分比就报警 */
export const MARGIN_RATIO_WARN = 80;
/** 同时挂着的单超过这个数量就提醒（多张一起成交会变成超仓） */
export const MAX_PENDING_ORDERS = 2;

/** 这张单是不是保护单（止损 / 止盈 / 只减仓） */
export function isProtectiveOrder(order: AccountOrder): boolean {
  if (order.closePosition) return true;
  const type = order.type.toUpperCase();
  return (
    type.startsWith("STOP") ||
    type.startsWith("TAKE_PROFIT") ||
    order.reduceOnly
  );
}

function clock(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

const KIND_LABEL: Record<BtcAction["kind"], string> = {
  open: "",
  close: "平仓",
  cancel: "撤单",
  transfer: "划转",
};

function describeAction(action: BtcAction): string {
  const verb =
    action.kind === "open"
      ? action.side === "short"
        ? "做空"
        : "做多"
      : KIND_LABEL[action.kind];
  const qty = action.qty ? ` ${fmtQty(action.qty)}` : "";
  const price = action.limitPrice ? ` @ ${action.limitPrice}` : "";
  return `${clock(action.ts)} ${verb}${qty}${price}`;
}

function fmtQty(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6);
}

/**
 * 生成核对报告。
 *
 * `snapshot` 为 null 或 `ok=false` 时只说明「无法核对」——没凭据、网络失败都属正常情况，
 * 不该让巡检因此停摆，但也不能假装核对过。
 */
export function buildPreflight(input: {
  snapshot: AccountSnapshot | null;
  actions: BtcAction[];
}): PreflightReport {
  const { snapshot, actions } = input;
  const issues: PreflightIssue[] = [];
  const settled: SettledAction[] = [];

  if (!snapshot || !snapshot.ok) {
    return {
      issues: [],
      settled: [],
      hasCritical: false,
      unprotected: false,
      prompt:
        "## 上次动作的落地情况\n本轮**无法读取账户**（未配置凭据或接口失败），" +
        "因此没有核对上次动作。不要假设上次的挂单已成交或已撤销。\n",
    };
  }

  const positions = snapshot.positions;
  const orders = snapshot.orders;
  const openIds = new Set(orders.map((order) => order.orderId));

  // ── 1. 结算账本里还没结论的动作 ──
  for (const action of actions) {
    if (action.status !== "pending") continue;

    // 1a. 平仓：仓位真的没了吗（reduceOnly 可能被拒，也可能只成交一部分）
    if (action.kind === "close") {
      const left = positions.find((position) => position.side === action.side);
      if (!left) {
        settled.push({
          id: action.id,
          status: "filled",
          note: "仓位已清空",
          text: `**已平仓**：${describeAction(action)} → 当前无该方向持仓`,
        });
        continue;
      }
      issues.push({
        level: "critical",
        text:
          `**上次平仓没有完成**：${describeAction(action)}，但当前仍有 ` +
          `${left.side === "long" ? "多" : "空"} ${fmtQty(left.qty)} @ ${left.entryPrice}。` +
          `可能是 reduceOnly 被拒或只部分成交，先处理这笔持仓。`,
      });
      settled.push({
        id: action.id,
        status: "unknown",
        note: "仍持有该方向仓位",
        text: `**平仓未完成**：${describeAction(action)}（仓位仍在）`,
      });
      continue;
    }

    if (action.kind !== "open") continue;

    // 1b. 开仓挂单：还在挂单里 = 未成交
    const stillOpen = action.orderId ? openIds.has(action.orderId) : false;
    if (stillOpen) {
      settled.push({
        id: action.id,
        text: `**仍未成交**：${describeAction(action)}（订单 ${action.orderId ?? "?"}）`,
      });
      continue;
    }

    // 方向也要对得上：方向反了说明这是用户手动开的仓，不能算作「我们那单成交了」
    const matched = positions.find(
      (position) => position.side === action.side,
    );
    if (matched) {
      // 限价单允许部分成交：数量差得多时必须点明，否则模型会以为仓位就是计划的那么大
      const planned = action.qty ?? 0;
      const partial =
        planned > 0 && matched.qty < planned * 0.9;
      if (partial) {
        issues.push({
          level: "warn",
          text:
            `**上次开仓只部分成交**：计划 ${fmtQty(planned)}，实际 ${fmtQty(
              matched.qty,
            )}` + `。止损数量要与真实仓位对齐。`,
        });
      }
      settled.push({
        id: action.id,
        status: "filled",
        note: `已成交，持仓 ${fmtQty(matched.qty)} @ ${matched.entryPrice}`,
        text:
          `**已${partial ? "部分" : ""}成交**：${describeAction(action)} → 当前持仓 ` +
          `${matched.side === "long" ? "多" : "空"} ${fmtQty(matched.qty)} @ ${matched.entryPrice}`,
      });
      continue;
    }

    settled.push({
      id: action.id,
      status: "cancelled",
      note: "订单已不在挂单列表，且没有对应方向的持仓",
      text: `**已撤销或过期**：${describeAction(action)}（既不在挂单里，也没有对应持仓）`,
    });
  }

  // ── 2. 持仓是否有保护单 ──
  const protective = orders.filter(isProtectiveOrder);
  let unprotected = false;
  if (positions.length > 0 && protective.length === 0) {
    unprotected = true;
    issues.push({
      level: "critical",
      text:
        "**当前持仓没有任何止损/止盈单**（交易所侧没有保护单）。" +
        "先决定补挂止损还是平仓，再考虑开新仓。",
    });
  }

  // ── 3. 强平距离与保证金率 ──
  for (const position of positions) {
    const gap = liquidationGapPct(position);
    if (gap !== null && gap < LIQUIDATION_WARN_PCT) {
      issues.push({
        level: "critical",
        text:
          `**距强平仅 ${gap.toFixed(1)}%**：${position.symbol} 强平价 ` +
          `${position.liquidationPrice}，标记价 ${position.markPrice}。` +
          `应减仓或补保证金，不要在此状态下开新仓。`,
      });
    }
  }
  if (snapshot.marginRatio > MARGIN_RATIO_WARN) {
    issues.push({
      level: "critical",
      text:
        `**保证金率 ${snapshot.marginRatio.toFixed(1)}%**（维持保证金/保证金余额）` +
        `已接近强平，必须先降杠杆或减仓。`,
    });
  }

  // ── 4. 挂单堆积 ──
  if (orders.length > MAX_PENDING_ORDERS) {
    const notional = orders.reduce(
      (sum, order) => sum + (order.price > 0 ? order.price * order.qty : 0),
      0,
    );
    issues.push({
      level: "warn",
      text:
        `同时挂着 ${orders.length} 张单（合计名义约 ${notional.toFixed(0)}）` +
        `——若一起成交会变成超仓，建议先撤掉不打算执行的。`,
    });
  }

  // ── 5. 已有持仓时还挂着开仓单：成交即加仓 ──
  const pendingOpens = actions.filter(
    (action) => action.status === "pending" && action.kind === "open",
  );
  if (positions.length > 0 && pendingOpens.length > 0) {
    issues.push({
      level: "warn",
      text:
        "已有持仓，同时还有未成交的开仓单：一旦成交就是**加仓**，" +
        "确认这是有意的；否则撤掉。",
    });
  }

  // ── 组装给提示词的段落 ──
  const lines: string[] = ["## 上次动作的落地情况（本轮开始前由代码核对）"];
  if (settled.length > 0) {
    for (const item of settled) lines.push(`- ${item.text}`);
  } else if (actions.some((action) => action.status !== "pending")) {
    lines.push("- 账本里没有待结算的动作（上次的动作都已结算）。");
  } else {
    lines.push("- 还没有交易动作记录。");
  }

  if (issues.length > 0) {
    lines.push("", "## 需要优先处理的问题");
    for (const issue of issues) {
      const mark = issue.level === "critical" ? "⚠" : "·";
      lines.push(`- ${mark} ${issue.text}`);
    }
    lines.push(
      "",
      "**先处理上面的问题（补止损、减仓、撤单），再判断是否开新仓。**",
    );
  }

  return {
    issues,
    settled,
    hasCritical: issues.some((issue) => issue.level === "critical"),
    unprotected,
    prompt: lines.join("\n") + "\n",
  };
}

/** 标记价距强平价的百分比（无持仓或强平价无效时返回 null） */
export function liquidationGapPct(position: AccountPosition): number | null {
  if (!(position.liquidationPrice > 0) || !(position.markPrice > 0)) return null;
  return (
    (Math.abs(position.markPrice - position.liquidationPrice) /
      position.markPrice) *
    100
  );
}
