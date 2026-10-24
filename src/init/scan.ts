import * as fs from "fs";
import * as path from "path";

/**
 * 项目扫描 —— `xzh init` 的**确定性**输入。
 *
 * 所有事实都来自文件系统：package.json 的 scripts、锁文件、构建/测试配置文件、
 * 顶层目录结构、既有文档清单。这里**不调用模型**、不做推测 —— 生成规范时
 * 「命令写错」比「没有规范」更糟，因为它会被当成权威约定注入后续对话。
 */

export interface ProjectCommand {
  /** 用途（安装依赖 / 开发 / 构建 / 测试 / 类型检查 / lint / 格式化） */
  name: string;
  /** 可直接执行的命令 */
  command: string;
  /** 来源（package.json scripts / Makefile / go.mod …），便于人工核对 */
  source: string;
}

export interface ProjectDirectory {
  /** 相对项目根的目录名（顶层） */
  name: string;
  /** 该目录下（递归）文件数 */
  files: number;
  /** 该目录下（递归）子目录数 */
  dirs: number;
}

export interface ProjectFacts {
  root: string;
  name: string;
  version?: string;
  description?: string;
  /** 探测到的语言 / 技术栈（如 TypeScript、Python、Go） */
  languages: string[];
  packageManager?: string;
  testFramework?: string;
  commands: ProjectCommand[];
  /** 顶层目录（已排除 node_modules / .git 等） */
  directories: ProjectDirectory[];
  /** 既有文档（相对路径） */
  docs: string[];
  /** 探测到的配置文件（相对路径） */
  configs: string[];
  /** 项目根下是否已有 AGENTS.md（大小写不敏感） */
  hasAgents: boolean;
  /** 是否存在 docs 目录 */
  hasDocsDir: boolean;
  /** 忽略目录之外的文件总数 */
  fileCount: number;
  /** package.json 的原始 scripts（写入 docs/COMMANDS.md 供人工核对） */
  rawScripts?: Record<string, string>;
}

/** 扫描时跳过的目录：依赖、构建产物、缓存与工具数据 */
export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "venv",
  ".venv",
  "env",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "target",
  "vendor",
  ".idea",
  ".vscode",
  ".xuanzhu",
  ".codebuddy",
  ".claude",
  "tmp",
  "temp",
]);

/** 既有可能的文档文件（相对路径，按优先级） */
const DOC_CANDIDATES = [
  "README.md",
  "README.en.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "AGENTS.md",
  "docs/ARCHITECTURE.md",
  "docs/README.md",
];

/** 探测技术栈用的标记文件 */
const LANGUAGE_MARKERS: Array<{ file: string; label: string }> = [
  { file: "tsconfig.json", label: "TypeScript" },
  { file: "package.json", label: "Node.js" },
  { file: "pyproject.toml", label: "Python" },
  { file: "requirements.txt", label: "Python" },
  { file: "setup.py", label: "Python" },
  { file: "manage.py", label: "Python" },
  { file: "go.mod", label: "Go" },
  { file: "Cargo.toml", label: "Rust" },
  { file: "pom.xml", label: "Java (Maven)" },
  { file: "build.gradle", label: "Java (Gradle)" },
  { file: "build.gradle.kts", label: "Kotlin (Gradle)" },
  { file: "composer.json", label: "PHP" },
  { file: "Gemfile", label: "Ruby" },
  { file: "CMakeLists.txt", label: "C/C++ (CMake)" },
];

const CONFIG_CANDIDATES = [
  ".editorconfig",
  ".gitignore",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  "eslint.config.js",
  "eslint.config.mjs",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.js",
  "prettier.config.js",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "Makefile",
  "Dockerfile",
  "docker-compose.yml",
  ".github/workflows",
];

function exists(root: string, rel: string): boolean {
  try {
    return fs.existsSync(path.join(root, rel));
  } catch {
    return false;
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readUtf8(file: string, limit = 4000): string | null {
  try {
    return fs.readFileSync(file, "utf8").slice(0, limit);
  } catch {
    return null;
  }
}

/** 读 package.json 的 description；没有则取 README 第一段正文 */
function detectDescription(root: string, pkg: Record<string, unknown> | null): string | undefined {
  const pkgDesc = typeof pkg?.description === "string" ? pkg.description.trim() : "";
  if (pkgDesc) return pkgDesc;

  for (const name of ["README.md", "readme.md", "Readme.md"]) {
    const text = readUtf8(path.join(root, name), 4000);
    if (!text) continue;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!") || trimmed.startsWith("<")) {
        continue;
      }
      return trimmed.replace(/[*_`]/g, "").slice(0, 200);
    }
  }
  return undefined;
}

function detectPackageManager(root: string): string | undefined {
  if (exists(root, "pnpm-lock.yaml")) return "pnpm";
  if (exists(root, "yarn.lock")) return "yarn";
  if (exists(root, "bun.lockb") || exists(root, "bun.lock")) return "bun";
  if (exists(root, "package-lock.json") || exists(root, "package.json")) return "npm";
  return undefined;
}

const SCRIPT_PRIORITY: Array<{ keys: string[]; name: string }> = [
  { keys: ["dev", "develop", "serve"], name: "开发" },
  { keys: ["build", "compile"], name: "构建" },
  { keys: ["test", "tests"], name: "测试" },
  { keys: ["typecheck", "check-types", "tsc"], name: "类型检查" },
  { keys: ["lint"], name: "lint" },
  { keys: ["format", "fmt"], name: "格式化" },
  { keys: ["check"], name: "检查" },
];

function commandsFromPackage(
  root: string,
  pkg: Record<string, unknown> | null,
  packageManager: string | undefined,
): ProjectCommand[] {
  // 没有 package.json 就不是 Node 项目：不能凭空生成 `npm install`
  if (!pkg) return [];
  const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
  const commands: ProjectCommand[] = [];
  const pm = packageManager ?? "npm";

  if (pm !== "bun") {
    commands.push({
      name: "安装依赖",
      command: pm === "yarn" ? "yarn install" : `${pm} install`,
      source: pm,
    });
  } else {
    commands.push({ name: "安装依赖", command: "bun install", source: "bun" });
  }

  for (const { keys, name } of SCRIPT_PRIORITY) {
    const key = keys.find((candidate) => typeof scripts[candidate] === "string");
    if (!key) continue;
    commands.push({
      name,
      command: `${pm} run ${key}`,
      source: `package.json scripts.${key}`,
    });
  }
  return commands;
}

function commandsFromMakefile(root: string): ProjectCommand[] {
  const text = readUtf8(path.join(root, "Makefile"), 20_000) ?? readUtf8(path.join(root, "makefile"), 20_000);
  if (!text) return [];

  const targets = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line);
    if (match) targets.add(match[1]);
  }

  const wanted: Array<{ names: string[]; label: string }> = [
    { names: ["install", "deps"], label: "安装依赖" },
    { names: ["build", "all"], label: "构建" },
    { names: ["test", "check"], label: "测试" },
    { names: ["lint"], label: "lint" },
    { names: ["dev", "run"], label: "开发" },
  ];
  const commands: ProjectCommand[] = [];
  for (const item of wanted) {
    const target = item.names.find((name) => targets.has(name));
    if (!target) continue;
    if (commands.some((command) => command.name === item.label)) continue;
    commands.push({ name: item.label, command: `make ${target}`, source: `Makefile:${target}` });
  }
  return commands;
}

function commandsFromOtherEcosystems(root: string): ProjectCommand[] {
  const commands: ProjectCommand[] = [];

  if (exists(root, "go.mod")) {
    commands.push({ name: "构建", command: "go build ./...", source: "go.mod" });
    commands.push({ name: "测试", command: "go test ./...", source: "go.mod" });
  }

  if (exists(root, "Cargo.toml")) {
    commands.push({ name: "构建", command: "cargo build", source: "Cargo.toml" });
    commands.push({ name: "测试", command: "cargo test", source: "Cargo.toml" });
  }

  if (exists(root, "pyproject.toml") || exists(root, "requirements.txt") || exists(root, "setup.py")) {
    if (exists(root, "requirements.txt")) {
      commands.push({
        name: "安装依赖",
        command: "pip install -r requirements.txt",
        source: "requirements.txt",
      });
    } else if (exists(root, "pyproject.toml")) {
      const pyproject = readUtf8(path.join(root, "pyproject.toml"), 20_000) ?? "";
      if (/\[tool\.poetry\]/.test(pyproject)) {
        commands.push({ name: "安装依赖", command: "poetry install", source: "pyproject.toml" });
      } else {
        commands.push({ name: "安装依赖", command: "pip install -e .", source: "pyproject.toml" });
      }
      if (exists(root, "poetry.lock")) {
        commands[commands.length - 1] = {
          name: "安装依赖",
          command: "poetry install",
          source: "poetry.lock",
        };
      }
    }
    if (
      exists(root, "pytest.ini") ||
      exists(root, "tox.ini") ||
      exists(root, "tests") ||
      exists(root, "test") ||
      /pytest/.test(readUtf8(path.join(root, "pyproject.toml"), 20_000) ?? "")
    ) {
      commands.push({ name: "测试", command: "pytest", source: "pytest 配置 / tests 目录" });
    }
  }

  if (exists(root, "pom.xml")) {
    commands.push({ name: "测试", command: "mvn test", source: "pom.xml" });
  }
  if (exists(root, "build.gradle") || exists(root, "build.gradle.kts")) {
    commands.push({ name: "测试", command: "./gradlew test", source: "Gradle" });
  }

  return commands;
}

/** 合并命令：同名只保留第一条，安装依赖永远排最前 */
function mergeCommands(...groups: ProjectCommand[][]): ProjectCommand[] {
  const seen = new Set<string>();
  const result: ProjectCommand[] = [];
  for (const group of groups) {
    for (const command of group) {
      if (seen.has(command.name)) continue;
      seen.add(command.name);
      result.push(command);
    }
  }
  const order = ["安装依赖", "开发", "构建", "测试", "类型检查", "lint", "格式化", "检查"];
  return result.sort((a, b) => {
    const ai = order.indexOf(a.name);
    const bi = order.indexOf(b.name);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
}

function detectTestFramework(root: string, pkg: Record<string, unknown> | null): string | undefined {
  const deps = {
    ...((pkg?.dependencies ?? {}) as Record<string, unknown>),
    ...((pkg?.devDependencies ?? {}) as Record<string, unknown>),
  };
  for (const name of ["vitest", "jest", "mocha", "ava", "node:test"]) {
    if (name in deps) return name;
  }
  if (exists(root, "pytest.ini") || exists(root, "tests") || exists(root, "test")) {
    if (exists(root, "pyproject.toml") || exists(root, "requirements.txt")) return "pytest";
  }
  if (exists(root, "go.mod")) return "go test";
  if (exists(root, "Cargo.toml")) return "cargo test";
  return undefined;
}

/** 统计一个目录下（递归、跳过忽略目录）的文件与子目录数 */
function countTree(dir: string, depth = 0): { files: number; dirs: number } {
  let files = 0;
  let dirs = 0;
  if (depth > 8) return { files, dirs };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { files, dirs };
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      dirs += 1;
      const child = countTree(path.join(dir, entry.name), depth + 1);
      files += child.files;
      dirs += child.dirs;
    } else if (entry.isFile()) {
      files += 1;
    }
  }
  return { files, dirs };
}

function scanDirectories(root: string): ProjectDirectory[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !IGNORED_DIRS.has(entry.name))
    .map((entry) => {
      const counts = countTree(path.join(root, entry.name));
      return { name: entry.name, files: counts.files, dirs: counts.dirs };
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 20);
}

/** 收集既有文档（含 docs 下第一层 md） */
function scanDocs(root: string): string[] {
  const docs: string[] = [];
  for (const candidate of DOC_CANDIDATES) {
    if (exists(root, candidate)) docs.push(candidate);
  }

  try {
    const entries = fs.readdirSync(path.join(root, "docs"), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !/\.(md|mdx)$/i.test(entry.name)) continue;
      const rel = `docs/${entry.name}`;
      if (!docs.includes(rel)) docs.push(rel);
      if (docs.length >= 20) break;
    }
  } catch {
    // 没有 docs 目录
  }
  return docs;
}

/** 扫描项目，返回生成规范所需的事实 */
export function scanProject(cwd: string): ProjectFacts {
  const root = path.resolve(cwd);
  const pkgPath = path.join(root, "package.json");
  const pkg = exists(root, "package.json") ? readJson(pkgPath) : null;

  const name =
    (typeof pkg?.name === "string" && pkg.name.trim()) || path.basename(root) || "project";
  const version = typeof pkg?.version === "string" ? pkg.version : undefined;
  const description = detectDescription(root, pkg);
  const packageManager = detectPackageManager(root);

  const languages: string[] = [];
  for (const marker of LANGUAGE_MARKERS) {
    if (!exists(root, marker.file)) continue;
    if (!languages.includes(marker.label)) languages.push(marker.label);
  }
  if (pkg) {
    const deps = {
      ...((pkg.dependencies ?? {}) as Record<string, unknown>),
      ...((pkg.devDependencies ?? {}) as Record<string, unknown>),
    };
    if ("react" in deps && !languages.includes("React")) languages.push("React");
    if ("vue" in deps && !languages.includes("Vue")) languages.push("Vue");
    if ("express" in deps && !languages.includes("Express")) languages.push("Express");
    if ("next" in deps && !languages.includes("Next.js")) languages.push("Next.js");
  }

  const commands = mergeCommands(
    commandsFromPackage(root, pkg, packageManager),
    commandsFromMakefile(root),
    commandsFromOtherEcosystems(root),
  );

  const configs = CONFIG_CANDIDATES.filter((rel) => exists(root, rel));

  let topEntryNames: string[] = [];
  try {
    topEntryNames = fs.readdirSync(root);
  } catch {
    // 读不了就当作空
  }
  const hasAgents = topEntryNames.some((name) => name.toLowerCase() === "agents.md");
  const hasDocsDir = topEntryNames.some((name) => name.toLowerCase() === "docs") &&
    exists(root, "docs");

  const counts = countTree(root);

  const rawScripts: Record<string, string> = {};
  const scripts = (pkg?.scripts ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value === "string") rawScripts[key] = value;
  }

  return {
    root,
    name,
    version,
    description,
    languages,
    packageManager,
    testFramework: detectTestFramework(root, pkg),
    commands,
    directories: scanDirectories(root),
    docs: scanDocs(root),
    configs,
    hasAgents,
    hasDocsDir,
    fileCount: counts.files,
    rawScripts: Object.keys(rawScripts).length > 0 ? rawScripts : undefined,
  };
}
