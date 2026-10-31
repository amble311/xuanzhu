import * as fs from "fs";
import * as path from "path";
import { getConfigDir } from "../utils/paths";
import { pruneAutoMemory } from "./memory-retrieval";

export {
  globalMemoryIndex,
  selectRelevantGlobalMemory,
  splitMemorySections,
} from "./memory-retrieval";

/**
 * 项目级目录（对应 CodeBuddy 的 `.codebuddy`）。
 *
 *   <cwd>/.xuanzhu/
 *   ├── memory/              项目级记忆
 *   │   ├── MEMORY.md          长期记忆（按主题整理的结论库，持续维护）
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

/**
 * 记忆存储位置。
 *
 * 项目记忆与全局记忆的读写逻辑完全相同（长期记忆 + 每日日志 + 精简 + 清空），
 * 区别只有目录与标题；抽成这个结构后，两套记忆不会再出现「项目修了、全局忘了」。
 */
export interface MemoryPaths {
  /** 记忆目录 */
  memoryDir: string;
  /** MEMORY.md */
  longTermFile: string;
  /** 新建长期记忆时写进文首的标题 */
  longTermTitle: string;
  /** 新建每日日志时写进文首的标题 */
  dailyTitle: string;
}

/** 全局记忆：~/.xzh/memory/（跨项目，随 XZH_HOME 重定向） */
export function resolveGlobalMemoryPaths(): MemoryPaths {
  const memoryDir = path.join(getConfigDir(), "memory");
  return {
    memoryDir,
    longTermFile: path.join(memoryDir, LONG_TERM_FILE),
    longTermTitle: "全局长期记忆",
    dailyTitle: "全局每日记录",
  };
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

/** 项目记忆路径（供记忆工具按 target 选择） */
export function resolveProjectMemoryPaths(cwd: string): MemoryPaths {
  return projectMemoryPaths(cwd);
}

/** 项目记忆路径（有 rulesFile 等额外字段，读取时只用记忆字段） */
function projectMemoryPaths(cwd: string): MemoryPaths {
  const paths = resolveProjectPaths(cwd);
  return {
    memoryDir: paths.memoryDir,
    longTermFile: paths.longTermFile,
    longTermTitle: "项目长期记忆",
    dailyTitle: "每日记录",
  };
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

/** 当日日志文件路径（项目或全局记忆目录下） */
export function dailyMemoryFileAt(paths: MemoryPaths, date = new Date()): string {
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return path.join(paths.memoryDir, `${stamp}.md`);
}

/** 当日日志文件路径：<项目>/.xuanzhu/memory/YYYY-MM-DD.md */
export function dailyMemoryFile(cwd: string, date = new Date()): string {
  return dailyMemoryFileAt(projectMemoryPaths(cwd), date);
}

export interface ProjectMemory {
  /** 长期记忆（MEMORY.md）内容 */
  longTerm: string;
  /** 最近一次每日日志的文件名与内容 */
  recentDailyName: string;
  recentDaily: string;
}

/** 读取任意记忆目录：长期记忆 + 最近的每日日志 */
export function readMemoryAt(paths: MemoryPaths): ProjectMemory {
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

/** 读取项目记忆：长期记忆 + 最近的每日日志 */
export function readProjectMemory(cwd: string): ProjectMemory {
  return readMemoryAt(projectMemoryPaths(cwd));
}

/** 读取全局记忆：~/.xzh/memory/MEMORY.md + 最近一份日志 */
export function readGlobalMemory(): ProjectMemory {
  return readMemoryAt(resolveGlobalMemoryPaths());
}

export type MemoryScope = "long" | "daily";

/** 追加写入任意记忆目录，返回写入的文件路径 */
export function appendMemoryAt(
  paths: MemoryPaths,
  content: string,
  scope: MemoryScope,
): string {
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
    scope === "long" ? paths.longTermFile : dailyMemoryFileAt(paths, now);
  const block = `\n\n## ${stamp}\n\n${content.trim()}\n`;

  // 用 append 完成「新建 + 追加」：早先是 existsSync 判定后分别 write/append，
  // 两个并发写入若都判定为「不存在」就会都用 writeFileSync 覆盖，先写者内容丢失。
  // append 最坏只会多写一次标题，不会丢数据。
  const header = fs.existsSync(target)
    ? ""
    : scope === "long"
      ? `# ${paths.longTermTitle}\n`
      : `# ${paths.dailyTitle}\n`;
  fs.appendFileSync(target, `${header}${block}`, "utf8");

  return target;
}

/** 追加写入项目记忆，返回写入的文件路径 */
export function appendMemory(
  cwd: string,
  content: string,
  scope: MemoryScope,
): string {
  return appendMemoryAt(projectMemoryPaths(cwd), content, scope);
}

// ------------------------------------------------------------ 自动记录（按主题）

export interface TopicMemoryEntryResult {
  file: string;
  /** 实际使用的主题名 */
  topic: string;
  /** 是否真的写入了（重复 / 超限 / 空内容时为 false） */
  added: boolean;
  /** 写入后触发的自动精简结果（未触发为 null） */
  compacted: MemoryCompactResult | null;
}

/**
 * 把一条自动摘要**按主题**并入长期记忆。
 *
 * 为什么不用 `appendMemory(scope="long")`：那会写成 `## 时间戳` 的追加块，
 * 与「长期记忆是按主题整理的结论库」相反，越用越乱；`compactLongTermMemory`
 * 也只把时间戳块当成可丢弃的旧记录。这里改为：
 *
 * - 找到 `## 自动记录 · <topic>` 小节，把条目插到该小节末尾；
 * - 没有该小节才新建；
 * - 完全相同的条目行不重复写；
 * - 写入前按 `memoryMaxChars` 预判，超限就跳过（自动摘要不能把长期记忆顶爆，
 *   语义压缩仍交给模型的 `memory_compact`）。
 */
export function appendLongTermTopicEntryAt(
  paths: MemoryPaths,
  topic: string,
  entry: string,
  maxChars = DEFAULT_MEMORY_MAX_CHARS,
): TopicMemoryEntryResult {
  fs.mkdirSync(paths.memoryDir, { recursive: true });

  const cleanTopic =
    topic.replace(/\s+/g, " ").replace(/^#+/, "").trim().slice(0, 60) || "项目";
  const cleanEntry = entry.trim();
  const heading = `## 自动记录 · ${cleanTopic}`;
  const base = {
    file: paths.longTermFile,
    topic: cleanTopic,
    compacted: null as MemoryCompactResult | null,
  };

  if (!cleanEntry) return { ...base, added: false };

  let text = "";
  try {
    text = fs.readFileSync(paths.longTermFile, "utf8");
  } catch {
    // 不存在：下面按新文件处理
  }
  if (!text.trim()) text = `# ${paths.longTermTitle}\n`;

  // 完全相同的条目行不重复写（同一天重复运行、重试都可能产生相同摘要）
  if (text.split("\n").some((line) => line.trim() === cleanEntry)) {
    return { ...base, added: false };
  }

  // 预判上限：自动摘要只做增量，不能把长期记忆顶到需要模型语义压缩的程度
  if (maxChars > 0 && text.trim().length + cleanEntry.length + heading.length + 8 > maxChars) {
    return { ...base, added: false };
  }

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === heading);

  if (headingIndex >= 0) {
    // 插到该小节末尾（下一个 ## 之前），跳过末尾空行
    let end = lines.length;
    for (let i = headingIndex + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) {
        end = i;
        break;
      }
    }
    let insertAt = end;
    while (insertAt > headingIndex + 1 && lines[insertAt - 1].trim() === "") {
      insertAt -= 1;
    }
    lines.splice(insertAt, 0, cleanEntry);
  } else {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", heading, "", cleanEntry, "");
  }

  const next = `${lines.join("\n").trimEnd()}\n`;
  const tmp = `${paths.longTermFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, next, "utf8");
  fs.renameSync(tmp, paths.longTermFile);

  const compacted = compactLongTermMemoryIfNeededAt(paths, maxChars);
  return { ...base, added: true, compacted };
}

export function appendLongTermTopicEntry(
  cwd: string,
  topic: string,
  entry: string,
  maxChars = DEFAULT_MEMORY_MAX_CHARS,
): TopicMemoryEntryResult {
  return appendLongTermTopicEntryAt(
    projectMemoryPaths(cwd),
    topic,
    entry,
    maxChars,
  );
}

// ------------------------------------------------------------ 长期记忆精简

/**
 * 长期记忆（MEMORY.md）的默认字符上限。
 *
 * 超过该值时会触发**精简**：先去除正文完全相同的重复块，仍然超限则从最旧的
 * **追加块**（`## 时间戳`）开始丢弃；按主题整理的稳定小节不动（见 `compactLongTermMemory`）。
 * 之所以要设上限：长期记忆每次启动都会注入系统提示词（节选 1500 字符），
 * 过长会让真正重要的结论被截断掉。取 12000 是「按主题整理的结论库能放下一个中型项目的
 * 事实与口径」与「可被有效节选」之间的折中（早期是 6000，主题化之后偏紧：刚一整理好
 * 就触发语义压缩，等于白整理一遍）。
 */
export const DEFAULT_MEMORY_MAX_CHARS = 12_000;

/**
 * 全局长期记忆的字符上限。
 *
 * 比项目记忆更小：全局记忆每次启动都会注入所有项目的提示词，必须短到
 * 「一眼能看完」；4000 字符足够放跨项目偏好、环境事实、代理地址与常用命令。
 */
export const DEFAULT_GLOBAL_MEMORY_MAX_CHARS = 4_000;

export interface MemoryCompactResult {
  /** 精简前字符数 */
  before: number;
  /** 精简后字符数 */
  after: number;
  /** 被去除的重复块数量 */
  removedDuplicates: number;
  /** 因超出上限而被丢弃的最旧「追加块」数量 */
  removedOldest: number;
}

interface MemoryBlock {
  /** 块标题行：`## 时间戳`（memory_write 追加的流水块）或 `## 主题`（整理后的小节） */
  title: string;
  /** 块正文 */
  body: string;
}

/**
 * 是否为 `memory_write`（scope=long）追加出来的流水块。
 *
 * 只有这类块的先后顺序带有「越早越可能过时」的含义，超限时可以自动裁剪；
 * `## 环境与部署` 这类主题小节的顺序是**重要性排序**，自动删掉等于静默抹掉项目事实，
 * 只能由模型在 `memory_compact` 时判断去留。
 */
function isAppendedBlock(title: string): boolean {
  return /^##\s+\d{4}-\d{2}-\d{2}(\s+\d{2}:\d{2})?\s*$/.test(title);
}

/** 最后一块追加块的下标（没有追加块时返回 -1）—— 它永不参与自动裁剪 */
function findLastAppendedIndex(blocks: MemoryBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (isAppendedBlock(blocks[i].title)) return i;
  }
  return -1;
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
 * 精简长期记忆：去重 + 超限时丢弃最旧的**追加块**，仅在确有变化时写盘。
 *
 * **只作用于长期记忆**，不碰每日日志：每日日志天然按天分存、总量有界，
 * 而长期记忆是无限追加的。
 *
 * 去重只认「正文完全相同」的块（模型重复记录同一结论很常见），不涉及语义判断；
 * 语义层面的合并由模型通过 `memory_compact` 工具完成。
 *
 * 裁剪**只删 `## 时间戳` 追加块**，且**永远保留最后一块追加块**：长期记忆的正确
 * 形态是「文首维护说明 + 按主题整理的稳定小节」，主题小节的顺序是重要性而非时间，
 * 自动删掉等于静默抹掉项目事实；而最新那块追加块往往是刚写进来、还没被并进主题的
 * 结论，被自己的自动精简吃掉最难排查。若剩下的内容仍超限，这里就停下，改由
 * `memory_write` 的返回与系统提示词的 ⚠ 段落要求模型用 `memory_compact` 做语义压缩。
 *
 * `maxChars <= 0` 表示**不限制长度**：此时只做去重（无损），不裁剪任何内容。
 */
export function compactLongTermMemoryAt(
  paths: MemoryPaths,
  maxChars = DEFAULT_MEMORY_MAX_CHARS,
): MemoryCompactResult | null {
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

  // 2. 仍然超限时从最旧的**追加块**开始丢弃（最新的结论优先保留）。
  //    主题小节（`## 环境与部署` 之类）不参与自动裁剪，**最新的追加块也永不丢**
  //    （刚写进 `memory_write` 的结论被自己的自动精简吃掉最难排查）—— 见函数注释。
  //    maxChars <= 0 = 不限制长度，跳过这一步、只保留上面的去重。
  //    下限 200 是防止误配置（如 1、10）把记忆裁得只剩标题。
  let removedOldest = 0;
  if (maxChars > 0) {
    const budget = Math.max(200, Math.floor(maxChars));
    let total = assembleMemoryBlocks(header, kept).trim().length;
    while (total > budget) {
      // 找「可丢的」追加块：跳过主题小节，也跳过**最后一块**追加块
      // （每轮重新定位：上一轮删除后下标会整体前移）
      const lastAppended = findLastAppendedIndex(kept);
      const index = kept.findIndex(
        (block, i) => isAppendedBlock(block.title) && i !== lastAppended,
      );
      if (index < 0) break; // 只剩主题小节 + 最新追加块 → 交给语义层（memory_compact）
      const dropped = kept.splice(index, 1)[0];
      total -= dropped.title.length + dropped.body.length + 4;
      removedOldest++;
    }
  }

  if (removedDuplicates === 0 && removedOldest === 0) {
    return { before, after: before, removedDuplicates: 0, removedOldest: 0 };
  }

  const compacted = assembleMemoryBlocks(header, kept);
  writeLongTermMemoryAt(paths, compacted);
  return {
    before,
    after: compacted.trim().length,
    removedDuplicates,
    removedOldest,
  };
}

export function compactLongTermMemory(
  cwd: string,
  maxChars = DEFAULT_MEMORY_MAX_CHARS,
): MemoryCompactResult | null {
  return compactLongTermMemoryAt(projectMemoryPaths(cwd), maxChars);
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
export function compactLongTermMemoryIfNeededAt(
  paths: MemoryPaths,
  maxChars = DEFAULT_MEMORY_MAX_CHARS,
): MemoryCompactResult | null {
  const unlimited = !(maxChars > 0);
  let size: number;
  try {
    if (!fs.existsSync(paths.longTermFile)) return null;
    size = fs.readFileSync(paths.longTermFile, "utf8").trim().length;
  } catch {
    return null;
  }
  if (!unlimited && size <= maxChars) return null;
  return compactLongTermMemoryAt(paths, maxChars);
}

export function compactLongTermMemoryIfNeeded(
  cwd: string,
  maxChars = DEFAULT_MEMORY_MAX_CHARS,
): MemoryCompactResult | null {
  return compactLongTermMemoryIfNeededAt(projectMemoryPaths(cwd), maxChars);
}

/** 覆盖写入长期记忆（原子写：先写临时文件再 rename，避免半截文件） */
export function writeLongTermMemoryAt(
  paths: MemoryPaths,
  content: string,
): string {
  fs.mkdirSync(paths.memoryDir, { recursive: true });
  const data = content.trim() ? `${content.trim()}\n` : "";
  const tmp = `${paths.longTermFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, paths.longTermFile);
  return paths.longTermFile;
}

export function writeLongTermMemory(cwd: string, content: string): string {
  return writeLongTermMemoryAt(projectMemoryPaths(cwd), content);
}

/**
 * 清理全局记忆中过期的自动记录（TTL）。
 * 只影响 `## 自动记录 · ...` 下的 `- YYYY-MM-DD：` 行，手工整理的小节不动。
 * 返回清理的行数；`days <= 0` 表示不启用。
 */
export function pruneGlobalMemory(days: number, now = new Date()): number {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const paths = resolveGlobalMemoryPaths();
  let raw: string;
  try {
    raw = fs.readFileSync(paths.longTermFile, "utf8");
  } catch {
    return 0;
  }
  const cleaned = pruneAutoMemory(raw, days, now);
  if (cleaned.removed > 0) {
    writeLongTermMemoryAt(paths, cleaned.text);
  }
  return cleaned.removed;
}

// ------------------------------------------------------------ 项目记忆清空

/** 记忆目录里的一个文件（清空 / 展示时用） */
export interface MemoryFileInfo {
  name: string;
  bytes: number;
}

/** 项目记忆的现状（`/memory` 展示、清空前确认框使用） */
export interface ProjectMemoryStatus {
  /** 记忆目录：<项目>/.xuanzhu/memory */
  dir: string;
  /** MEMORY.md 是否存在 */
  hasLongTerm: boolean;
  /** MEMORY.md 的字符数（trim 后） */
  longTermChars: number;
  /** 每日日志（YYYY-MM-DD.md），按日期升序 */
  dailyFiles: MemoryFileInfo[];
  /** 所有记忆文件的总字节数（含 MEMORY.md） */
  totalBytes: number;
  /** MEMORY.md 的字节数（不存在为 0） */
  longTermBytes: number;
}

/** 只认这两类文件：长期记忆与每日日志。其它文件不参与清空，避免误删用户放进去的东西 */
function isMemoryFile(name: string): boolean {
  return name === LONG_TERM_FILE || /^\d{4}-\d{2}-\d{2}\.md$/.test(name);
}

/** 查看记忆现状（不修改任何文件） */
export function inspectMemoryAt(paths: MemoryPaths): ProjectMemoryStatus {
  const status: ProjectMemoryStatus = {
    dir: paths.memoryDir,
    hasLongTerm: false,
    longTermChars: 0,
    dailyFiles: [],
    totalBytes: 0,
    longTermBytes: 0,
  };

  try {
    if (fs.existsSync(paths.longTermFile)) {
      const raw = fs.readFileSync(paths.longTermFile, "utf8");
      status.hasLongTerm = true;
      status.longTermChars = raw.trim().length;
      status.longTermBytes = Buffer.byteLength(raw, "utf8");
      status.totalBytes += status.longTermBytes;
    }
  } catch {
    // 读不了就当作不存在
  }

  try {
    const names = fs
      .readdirSync(paths.memoryDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .sort();
    for (const name of names) {
      try {
        const file = path.join(paths.memoryDir, name);
        const stat = fs.statSync(file);
        if (!stat.isFile()) continue;
        status.dailyFiles.push({ name, bytes: stat.size });
        status.totalBytes += stat.size;
      } catch {
        // 单个文件读不了就跳过
      }
    }
  } catch {
    // 目录不存在 = 没有记忆
  }

  return status;
}

export function inspectProjectMemory(cwd: string): ProjectMemoryStatus {
  return inspectMemoryAt(projectMemoryPaths(cwd));
}

export interface ClearedProjectMemory {
  /** 实际删除成功的文件 */
  files: MemoryFileInfo[];
  /** 实际删除的总字节数 */
  totalBytes: number;
}

/**
 * 清空当前项目的记忆（`/memory clear`）。
 *
 * 只删 `MEMORY.md` 与 `YYYY-MM-DD.md`，**不碰**目录里的其它文件、也不动
 * `~/.xzh/sessions` 的会话存档（两者是不同概念：记忆是给模型的结论库，
 * 会话是可 `/resume` 的原始记录）。
 *
 * 失败（权限等）不抛异常：返回实际删掉的文件，调用方据此如实告知用户。
 */
export function clearMemoryAt(paths: MemoryPaths): ClearedProjectMemory {
  const files: MemoryFileInfo[] = [];
  let totalBytes = 0;

  let names: string[];
  try {
    names = fs.readdirSync(paths.memoryDir).filter(isMemoryFile).sort();
  } catch {
    return { files, totalBytes };
  }

  for (const name of names) {
    const file = path.join(paths.memoryDir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      fs.unlinkSync(file);
      files.push({ name, bytes: stat.size });
      totalBytes += stat.size;
    } catch {
      // 删不掉就留在原地；返回值反映真实结果
    }
  }

  return { files, totalBytes };
}

export function clearProjectMemory(cwd: string): ClearedProjectMemory {
  return clearMemoryAt(projectMemoryPaths(cwd));
}

// ------------------------------------------------------------ 全局记忆

/** 追加写入全局记忆（~/.xzh/memory） */
export function appendGlobalMemory(
  content: string,
  scope: MemoryScope,
): string {
  return appendMemoryAt(resolveGlobalMemoryPaths(), content, scope);
}

/** 按主题并入全局长期记忆 */
export function appendGlobalTopicEntry(
  topic: string,
  entry: string,
  maxChars = DEFAULT_MEMORY_MAX_CHARS,
): TopicMemoryEntryResult {
  return appendLongTermTopicEntryAt(
    resolveGlobalMemoryPaths(),
    topic,
    entry,
    maxChars,
  );
}

/** 全局长期记忆超限时自动精简 */
export function compactGlobalMemoryIfNeeded(
  maxChars = DEFAULT_MEMORY_MAX_CHARS,
): MemoryCompactResult | null {
  return compactLongTermMemoryIfNeededAt(
    resolveGlobalMemoryPaths(),
    maxChars,
  );
}

/** 覆盖写入全局长期记忆 */
export function writeGlobalMemory(content: string): string {
  return writeLongTermMemoryAt(resolveGlobalMemoryPaths(), content);
}

/** 查看全局记忆现状 */
export function inspectGlobalMemory(): ProjectMemoryStatus {
  return inspectMemoryAt(resolveGlobalMemoryPaths());
}

/** 清空全局记忆 */
export function clearGlobalMemory(): ClearedProjectMemory {
  return clearMemoryAt(resolveGlobalMemoryPaths());
}
