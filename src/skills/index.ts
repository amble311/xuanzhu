import * as fs from "fs";
import * as path from "path";
import { getBuiltinSkillsDir, getUserSkillsDir } from "../utils/paths";

/**
 * 玄猪技能系统。
 *
 * 技能 = 一个包含 `SKILL.md` 的目录，用于指导模型使用某个外部 CLI 工具
 * （如 playwright-cli、officecli、gh 等）。模型通过 `list_skills` 发现技能、
 * 用 `load_skill` 加载完整指南，再借助 `bash` 工具执行对应命令。
 *
 * 技能来源分两级（全局通用），优先级从高到低，同名时高优先级覆盖：
 *   1. 用户：~/.xzh/skills
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
}

const SKILL_FILENAME = "SKILL.md";
const MAX_SKILL_CHARS = 80_000;

interface Frontmatter {
  name?: string;
  description?: string;
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

  return { meta: { name, description: extractDescription(raw) }, body };
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
    });
  }
}

/** 发现全部可用技能（同名时用户技能覆盖内置技能） */
export function discoverSkills(): SkillInfo[] {
  const found = new Map<string, SkillInfo>();
  scanDir(getBuiltinSkillsDir(), "builtin", found);
  scanDir(getUserSkillsDir(), "user", found);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 按名称查找技能（大小写不敏感） */
export function findSkill(name: string): SkillInfo | undefined {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return undefined;
  return discoverSkills().find(
    (skill) => skill.name.toLowerCase() === normalized,
  );
}

/** 读取技能的完整指南内容 */
export function loadSkillContent(skill: SkillInfo): string {
  const content = fs.readFileSync(skill.file, "utf8");
  if (content.length <= MAX_SKILL_CHARS) return content;
  return `${content.slice(0, MAX_SKILL_CHARS)}\n\n…（技能内容过长，已截断）`;
}
