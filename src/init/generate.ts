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
export const DOCS_INDEX_FILE = "docs/README.md";

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
    "README.md": "项目说明",
    "README.en.md": "英文说明",
    "CHANGELOG.md": "变更记录",
    "CONTRIBUTING.md": "贡献指南",
    "SECURITY.md": "安全策略",
    [ARCHITECTURE_FILE]: "架构与目录说明（本文件）",
    [COMMANDS_FILE]: "命令手册",
    [CONVENTIONS_FILE]: "编码与工程约定",
  };
  return `- \`${rel}\`${known[rel] ? ` — ${known[rel]}` : ""}`;
}

function docIndex(facts: ProjectFacts, generated: string[]): string {
  const files: string[] = [];
  for (const rel of [...facts.docs, ...generated]) {
    if (rel.toLowerCase() === "agents.md") continue; // 不自引用
    if (!files.includes(rel)) files.push(rel);
  }
  if (files.length === 0) return "";
  return `## 文档索引\n\n${files.map(docLine).join("\n")}`;
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

/** 生成 docs/README.md：文档入口与 AGENTS 的映射 */
export function buildDocsIndexDoc(
  facts: ProjectFacts,
  options: { version: string; date: string; generatedDocs: string[] },
): string {
  const links = [
    ...new Set(["AGENTS.md", ...options.generatedDocs, DOCS_INDEX_FILE]),
  ];
  const has = (file: string): boolean =>
    file === DOCS_INDEX_FILE || options.generatedDocs.includes(file);
  const rows = [
    "| 项目入口大纲、必守约定 | `AGENTS.md` |",
    "| 目录结构、模块职责、数据流 | `docs/ARCHITECTURE.md` |",
    has(COMMANDS_FILE) ? "| 安装 / 构建 / 测试 / 校验命令 | `docs/COMMANDS.md` |" : "",
    has(CONVENTIONS_FILE) ? "| 编码风格、配置与环境约定 | `docs/CONVENTIONS.md` |" : "",
  ].filter(Boolean);
  return `# ${facts.name} 文档索引

${GENERATED_MARK(options.version, options.date)}

> \`AGENTS.md\` 只放大纲；本目录存放详细说明。Agent 先读 AGENTS.md，再按需打开对应文档。
> 修改代码后同步维护对应 md；md 改动涉及设计变化时，必须在回复中额外说明。

## 对应关系

| 内容 | 位置 |
| --- | --- |
${rows.join("\n")}

## 已有文档

${links.map((item) => `- \`${item}\``).join("\n")}
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

  return `# ${facts.name} 架构说明

${GENERATED_MARK(options.version, options.date)}

## 目录结构

\`\`\`
${renderTree(facts.root, 2, 60)}
\`\`\`

## 模块概览

${modules}

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
