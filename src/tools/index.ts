import type { JsonSchema, ToolSpec } from "../llm/types";
import { taskTool } from "./agent";
import { askUserTool } from "./ask";
import { bashTool } from "./bash";
import { bashJobTool } from "./job-tools";
import {
  editFileTool,
  globTool,
  grepTool,
  listDirTool,
  readFileTool,
  writeFileTool,
} from "./filesystem";
import { deviceTools } from "./device";
import { goalCompleteTool } from "./goal";
import { memoryTool } from "./memory";
import { reportStatusTool } from "./status";
import { codeNavTool } from "./repo-map";
import { listSkillsTool, loadSkillTool } from "./skills";
import { todoWriteTool } from "./todo";
import { watchdogTool } from "./watchdog";
import type { ToolContext, ToolDefinition, ToolResult } from "./types";
import { recordErrorReport } from "../utils/error-reports";
import { resolveProjectPaths } from "../workspace";

export * from "./types";

/**
 * 通用工具集合（普通模式 + 设备桥）。
 *
 * ⚠️ **不要**把 `btcTools` / `aShareTools` 加进来：它们带着整套 A 股 / 交易所业务层，
 * 加进来就等于让每个普通会话为几十个用不到的工具付内存。模式工具经
 * `AgentMode.tools` 注入，由 `Agent.allTools()` 在进入模式时才合并。
 */
export const TOOLS: ToolDefinition[] = [
  listSkillsTool,
  loadSkillTool,
  memoryTool,
  todoWriteTool,
  goalCompleteTool,
  reportStatusTool,
  askUserTool,
  taskTool,
  codeNavTool,
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  writeFileTool,
  editFileTool,
  bashTool,
  bashJobTool,
  watchdogTool,
  ...deviceTools,
];

/**
 * 工具是否在指定模式下可见。
 *
 * 与技能同一套语义：未声明 `modes` = 通用工具，所有模式可用；声明了则只在列出的
 * 模式出现，**普通模式不可见**。过滤点有两处（下发给模型的 schema、执行前的查找），
 * 只做前者的话，模型凭上下文里残留的名字仍能调用到本该不存在的工具。
 */
export function toolVisibleInMode(
  tool: ToolDefinition,
  mode?: string,
): boolean {
  if (!tool.modes || tool.modes.length === 0) return true;
  const normalized = mode?.trim().toLowerCase();
  if (!normalized) return false;
  return tool.modes.some((item) => item.toLowerCase() === normalized);
}

/**
 * 子代理**永不**可用的工具（无论白名单怎么写都会被过滤）。
 *
 * - `task`：否则子代理可以再派生子代理，形成无界递归；
 * - `todo_write`：任务列表属于主会话，子代理的任务不展示给用户，写上只会造成混乱；
 * - `goal_complete`：目标模式属于主会话 —— 子代理调用它既结束不了目标，
 *   还会让主代理误以为整体已完成；
 * - `report_status`：状态上报由界面消费，子代理上报没人看得见 ——
 *   它的受阻/不确定应写进结论文本，由主代理转述；
 * - `memory`（读 / 写 / 精简三合一）：记忆由主代理统一维护 —— 子代理只看得到一件
 *   子任务，不具备判断「什么值得跨会话保留」的全局视角，两边同时写还容易重复；
 * - `device_*`：手机只有一台，多个子代理并行推脚本会互相打断（一个跑起来就把上一个顶掉），
 *   而且设备操作属于「对外部真实环境施加影响」，应由主代理统一发起。
 *   将来若要"在手机上验证"的子代理，需要先在这里开例外 —— 那是有意的决定。
 * - `ask_user`：子代理没有自己的交互界面，提问只能回到主代理转述 ——
 *   它应当把需要用户决定的事写进结论，由主代理统一去问（避免并行子代理同时抢界面）。
 * - `bash_job`（查看 / 终止后台任务）：后台任务注册表只挂主代理 ——
 *   子代理结束后它的后台进程没有归属，还会跟主对话抢进程组。
 */
export const SUBAGENT_FORBIDDEN_TOOLS = new Set([
  "task",
  "todo_write",
  "goal_complete",
  "report_status",
  "ask_user",
  "bash_job",
  "memory",
  "watchdog",
  ...deviceTools.map((tool) => tool.name),
]);

export function findTool(
  name: string,
  tools: ToolDefinition[] = TOOLS,
): ToolDefinition | undefined {
  return tools.find((tool) => tool.name === name);
}

/**
 * 解析工具名（含旧名别名），返回规范工具与需要补的默认参数。
 *
 * 别名只用于**执行**：`getToolSpecs()` 仍然只下发规范名，因此合并工具不会
 * 增加每轮 schema 开销；旧会话里残留的 `memory_write(...)` 调用也不会失效。
 */
export function resolveTool(
  name: string,
  tools: ToolDefinition[] = TOOLS,
): { tool: ToolDefinition; defaultArgs: Record<string, unknown> } | undefined {
  const direct = tools.find((tool) => tool.name === name);
  if (direct) return { tool: direct, defaultArgs: {} };
  for (const tool of tools) {
    const alias = tool.aliases?.find((item) => item.name === name);
    if (alias) return { tool, defaultArgs: alias.args ?? {} };
  }
  return undefined;
}

/** 小窗口下压缩 schema 的选项（只在 small 档使用） */
export interface ToolSpecOptions {
  /** description 最多保留多少字符（不传 = 不截断） */
  maxDescriptionChars?: number;
  /** 参数 description 最多保留多少字符（不传 = 不截断） */
  maxParamDescriptionChars?: number;
}

/** 在句末 / 分号 / 换行处截断，避免把一句话切成半截 */
function clipSpecText(text: string, max?: number): string {
  if (!max || max <= 0 || text.length <= max) return text;
  const slice = text.slice(0, max);
  const stop = Math.max(
    slice.lastIndexOf("。"),
    slice.lastIndexOf("；"),
    slice.lastIndexOf("\n"),
  );
  return `${stop >= Math.floor(max * 0.5) ? slice.slice(0, stop + 1) : slice}…`;
}

function clipSchema(schema: JsonSchema, max: number): JsonSchema {
  const out: JsonSchema = { ...schema };
  if (typeof out.description === "string") {
    out.description = clipSpecText(out.description, max);
  }
  if (out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([key, value]) => [
        key,
        clipSchema(value, max),
      ]),
    );
  }
  if (out.items) out.items = clipSchema(out.items, max);
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const value = out[key];
    if (Array.isArray(value)) {
      out[key] = value.map((item) => clipSchema(item as JsonSchema, max));
    }
  }
  return out;
}

/**
 * 转换为 LLM 所需的工具声明。
 *
 * small 档会传入压缩选项：描述截到一句话、参数说明截到关键词级别。
 * 小模型本来就难以消化长描述，省下的 token 直接变成可用的对话预算。
 */
export function getToolSpecs(
  tools: ToolDefinition[] = TOOLS,
  options: ToolSpecOptions = {},
): ToolSpec[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: clipSpecText(tool.description, options.maxDescriptionChars),
    parameters: options.maxParamDescriptionChars
      ? clipSchema(tool.parameters, options.maxParamDescriptionChars)
      : tool.parameters,
  }));
}

/**
 * 子代理可用的工具集合：`allowedNames` 为子代理定义里的工具白名单
 * （见 `src/subagents`）。未传时表示「除禁用项外的全部工具」。
 */
export function toolsForSubAgent(allowedNames?: string[]): ToolDefinition[] {
  return TOOLS.filter((tool) => {
    if (SUBAGENT_FORBIDDEN_TOOLS.has(tool.name)) return false;
    if (!allowedNames) return true;
    return allowedNames.includes(tool.name);
  });
}

export interface ExecuteToolResult extends ToolResult {
  /** 是否因用户拒绝而未执行 */
  denied?: boolean;
}

/** 执行指定工具；参数为 JSON 字符串 */
export async function executeTool(
  name: string,
  argsJson: string,
  ctx: ToolContext,
  tools: ToolDefinition[] = TOOLS,
): Promise<ExecuteToolResult> {
  const resolved = resolveTool(name, tools);
  if (!resolved) {
    return { ok: false, content: `错误：未知工具 "${name}"` };
  }
  const tool = resolved.tool;

  let args: Record<string, unknown> = {};
  if (argsJson && argsJson.trim()) {
    try {
      const parsed = JSON.parse(argsJson);
      // 排除数组：否则 `[1,2]` 会被当成参数对象，所有属性取值都是 undefined
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch (err) {
      return {
        ok: false,
        content: `错误：工具参数不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  // 旧名别名补默认参数（如 memory_write → memory 且 action=write）。
  // 显式传入的参数优先，避免别名把模型给的值覆盖掉。
  args = { ...resolved.defaultArgs, ...args };

  // 参数校验：未知参数与缺失的必填参数都直接报错。
  // 否则「参数名写错」会被静默忽略并按默认值执行——例如把 list_dir 的 path 写成
  // dirPath 时会悄悄列出当前目录，让调用方误以为列的是目标目录。
  const schema = tool.parameters as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const properties = schema.properties ?? {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  const unknown = Object.keys(args).filter((key) => !(key in properties));
  if (unknown.length > 0) {
    const available = Object.keys(properties);
    return {
      ok: false,
      content:
        `错误：${name} 收到未知参数 ${unknown.map((k) => `"${k}"`).join("、")}。` +
        `可用参数：${available.length > 0 ? available.map((k) => `"${k}"`).join("、") : "（无）"}`,
    };
  }

  const missing = required.filter(
    (key) => args[key] === undefined || args[key] === null,
  );
  if (missing.length > 0) {
    return {
      ok: false,
      content: `错误：${name} 缺少必填参数 ${missing.map((k) => `"${k}"`).join("、")}。`,
    };
  }

  try {
    return await tool.execute(args, ctx);
  } catch (err) {
    // 工具内部**抛异常**说明实现有问题（可预期的失败应当返回 ok:false），
    // 因此这里落一份错误报告；返回值仍是正常的失败结果，不影响对话继续。
    recordErrorReport({
      kind: "tool-error",
      category: "bug",
      error: err,
      tool: name,
      cwd: ctx.cwd,
      project: resolveProjectPaths(ctx.cwd).dir,
    });
    return {
      ok: false,
      content: `工具执行异常：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
