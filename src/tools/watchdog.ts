import type { ToolDefinition, ToolResult } from "./types";

const MIN_SECONDS = 30;
const MAX_SECONDS = 1_800;

function format(status: {
  active: boolean;
  timeoutSeconds: number;
  defaultSeconds: number;
  extended: boolean;
}): string {
  if (!status.active) return "看门狗未启用（非 TUI 会话，或配置已关闭）。";
  const head = status.extended
    ? `看门狗：临时放宽中，当前 ${status.timeoutSeconds}s（默认 ${status.defaultSeconds}s）`
    : `看门狗：${status.timeoutSeconds}s（默认 ${status.defaultSeconds}s）`;
  return (
    `${head}。\n` +
    "它只处理**同步阻塞**（事件循环停住）；模型慢、网络挂起、异步下载都不会触发。"
  );
}

/**
 * `watchdog` —— 模型自主调整同步卡死看门狗的运行时超时。
 *
 * 只给 `extend` / `restore`，**不提供关闭，也不写配置文件**：
 * 安全网可以被临时放宽（应对已知的长同步步骤），但不能被模型自己拆掉。
 * 放宽带租约，模型忘记 restore 时也会自动回到配置默认值。
 */
export const watchdogTool: ToolDefinition = {
  name: "watchdog",
  description:
    "同步卡死看门狗：status 查看，extend 临时放宽（30–1800s），restore 恢复默认；" +
    "不能关闭，重启后回到配置值。仅同步步骤需要，下载/长命令用 run_in_background。",
  smallProfile: true,
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["status", "extend", "restore"],
        description: "status=查看；extend=临时放宽（需 seconds）；restore=恢复默认",
      },
      seconds: {
        type: "integer",
        description: `extend 的目标秒数（${MIN_SECONDS}–${MAX_SECONDS}，只会上调，不会低于默认）`,
      },
    },
    required: ["action"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const control = ctx.watchdog;
    if (!control) {
      return {
        ok: false,
        content:
          "当前没有可用的看门狗（非 TUI 会话，或配置已关闭）：无法查看或调整。",
      };
    }

    const action = typeof args.action === "string" ? args.action : "";
    if (action === "status") {
      return { ok: true, content: format(control.status()) };
    }

    if (action === "restore") {
      const status = control.restore();
      return {
        ok: true,
        content: `已恢复默认超时 ${status.defaultSeconds}s。\n${format(status)}`,
      };
    }

    if (action === "extend") {
      const seconds =
        typeof args.seconds === "number" ? Math.floor(args.seconds) : NaN;
      if (!Number.isFinite(seconds)) {
        return {
          ok: false,
          content: `错误：extend 需要 seconds（${MIN_SECONDS}–${MAX_SECONDS} 秒）。`,
        };
      }
      if (seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
        return {
          ok: false,
          content: `错误：seconds 必须在 ${MIN_SECONDS}–${MAX_SECONDS} 之间；看门狗不能用它关闭。`,
        };
      }
      const status = control.extend(seconds);
      if (!status.extended) {
        return {
          ok: true,
          content: `默认超时 ${status.defaultSeconds}s 已经覆盖 ${seconds}s，无需放宽。`,
        };
      }
      ctx.emit?.(
        `看门狗临时放宽：${status.defaultSeconds}s → ${status.timeoutSeconds}s（完成后会自动恢复）`,
      );
      return {
        ok: true,
        content:
          `已临时放宽到 ${status.timeoutSeconds}s（默认 ${status.defaultSeconds}s，租约到期或 restore 后恢复）。\n` +
          "这只影响同步阻塞；下载 / 长命令请用 run_in_background，不要靠它硬扛。",
      };
    }

    return {
      ok: false,
      content: "错误：action 必须是 status / extend / restore。",
    };
  },
};
