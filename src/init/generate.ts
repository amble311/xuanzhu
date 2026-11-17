import * as fs from "fs";
import * as path from "path";
import { IGNORED_DIRS, type ProjectFacts } from "./scan";

/**
 * 规范文档生成 —— 只把**扫描到的事实**写进去。
 *
 * 三条硬约束：
 * 1. 不编造命令 / 模块职责：没探测到就写「未检测到」或「待补充」，不能猜；
 * 2. AGENTS.md 保持精简（只放必须遵守的入口级信息），细节放 docs/；
 * 3. 内容可增量合并：生成结果是若干 `## 小节`，已有同名小节时不会被追加。
 */

/** 生成文件的相对路径 */
export const AGENTS_FILE = "AGENTS.md";
export const ARCHITECTURE_FILE = "docs/ARCHITECTURE.md";
export const COMMANDS_FILE = "docs/COMMANDS.md";
export const CONVENTIONS_FILE = "docs/CONVENTIONS.md";
/**
 * 索引文件名刻意不用 README：`README.md` 是**发布物**（给使用者看、随 npm 包分发），
 * 开发文档的入口不该占用这个名字，否则项目里会出现两个「README」互相抢注意力。
 */
export const DOCS_INDEX_FILE = "docs/INDEX.md";
/** 逐模块说明目录：按项目**实际顶层目录**一篇一个文件，而不是平铺 */
export const MODULES_DIR = "docs/modules";
export const MODULES_INDEX_FILE = `${MODULES_DIR}/INDEX.md`;
/** 单次最多生成多少篇模块说明（超大仓库只覆盖主要目录） */
const MAX_MODULE_DOCS = 12;

/**
 * AGENTS.md 必须以这两行开头（代码生成、`/init` 模型重写、增量合并都会兜住）。
 *
 * 它是**行为约束**而不只是说明：读 AGENTS 的 Agent 先看到「只写框架 + 改代码要同步明细」，
 * 才会把细节写进 `docs/`，而不是继续把 AGENTS 写成第二个架构文档。
 */
export const AGENTS_MANDATORY_HEADER = [
  "（必须执行）本文档只设计与记录重要说明、详细设计文档位置的映射、总体框架等",
  "（必须执行）改动代码时同步更新此设计文档与文档中对应的docs下的明细设计文档；",
].join("\n");

/** 内容是否已经以强制两行开头 */
export function hasAgentsHeader(content: string): boolean {
  const normalized = content.replace(/\r\n/g, "\n").trimStart();
  return AGENTS_MANDATORY_HEADER.split("\n").every((line, index) => {
    return normalized.split("\n")[index]?.trim() === line;
  });
}

/** 给任意 AGENTS 正文补上强制开头（已存在则不重复加） */
export function withAgentsHeader(content: string): string {
  if (hasAgentsHeader(content)) return content;
  return `${AGENTS_MANDATORY_HEADER}\n\n${content.trimStart()}`;
}

/**
 * docs/ 的目录分工：根目录只放**入口级索引与总纲**，细节全部进子目录。
 *
 * 只描述约定，不预创建目录 —— 空目录进不了 git，也只会让人以为「这里该写点什么」。
 */
export const DOCS_SUBDIRS: Array<{ path: string; label: string; purpose: string }> = [
  {
    path: MODULES_DIR,
    label: "逐模块说明",
    purpose: "按项目实际顶层目录一篇一个文件（`modules/INDEX.md` 是总表）",
  },
  { path: "docs/guides", label: "操作指南", purpose: "步骤、流程、排障（how-to）" },
  { path: "docs/reference", label: "参考手册", purpose: "API、配置项、数据字典" },
  { path: "docs/decisions", label: "架构决策记录", purpose: "一篇一个决定，文件名 `NNNN-短标题.md`" },
];

/** 文档是否位于「入口层」（项目根 或 docs/ 根），子目录文档不算 */
function isEntryDoc(rel: string): boolean {
  if (!rel.includes("/")) return true;
  if (!rel.startsWith("docs/")) return false;
  return !rel.slice("docs/".length).includes("/");
}

/** 子目录的中文说明：先按最长前缀匹配内置约定，再看该目录 README 的一级标题 */
function groupLabel(groupPath: string, title?: string): string {
  const preset = DOCS_SUBDIRS.filter(
    (item) => groupPath === item.path || groupPath.startsWith(`${item.path}/`),
  ).sort((a, b) => b.path.length - a.path.length)[0];
  return preset?.label ?? title ?? "专题文档";
}

const GENERATED_MARK = (version: string, date: string): string =>
  `> 本文件由 \`xzh init\` 扫描生成（xzh v${version}，${date}）。可直接编辑；` +
  `再次运行只会补充缺失的 \`## 小节\`，不会覆盖已有内容。`;

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function commandRows(facts: ProjectFacts): string {
  if (facts.commands.length === 0) return "（未检测到可用的构建 / 测试命令，请在此补充）";
  return [
    "| 用途 | 命令 | 来源 |",
    "| --- | --- | --- |",
    ...facts.commands.map(
      (command) =>
        `| ${command.name} | \`${escapeCell(command.command)}\` | ${escapeCell(command.source)} |`,
    ),
  ].join("\n");
}

function entry(prefix: string, name: string, suffix: string, isLast: boolean): string {
  const branch = isLast ? "└── " : "├── ";
  return `${prefix}${branch}${name}${suffix}`;
}

/** 渲染两层目录树（跳过依赖 / 构建产物） */
export function renderTree(root: string, maxDepth = 2, maxEntries = 40): string {
  const lines: string[] = [`${path.basename(root) || "project"}/`];
  let count = 0;

  const walk = (dir: string, prefix: string, depth: number): void => {
    if (count >= maxEntries) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const visible = entries
      .filter((item) => !IGNORED_DIRS.has(item.name))
      .filter((item) => !item.name.startsWith(".") || item.name === ".github")
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 24);

    visible.forEach((item, index) => {
      if (count >= maxEntries) return;
      count += 1;
      const isLast = index === visible.length - 1;
      if (item.isDirectory()) {
        lines.push(entry(prefix, `${item.name}/`, "", isLast));
        if (depth < maxDepth) walk(path.join(dir, item.name), `${prefix}${isLast ? "    " : "│   "}`, depth + 1);
      } else {
        lines.push(entry(prefix, item.name, "", isLast));
      }
    });
  };

  walk(root, "", 1);
  return lines.join("\n");
}

function docLine(rel: string): string {
  const known: Record<string, string> = {
    "README.md": "项目说明（发布物，不属于开发文档）",
    "README.en.md": "英文说明（发布物）",
    "CHANGELOG.md": "变更记录",
    "CONTRIBUTING.md": "贡献指南",
    "SECURITY.md": "安全策略",
    [ARCHITECTURE_FILE]: "架构与目录说明",
    [COMMANDS_FILE]: "命令手册",
    [CONVENTIONS_FILE]: "编码与工程约定",
    [DOCS_INDEX_FILE]: "文档索引",
    [MODULES_INDEX_FILE]: "模块总表",
  };
  return `- \`${rel}\`${known[rel] ? ` — ${known[rel]}` : ""}`;
}

/**
 * AGENTS.md 的文档索引：入口文档逐条列，子目录**按目录汇总**。
 *
 * 不能把 docs/ 下所有文件都列出来 —— 文档一多，AGENTS 就变成第二个索引，
 * 违背「只放入口级信息」的设计。完整列表在 `docs/INDEX.md`。
 */
function docIndex(facts: ProjectFacts, generated: string[]): string {
  const files: string[] = [];
  for (const rel of [...facts.docs, ...generated]) {
    if (rel.toLowerCase() === "agents.md") continue; // 不自引用
    if (!files.includes(rel)) files.push(rel);
  }
  if (files.length === 0) return "";

  const entryDocs = files.filter(isEntryDoc);
  const groups = facts.docGroups.filter((group) => group.path !== "docs");
  const lines = entryDocs.map(docLine);

  for (const group of groups) {
    const names = group.files.map((rel) => path.basename(rel));
    const shown = names.slice(0, 6).join("、");
    lines.push(
      `- \`${group.path}/\`（${names.length} 篇）— ${groupLabel(group.path, group.title)}` +
        `：${shown}${names.length > 6 ? " 等" : ""}`,
    );
  }

  const hint =
    files.length > entryDocs.length
      ? `\n\n> 完整文档地图（含子目录）见 \`${DOCS_INDEX_FILE}\`。`
      : "";
  return `## 文档索引\n\n${lines.join("\n")}${hint}`;
}

/**
 * 生成 AGENTS.md（入口级大纲，不写细节）。
 *
 * 固定设计：
 * - 只描述项目是什么、怎么验证、去哪里看细节；
 * - 完整命令、目录树、模块职责、编码约定都放 docs/；
 * - 本文件任何新增内容都应先问「这是入口级导航，还是 docs 的细节？」
 */
export function buildAgentsDoc(
  facts: ProjectFacts,
  options: { version: string; date: string; generatedDocs: string[] },
): string {
  const overview: string[] = [];
  overview.push(`- 项目：\`${facts.name}\`${facts.version ? `（v${facts.version}）` : ""}`);
  if (facts.description) overview.push(`- 简介：${facts.description}`);
  if (facts.languages.length > 0) overview.push(`- 技术栈：${facts.languages.join("、")}`);
  if (facts.packageManager) overview.push(`- 包管理器：${facts.packageManager}`);
  if (facts.testFramework) overview.push(`- 测试：${facts.testFramework}`);
  overview.push(
    `- 规模：约 ${facts.fileCount} 个文件、${facts.directories.length} 个顶层目录（不含依赖与构建产物）`,
  );

  const commandNames = ["安装依赖", "测试", "构建", "类型检查", "lint", "格式化"];
  const commandLines = commandNames
    .map((name) => facts.commands.find((command) => command.name === name))
    .filter((command): command is NonNullable<typeof command> => Boolean(command))
    .map((command) => `- ${command.name}：\`${command.command}\``);
  if (commandLines.length === 0) {
    commandLines.push("- （未检测到构建 / 测试命令，见 `docs/COMMANDS.md`）");
  }

  const topDirs = facts.directories
    .slice(0, 10)
    .map((dir) => `\`${dir.name}/\``)
    .join("、");
  const dirLine = topDirs
    ? `- 顶层目录：${topDirs}`
    : "- （未检测到顶层目录）";

  const hasDoc = (file: string): boolean => options.generatedDocs.includes(file);
  const commandHint = hasDoc(COMMANDS_FILE)
    ? "> 完整命令、来源与说明见 `docs/COMMANDS.md`。"
    : "> 目前未检测到完整命令表；需要时再补 `docs/COMMANDS.md`。";
  const conventionHint = hasDoc(CONVENTIONS_FILE)
    ? "- 详细编码规范与环境约定见 `docs/CONVENTIONS.md`；需要补充时先写 docs，不要在 AGENTS 展开。"
    : "- 编码规范与环境约定如有需要，请新建 `docs/CONVENTIONS.md`，不要在 AGENTS 展开。";

  const sections = [
    AGENTS_MANDATORY_HEADER,
    `# ${facts.name} 开发规范`,
    GENERATED_MARK(options.version, options.date),
    "> **本文件只保留入口级大纲，详细内容写在 `docs/` 下；不要把长说明、完整命令表、目录树或代码细节堆在这里。**",
    `## 项目概览\n\n${overview.join("\n")}`,
    `## 常用命令\n\n${commandLines.join("\n")}\n\n${commandHint}`,
    `## 目录结构\n\n${dirLine}\n\n> 模块职责、入口与数据流见 \`docs/ARCHITECTURE.md\`。`,
    "## 开发约定\n\n" +
      "- 先读本文件与相关 `docs/` 小节，再开始修改。\n" +
      "- 修改代码后运行上面的测试 / 构建命令；无法验证时说明原因与风险。\n" +
      conventionHint,
    "## 文档同步\n\n" +
      "- **修改项目代码后，必须同步修改 `AGENTS.md` 或 `docs/` 下对应的说明文件**，" +
      "让入口大纲与详细文档互相呼应；不要在代码改了之后留下过期说明。\n" +
      "- 修改 `AGENTS.md` / `docs/*.md` 时，如果设计、目录、命令或约定发生变化，" +
      "**必须在最终回复中额外告知用户设计变化**，不要只提交文件改动。",
  ];


  const docs = docIndex(facts, options.generatedDocs);
  if (docs) sections.push(docs);

  return `${sections.join("\n\n")}\n`;
}

/** 生成 docs/INDEX.md：文档入口、目录分工与分层索引 */
export function buildDocsIndexDoc(
  facts: ProjectFacts,
  options: { version: string; date: string; generatedDocs: string[] },
): string {
  const has = (file: string): boolean =>
    file === DOCS_INDEX_FILE || options.generatedDocs.includes(file);
  const rows = [
    "| 项目入口大纲、必守约定 | `AGENTS.md` |",
    "| 目录结构、总体框架、数据流 | `docs/ARCHITECTURE.md` |",
    has(COMMANDS_FILE) ? "| 安装 / 构建 / 测试 / 校验命令 | `docs/COMMANDS.md` |" : "",
    has(CONVENTIONS_FILE) ? "| 编码风格、配置与环境约定 | `docs/CONVENTIONS.md` |" : "",
    has(MODULES_INDEX_FILE) ? "| 逐模块明细 | `docs/modules/INDEX.md` |" : "",
  ].filter(Boolean);

  const convention = [
    "| 位置 | 放什么 |",
    "| --- | --- |",
    "| `docs/` 根 | 只放入口级：`INDEX.md`（本索引）、`ARCHITECTURE.md`、`COMMANDS.md`、`CONVENTIONS.md` |",
    ...DOCS_SUBDIRS.map((item) => `| \`${item.path}/\` | ${item.label}：${item.purpose} |`),
  ].join("\n");

  const modules = moduleTargets(facts);
  const moduleLines =
    modules.length === 0
      ? "（暂无模块文档；顶层目录为空或都被忽略）"
      : [
          "| 目录 | 文件数 | 明细 |",
          "| --- | --- | --- |",
          ...modules.map(
            (dir) =>
              `| \`${escapeCell(dir.name)}/\` | ${dir.files} | \`${moduleDocPath(dir.name)}\` |`,
          ),
        ].join("\n");

  const allDocs: string[] = [];
  for (const rel of [...facts.docs, ...options.generatedDocs, DOCS_INDEX_FILE]) {
    if (rel.toLowerCase() === "agents.md") continue; // 不自引用
    if (!allDocs.includes(rel)) allDocs.push(rel);
  }
  const rootDocs = allDocs.filter((rel) => !rel.includes("/"));
  const docsRoot = allDocs.filter((rel) => rel.startsWith("docs/") && isEntryDoc(rel));
  const groups = facts.docGroups.filter(
    (group) => group.path !== "docs" && group.path !== MODULES_DIR,
  );

  const existing: string[] = [];
  if (rootDocs.length > 0) {
    existing.push(`### 项目根\n\n${rootDocs.map(docLine).join("\n")}`);
  }
  if (docsRoot.length > 0) {
    existing.push(`### \`docs/\`\n\n${docsRoot.map(docLine).join("\n")}`);
  }
  for (const group of groups) {
    existing.push(
      `### \`${group.path}/\` — ${groupLabel(group.path, group.title)}\n\n` +
        group.files.map(docLine).join("\n"),
    );
  }

  return `# ${facts.name} 文档索引

${GENERATED_MARK(options.version, options.date)}

> 这里是**开发文档**。仓库根 \`README.md\` 是发布物（面向使用者、随包分发），开发文档不占用这个名字。
> \`AGENTS.md\` 只放总体框架与「细节在哪」；改代码时按它的要求同步更新本文件与对应明细。
> 修改代码后同步维护对应 md；md 改动涉及设计变化时，必须在回复中额外说明。

## 目录分工

${convention}

- 子目录按**项目实际内容**划分：\`modules/\` 一篇对应一个顶层目录，其余按主题进 \`guides/\`、\`reference/\`、\`decisions/\`。
- 最多两层（\`docs/<主题>/[<子主题>/]<文件>.md\`），文件名用小写连字符；
  **只有真的写了文档才建目录**，不要提交空目录占位。
- 入口级只放四个文件，新增长篇说明落到子目录，别继续堆在根上。

## 对应关系

| 内容 | 位置 |
| --- | --- |
${rows.join("\n")}

## 模块明细

${moduleLines}

> 模块文档由扫描到的顶层目录生成骨架，职责 / 入口 / 运行时数据需要维护者补齐；
> 改动该目录时按 \`ARCHITECTURE.md\` 的口径同步更新对应文件。

## 已有文档

${existing.length > 0 ? existing.join("\n\n") : "（暂无）"}
`;
}

/** 需要生成模块文档的顶层目录：跳过 docs 自身与空目录，最多 MAX_MODULE_DOCS 个 */
export function moduleTargets(facts: ProjectFacts): ProjectFacts["directories"] {
  return facts.directories
    .filter((dir) => dir.name !== "docs" && dir.files > 0)
    .slice(0, MAX_MODULE_DOCS);
}

/** 模块文档的相对路径 */
export function moduleDocPath(dirName: string): string {
  return `${MODULES_DIR}/${dirName}.md`;
}

/** 生成 docs/modules/INDEX.md：模块总表 */
export function buildModulesIndexDoc(
  facts: ProjectFacts,
  options: { version: string; date: string },
): string {
  const modules = moduleTargets(facts);
  const rows =
    modules.length === 0
      ? "（未检测到可描述的顶层目录）"
      : [
          "| 目录 | 文件数 | 子目录 | 明细 |",
          "| --- | --- | --- | --- |",
          ...modules.map(
            (dir) =>
              `| \`${escapeCell(dir.name)}/\` | ${dir.files} | ${dir.dirs} | [\`${dir.name}.md\`](./${dir.name}.md) |`,
          ),
        ].join("\n");

  return `# 模块索引

${GENERATED_MARK(options.version, options.date)}

> 一篇对应一个**实际存在的顶层目录**。新增 / 删除顶层目录时同步这张表，
> 并在 \`docs/INDEX.md\` 的「模块明细」里保持一致。

## 总表

${rows}

## 维护规则

1. **职责**写「这个目录负责什么、不负责什么」，不要罗列文件名（文件表在下方）。
2. **入口**写清外部从哪里进来（CLI 命令、HTTP 路由、被哪个模块调用）。
3. **运行时数据**写目录 / 文件名与「删了会怎样」，链接到 \`docs/data-files.md\`（如果项目有）。
4. **相关测试**只列文件，不贴代码。
`;
}

/** 生成单个模块文档骨架（只写扫描到的事实，职责等待补充） */
export function buildModuleDoc(
  facts: ProjectFacts,
  dir: ProjectFacts["directories"][number],
  options: { version: string; date: string },
): string {
  const entries = dir.entries ?? [];
  const shown = entries.slice(0, 30);
  const table =
    shown.length === 0
      ? "（目录为空或读取失败）"
      : [
          "| 条目 | 说明 |",
          "| --- | --- |",
          ...shown.map((name) =>
            name.endsWith("/")
              ? `| \`${escapeCell(name)}\` | 子目录（待补充） |`
              : `| \`${escapeCell(name)}\` | 待补充 |`,
          ),
          ...(entries.length > shown.length
            ? [`| …… | 还有 ${entries.length - shown.length} 个条目，见目录本身 |`]
            : []),
        ].join("\n");

  return `# \`${dir.name}/\` 模块说明

${GENERATED_MARK(options.version, options.date)}

> 扫描事实：**${dir.files} 个文件、${dir.dirs} 个子目录**（不含依赖与构建产物）。
> 下面是骨架，请补齐职责、入口与数据流；细节机制写进 \`docs/ARCHITECTURE.md\` 对应小节。

## 职责

- 待补充：这个目录负责什么、不负责什么（边界比清单更重要）。

## 入口

- 待补充：外部从哪里进来（命令 / 路由 / 被谁调用）。

## 文件

${table}

## 运行时数据

- 待补充：读写哪些文件 / 数据库 / 外部服务；能删吗。

## 相关测试

- 待补充：覆盖该目录的测试文件。

## 修改时注意

- 待补充：容易踩的坑、不能破坏的不变量。
`;
}

/** 生成 docs/ARCHITECTURE.md */
export function buildArchitectureDoc(
  facts: ProjectFacts,
  options: { version: string; date: string },
): string {
  const modules =
    facts.directories.length === 0
      ? "（未检测到子目录）"
      : [
          "| 目录 | 文件数 | 说明 |",
          "| --- | --- | --- |",
          ...facts.directories.map(
            (dir) => `| \`${escapeCell(dir.name)}/\` | ${dir.files} | 待补充 |`,
          ),
        ].join("\n");

  const commands =
    facts.commands.length === 0
      ? "（未检测到运行 / 构建命令）"
      : facts.commands
          .map((command) => `- **${command.name}**：\`${command.command}\``)
          .join("\n");

  const docLines = [
    "- `docs/` —— 入口级：`INDEX.md`（索引）、`ARCHITECTURE.md`（本文件）、" +
      "`COMMANDS.md`、`CONVENTIONS.md`（**不放 README**：README 是发布物）",
    `- \`${MODULES_DIR}/\` —— 逐模块说明：${moduleTargets(facts)
      .map((dir) => `\`${dir.name}.md\``)
      .join("、") || "（暂无）"}；总表见 \`${MODULES_INDEX_FILE}\``,
    ...facts.docGroups
      .filter((group) => group.path !== "docs" && group.path !== MODULES_DIR)
      .map(
        (group) =>
          `- \`${group.path}/\` —— ${group.files.length} 篇：${groupLabel(group.path, group.title)}`,
      ),
  ].join("\n");

  return `# ${facts.name} 架构说明

${GENERATED_MARK(options.version, options.date)}

## 目录结构

\`\`\`
${renderTree(facts.root, 2, 60)}
\`\`\`

## 模块概览

${modules}

## 文档组织

${docLines}

> 文档按主题进子目录（\`modules/\` 逐目录一篇，另有 \`guides/\` / \`reference/\` / \`decisions/\`），
> 根目录只留入口级四个文件（不含 README）；完整索引见 \`docs/INDEX.md\`。

## 入口与运行

${commands}

## 数据流与关键设计

- 待补充：核心模块之间的调用关系、数据存储与外部依赖。
- 待补充：关键设计取舍（为什么这样分层、有哪些约束）。

> 本文件只写入可确定的事实；「待补充」部分需要项目维护者完善。
`;
}

/** 生成 docs/COMMANDS.md */
export function buildCommandsDoc(
  facts: ProjectFacts,
  options: { version: string; date: string },
): string {
  const raw = facts.rawScripts
    ? [
        "## package.json scripts（原始）",
        "",
        "| script | 内容 |",
        "| --- | --- |",
        ...Object.entries(facts.rawScripts).map(
          ([name, value]) => `| \`${escapeCell(name)}\` | \`${escapeCell(value)}\` |`,
        ),
      ].join("\n")
    : "";

  return `# ${facts.name} 命令手册

${GENERATED_MARK(options.version, options.date)}

## 常用命令

${commandRows(facts)}
${raw ? `\n${raw}\n` : ""}
## 说明

- 命令按原样提取；如与实际不符请直接修改本文件。
- 安装依赖后，构建 / 测试命令通常需要在项目根目录执行。
`;
}

/** 生成 docs/CONVENTIONS.md */
export function buildConventionsDoc(
  facts: ProjectFacts,
  options: { version: string; date: string },
): string {
  const purposes: Record<string, string> = {
    ".editorconfig": "缩进、换行符与字符集等基础风格",
    ".gitignore": "忽略规则（构建产物、依赖、本地配置）",
    ".eslintrc": "JavaScript / TypeScript 静态检查",
    ".eslintrc.js": "JavaScript / TypeScript 静态检查",
    ".eslintrc.cjs": "JavaScript / TypeScript 静态检查",
    ".eslintrc.json": "JavaScript / TypeScript 静态检查",
    "eslint.config.js": "JavaScript / TypeScript 静态检查",
    "eslint.config.mjs": "JavaScript / TypeScript 静态检查",
    ".prettierrc": "代码格式化",
    ".prettierrc.json": "代码格式化",
    ".prettierrc.js": "代码格式化",
    "prettier.config.js": "代码格式化",
    "tsconfig.json": "TypeScript 编译选项（strict / target / paths 等）",
    "pyproject.toml": "Python 依赖与工具配置",
    "requirements.txt": "Python 依赖",
    "go.mod": "Go 模块与依赖",
    "Cargo.toml": "Rust 依赖与构建",
    Makefile: "常用任务入口",
    Dockerfile: "容器镜像构建",
    "docker-compose.yml": "本地多服务编排",
    ".github/workflows": "CI 流程",
  };

  const rows =
    facts.configs.length === 0
      ? "（未检测到配置文件）"
      : [
          "| 配置文件 | 用途 |",
          "| --- | --- |",
          ...facts.configs.map(
            (file) => `| \`${escapeCell(file)}\` | ${purposes[file] ?? "项目配置"} |`,
          ),
        ].join("\n");

  const style: string[] = [];
  if (facts.configs.includes(".editorconfig")) {
    style.push("- 缩进与换行以 `.editorconfig` 为准。");
  }
  if (facts.configs.some((file) => file.includes("eslint"))) {
    style.push("- 提交前运行 lint（见 `docs/COMMANDS.md` 或 AGENTS.md）。");
  }
  if (facts.configs.some((file) => file.includes("prettier"))) {
    style.push("- 格式化以 Prettier 配置为准。");
  }
  if (facts.configs.includes("tsconfig.json")) {
    style.push("- TypeScript 编译选项以 `tsconfig.json` 为准；不要绕过类型检查提交。");
  }
  if (style.length === 0) style.push("- 待补充：缩进、命名、提交信息与评审要求。");

  return `# ${facts.name} 编码与工程约定

${GENERATED_MARK(options.version, options.date)}

## 配置文件

${rows}

## 风格要点

${style.join("\n")}

## 待补充

- 提交信息格式（如 Conventional Commits）
- 分支策略与评审要求
- 测试覆盖要求与不允许的做法
`;
}

export interface GeneratedDoc {
  relPath: string;
  content: string;
}

/** 生成全部规范文件（均为文本，不写盘） */
export function generateProjectDocs(
  facts: ProjectFacts,
  options: { version: string; date: string },
): GeneratedDoc[] {
  const docs: GeneratedDoc[] = [
    { relPath: ARCHITECTURE_FILE, content: buildArchitectureDoc(facts, options) },
  ];
  if (facts.commands.length > 0 || facts.rawScripts) {
    docs.push({ relPath: COMMANDS_FILE, content: buildCommandsDoc(facts, options) });
  }
  if (facts.configs.length > 0) {
    docs.push({ relPath: CONVENTIONS_FILE, content: buildConventionsDoc(facts, options) });
  }
  // 逐模块：按项目实际顶层目录一篇一个文件（多级目录，不平铺）
  const modules = moduleTargets(facts);
  if (modules.length > 0) {
    docs.push({
      relPath: MODULES_INDEX_FILE,
      content: buildModulesIndexDoc(facts, options),
    });
    for (const dir of modules) {
      docs.push({
        relPath: moduleDocPath(dir.name),
        content: buildModuleDoc(facts, dir, options),
      });
    }
  }
  docs.push({
    relPath: DOCS_INDEX_FILE,
    content: buildDocsIndexDoc(facts, {
      ...options,
      generatedDocs: docs.map((doc) => doc.relPath),
    }),
  });
  docs.push({
    relPath: AGENTS_FILE,
    content: buildAgentsDoc(facts, {
      ...options,
      generatedDocs: docs.map((doc) => doc.relPath),
    }),
  });
  return docs;
}
