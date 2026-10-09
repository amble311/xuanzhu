import * as fs from "fs";
import * as path from "path";

/**
 * 项目级目录（对应 CodeBuddy 的 `.codebuddy`）。
 *
 *   <cwd>/.xuanzhu/
 *   ├── memory/              项目级记忆
 *   │   ├── MEMORY.md          长期记忆（持续维护）
 *   │   └── YYYY-MM-DD.md      每日记录（按天分存，追加）
 *   └── rules.md             项目规则（内容注入系统提示词）
 *
 * 位置约定（重要）：`.xuanzhu` **始终**位于用户当前指定的项目路径（cwd）之下，
 * **不做任何向上查找**。即在 /a/b/c 工作时只使用 /a/b/c/.xuanzhu ——
 * 即使 /a 或 /a/b 下已存在 .xuanzhu 也不复用；记忆与规则严格归属当前项目路径。
 * 没有则自动创建（见 ensureProjectDir）。
 *
 * 与全局目录的分工：
 *   - `~/.xzh`：**全局通用**内容，只有一份 —— config.json（模型配置）+ skills/。
 *   - `<项目>/.xuanzhu`：**随项目走**的内容 —— 按天分存的记录 + 项目长期记忆 + 规则。
 * 两者目录名不同、职责分离，技能与 CLI 一律不放进项目目录。
 */

export const PROJECT_DIR_NAME = ".xuanzhu";
const LONG_TERM_FILE = "MEMORY.md";

export interface ProjectPaths {
  /** 项目根目录（即传入的 cwd，.xuanzhu 就建在这一层） */
  root: string;
  /** <root>/.xuanzhu */
  dir: string;
  /** <root>/.xuanzhu/memory */
  memoryDir: string;
  /** <root>/.xuanzhu/memory/MEMORY.md */
  longTermFile: string;
  /** <root>/.xuanzhu/rules.md */
  rulesFile: string;
}

const RULES_TEMPLATE = `# 项目规则

> 本文件内容会作为「项目级指令」追加到玄猪的系统提示词中，用于约定本项目的
> 编码规范、目录结构、构建与测试命令等。留空或删除本文件即表示不使用项目规则。

## 约定（请按项目实际情况修改）

- 语言 / 框架：
- 包管理器：
- 安装依赖：
- 运行测试：
- 代码风格：
`;

/** 项目根目录下通用的项目说明文件（CodeBuddy / Claude Code / Cursor 等都读它） */
const AGENTS_FILE = "AGENTS.md";

/** 读取文本文件并 trim；不存在或全为空白时返回 null */
function readTextFile(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** 项目根存在 AGENTS.md 时，rules.md 写入的「引用式」内容 */
const RULES_FROM_AGENTS_HEADER = `# 项目规则

> 本文件内容会作为「项目级指令」追加到玄猪的系统提示词中。
> 留空或删除本文件即表示不使用项目规则。

## 必须遵守

本项目根目录下的 \`AGENTS.md\` 记录了本项目的完整约定（技术栈、常用命令、代码规范、
目录结构等）。**你必须严格按照 \`AGENTS.md\` 执行。**

在开始任何工作之前，先读取项目根目录的 \`AGENTS.md\`。若它在会话过程中被修改，
请重新读取以获取最新内容 —— 它始终是本项目约定的唯一来源。`;

/**
 * 生成 `.xuanzhu/rules.md` 的初始内容。
 *
 * 若项目根目录已有 `AGENTS.md`，**不复制它的内容**，而是写入一条
 * 「必须遵循 AGENTS.md」的指令。
 *
 * 之所以用引用而非复制：复制会形成**快照**，之后 `AGENTS.md` 的改动不会同步过来，
 * 模型会一直按旧规则工作，而且用户无从察觉。写成引用后，`AGENTS.md` 始终是
 * 唯一真实来源 —— 用户改完它，模型下次读取（它有 `read_file` 工具）即可看到最新内容。
 *
 * 没有 `AGENTS.md` 时用默认模板，引导用户在自己的 rules.md 里填写。
 */
function buildRulesTemplate(root: string): string {
  if (readTextFile(path.join(root, AGENTS_FILE)) === null) return RULES_TEMPLATE;
  return `${RULES_FROM_AGENTS_HEADER}\n`;
}

function buildPaths(root: string): ProjectPaths {
  const dir = path.join(root, PROJECT_DIR_NAME);
  const memoryDir = path.join(dir, "memory");
  return {
    root,
    dir,
    memoryDir,
    longTermFile: path.join(memoryDir, LONG_TERM_FILE),
    rulesFile: path.join(dir, "rules.md"),
  };
}

/**
 * 项目目录路径：**固定**为 cwd 下的 `.xuanzhu`，不做任何向上查找。
 * 目录本身可能尚未创建，由 ensureProjectDir() 负责建立。
 */
export function resolveProjectPaths(cwd: string): ProjectPaths {
  return buildPaths(path.resolve(cwd));
}

/** 确保项目目录存在（记忆目录 + 规则模板）；返回是否本次新建 */
export function ensureProjectDir(cwd: string): {
  paths: ProjectPaths;
  created: boolean;
} {
  const paths = resolveProjectPaths(cwd);
  if (fs.existsSync(paths.dir)) {
    fs.mkdirSync(paths.memoryDir, { recursive: true });
    // 目录已存在但规则文件缺失时补写（老版本建的目录、或用户手动删过），
    // 否则用户会以为「项目规则已启用」而实际没有这个文件。
    try {
      if (!fs.existsSync(paths.rulesFile)) {
        fs.writeFileSync(paths.rulesFile, buildRulesTemplate(paths.root), "utf8");
      }
    } catch {
      // 忽略：无写权限等情况下不影响启动
    }
    return { paths, created: false };
  }
  try {
    fs.mkdirSync(paths.memoryDir, { recursive: true });
    fs.writeFileSync(paths.rulesFile, buildRulesTemplate(paths.root), "utf8");
    return { paths, created: true };
  } catch {
    return { paths, created: false };
  }
}

/** 读取项目规则（不存在或为空时返回 null） */
export function loadProjectRules(cwd: string): string | null {
  return readTextFile(resolveProjectPaths(cwd).rulesFile);
}

/** 当日日志文件路径：<项目>/.xuanzhu/memory/YYYY-MM-DD.md */
export function dailyMemoryFile(cwd: string, date = new Date()): string {
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return path.join(resolveProjectPaths(cwd).memoryDir, `${stamp}.md`);
}

export interface ProjectMemory {
  /** 长期记忆（MEMORY.md）内容 */
  longTerm: string;
  /** 最近一次每日日志的文件名与内容 */
  recentDailyName: string;
  recentDaily: string;
}

/** 读取项目记忆：长期记忆 + 最近的每日日志 */
export function readProjectMemory(cwd: string): ProjectMemory {
  const paths = resolveProjectPaths(cwd);
  let longTerm = "";
  let recentDaily = "";
  let recentDailyName = "";

  try {
    if (fs.existsSync(paths.longTermFile)) {
      longTerm = fs.readFileSync(paths.longTermFile, "utf8").trim();
    }
  } catch {
    // 忽略
  }

  try {
    if (fs.existsSync(paths.memoryDir)) {
      const daily = fs
        .readdirSync(paths.memoryDir)
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
        .sort()
        .reverse();
      if (daily.length > 0) {
        recentDailyName = daily[0];
        recentDaily = fs
          .readFileSync(path.join(paths.memoryDir, daily[0]), "utf8")
          .trim();
      }
    }
  } catch {
    // 忽略
  }

  return { longTerm, recentDailyName, recentDaily };
}

export type MemoryScope = "long" | "daily";

/** 追加写入项目记忆，返回写入的文件路径 */
export function appendMemory(
  cwd: string,
  content: string,
  scope: MemoryScope,
): string {
  const paths = resolveProjectPaths(cwd);
  fs.mkdirSync(paths.memoryDir, { recursive: true });

  // 只取一次当前时间：文件名用本地日期，块内时间戳也必须用本地时间，
  // 否则 UTC+8 的 00:00–08:00 会出现「文件是 D 日、内容却是 D-1 日」；
  // 两次 new Date() 还会在午夜附近取到不同日期。
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const target =
    scope === "long" ? paths.longTermFile : dailyMemoryFile(cwd, now);
  const block = `\n\n## ${stamp}\n\n${content.trim()}\n`;

  // 用 append 完成「新建 + 追加」：早先是 existsSync 判定后分别 write/append，
  // 两个并发写入若都判定为「不存在」就会都用 writeFileSync 覆盖，先写者内容丢失。
  // append 最坏只会多写一次标题，不会丢数据。
  const header = fs.existsSync(target)
    ? ""
    : scope === "long"
      ? "# 项目长期记忆\n"
      : "# 每日记录\n";
  fs.appendFileSync(target, `${header}${block}`, "utf8");

  return target;
}

// ------------------------------------------------------------ 长期记忆精简

/**
 * 长期记忆（MEMORY.md）的默认字符上限。
 *
 * 超过该值时会触发**精简**：先去除正文完全相同的重复块，仍然超限则从最旧的块
 * 开始丢弃。之所以要设上限：记忆是**只追加**的，长期使用后会把 MEMORY.md 撑得
 * 很长，而它每次启动都会注入系统提示词（节选 1500 字符）—— 过长会让真正重要的
 * 结论被截断掉。取 6000 是「内容足够丰富」与「可被有效节选」之间的折中。
 */
export const DEFAULT_MEMORY_MAX_CHARS = 6_000;

export interface MemoryCompactResult {
  /** 精简前字符数 */
  before: number;
  /** 精简后字符数 */
  after: number;
  /** 被去除的重复块数量 */
  removedDuplicates: number;
  /** 因超出上限而被丢弃的最旧块数量 */
  removedOldest: number;
}

interface MemoryBlock {
  /** 块标题行（`## 时间戳`） */
  title: string;
  /** 块正文 */
  body: string;
}

/** 把长期记忆拆成「头部 + 若干 `## ` 块」 */
function splitMemoryBlocks(text: string): {
  header: string;
  blocks: MemoryBlock[];
} {
  const lines = text.split("\n");
  let firstBlock = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      firstBlock = i;
      break;
    }
  }
  if (firstBlock < 0) return { header: text.trim(), blocks: [] };

  const header = lines.slice(0, firstBlock).join("\n").trim();
  const blocks: MemoryBlock[] = [];
  let title = "";
  let body: string[] = [];
  const flush = () => {
    if (title) blocks.push({ title, body: body.join("\n").trim() });
  };
  for (let i = firstBlock; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      flush();
      title = line.trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return { header, blocks };
}

/** 拼回长期记忆文件内容 */
function assembleMemoryBlocks(header: string, blocks: MemoryBlock[]): string {
  const head = header || "# 项目长期记忆";
  if (blocks.length === 0) return `${head}\n`;
  const parts = blocks.map((block) => `${block.title}\n\n${block.body}`);
  return `${head}\n\n${parts.join("\n\n")}\n`;
}

/** 去重比较用的正文键：忽略空白差异 */
function blockKey(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

/**
 * 精简长期记忆：去重 + 超限时丢弃最旧的块，仅在确有变化时写盘。
 *
 * **只作用于长期记忆**，不碰每日日志：每日日志天然按天分存、总量有界，
 * 而长期记忆是无限追加的。
 *
 * 去重只认「正文完全相同」的块（模型重复记录同一结论很常见），不涉及语义判断；
 * 语义层面的合并由模型通过 `memory_compact` 工具完成。
 *
 * `maxChars <= 0` 表示**不限制长度**：此时只做去重（无损），不裁剪任何内容。
 */
export function compactLongTermMemory(
  cwd: string,
  maxChars = DEFAULT_MEMORY_MAX_CHARS,
): MemoryCompactResult | null {
  const paths = resolveProjectPaths(cwd);
  if (!fs.existsSync(paths.longTermFile)) return null;

  let original: string;
  try {
    original = fs.readFileSync(paths.longTermFile, "utf8");
  } catch {
    return null;
  }
  const before = original.trim().length;
  const { header, blocks } = splitMemoryBlocks(original);
  if (blocks.length === 0) {
    return { before, after: before, removedDuplicates: 0, removedOldest: 0 };
  }

  // 1. 去重：正文相同的块只保留最早出现的一次（时间戳也更早，位置稳定）
  const seen = new Set<string>();
  const kept: MemoryBlock[] = [];
  let removedDuplicates = 0;
  for (const block of blocks) {
    const key = blockKey(block.body);
    if (key && seen.has(key)) {
      removedDuplicates++;
      continue;
    }
    if (key) seen.add(key);
    kept.push(block);
  }

  // 2. 仍然超限时从最旧的块开始丢弃（最新的结论优先保留）。
  //    maxChars <= 0 = 不限制长度，跳过这一步、只保留上面的去重。
  //    下限 200 是防止误配置（如 1、10）把记忆裁得只剩标题。
  let removedOldest = 0;
  if (maxChars > 0) {
    const budget = Math.max(200, Math.floor(maxChars));
    if (assembleMemoryBlocks(header, kept).trim().length > budget) {
      let total = assembleMemoryBlocks(header, kept).trim().length;
      while (kept.length > 1 && total > budget) {
        const dropped = kept.shift()!;
        total -= dropped.title.length + dropped.body.length + 4;
        removedOldest++;
      }
    }
  }

  if (removedDuplicates === 0 && removedOldest === 0) {
    return { before, after: before, removedDuplicates: 0, removedOldest: 0 };
  }

  const compacted = assembleMemoryBlocks(header, kept);
  writeLongTermMemory(cwd, compacted);
  return {
    before,
    after: compacted.trim().length,
    removedDuplicates,
    removedOldest,
  };
}

/**
 * 「达到阈值就自动精简」的入口：未超过 `maxChars` 时**什么都不做**（返回 null）。
 *
 * 调用方（Agent 启动 / `/switch` 切换目录）不必自己判断大小，直接调用即可 ——
 * 精简是否发生、精简了多少，由返回值描述。
 *
 * `maxChars <= 0` 表示**不限制长度**：此时仍然会做无损的**去重**，
 * 但不会裁剪任何内容。
 */
export function compactLongTermMemoryIfNeeded(
  cwd: string,
  maxChars = DEFAULT_MEMORY_MAX_CHARS,
): MemoryCompactResult | null {
  const unlimited = !(maxChars > 0);
  const paths = resolveProjectPaths(cwd);
  let size: number;
  try {
    if (!fs.existsSync(paths.longTermFile)) return null;
    size = fs.readFileSync(paths.longTermFile, "utf8").trim().length;
  } catch {
    return null;
  }
  if (!unlimited && size <= maxChars) return null;
  return compactLongTermMemory(cwd, maxChars);
}

/** 覆盖写入长期记忆（原子写：先写临时文件再 rename，避免半截文件） */
export function writeLongTermMemory(cwd: string, content: string): string {
  const paths = resolveProjectPaths(cwd);
  fs.mkdirSync(paths.memoryDir, { recursive: true });
  const data = content.trim() ? `${content.trim()}\n` : "";
  const tmp = `${paths.longTermFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, paths.longTermFile);
  return paths.longTermFile;
}
