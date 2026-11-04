import { btcSetupNeeded, ensureBtcAssets } from "../btc/bootstrap";
import { ensureBtcBackend } from "../btc/daemon";
import { setupBtcEnv } from "../btc/setup";
import { ansi } from "../utils/ansi";
import { getBtcHome } from "../utils/paths";
import type { AgentMode } from "./types";

/** 模式名，同时是 `xzh btc` 的子命令名 */
export const BTC_MODE_NAME = "btc";

export interface BtcModeOptions {
  /**
   * 模拟盘变体（`xzh btc moni`）。
   *
   * 仍然是同一个模式（名字、目录、技能、工具集都不变），只是：
   * - 启动提示与提示词里标明「这是模拟盘，可以虚拟开平仓」；
   * - 常驻服务用 `paper` 角色（独立进程、独立账本），不会污染观察模式。
   */
  paper?: boolean;
}

/**
 * btc 专用模式。
 *
 * 每次调用都重新解析 home —— 这样 `XZH_BTC_HOME` 在进程启动后设置也能生效，
 * 测试里不必在 import 之前就把环境变量准备好。
 */
export function createBtcMode(options: BtcModeOptions = {}): AgentMode {
  const home = getBtcHome();
  const paper = options.paper === true;
  const role = paper ? "paper" : "live";

  const paperSection = paper
    ? `

- **当前是模拟盘（paper）**：可以用 \`btc_paper_open\` / \`btc_paper_close\` 在本地虚拟账本上开平仓，
  用 \`btc_paper_status\` 看权益与持仓。初始资金见 status，**不涉及真钱**。
  但纪律与实盘相同：开仓前说清方向、仓位、止损、依据；平仓后回报盈亏。
  绝不可以说成「实盘已成交」——它只是模拟撮合。`
    : "";

  return {
    name: BTC_MODE_NAME,
    label: paper ? "BTC 模拟盘" : "BTC 量化交易",
    home,
    cwdLocked: true,
    startupHint: paper
      ? `btc 模拟盘：工作目录固定为 ${home}（不可 /switch），` +
        `虚拟账本开平仓可用（btc_paper_*），不涉及真钱`
      : `btc 模式：工作目录固定为 ${home}（不可 /switch），` + `交易工具 btc_* 已启用`,
    // 启动时把计算脚本释放到 home：纯本地复制，毫秒级
    bootstrap: ensureBtcAssets,
    // 首次进入自动装环境：新手不该先读一段「请手动运行 setup」的提示。
    // 已就绪时只是一次 stat（标记文件），不会每次启动都起 python。
    autoSetup: async () => {
      if (!btcSetupNeeded(home)) return { ok: true, skipped: true };
      process.stdout.write(
        `${ansi.yellow}首次进入 btc 模式，正在准备计算环境（一次性，需联网）…${ansi.reset}\n`,
      );
      return setupBtcEnv();
    },
    // 常驻后端：行情巡检进程。界面退出后继续跑，下次进入复用同一个（不会重复启动）。
    // 模拟盘用独立角色，两个进程可以同时存在（原 btc 项目也是双后端）。
    ensureService: async () => {
      const backend = await ensureBtcBackend({ role });
      if (backend.running) {
        const next = backend.state?.nextCheckAt;
        return {
          ok: true,
          message:
            `${backend.started ? "已启动" : "复用"} btc ${paper ? "模拟盘" : "常驻"}后端（pid ${
              backend.state?.pid ?? "?"
            }）` +
            (next ? `，下次巡检 ${next}` : "") +
            `；停止用 xzh btc stop`,
        };
      }
      return {
        ok: false,
        message: `⚠ btc ${paper ? "模拟盘" : "常驻"}后端未启动：${
          backend.error ?? "未知原因"
        }`,
      };
    },
    promptSection: `## 当前模式：BTC ${paper ? "模拟盘" : "量化交易"}

本次运行由 \`xzh btc${paper ? " moni" : ""}\` 启动，是**专为 BTC ${
      paper ? "模拟交易" : "量化交易"
    }准备的常驻 agent**，请按交易场景而不是通用编码场景思考。

- 工作目录固定为 ${home}，**本次运行不可 \`/switch\`**。行情库、日志、计算脚本都在这里；
  要改路径只能退出重开，不要试图绕过。
- 交易相关能力用专用工具，不要自己拼 bash 去算：
  \`btc_status\`（环境与数据是否新鲜）→ \`btc_sync\`（增量同步 K 线）→
  \`btc_signal\`（三阶段买卖点）→ \`btc_backtest\`（全量回测，支持临时覆盖参数）
  → \`btc_schedule\` / \`btc_unschedule\`（安排与撤销后台巡检）→
  \`btc_policy\`（把用户的长期要求落盘，注入后台每一轮巡检）。
  技能范围也收窄到交易相关，先 \`list_skills\` 再 \`load_skill\`；列表里没有的领域就是本模式不支持的。
${
      paper
        ? "- 模拟盘的 \`btc_paper_open\` / \`btc_paper_close\` 不涉及真钱，但纪律相同：动仓前说清标的、\n  方向、仓位、止损、依据；成交后按工具返回值回报，不要说成「实盘已成交」。"
        : "- 本模式**尚未接入下单工具**：你的判断以方案形式给出（方向、仓位、止损、依据），\n  不得声称已下单或已成交；真要执行由用户手动完成，或在模拟盘（xzh btc moni）里验证。"
    }
- 买卖点必须走三阶段（周线定势 → 日线定向 → 小时线定时）。任一阶段是 \`wait\` / \`stand_aside\`
  就明确说不做，不要为「已经分析了」而勉强给方向；\`degraded=true\` 时必须说明「小时线未确认」。
- 用户提出的**长期要求**（风控阈值、周期偏好、禁止逆势等）必须用 \`btc_policy\` 落盘 ——
  后台巡检是独立进程，只在对话里答应一句「记住了」不会传过去。
- 价格、指标、余额、回测结果一律取自工具返回；拿不到数据就说拿不到，不凭记忆或估算。
- 回测与实盘的参数口径必须一致（手续费 0.05%、资金费 0.01%/8h、T 日收盘成交、无滑点），
  对比两次回测前先确认口径没变。${paperSection}`,
  };
}
