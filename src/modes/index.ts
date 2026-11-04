import * as fs from "fs";
import * as path from "path";
import { createBtcMode } from "./btc";
import type { AgentMode } from "./types";

/**
 * 模式注册表。
 *
 * 新增模式（例如 `xzh note`、`xzh trade`）= 在 `MODES` 里加一个构造函数 +
 * `src/cli/index.ts` 加一个 case。技能只需在 SKILL.md 的 frontmatter 里写
 * `modes: [名字]` 就会自动归属，不用改技能发现逻辑。
 */
export type { AgentMode } from "./types";
export { BTC_MODE_NAME, createBtcMode } from "./btc";
// home 的解析在 utils/paths（btc 的资产与工具也用它，放这里会形成循环依赖）
export { getBtcHome } from "../utils/paths";

/** 全部已注册的模式（顺序即 help 里的展示顺序） */
export function allModes(): AgentMode[] {
  return [createBtcMode()];
}

/** 按名字查找模式（大小写不敏感）；未注册返回 undefined */
export function findMode(name: string | undefined): AgentMode | undefined {
  const normalized = name?.trim().toLowerCase();
  if (!normalized) return undefined;
  return allModes().find((mode) => mode.name.toLowerCase() === normalized);
}

/**
 * 按目录反查模式：`xzh ~/.btc` 与 `xzh btc` 应该进入同一个模式。
 *
 * 用 realpath 比较，因为用户可能通过软链接（`~/.btc -> /data/btc`）进入；
 * 任一侧解析失败就退化为 `path.resolve` 比较，不能因为权限问题把模式丢给普通流程。
 */
export function modeForHome(dir: string): AgentMode | undefined {
  const target = normalize(dir);
  if (!target) return undefined;
  return allModes().find((mode) => normalize(mode.home) === target);
}

function normalize(dir: string): string | null {
  if (!dir) return null;
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}
