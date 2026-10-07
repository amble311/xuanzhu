import type { ToolSpec } from "../llm/types";
import { bashTool } from "./bash";
import {
  editFileTool,
  globTool,
  grepTool,
  listDirTool,
  readFileTool,
  writeFileTool,
} from "./filesystem";
import { memoryReadTool, memoryWriteTool } from "./memory";
import { listSkillsTool, loadSkillTool } from "./skills";
import type { ToolContext, ToolDefinition, ToolResult } from "./types";

export * from "./types";

/** 玄猪内置工具集合 */
export const TOOLS: ToolDefinition[] = [
  listSkillsTool,
  loadSkillTool,
  memoryReadTool,
  memoryWriteTool,
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  writeFileTool,
  editFileTool,
  bashTool,
];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

/** 转换为 LLM 所需的工具声明 */
export function getToolSpecs(): ToolSpec[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
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
): Promise<ExecuteToolResult> {
  const tool = findTool(name);
  if (!tool) {
    return { ok: false, content: `错误：未知工具 "${name}"` };
  }

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
    return {
      ok: false,
      content: `工具执行异常：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
