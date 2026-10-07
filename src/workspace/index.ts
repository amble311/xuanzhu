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

/** 从 AGENTS.md 引入初始规则时，加在文件头的来源与同步说明 */
const RULES_FROM_AGENTS_HEADER = `# 项目规则

> 本文件内容会作为「项目级指令」追加到玄猪的系统提示词中，
> 用于约定本项目的编码规范、目录结构、构建与测试命令等。
> 留空或删除本文件即表示不使用项目规则。
>
> 📌 以下内容取自本项目根目录的 \`AGENTS.md\`，是**初始化时的一次性快照**。
> 之后修改 \`AGENTS.md\` **不会**自动同步到这里 —— 若希望两处一致请手动同步，
> 或者干脆只在此文件中维护。`;

/**
 * 生成 `.xuanzhu/rules.md` 的初始内容。
 *
 * 玄猪只读取 `rules.md` 一个来源（避免多份规则互相冲突、也难以判断优先级）。
 * 但很多项目根目录已经有 `AGENTS.md`，因此**在初始化时**把它的内容拿来当初始规则，
 * 用户不必为了用玄猪再维护第二份文档。
 *
 * 取的是快照而非运行时读取：这样规则来源始终唯一、行为可预测，
 * 且 AGENTS.md 改动不会在用户不知情时影响玄猪的行为（文件头已写明这一点）。
 */
function buildRulesTemplate(root: string): string {
  const agents = readTextFile(path.join(root, AGENTS_FILE));
  if (!agents) return RULES_TEMPLATE;
  return `${RULES_FROM_AGENTS_HEADER}\n\n${agents}\n`;
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
