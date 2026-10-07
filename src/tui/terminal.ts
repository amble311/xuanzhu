import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ansi } from "../utils/ansi";

/** 面板保留的最大行数（防止长任务输出撑爆内存） */
const MAX_LINES = 2000;
/** 单行未结束内容的最大长度（防止无换行输出撑爆内存） */
const MAX_PARTIAL = 8192;
/** 中断后强制杀死的等待时间（毫秒） */
const KILL_GRACE_MS = 1200;

/**
 * 右侧终端面板：在项目目录下执行 shell 命令并收集输出。
 *
 * 实现说明：为支持可靠中断（Ctrl+C）且不引入原生依赖，每条命令使用独立的
 * `spawn(shell, ["-c", cmd])`，而不是持久 PTY。因此：
 * - 不支持 vim / htop / less 这类需要 TTY 的全屏交互程序；
 * - `export` 的环境变量不会跨命令保留；
 * - `cd` 由本类维护（见 handleCd），使面板具备"当前目录"语义。
 */
export class ShellPanel {
  private lines: string[] = [];
  /** 尚未遇到换行的当前行（进度输出会反复覆盖它） */
  private partial = "";
  private running?: ChildProcess;
  private killTimer?: NodeJS.Timeout;
  private cwd: string;
  private readonly onChange: () => void;

  /**
   * ANSI 解析状态。必须是**实例字段**：输出以管道分片到达时，
   * 一个转义序列可能被切成两块（如 `\x1b[3` + `1m`），
   * 若每块都从 "text" 状态重新开始，后半截会作为普通文本写入输出行。
   */
  private parseState: "text" | "esc" | "csi" | "osc" = "text";
  private parseSeq = "";

  constructor(cwd: string, onChange: () => void) {
    this.cwd = cwd;
    this.onChange = onChange;
    this.pushLine(`${ansi.gray}终端就绪 · 命令在当前项目目录下执行${ansi.reset}`);
  }

  getCwd(): string {
    return this.cwd;
  }

  isRunning(): boolean {
    return this.running !== undefined;
  }

  /** 切换项目目录（/switch 时调用） */
  setCwd(cwd: string): void {
    this.cwd = cwd;
    this.pushLine(`${ansi.gray}── 工作目录已切换：${cwd}${ansi.reset}`);
    this.onChange();
  }

  clear(): void {
    this.lines = [];
    this.partial = "";
    this.onChange();
  }

  /** 向输出区追加提示文本（用于展示补全候选等） */
  notice(text: string): void {
    this.pushLine(text);
    this.onChange();
  }

  /** 面板可视行（含尚未结束的当前行） */
  visibleLines(): string[] {
    return this.partial ? [...this.lines, this.partial] : this.lines;
  }

  /** 执行一条命令 */
  run(command: string): void {
    const cmd = command.trim();
    if (!cmd) return;
    if (this.running) {
      this.pushLine(`${ansi.yellow}⚠ 上一条命令仍在运行，请先 Ctrl+C 中断${ansi.reset}`);
      this.onChange();
      return;
    }

    // 内置处理：清屏与目录切换
    if (cmd === "clear" || cmd === "cls") {
      this.clear();
      return;
    }
    if (this.handleCd(cmd)) return;

    this.flushPartial();
    this.pushLine(
      `${ansi.brightGreen}❯${ansi.reset} ${ansi.bold}${cmd}${ansi.reset}`,
    );

    const shell = process.env.SHELL || "/bin/bash";
    let child: ChildProcess;
    try {
      child = spawn(shell, ["-c", cmd], {
        cwd: this.cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          // 让支持的程序在管道下仍输出颜色
          CLICOLOR_FORCE: "1",
          FORCE_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
        // 独立进程组：中断时可以向整组发信号，避免留下孤儿进程
        detached: true,
      });
    } catch (err) {
      this.pushLine(
        `${ansi.red}✗ 启动失败：${err instanceof Error ? err.message : String(err)}${ansi.reset}`,
      );
      this.onChange();
      return;
    }

    this.running = child;
    const feed = (data: Buffer): void => this.feed(data.toString("utf8"));
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);

    child.on("error", (err) => {
      this.flushPartial();
      this.pushLine(`${ansi.red}✗ 执行出错：${err.message}${ansi.reset}`);
      this.running = undefined;
      this.onChange();
    });

    child.on("close", (code, signal) => {
      this.flushPartial();
      if (signal) {
        this.pushLine(`${ansi.yellow}⏹ 已中断（${signal}）${ansi.reset}`);
      } else if (code === 0) {
        this.pushLine(`${ansi.gray}✓ 完成${ansi.reset}`);
      } else {
        this.pushLine(`${ansi.red}✗ 退出码 ${code}${ansi.reset}`);
      }
      this.running = undefined;
      this.onChange();
    });

    this.onChange();
  }

  /** 中断正在运行的命令（先 SIGINT，超时后 SIGKILL 整组） */
  interrupt(): void {
    const child = this.running;
    if (!child || child.pid === undefined) return;
    const pid = child.pid;
    const signalGroup = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // 进程可能已退出
        }
      }
    };
    signalGroup("SIGINT");
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = setTimeout(() => {
      this.killTimer = undefined;
      if (this.running === child) signalGroup("SIGKILL");
    }, KILL_GRACE_MS);
  }

  /**
   * 释放资源：终止仍在运行的命令并清理定时器。
   * 命令以 `detached` 独立进程组启动，若不在退出时终止，父进程结束后它会成为孤儿。
   */
  dispose(): void {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = undefined;
    }
    const child = this.running;
    this.running = undefined;
    if (!child || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // 进程可能已退出
      }
    }
  }

  // ------------------------------------------------------------ 内部实现

  /** 处理 `cd`（自行维护工作目录，因为每条命令是独立进程） */
  private handleCd(command: string): boolean {
    const match = /^cd(?:\s+([\s\S]*))?$/.exec(command);
    if (!match) return false;
    const raw = (match[1] ?? "").trim().replace(/^['"]|['"]$/g, "");

    let next: string;
    if (!raw || raw === "~") {
      next = os.homedir();
    } else {
      const expanded = raw.startsWith("~/")
        ? path.join(os.homedir(), raw.slice(2))
        : raw;
      next = path.isAbsolute(expanded)
        ? expanded
        : path.resolve(this.cwd, expanded);
    }

    try {
      if (!fs.statSync(next).isDirectory()) {
        this.pushLine(`${ansi.red}cd: 不是目录：${next}${ansi.reset}`);
        this.onChange();
        return true;
      }
    } catch {
      this.pushLine(`${ansi.red}cd: 目录不存在：${next}${ansi.reset}`);
      this.onChange();
      return true;
    }

    this.cwd = next;
    this.flushPartial();
    this.pushLine(`${ansi.gray}cd ${this.cwd}${ansi.reset}`);
    this.onChange();
    return true;
  }

  /**
   * 消费一段输出：
   * - 按行拆分，`\r` 视为回到行首（覆盖当前行，用于进度条）；
   * - 保留 SGR 颜色序列（`\x1b[…m`），丢弃光标移动等其他控制序列，
   *   否则子进程的终端控制会破坏本应用的整屏渲染。
   */
  private feed(text: string): void {
    const data = text.replace(/\r\n/g, "\n");
    let buffer = this.partial;
    // 跨 chunk 保持解析状态（见 parseState 字段说明）
    let state = this.parseState;
    let seq = this.parseSeq;

    for (const ch of data) {
      if (state === "osc") {
        // OSC 以 BEL 或 ST(\x1b\\) 结束，内容整体丢弃
        if (ch === "\x07") state = "text";
        else if (ch === "\\" && seq.endsWith("\x1b")) state = "text";
        seq += ch;
        continue;
      }
      if (state === "esc") {
        if (ch === "[") {
          state = "csi";
          seq = "\x1b[";
          continue;
        }
        if (ch === "]") {
          state = "osc";
          seq = "\x1b]";
          continue;
        }
        state = "text"; // 其他两字节序列：丢弃
        continue;
      }
      if (state === "csi") {
        seq += ch;
        if (ch >= "@" && ch <= "~") {
          // 终止字节：仅保留颜色 / 样式（SGR）
          if (ch === "m") buffer += seq;
          state = "text";
        }
        continue;
      }

      if (ch === "\x1b") {
        state = "esc";
        seq = "\x1b";
        continue;
      }
      if (ch === "\r") {
        buffer = "";
        continue;
      }
      if (ch === "\n") {
        this.pushLine(buffer);
        buffer = "";
        continue;
      }
      if (ch === "\x07" || ch === "\x08") continue; // 蜂鸣 / 退格
      buffer += ch;
    }

    // 无换行的超长输出（如 `tr -d '\n'`）会让 partial 无界增长，
    // 行数上限对它无效；超过阈值就当作一整行收下。
    if (buffer.length > MAX_PARTIAL) {
      this.pushLine(buffer);
      buffer = "";
    }

    this.parseState = state;
    this.parseSeq = seq;
    this.partial = buffer;
    this.onChange();
  }

  private pushLine(line: string): void {
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) {
      this.lines.splice(0, this.lines.length - MAX_LINES);
    }
  }

  private flushPartial(): void {
    if (!this.partial) return;
    this.pushLine(this.partial);
    this.partial = "";
  }
}

// -------------------------------------------------------------------- 补全

/**
 * 右侧终端每条命令独立执行（非持久 shell），因此 shell 自身的 Tab 补全不可用，
 * 这里在客户端实现一份等价的补全：命令位置补 PATH 中的可执行名，参数位置补文件路径。
 */

/** 参与补全的内建命令（不存在于 PATH） */
const BUILTINS = [
  "alias",
  "cd",
  "clear",
  "cls",
  "echo",
  "exit",
  "export",
  "false",
  "history",
  "pwd",
  "set",
  "source",
  "true",
  "type",
  "unalias",
  "unset",
  "which",
];

/** PATH 中的命令名 + 内建命令（首次扫描后缓存，避免每次 Tab 都遍历磁盘） */
let commandCache: string[] | null = null;

function allCommands(): string[] {
  if (commandCache) return commandCache;
  const names = new Set<string>(BUILTINS);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) names.add(name);
  }
  commandCache = [...names].sort();
  return commandCache;
}

function commonPrefix(values: string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

/** 把用户输入的目录片段（可能是相对路径 / 绝对路径 / ~）解析为绝对路径 */
function resolveDir(cwd: string, dirPart: string): string {
  if (!dirPart) return cwd;
  if (dirPart === "~" || dirPart.startsWith("~/")) {
    return path.join(os.homedir(), dirPart.slice(1));
  }
  return path.isAbsolute(dirPart) ? dirPart : path.resolve(cwd, dirPart);
}

interface PathScan {
  /** 用户输入中「目录部分」（保留原样，用于回填，含结尾 /） */
  dirPart: string;
  /** 待补全的文件名前缀 */
  base: string;
  /** 候选条目（目录以 / 结尾） */
  names: string[];
}

/** 判定条目是否为目录：符号链接要解析真实类型（Dirent.isDirectory() 对链接返回 false） */
function isDirectoryEntry(entry: fs.Dirent, dir: string): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(dir, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

function scanPath(cwd: string, word: string, dirOnly: boolean): PathScan {
  const slash = word.lastIndexOf("/");
  const dirPart = slash >= 0 ? word.slice(0, slash + 1) : "";
  const base = word.slice(slash + 1);

  const dir = resolveDir(cwd, dirPart);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { dirPart, base, names: [] };
  }

  const names = entries
    .filter((entry) => {
      if (dirOnly && !isDirectoryEntry(entry, dir)) return false;
      // 除非用户显式输入 . 开头，否则不提示隐藏项
      if (entry.name.startsWith(".") && !base.startsWith(".")) return false;
      return entry.name.startsWith(base);
    })
    .map((entry) => entry.name + (isDirectoryEntry(entry, dir) ? "/" : ""))
    .sort();

  return { dirPart, base, names };
}

export interface TermCompletion {
  /** 补全后的整行输入 */
  line: string;
  /** 补全后的光标位置 */
  cursor: number;
  /** 不为空时表示无法继续补全，应把这些候选展示给用户 */
  candidates: string[];
}

/**
 * 计算 Tab 补全结果。
 * - 唯一候选：直接补全（目录补 `/`，命令/文件后补空格）
 * - 多候选：先补公共前缀；若已无法扩展则返回候选列表供展示
 * - 无候选：返回 null
 */
export function completeTermInput(
  cwd: string,
  line: string,
  cursor: number,
): TermCompletion | null {
  const rawBefore = line.slice(0, cursor);
  // 尾部空白：回退到上一个未完成的词（与 shell 的 Tab 行为一致，
  // 否则 `cat src/tui/ ` 会被当成"补全当前目录"）
  const before = rawBefore.replace(/\s+$/, "");

  const wordStart = before.lastIndexOf(" ") + 1;
  let word = before.slice(wordStart);
  const head = before.slice(0, wordStart);

  // `VAR=path` 形式：只补全 `=` 之后的部分
  let assignPrefix = "";
  const eq = word.lastIndexOf("=");
  if (eq >= 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word.slice(0, eq))) {
    assignPrefix = word.slice(0, eq + 1);
    word = word.slice(eq + 1);
  }

  // 引号包裹的路径（`cat "src/tu`）—— 剥离引号参与补全，回填时再补上
  let quote = "";
  if (word.startsWith('"') || word.startsWith("'")) {
    quote = word[0];
    word = word.slice(1);
  }

  // 显式路径（./ ../ / ~ 开头）即使在命令位置也按路径补全
  const looksLikePath =
    word.startsWith("./") ||
    word.startsWith("../") ||
    word.startsWith("/") ||
    word.startsWith("~");
  const isCommand =
    head.trim().length === 0 && !looksLikePath && assignPrefix.length === 0;

  const wrap = (value: string): string => `${assignPrefix}${quote}${value}`;

  let dirPart = "";
  let names: string[];
  if (isCommand) {
    names = allCommands().filter((name) => name.startsWith(word));
  } else {
    // `cd` 只补目录
    const firstWord = head.trim().split(/\s+/)[0] ?? "";
    const scan = scanPath(cwd, word, firstWord === "cd");
    dirPart = scan.dirPart;
    names = scan.names;
  }

  if (names.length === 0) return null;

  // 唯一候选：直接补全
  if (names.length === 1) {
    const completed = dirPart + names[0];
    const isDir = completed.endsWith("/");
    const closed = quote && !isDir ? quote : "";
    const suffix = isDir ? "" : " ";
    const nextBefore = head + wrap(completed) + closed + suffix;
    return {
      line: nextBefore + line.slice(cursor),
      cursor: nextBefore.length,
      candidates: [],
    };
  }

  // 多候选：尽量补公共前缀
  const base = isCommand ? word : word.slice(dirPart.length);
  const common = commonPrefix(names);
  if (common.length > base.length) {
    const nextBefore = head + wrap(dirPart + common);
    return {
      line: nextBefore + line.slice(cursor),
      cursor: nextBefore.length,
      candidates: [],
    };
  }

  // 已无法继续补全：展示候选
  return {
    line,
    cursor,
    candidates: names.map((name) => wrap(dirPart + name)),
  };
}
