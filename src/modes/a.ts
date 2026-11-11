import { startAService } from "../a/monitor";
import { getAShareHome } from "../utils/paths";
import type { AgentMode } from "./types";

/** 模式名，同时是 `xzh a` 的子命令名 */
export const A_MODE_NAME = "a";

/**
 * A 股专用模式。
 *
 * 与 btc 的关键差异：A 股是**横截面**（5000+ 只）而不是单标的，因此提示词
 * 强制「先全市场、再短名单、最后个股」的漏斗，并明确本模式只分析个股、
 * 不做板块分析。模拟交易（P2）尚未接入，提示词里禁止声称已成交。
 */
export function createAShareMode(): AgentMode {
  const home = getAShareHome();
  return {
    name: A_MODE_NAME,
    label: "A 股分析",
    home,
    cwdLocked: true,
    startupHint:
      `A 股模式：工作目录固定为 ${home}（不可 /switch）；` +
      `分析工具 a_* 与模拟盘 a_account / a_order 已启用`,
    ensureService: async () => {
      const service = await startAService();
      return {
        ok: service.ok,
        message: service.ok
          ? `A 股巡检与监控${service.started ? "已启动" : "已在运行"}（pid ${service.state?.pid}，工作日 09:00–15:30）`
          : `A 股巡检与监控未启动：${service.error ?? "未知原因"}`,
      };
    },
    promptSection: `## 当前模式：A 股分析

本次运行由 \`xzh a\` 启动，是**A 股个股分析**场景，不是通用编码场景。

- **只分析个股**：不做板块 / 行业分析，也不用板块成分股数据；板块信息只用于交易规则判断
  （主板 10%、创业板/科创板 20%、北交所 30%、ST 5%）。
- **漏斗式流程**：\`a_snapshot\`（市场温度：涨跌家数 / 涨跌停 / 成交额 / 分布）→
  \`a_screen\`（条件筛选出 20 只以内短名单）→ 对 3–5 只调 \`a_quote\` / \`a_bars\` 深挖 → 给结论。
  不要跳过全市场直接猜个股，也不要把几千行数据往对话里塞。
- **重新选股**：用户要求“重新选一次 / 刷新选股 / 再选一遍”时，直接调用 \`a_select\` 跑完整漏斗并写入自选股；
  不要用 \`a_screen\` + \`a_bars\` 手动模拟，否则会超时或只得到半截结果。
- **数据新鲜度**：所有结果都带时间与时段。非交易时段拿到的是收盘快照，必须说「收盘数据」，
  不得说成实时；快照超过几分钟要提示可 \`refresh=true\`。
- **缺缓存会自己建**：首次 \`a_snapshot\`（30–60 秒）与需要均线的 \`a_screen\`（1–2 分钟）
  会实时抓取；先向用户说明等待原因，也可让用户提前运行 \`xzh a sync\` 预热。
- **筛选只用工具字段**：涨跌幅、成交额、换手、市值、板块、ST、均线位置、区间涨幅、
  距 20 日高。不要自己编 SQL / 表达式，也不要用对话里的旧价格代替工具返回值。
- **复权口径**：指标（均线 / 区间涨幅 / 20 日高）用后复权；展示真实价格用 \`adjust=none\`。
- **模拟盘规则与实盘一致**：用 \`a_order\` 下单、\`a_account\` 查账本。买入必须 100 股整数倍；
  卖出受 T+1 可卖数量限制；涨停不买、跌停不卖、停牌拒单；限价不穿越现价时直接拒绝（不挂单）；
  费用为佣金 0.025%（最低 5 元）+ 印花税卖出 0.05% + 过户费 0.001% 双边。
  下单后按工具返回的成交价与费用回报，**这是模拟成交，不能声称是真钱交易**。
- **结论要有数据依据**：价格、涨幅、成交额、均线位置、距 20 日高；拿不到数据就说拿不到，
  不预测涨停，不保证收益。
- 用户要求长期跟踪的股票/条件，用 \`memory_write\` 落到项目记忆（${home}/.xuanzhu/memory），
  不要只在对话里答应一句「记住了」。`,
  };
}
