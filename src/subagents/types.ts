/** 构造子代理系统提示词时可用到的上下文 */
export interface SubAgentContext {
  /** 当前工作目录 */
  cwd: string;
  /** 子任务的一句话说明 */
  description: string;
  /** 主代理写下的完整任务描述 */
  prompt: string;
}

/**
 * 子代理定义。
 *
 * 新增一个子代理只需要：
 *   1. 在 `src/subagents/` 下新建一个文件并导出 `SubAgentDefinition`；
 *   2. 把它加进 `src/subagents/index.ts` 的 `SUBAGENTS` 数组。
 * 主代理侧的 `task` 工具（参数 `subagent_name`）、可用工具白名单与系统提示词
 * 都会自动按注册表生效，无需改动别处。
 *
 * 约定：子代理**永不**获得 `task`（防无界递归）、`todo_write` 与
 * `memory_write` / `memory_compact`（任务列表与记忆归属主会话），
 * 因此这里即使写进白名单也会被过滤掉。
 */
export interface SubAgentDefinition {
  /** 唯一名称，主代理通过 `task(subagent_name=<name>)` 指定 */
  name: string;
  /** 给**主代理**看的说明：什么时候该派它出去（会拼进 `task` 工具的描述） */
  description: string;
  /** 允许使用的工具名白名单 */
  toolNames: string[];
  /** 子代理的系统提示词 */
  systemPrompt(ctx: SubAgentContext): string;
}
