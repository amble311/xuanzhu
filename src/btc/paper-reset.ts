import { getBtcHome } from "../utils/paths";
import { appendMemory } from "../workspace";
import { runRunner } from "./python";

/**
 * 模拟盘重置（`/reset moni` 与 `btc_paper_reset` 共用）。
 *
 * 为什么要单独一层：
 * - 重置是**破坏性操作**，之后所有绩效从零开始，但下一轮对话里模型只会看到
 *   「钱回到 10 万」—— 不知道是用户重置的、还是数据丢了。
 *   所以重置成功后必须把**重置前的状态**写进项目记忆（`~/.xzh_btc/.xuanzhu/memory`）。
 * - TUI 命令与模型工具走同一条路径，避免两边行为不一致（例如工具重置了却不留痕）。
 *
 * 记忆写失败**不让重置失败**：钱已经回去了，此时报错只会让用户以为没重置成功。
 */

export interface ClearedPaperSummary {
  /** 已平仓笔数 */
  trades: number;
  wins: number;
  win_rate: number;
  realized_pnl: number;
  fees_paid: number;
  /** 被清掉的未成交挂单数 */
  open_orders: number;
  position: { side: string; qty: number; entry_price: number } | null;
  cash_before: number;
  initial_capital_before: number | null;
}

export interface PaperResetData {
  reset: boolean;
  capital: number;
  cleared: ClearedPaperSummary;
  /** 重置时间（UTC ISO，来自计算层） */
  at: string;
}

export type PaperResetSource = "command" | "tool";

function money(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${money(value)}`;
}

/**
 * 生成写进记忆的一段话（纯函数，便于单测）。
 *
 * 写法要求：**带上被清掉的东西**（笔数/盈亏/持仓/挂单）与**谁重置的**。
 * 只写「已重置」等于没写 —— 下次对话里模型仍然不知道之前发生过什么。
 */
export function formatResetMemory(
  data: PaperResetData,
  source: PaperResetSource,
): string {
  const cleared = data.cleared;
  const who =
    source === "command"
      ? "用户执行 `/reset moni`"
      : "模型调用 `btc_paper_reset`";

  const trades =
    cleared.trades > 0
      ? `${cleared.trades} 笔已平仓成交（胜率 ${money(cleared.win_rate)}%，` +
        `实现盈亏 ${signed(cleared.realized_pnl)}，手续费 ${money(cleared.fees_paid)}）`
      : "0 笔已平仓成交（此前没有平仓记录）";
  const pending =
    cleared.open_orders > 0 ? `${cleared.open_orders} 张未成交挂单` : "无未成交挂单";
  const position = cleared.position
    ? `持仓 ${cleared.position.side === "long" ? "多" : "空"} ` +
      `${cleared.position.qty} @ ${money(cleared.position.entry_price)}`
    : "无持仓";
  const capitalBefore =
    cleared.initial_capital_before === null
      ? ""
      : `初始资金 ${money(cleared.initial_capital_before)} → `;

  return (
    `- 模拟盘账本被重置（${who}）：清空 ${trades}、${pending}、${position}；` +
    `现金 ${money(cleared.cash_before)} → ${money(data.capital)}，` +
    `${capitalBefore}${money(data.capital)}。\n` +
    "  此前所有模拟操作与绩效不再可查，后续统计从零开始。"
  );
}

export type PaperResetResult =
  | {
      ok: true;
      data: PaperResetData;
      /** 记忆写入路径；写失败时为 undefined */
      memoryFile?: string;
      /** 记忆写失败的提示（重置本身已成功） */
      memoryWarning?: string;
    }
  | { ok: false; error: string; detail?: string };

export interface PaperResetOptions {
  home?: string;
  /** 新的初始资金；不传由计算层回落 `BTC_PAPER_CAPITAL` 或 100000 */
  capital?: number;
  source: PaperResetSource;
}

export async function resetPaperLedger(
  options: PaperResetOptions,
): Promise<PaperResetResult> {
  const home = options.home ?? getBtcHome();
  const payload =
    options.capital === undefined ? {} : { capital: options.capital };

  const result = await runRunner<PaperResetData>("paper-reset", payload, { home });
  if (!result.ok) {
    return { ok: false, error: result.error, detail: result.detail };
  }

  try {
    const memoryFile = appendMemory(
      home,
      formatResetMemory(result.data, options.source),
      "daily",
    );
    return { ok: true, data: result.data, memoryFile };
  } catch (err) {
    return {
      ok: true,
      data: result.data,
      memoryWarning: `重置已完成，但写记忆失败：${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
