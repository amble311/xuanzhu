export * from "./types";

import { codeExplorer } from "./code-explorer";
import type { SubAgentDefinition } from "./types";

/**
 * 子代理注册表。
 *
 * **新增子代理**：实现 `SubAgentDefinition` 后加进这个数组即可 ——
 * `task` 工具的参数枚举、可用工具白名单与系统提示词都会自动跟随。
 */
export const SUBAGENTS: SubAgentDefinition[] = [codeExplorer];

/** 未指定 `subagent_name` 时使用的子代理 */
export const DEFAULT_SUBAGENT_NAME = SUBAGENTS[0].name;

/** 全部子代理名称（用于工具参数枚举与错误提示） */
export function subAgentNames(): string[] {
  return SUBAGENTS.map((agent) => agent.name);
}

/** 按名称查找子代理；名称为空时返回默认子代理 */
export function findSubAgent(name?: string): SubAgentDefinition | undefined {
  const key = name?.trim();
  if (!key) return SUBAGENTS.find((agent) => agent.name === DEFAULT_SUBAGENT_NAME);
  return SUBAGENTS.find((agent) => agent.name === key);
}
