import * as fs from "fs";
import * as path from "path";
import { getBuiltinSkillsDir, getUserSkillsDir } from "../utils/paths";
import { getDisabledSkillNames } from "./state";

/**
 * 玄猪技能系统。
 *
 * 技能 = 一个包含 `SKILL.md` 的目录，用于指导模型使用某个外部 CLI 工具
 * （如 playwright-cli、officecli、gh 等）。模型通过 `list_skills` 发现技能、
 * 用 `load_skill` 加载完整指南，再借助 `bash` 工具执行对应命令。
 *
 * 技能来源分两级（全局通用），优先级从高到低，同名时高优先级覆盖：
 *   1. 用户：~/.xzh/data/skills
 *   2. 内置：<安装目录>/skills（打包后为 dist/skills）
 */

export type SkillSource = "builtin" | "user";

export interface SkillInfo {
  name: string;
  description: string;
  /** 技能目录 */
  dir: string;
  /** SKILL.md 绝对路径 */
  file: string;
  source: SkillSource;
  /**
   * 归属的专用模式（`modes: [btc]`）；空数组 = 通用技能，所有模式可见。
   *
   * 语义（与 `discoverSkills` 一致）：
   * - 未声明 → 普通模式与所有专用模式都可见（这才是「通用」）；
   * - 声明了 → **只有**列出的模式可见，普通模式一律不可见。
   * 这样 btc 技能不会污染普通 xzh 的技能列表，普通技能也能在 btc 模式里继续用。
   */
  modes: string[];
}

const SKILL_FILENAME = "SKILL.md";
const MAX_SKILL_CHARS = 80_000;

interface Frontmatter {
  name?: string;
  description?: string;
  modes?: string[];
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "").trim();
}

/** 解析 SKILL.md 的 YAML frontmatter（仅提取 name 与 description） */
export function parseFrontmatter(content: string): {
  meta: Frontmatter;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { meta: {}, body: content };

  const raw = match[1];
  const body = content.slice(match[0].length);

  const nameLine = /^name:\s*(.+)$/m.exec(raw)?.[1];
  const name = nameLine ? stripQuotes(nameLine) : undefined;

  return {
    meta: { name, description: extractDescription(raw), modes: extractModes(raw) },
    body,
  };
}

/**
 * 解析 `modes` 字段，支持三种常见写法：
 *
 * ```yaml
 * modes: [btc]        # 行内数组
 * modes: btc          # 单个值
 * modes:              # YAML 列表
 *   - btc
 * ```
 *
 * 名字统一小写：`xzh btc` 的 `btc` 是命令名，写错大小写不该让技能凭空消失。
 */
function extractModes(raw: string): string[] {
  const normalize = (value: string) =>
    stripQuotes(value.trim()).toLowerCase();

  // 只吃行内空白（`\s` 会连换行一起吃掉，把块形式误判成单值 `- btc`）
  const inline = /^modes:[ \t]*(.+)$/m.exec(raw)?.[1]?.trim();
  if (inline) {
    return inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map(normalize)
      .filter(Boolean);
  }

  // 块形式：`modes:` 独占一行，后面是若干 `- btc`
  const block = /^modes:\s*\r?\n((?:[ \t]+-\s*\S.*\r?\n?)+)/m.exec(raw)?.[1];
  if (!block) return [];
  return block
    .split(/\r?\n/)
    .map((line) => normalize(line.replace(/^[ \t]*-\s*/, "")))
    .filter(Boolean);
}

/** 支持单行与 YAML 块（> / |）两种 description 写法 */
function extractDescription(raw: string): string {
  const inline = /^description:\s*(.*)$/m.exec(raw)?.[1]?.trim();
  if (inline && inline !== ">" && inline !== "|" && inline !== ">-" && inline !== "|-") {
    return stripQuotes(inline);
  }
  const block = /^description:\s*[>|]-?\s*\n((?:[ \t]+\S.*\n?)+)/m.exec(raw)?.[1];
  return block ? block.replace(/\s+/g, " ").trim() : "";
}

/** 查找技能定义文件，兼容 SKILL.md / skill.md 两种命名 */
function findSkillFile(dir: string): string | null {
  const primary = path.join(dir, SKILL_FILENAME);
  if (fs.existsSync(primary)) return primary;
  try {
    const match = fs
      .readdirSync(dir)
      .find((name) => name.toLowerCase() === SKILL_FILENAME.toLowerCase());
    return match ? path.join(dir, match) : null;
  } catch {
    return null;
  }
}

function scanDir(
  root: string,
  source: SkillSource,
  found: Map<string, SkillInfo>,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const file = findSkillFile(dir);
    if (!file) continue;

    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const { meta } = parseFrontmatter(content);
    const name = (meta.name || entry.name).trim();
    if (!name) continue;

    // 后扫描的来源覆盖同名技能（调用顺序即优先级）
    found.set(name, {
      name,
      description: meta.description ?? "",
      dir,
      file,
      source,
      modes: meta.modes ?? [],
    });
  }
}

export interface DiscoverSkillsOptions {
  /**
   * 是否包含**已禁用**的技能。
   *
   * 默认排除：`list_skills` / `load_skill` 面向模型，被禁用的技能应当不可见、不可加载。
   * 需要看全量（`xzh skill` 的列表、启用/删除操作）时显式传 `includeDisabled: true`。
   */
  includeDisabled?: boolean;
  /**
   * 当前专用模式名（如 `btc`）；缺省 = 普通模式。
   *
   * 过滤规则见 `SkillInfo.modes`：声明了 modes 的技能只在对应模式出现，
   * 普通模式下完全不可见 —— 这样 `xzh skill list` 之外的日常列表不会被交易技能塞满。
   */
  mode?: string;
  /**
   * 忽略模式限制，返回所有模式的技能。
   *
   * 只给 `xzh skill` 的管理命令用（列出 / 启用 / 删除）：用户在配置层面必须能看见
   * 全部技能，否则没法把某个 btc 技能禁用掉。模型侧永远不要传它。
   */
  includeAllModes?: boolean;
}

/** 发现全部可用技能（同名时用户技能覆盖内置技能；默认不含已禁用项） */
export function discoverSkills(
  options: DiscoverSkillsOptions = {},
): SkillInfo[] {
  const found = new Map<string, SkillInfo>();
  scanDir(getBuiltinSkillsDir(), "builtin", found);
  scanDir(getUserSkillsDir(), "user", found);
  let all = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));

  if (!options.includeAllModes) {
    const mode = options.mode?.trim().toLowerCase();
    all = all.filter((skill) => visibleInMode(skill, mode));
  }

  if (options.includeDisabled) return all;

  const disabled = new Set(
    getDisabledSkillNames().map((name) => name.toLowerCase()),
  );
  return all.filter((skill) => !disabled.has(skill.name.toLowerCase()));
}

/**
 * 技能是否在指定模式下可见。
 *
 * - 技能未声明 modes → 通用技能，任何模式（含普通模式）都可见；
 * - 技能声明了 modes → 只有在列出的模式里可见，**普通模式不可见**。
 */
function visibleInMode(skill: SkillInfo, mode?: string): boolean {
  if (skill.modes.length === 0) return true;
  if (!mode) return false;
  return skill.modes.includes(mode);
}

/** 按名称查找技能（大小写不敏感；默认不含已禁用项，见 discoverSkills） */
export function findSkill(
  name: string,
  options: DiscoverSkillsOptions = {},
): SkillInfo | undefined {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return undefined;
  return discoverSkills(options).find(
    (skill) => skill.name.toLowerCase() === normalized,
  );
}

/** 读取技能的完整指南内容 */
export function loadSkillContent(skill: SkillInfo): string {
  const content = fs.readFileSync(skill.file, "utf8");
  if (content.length <= MAX_SKILL_CHARS) return content;
  return `${content.slice(0, MAX_SKILL_CHARS)}\n\n…（技能内容过长，已截断）`;
}

export {
  getDisabledSkillNames,
  getSkillStatePath,
  isSkillDisabled,
  setSkillDisabled,
} from "./state";
