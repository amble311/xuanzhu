/**
 * 顶部信息区的纯排列逻辑（无 ANSI、无 I/O，便于单测）。
 *
 * 顺序约定：
 *   品牌 → 目录 → 目标（可选）→ 快捷键提示 → 任务列表
 * 模型只显示在底部状态栏，顶部不重复。
 */
export interface HeaderBlocks {
  brand: string;
  directory: string;
  goal?: string | null;
  shortcuts: string[];
  todos: string[];
}

export function composeHeaderBlocks(blocks: HeaderBlocks): string[] {
  return [
    blocks.brand,
    blocks.directory,
    ...(blocks.goal ? [blocks.goal] : []),
    ...blocks.shortcuts,
    ...blocks.todos,
  ];
}
