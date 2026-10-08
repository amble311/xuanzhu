import * as fs from "fs";
import * as path from "path";
import { Agent, type AgentEvents } from "../core/agent";
import {
  effectiveModels,
  saveConfig,
  type ModelEntry,
  type XuanZhuConfig,
} from "../config/store";
import { findProvider } from "../llm";
import { friendlyError } from "../llm/http";
import type { LLMProvider, ToolCall } from "../llm/types";
import type { ExecuteToolResult } from "../tools";
import type { ConfirmRequest } from "../tools/types";
import { expandHome, getConfigDir } from "../utils/paths";
import { VERSION } from "../utils/version";
import { ensureProjectDir } from "../workspace";
import {
  ansi,
  cursor,
  padEnd,
  sanitizeControl,
  screen,
  textWidth,
  truncate,
  wrapText,
} from "../utils/ansi";
import { MarkdownRenderer } from "./markdown";
import { completeTermInput, ShellPanel } from "./terminal";

export interface TuiAppOptions {
  provider: LLMProvider;
  config: XuanZhuConfig;
  cwd: string;
  providerLabel: string;
  model: string;
  /** 当前模型的调用权重（多模型权重机制） */
  modelWeight?: number;
  /** 启动时选中的模型条目，交由 Agent 做失败降级切换 */
  activeModel?: ModelEntry | null;
  /**
   * 是否启用意图分析。缺省时读取配置中的 `intent.enabled`；
   * CLI 的 `--intent` / `--no-intent` 会在此给出显式覆盖值（不写回配置）。
   */
  intentEnabled?: boolean;
  autoApprove: boolean;
  /**
   * 启动时先显示在输出区的提示（多行字符串）。
   *
   * 用于「上次运行疑似异常退出」这类必须在界面里看到的信息 ——
   * 直接写 stdout 的话，会被随后进入的备用屏覆盖掉。
   */
  startupNotice?: string;
}

interface PendingConfirm {
  request: ConfirmRequest;
  resolve: (approved: boolean) => void;
  selected: boolean;
}

interface InputLayout {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
}

/** 玄猪全屏终端界面 */
/**
 * 在不依赖 TuiApp 实例的前提下恢复终端状态。
 *
 * 供未捕获异常 / SIGTERM / SIGHUP 这类「非正常退出」路径调用：
 * 进入界面时开启了备用屏、鼠标上报、关闭了自动换行、还改写了 modifyOtherKeys，
 * 若不在退出前还原，shell 会残留「点鼠标吐转义码」「输出不换行」等坏状态。
 */
export function restoreTerminalSafely(): void {
  try {
    process.stdout.write(
      // 关闭括号粘贴与鼠标上报、恢复自动换行，并把 modifyOtherKeys 还原为终端初始设置，
      // 再退出备用屏幕
      "\x1b[?2004l" +
        "\x1b[>4m" +
        "\x1b[?1000l\x1b[?1006l\x1b[?7h" +
        ansi.reset +
        cursor.show +
        screen.exitAlt,
    );
  } catch {
    // 进程即将退出，写失败也无能为力
  }
  try {
    if (process.stdin.isTTY && process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
  } catch {
    // 忽略
  }
}

export class TuiApp {
  private readonly options: TuiAppOptions;
  private readonly agent: Agent;
  private readonly markdown = new MarkdownRenderer();
  private cwd: string;

  /** 当前模型（可能因失败降级而切换） */
  private modelProviderLabel: string;
  private modelLabel: string;
  private modelWeight?: number;

  private lines: string[] = [];
  private input = "";
  private inputCursor = 0;
  private scrollOffset = 0;
  private statusText = "就绪";
  private statusDetail = "";
  private busy = false;
  private exited = false;
  private autoApprove: boolean;
  /** 是否启用意图分析（界面内用 /intent 切换并写回配置） */
  private intentEnabled: boolean;

  private history: string[] = [];
  private historyIndex = -1;

  private pendingConfirm?: PendingConfirm;
  private abortController?: AbortController;
  private keyBuffer = "";
  private escTimer?: NodeJS.Timeout;
  private projectDirCreated?: string;
  private needsRender = false;
  /**
   * 是否捕获鼠标（滚轮 + 拖拽）。
   *
   * **默认关闭**：开启后终端会把**所有**鼠标事件交给应用，包括右键 ——
   * 于是右键菜单、原生拖拽选择、中键粘贴全部失效，而终端层面无法做到
   * 「只捕获滚轮、放行右键」。相比之下滚动有 `PgUp`/`PgDn` 与鼠标滚轮之外的
   * 更重要的键位可用，因此默认把原生鼠标行为还给用户。
   *
   * 需要滚轮滚动输出区时执行 `/mouse` 开启（此时可用 Shift+拖拽临时选择）。
   */
  private mouseCapture = false;
  /** 最近一次对话在输出区中的起始行号（含用户提问），供 /copy last 使用 */
  private lastAnswerStart = 0;
  private streamingPreview = "";
  private termVisible = true;
  private termFocus = false;
  private termScroll = 0;
  private lastLeftWidth = 0;
  /** 上次渲染的物理行数，用于「视口锚定」（见 render） */
  private lastPhysicalCount = 0;
  private lastTermPhysicalCount = 0;

  /** 终端面板的输入行（与左侧对话输入相互独立） */
  private termInput = "";
  private termInputCursor = 0;
  private termHistory: string[] = [];
  private termHistoryIndex = -1;
  private readonly term: ShellPanel;

  private readonly onData = (chunk: string) => this.handleData(chunk);
  private readonly onResize = () => {
    // 用 -1 表示「本次渲染跳过视口锚定」。
    // 不能清零计数：锚定逻辑是「count > lastCount 时把差值补进 scrollOffset」，
    // 清零会让下一次渲染误判为新增了全部行，把已上翻的视口一路推到最顶部。
    this.lastPhysicalCount = -1;
    this.lastTermPhysicalCount = -1;
    this.scheduleRender();
  };

  constructor(options: TuiAppOptions) {
    this.options = options;
    this.cwd = options.cwd;
    this.autoApprove = options.autoApprove;
    this.intentEnabled =
      options.intentEnabled ?? options.config.intent?.enabled === true;
    // 同步到配置对象（内存中）：Agent 读取的是 config.intent.enabled。
    // CLI 的 --intent / --no-intent 只在此覆盖本次运行，不会写回磁盘。
    options.config.intent = {
      ...(options.config.intent ?? { enabled: false }),
      enabled: this.intentEnabled,
    };
    this.modelProviderLabel = options.providerLabel;
    this.modelLabel = options.model;
    this.modelWeight = options.modelWeight;
    this.term = new ShellPanel(options.cwd, () => this.scheduleRender());

    // 首次运行时初始化项目目录（<项目>/.xuanzhu）
    const project = ensureProjectDir(options.cwd);
    if (project.created) {
      this.projectDirCreated = project.paths.dir;
    }
    const events: AgentEvents = {
      onText: (delta) => this.handleTextDelta(delta),
      onReasoning: () => undefined,
      onToolStart: (call) => this.handleToolStart(call),
      onToolEnd: (call, result) => this.handleToolEnd(call, result),
      onStatus: (status, detail) => {
        this.statusText = status;
        this.statusDetail = detail ?? "";
        this.scheduleRender();
      },
      onNotice: (message) => this.handleNotice(message),
      onIntent: (analysis, original) => this.handleIntent(analysis, original),
      onModelChange: (info) => this.handleModelChange(info),
      confirm: (request) => this.requestConfirm(request),
      // 轮次配额用尽时问一次，而不是硬性中断 —— 真实的重构任务常常超过默认轮数，
      // 直接停掉会让工作断在半路。复用同一套确认弹窗（y 继续 / n 结束）。
      onRoundLimit: (used) =>
        this.requestConfirm({
          tool: "round_limit",
          title: `已调用 ${used} 轮工具，是否继续？`,
          detail:
            `本轮对话已执行 ${used} 轮工具调用（达到当前上限），任务可能尚未完成。\n\n` +
            `· 按 y 继续：再追加 ${this.options.config.maxToolRounds} 轮\n` +
            `· 按 n 结束：保留已有进展，本轮到此为止\n\n` +
            `想永久调整上限：编辑配置文件的 maxToolRounds 字段。`,
          danger: false,
        }),
    };
    this.agent = new Agent(
      options.provider,
      options.config,
      options.cwd,
      events,
      options.activeModel,
    );
  }

  async start(): Promise<void> {
    this.enterTerminal();
    if (this.options.startupNotice) {
      for (const line of this.options.startupNotice.split("\n")) {
        this.lines.push(line);
      }
      this.lines.push("");
    }
    if (this.projectDirCreated) {
      this.lines.push(
        `${ansi.green}✓ 已初始化项目目录 ${this.projectDirCreated}${ansi.reset}`,
      );
      this.lines.push(
        `${ansi.gray}  · memory/   项目记忆（玄猪写入，跨会话复用）${ansi.reset}`,
      );
      this.lines.push(
        `${ansi.gray}  · rules.md  项目规则（内容注入系统提示词）${ansi.reset}`,
      );
      this.lines.push("");
    }
    this.scheduleRender();
    await new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  private resolveExit?: () => void;

  // ---------------------------------------------------------------- 终端控制

  private enterTerminal(): void {
    process.stdout.write(
      screen.enterAlt +
        cursor.hide +
        // 关闭自动换行：即使某行略超宽也不会折行并推动整屏滚动
        "\x1b[?7l" +
        // 启用鼠标上报（含滚轮），并采用 SGR 扩展坐标。
        // 注意这会禁用终端的原生拖拽选择 —— 需要选择文本时用 `/mouse` 临时关闭，
        // 或在任何终端里按住 Shift 拖拽（多数终端会用 Shift 绕过应用级鼠标捕获）。
        (this.mouseCapture ? "\x1b[?1000h\x1b[?1006h" : "\x1b[?1000l\x1b[?1006l") +
        // 启用括号粘贴：终端会把粘贴内容包在 ESC[200~ … ESC[201~ 之间，
        // 我们据此整段插入 —— 否则多行内容里的换行会被逐个当成「提交」，
        // 粘贴一大段文本就会连发好几条消息。
        "\x1b[?2004h" +
        // 请求上报带修饰键的 Enter 等按键
        this.extendedKeyRequest(),
    );
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", this.onData);
    process.stdout.on("resize", this.onResize);
  }

  /**
   * 把当前未完成的流式预览「落定」到输出区。
   *
   * streamingPreview 是渲染时追加在**最末尾**的临时行，而工具调用 / 提示等事件
   * 会把新行 push 进 lines（位置在预览之前）。若不先落定，就会出现
   * 「工具行在上、它前面那句还没换行的正文被挤到下面」的顺序错乱。
   */
  private flushStreamingPreview(): void {
    if (this.streamingPreview) {
      this.lines.push(this.streamingPreview);
      this.streamingPreview = "";
    }
  }

  /** 输出区保留的最大行数（超出丢弃最旧的，避免长会话内存无界增长） */
  private static readonly MAX_OUTPUT_LINES = 4000;

  /** 裁剪输出区，只保留最近的若干行 */
  private trimOutputLines(): void {
    const max = TuiApp.MAX_OUTPUT_LINES;
    if (this.lines.length > max) {
      this.lines.splice(0, this.lines.length - max);
    }
  }

  private exitTerminal(): void {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = undefined;
    }
    process.stdin.off("data", this.onData);
    process.stdout.off("resize", this.onResize);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    process.stdout.write(
      // 关闭括号粘贴与鼠标上报、恢复自动换行，并把 modifyOtherKeys 还原为终端初始设置，
      // 再退出备用屏幕
      "\x1b[?2004l" +
        "\x1b[>4m" +
        "\x1b[?1000l\x1b[?1006l\x1b[?7h" +
        ansi.reset +
        cursor.show +
        screen.exitAlt,
    );
  }

  /**
   * 请求终端上报「修饰键 + Enter」等按键（`\x1b[>4;2m` = xterm modifyOtherKeys level 2）。
   *
   * ⚠️ 曾经在这里**额外叠加** kitty 键盘协议（`\x1b[>1u`），想借此让 xterm.js 类终端
   * 也能上送 Shift+Enter。实测这是有害的：部分终端收到 `>1u` 后**只处理 `u` 系列序列、
   * 放弃 `~` 系列**，导致原本好用的 modifyOtherKeys（`CSI 27;<mod>;13~`）失效 ——
   * 表现为 Ctrl+Enter 与 Shift+Enter **双双失灵**，而 Alt+Enter 仍可用
   * （它走终端原生的 `ESC CR` 编码，不依赖任何协议）。
   *
   * 因此这里只保留单一协议，不再叠加。
   *
   * kitty / Ghostty 把这条 xterm 兼容序列映射到自家的 progressive enhancement 协议上
   * （level 2 等价于「所有按键都用转义码上报」，连普通字母都会变成 `CSI <code>u`），
   * 启用后反而会破坏输入，因此这两类终端跳过——它们本身就会直接上送 `CSI 13;2u`。
   * 不识别该序列的终端（如 xterm.js）会直接忽略，无副作用。
   */
  private extendedKeyRequest(): string {
    const term = process.env.TERM ?? "";
    const program = process.env.TERM_PROGRAM ?? "";

    // 手动改用 kitty 键盘协议：给「modifyOtherKeys 不生效」的终端一条出路
    // （典型是基于 xterm.js 的 IDE 内置终端）。
    // 它只让**有歧义的按键**改发转义码，普通输入不受影响。
    // 之所以不默认开启，是因为 0.1.6 曾无条件叠加它，结果在部分终端上
    // **挤掉了原本可用的 modifyOtherKeys**（详见上面的说明）。
    // 用 `XZH_KITTY_KEYS=1 xzh` 可试用；若 Ctrl/Shift+Enter 从此正常，就是它了。
    if (process.env.XZH_KITTY_KEYS) return "\x1b[>1u";

    if (process.env.KITTY_WINDOW_ID) return "";
    if (/kitty|ghostty/i.test(term) || /kitty|ghostty/i.test(program)) {
      return "";
    }
    return "\x1b[>4;2m";
  }

  private shutdown(): void {
    if (this.exited) return;
    this.exited = true;
    // 右侧终端里的命令以 detached 独立进程组运行，不主动终止会成为孤儿进程
    this.term.dispose();
    this.exitTerminal();
    this.resolveExit?.();
  }

  // ------------------------------------------------------------------ 事件流

  private handleTextDelta(delta: string): void {
    // 模型正文可能含终端控制序列（清屏 / 退出备用屏等），渲染前必须剥掉
    const completed = this.markdown.push(sanitizeControl(delta));
    if (completed.length > 0) {
      this.lines.push(...completed);
    }
    this.streamingPreview = this.markdown.peek();
    this.scheduleRender();
  }

  private handleToolStart(call: ToolCall): void {
    // 先落定未完成的正文，否则它会被渲染到工具行下方，顺序错乱
    this.flushStreamingPreview();
    const summary = summarizeToolCall(call);
    this.lines.push(`${ansi.magenta}⏺${ansi.reset} ${ansi.bold}${call.name}${ansi.reset} ${ansi.gray}${summary}${ansi.reset}`);
    this.statusText = `执行 ${call.name}`;
    this.scheduleRender();
  }

  private handleToolEnd(_call: ToolCall, result: ExecuteToolResult): void {
    this.flushStreamingPreview();
    // summary 由工具生成，可能包含被读文件的片段或命令输出，同样需要净化
    const preview = sanitizeControl(
      result.summary ?? (result.ok ? "完成" : "失败"),
    ).slice(0, 60);
    const mark = result.denied
      ? `${ansi.yellow}⎿ 已拒绝${ansi.reset}`
      : result.ok
        ? `${ansi.green}⎿ ${preview}${ansi.reset}`
        : `${ansi.red}⎿ ${preview}${ansi.reset}`;
    this.lines.push(`  ${mark}`);
    this.statusText = "思考中";
    this.scheduleRender();
  }

  /** 把工具内部日志追加到输出区 */
  private handleNotice(rawMessage: string): void {
    this.flushStreamingPreview();
    // 提示文本里常夹带服务端返回的错误体或命令输出，一并净化
    const message = sanitizeControl(rawMessage);
    for (const line of message.split("\n")) {
      if (line.trim().length > 0) {
        this.lines.push(`${ansi.gray}  ${line}${ansi.reset}`);
      }
    }
    this.scheduleRender();
  }

  /** 意图分析完成：展示分析结果（它将被用作本次输入） */
  private handleIntent(rawAnalysis: string, original: string): void {
    const MAX_LINES = 14;
    const analysis = sanitizeControl(rawAnalysis);
    const rows = analysis
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    this.lines.push(`${ansi.gray}⌁ 意图分析结果（将作为本次输入）${ansi.reset}`);
    for (const line of rows.slice(0, MAX_LINES)) {
      this.lines.push(`${ansi.gray}  ${line}${ansi.reset}`);
    }
    if (rows.length > MAX_LINES) {
      this.lines.push(
        `${ansi.gray}  …（共 ${rows.length} 行，完整内容已作为输入发送）${ansi.reset}`,
      );
    }
    this.lines.push(
      `${ansi.gray}  原始消息：${truncate(original.replace(/\s+/g, " "), 60)}${ansi.reset}`,
    );
    this.scheduleRender();
  }

  /** 模型降级切换 / 权重耗尽重置后的界面更新 */
  private handleModelChange(info: {
    provider: string;
    model: string;
    weight: number;
    reason: string;
  }): void {
    this.modelProviderLabel =
      findProvider(info.provider)?.label ?? info.provider;
    this.modelLabel = info.model;
    this.modelWeight = info.weight;
    // 只有真正发生「切换」才在输出区提示；纯降权仅更新状态栏，避免刷屏
    if (info.reason !== "调用失败降权") {
      this.lines.push(
        `${ansi.yellow}⇄ 模型已切换为 ${info.provider}/${info.model}（权重 ${info.weight}）${ansi.reset}`,
      );
    }
    this.scheduleRender();
  }

  private requestConfirm(request: ConfirmRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pendingConfirm = { request, resolve, selected: true };
      this.scheduleRender();
    });
  }

  // ------------------------------------------------------------------ 输入

  private handleData(chunk: string): void {
    if (process.env.XZH_DEBUG_KEYS) this.logRawKeys(chunk);
    this.keyBuffer += chunk;
    this.drainKeys();
  }

  /**
   * 把终端送来的原始字节追加到 `<全局目录>/keys.log`。
   *
   * 仅用于排查「某个组合键在玄猪里没反应」这类问题，根因通常在**终端侧**：
   * 有的终端把 Ctrl+Enter 与 Enter 编成完全相同的字节，程序无从区分。
   *
   * 用法：`XZH_DEBUG_KEYS=1 xzh` 启动，按几下目标键再退出，然后看该文件。
   */
  private logRawKeys(chunk: string): void {
    const hex = [...chunk]
      .map((c) => c.codePointAt(0)!.toString(16).padStart(2, "0"))
      .join(" ");
    const readable = chunk
      .replace(/\x1b/g, "\\e")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n");
    try {
      fs.appendFileSync(
        path.join(getConfigDir(), "keys.log"),
        `${new Date().toISOString()}  hex=[${hex}]  raw=${JSON.stringify(readable)}\n`,
      );
    } catch {
      // 写不了日志不影响使用
    }
  }

  /**
   * 依次取出并处理按键。
   *
   * 转义序列（方向键、PgUp 等）可能被终端分片送达（例如先到 "\x1b"，再到 "[A"）。
   * 遇到不完整的序列前缀时先等待后续字节，超时后再判定：
   * - 确实只是单独的 ESC → 作为 ESC 处理；
   * - 其他不完整序列 → 直接丢弃，避免残留字符被当作输入插入。
   */
  private drainKeys(): void {
    for (;;) {
      const key = this.readKey();
      if (key === null) {
        if (this.keyBuffer.startsWith("\x1b")) {
          if (this.escTimer) clearTimeout(this.escTimer);
          this.escTimer = setTimeout(() => {
            this.escTimer = undefined;
            const pending = this.keyBuffer;
            this.keyBuffer = "";
            if (pending === "\x1b") {
              this.handleKey("\x1b");
            }
          }, 40);
        }
        return;
      }
      if (this.escTimer) {
        clearTimeout(this.escTimer);
        this.escTimer = undefined;
      }
      this.handleKey(key);
      if (this.exited) return;
    }
  }

  private readKey(): string | null {
    const buf = this.keyBuffer;
    if (buf.length === 0) return null;

    // 括号粘贴（bracketed paste）：终端把粘贴内容包在 \x1b[200~ … \x1b[201~ 之间。
    // 必须整段取出交给 handleKey 一次性插入 —— 否则其中的换行会被当成「提交」，
    // 粘贴一大段文本就会连发好几条消息。内容可能分多次到达，未收全时返回 null 等待。
    if (buf.startsWith("\x1b[200~")) {
      const end = buf.indexOf("\x1b[201~", 6);
      if (end === -1) return null;
      this.keyBuffer = buf.slice(end + 6);
      return buf.slice(0, end + 6);
    }

    if (buf[0] === "\x1b") {
      // 完整 CSI 序列（final byte 位于 0x40–0x7E）
      const csi = /^\x1b\[[0-9:;<=>?]*[@-~]/.exec(buf);
      if (csi) {
        this.keyBuffer = buf.slice(csi[0].length);
        return csi[0];
      }
      // 完整 SS3 序列（如 \x1bOA）
      const ss3 = /^\x1bO[A-Za-z]/.exec(buf);
      if (ss3) {
        this.keyBuffer = buf.slice(ss3[0].length);
        return ss3[0];
      }
      // 仍是序列前缀（\x1b / \x1b[ / \x1b[1;5 等）：等待后续字节
      if (/^\x1b\[?[0-9:;<=>?]*$/.test(buf)) return null;
      // ESC + 单个非序列字符
      if (buf.length >= 2) {
        this.keyBuffer = buf.slice(2);
        return buf.slice(0, 2);
      }
      return null;
    }
    const cp = buf.codePointAt(0);
    if (cp === undefined) return null;
    const char = String.fromCodePoint(cp);
    this.keyBuffer = buf.slice(char.length);
    return char;
  }

  private handleKey(rawKey: string): void {
    // 括号粘贴：整段一次性插入输入框（保留其中的换行），不逐字走按键逻辑 ——
    // 逐字处理会让内容里的回车触发「提交」，也会把粘贴的转义码当控制键执行。
    if (rawKey.startsWith("\x1b[200~") && rawKey.endsWith("\x1b[201~")) {
      const pasted = rawKey
        .slice(6, rawKey.length - 6)
        .replace(/\r\n?/g, "\n")
        // 去掉残留的控制字符，避免粘贴内容里的光标移动指令干扰渲染
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
      if (pasted) this.insertText(pasted);
      return;
    }

    // 归一化终端的扩展按键序列（Ctrl/Shift+Enter、modifyOtherKeys 下的 Ctrl+字母等）
    const key = normalizeKey(rawKey);
    if (this.pendingConfirm) {
      this.handleConfirmKey(key);
      return;
    }

    // 鼠标事件：左键点击切换焦点，滚轮滚动所在栏
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(key);
    if (mouse) {
      this.handleMouse(mouse);
      return;
    }

    // Shift+Tab：在「对话输入」与「右侧终端」之间切换焦点
    if (key === "\x1b[Z") {
      this.toggleFocus();
      return;
    }

    if (this.termFocus) {
      this.handleTermKey(key);
      return;
    }

    switch (key) {
      case "\x03": // Ctrl+C
        if (this.busy) {
          this.abortController?.abort();
          this.statusText = "中断中…";
          this.scheduleRender();
        } else if (this.input.length > 0) {
          this.input = "";
          this.inputCursor = 0;
          this.scheduleRender();
        } else {
          this.shutdown();
        }
        return;
      case "\x04": // Ctrl+D：本轮对话正在进行时结束它；任何情况下都不退出界面
        if (this.busy) {
          this.abortController?.abort();
          this.statusText = "中断中…";
          this.scheduleRender();
        }
        return;
      case "\r": // Enter
        void this.submit();
        return;
      case "\x0a": // Ctrl+J 换行
        this.insertText("\n");
        return;
      case "\x7f":
      case "\b":
        this.backspace();
        return;
      case "\x01": // Ctrl+A
        this.inputCursor = 0;
        this.scheduleRender();
        return;
      case "\x05": // Ctrl+E
        this.inputCursor = this.input.length;
        this.scheduleRender();
        return;
      case "\x0c": // Ctrl+L
        this.lines = [];
        this.scrollOffset = 0;
        this.scheduleRender();
        return;
      case "\x1b[A": // Up
        this.navigateHistory(-1);
        return;
      case "\x1b[B": // Down
        this.navigateHistory(1);
        return;
      case "\x1b[C": // Right
        this.moveCursor(1);
        return;
      case "\x1b[D": // Left
        this.moveCursor(-1);
        return;
      case "\x1b[5~": // PageUp：向上翻页
        this.scrollBy(5);
        return;
      case "\x1b[6~": // PageDown：向下翻页
        this.scrollBy(-5);
        return;
      case "\x1b[1;2A": // Shift+Up：逐行上翻
        this.scrollBy(1);
        return;
      case "\x1b[1;2B": // Shift+Down：逐行下翻
        this.scrollBy(-1);
        return;
      case "\x1b[H": // Home：跳到最早的历史
      case "\x1b[1~":
      case "\x1b[7~":
        this.scrollToTop();
        return;
      case "\x1b[F": // End：回到最新
      case "\x1b[4~":
      case "\x1b[8~":
        this.scrollToBottom();
        return;
      default:
        if (key.charCodeAt(0) >= 0x20) {
          this.insertText(key);
        }
    }
  }

  /** 鼠标：滚轮滚动指针所在栏，左键点击切换焦点 */
  private handleMouse(match: RegExpExecArray): void {
    const button = Number(match[1]);
    const column = Number(match[2]);
    const pressed = match[4] === "M";
    const termWidth = this.resolveTermWidth(process.stdout.columns || 80);
    const inTerm =
      this.lastLeftWidth > 0 &&
      termWidth > 0 &&
      column > this.lastLeftWidth + 1;

    // 滚轮必须先于「左键单击」判断：
    // 滚轮的按钮码为 64(上翻)/65(下翻)，其低位与左键同为 0，
    // 若先判 (button & 3) === 0，上翻会被误判成点击而直接返回，
    // 结果就是「只能往下、永远回不到历史」。
    if (pressed && (button & 64) === 64) {
      const upwards = (button & 1) === 0;
      const delta = upwards ? 3 : -3;
      if (inTerm) {
        this.scrollTermBy(delta);
      } else {
        this.scrollBy(delta);
      }
      return;
    }

    // 左键按下（排除拖拽的移动标志位）：焦点跟随鼠标点击的栏目
    if (pressed && (button & 3) === 0 && (button & 32) === 0) {
      if (inTerm !== this.termFocus) {
        this.termFocus = inTerm;
        this.scheduleRender();
      }
    }
  }

  /** Shift+Tab：在对话输入与右侧终端之间切换焦点 */
  private toggleFocus(): void {
    if (!this.termVisible) {
      this.lines.push(
        `${ansi.gray}终端面板已隐藏，输入 /term 可重新显示。${ansi.reset}`,
      );
      this.scheduleRender();
      return;
    }
    this.termFocus = !this.termFocus;
    this.scheduleRender();
  }

  /** 终端面板聚焦时的按键处理 */
  private handleTermKey(key: string): void {
    switch (key) {
      case "\x04": // Ctrl+D：直接中断正在运行的命令（任何情况下都不会退出玄猪）
        if (this.term.isRunning()) {
          this.term.interrupt();
          this.scheduleRender();
        }
        return;
      case "\x03": // Ctrl+C：中断命令 / 清空输入 / 回到对话
        if (this.term.isRunning()) {
          this.term.interrupt();
        } else if (this.termInput.length > 0) {
          this.termInput = "";
          this.termInputCursor = 0;
        } else {
          this.termFocus = false;
        }
        this.scheduleRender();
        return;
      case "\r":
        this.submitTermCommand();
        return;
      case "\t": // Tab：命令名 / 路径补全
        this.applyTermCompletion();
        return;
      case "\x7f":
      case "\b":
        this.termBackspace();
        return;
      case "\x01":
        this.termInputCursor = 0;
        this.scheduleRender();
        return;
      case "\x05":
        this.termInputCursor = this.termInput.length;
        this.scheduleRender();
        return;
      case "\x0c": // Ctrl+L：清空终端输出
        this.term.clear();
        this.scrollTermToBottom();
        return;
      case "\x1b[A":
        this.navigateTermHistory(-1);
        return;
      case "\x1b[B":
        this.navigateTermHistory(1);
        return;
      case "\x1b[C":
        this.termInputCursor = Math.min(
          this.termInput.length,
          this.termInputCursor + 1,
        );
        this.scheduleRender();
        return;
      case "\x1b[D":
        this.termInputCursor = Math.max(0, this.termInputCursor - 1);
        this.scheduleRender();
        return;
      case "\x1b[5~": // PageUp：向上翻页
        this.scrollTermBy(5);
        return;
      case "\x1b[6~": // PageDown：向下翻页
        this.scrollTermBy(-5);
        return;
      case "\x1b[1;2A": // Shift+Up：逐行上翻
        this.scrollTermBy(1);
        return;
      case "\x1b[1;2B": // Shift+Down：逐行下翻
        this.scrollTermBy(-1);
        return;
      case "\x1b[H": // Home：跳到最早的输出
      case "\x1b[1~":
      case "\x1b[7~":
        this.scrollTermToTop();
        return;
      case "\x1b[F": // End：回到最新输出
      case "\x1b[4~":
      case "\x1b[8~":
        this.scrollTermToBottom();
        return;
      default:
        if (key.charCodeAt(0) >= 0x20) {
          this.termInput =
            this.termInput.slice(0, this.termInputCursor) +
            key +
            this.termInput.slice(this.termInputCursor);
          this.termInputCursor += key.length;
          this.termScroll = 0;
          this.scheduleRender();
        }
    }
  }

  private termBackspace(): void {
    if (this.termInputCursor <= 0) return;
    let start = this.termInputCursor - 1;
    const code = this.termInput.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff && start > 0) start -= 1;
    this.termInput =
      this.termInput.slice(0, start) + this.termInput.slice(this.termInputCursor);
    this.termInputCursor = start;
    this.scheduleRender();
  }

  private navigateTermHistory(direction: number): void {
    if (this.termHistory.length === 0) return;
    if (this.termHistoryIndex === -1) {
      this.termHistoryIndex = this.termHistory.length;
    }
    this.termHistoryIndex += direction;
    if (this.termHistoryIndex < 0) this.termHistoryIndex = 0;
    if (this.termHistoryIndex >= this.termHistory.length) {
      this.termHistoryIndex = -1;
      this.termInput = "";
      this.termInputCursor = 0;
    } else {
      this.termInput = this.termHistory[this.termHistoryIndex];
      this.termInputCursor = this.termInput.length;
    }
    this.scheduleRender();
  }

  private submitTermCommand(): void {
    const command = this.termInput.trim();
    if (!command) return;
    this.termInput = "";
    this.termInputCursor = 0;
    this.termScroll = 0;
    this.termHistory.push(command);
    this.termHistoryIndex = -1;
    this.term.run(command);
    this.scheduleRender();
  }

  /** Tab 补全：命令位置补 PATH 中的命令，参数位置补文件路径 */
  private applyTermCompletion(): void {
    const result = completeTermInput(
      this.term.getCwd(),
      this.termInput,
      this.termInputCursor,
    );
    if (!result) return;

    if (result.candidates.length > 0) {
      // 已有多个候选且无法继续补全：列出候选（过多时截断，避免刷屏）
      const MAX_SHOWN = 24;
      const shown = result.candidates.slice(0, MAX_SHOWN);
      const more =
        result.candidates.length > shown.length
          ? `  …（共 ${result.candidates.length} 项）`
          : "";
      this.term.notice(
        `${ansi.gray}${shown.join("   ")}${more}${ansi.reset}`,
      );
    } else {
      this.termInput = result.line;
      this.termInputCursor = result.cursor;
      this.termScroll = 0;
    }
    this.scheduleRender();
  }

  private handleConfirmKey(key: string): void {
    const pending = this.pendingConfirm;
    if (!pending) return;
    switch (key) {
      case "y":
      case "Y":
      case "\r":
        this.resolveConfirm(true);
        return;
      case "\x04": // Ctrl+D：拒绝该操作并立即终止当前对话
        this.abortController?.abort();
        this.resolveConfirm(false);
        return;
      case "n":
      case "N":
      case "\x1b":
      case "\x03":
        this.resolveConfirm(false);
        return;
      case "\x1b[C":
      case "\x1b[D":
      case "\t":
        pending.selected = !pending.selected;
        this.scheduleRender();
        return;
      default:
        return;
    }
  }

  private resolveConfirm(approved: boolean): void {
    const pending = this.pendingConfirm;
    if (!pending) return;
    this.pendingConfirm = undefined;
    const label = approved ? "已允许" : "已拒绝";
    this.lines.push(`  ${approved ? ansi.green : ansi.yellow}${label}${ansi.reset}`);
    pending.resolve(approved);
    this.scheduleRender();
  }

  private insertText(text: string): void {
    this.input =
      this.input.slice(0, this.inputCursor) +
      text +
      this.input.slice(this.inputCursor);
    this.inputCursor += text.length;
    this.scrollOffset = 0;
    this.scheduleRender();
  }

  private backspace(): void {
    if (this.inputCursor <= 0) return;
    // 处理代理对
    let start = this.inputCursor - 1;
    const code = this.input.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff && start > 0) {
      start -= 1;
    }
    this.input = this.input.slice(0, start) + this.input.slice(this.inputCursor);
    this.inputCursor = start;
    this.scheduleRender();
  }

  private moveCursor(delta: number): void {
    const next = this.inputCursor + delta;
    this.inputCursor = Math.max(0, Math.min(this.input.length, next));
    this.scheduleRender();
  }

  private navigateHistory(direction: number): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) {
      this.historyIndex = this.history.length;
    }
    this.historyIndex += direction;
    if (this.historyIndex < 0) this.historyIndex = 0;
    if (this.historyIndex >= this.history.length) {
      this.historyIndex = -1;
      this.input = "";
      this.inputCursor = 0;
    } else {
      this.input = this.history[this.historyIndex];
      this.inputCursor = this.input.length;
    }
    this.scheduleRender();
  }

  /** 滚动左侧对话区：delta > 0 表示向更早的历史滚动（偏移量按「距底部行数」计） */
  private scrollBy(delta: number): void {
    this.setScrollOffset(this.scrollOffset + delta);
  }

  /** 设置左栏滚动偏移（上限由渲染时按实际行数收敛） */
  private setScrollOffset(offset: number): void {
    this.scrollOffset = Math.max(0, Math.round(offset));
    this.scheduleRender();
  }

  /** 左栏跳到最早的历史（上限由渲染时收敛到实际可滚动行数） */
  private scrollToTop(): void {
    this.setScrollOffset(Number.MAX_SAFE_INTEGER);
  }

  private scrollToBottom(): void {
    this.setScrollOffset(0);
  }

  /** 滚动右侧终端输出：delta > 0 表示向更早的输出滚动 */
  private scrollTermBy(delta: number): void {
    this.termScroll = Math.max(0, Math.round(this.termScroll + delta));
    this.scheduleRender();
  }

  private scrollTermToTop(): void {
    this.termScroll = Number.MAX_SAFE_INTEGER;
    this.scheduleRender();
  }

  private scrollTermToBottom(): void {
    this.termScroll = 0;
    this.scheduleRender();
  }

  // ------------------------------------------------------------------ 提交

  private async submit(): Promise<void> {
    if (this.busy) return;
    const text = this.input.trim();
    if (!text) return;

    this.input = "";
    this.inputCursor = 0;
    this.scrollOffset = 0;
    this.history.push(text);
    this.historyIndex = -1;

    if (text.startsWith("/")) {
      this.handleCommand(text);
      return;
    }

    // 记录本轮在输出区中的起点（从用户提问那行算起），供 /copy last 精确复制整轮对话
    this.lastAnswerStart = this.lines.length;

    // 用户输入：绿底块标记 + 亮绿加粗正文，便于在历史记录中一眼定位
    const badge = `${ansi.bgGreen}${ansi.black}${ansi.bold} ❯ ${ansi.reset}`;
    const [firstLine, ...restLines] = text.split("\n");
    this.lines.push(
      `${badge} ${ansi.brightGreen}${ansi.bold}${firstLine}${ansi.reset}`,
    );
    for (const line of restLines) {
      this.lines.push(
        `${ansi.brightGreen}${ansi.bold}│${ansi.reset} ${ansi.brightGreen}${line}${ansi.reset}`,
      );
    }
    this.lines.push("");

    this.busy = true;
    this.statusText = "思考中";
    this.statusDetail = "";
    this.abortController = new AbortController();
    this.scheduleRender();

    // 快照本次请求使用的模型：run 内部可能因失败而降权或切换模型，
    // 出错时应报告「实际发起请求时」用的模型，否则会把旧模型的错误归到新模型头上。
    const requestModel = { label: this.modelLabel, weight: this.modelWeight };

    try {
      await this.agent.run(text, this.abortController.signal);
    } catch (err) {
      const [first, ...rest] = friendlyError(err).split("\n");
      this.lines.push(`${ansi.red}✗ ${first}${ansi.reset}`);
      for (const extra of rest) {
        this.lines.push(`${ansi.gray}  ${extra}${ansi.reset}`);
      }
      // 附上本次请求实际使用的模型与权重（用快照，避免被降级切换后的值覆盖）
      const weightText =
        requestModel.weight !== undefined ? `（权重 ${requestModel.weight}）` : "";
      this.lines.push(
        `${ansi.gray}  本次请求使用的模型：${this.modelProviderLabel} / ${requestModel.label}${weightText}${ansi.reset}`,
      );
    } finally {
      const tail = this.markdown.flush();
      if (tail.length > 0) this.lines.push(...tail);
      this.streamingPreview = "";
      this.lines.push("");
      this.busy = false;
      this.abortController = undefined;
      this.statusText = "就绪";
      this.scheduleRender();
    }
  }

  private handleCommand(text: string): void {
    const [command, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(" ");
    switch (command) {
      case "help":
      case "h":
        this.printHelp();
        break;
      case "clear":
        this.lines = [];
        break;
      case "copy":
        this.copyOutput(arg);
        break;
      case "mouse":
        this.toggleMouseCapture();
        break;
      case "reset":
        this.agent.reset();
        this.lines.push(`${ansi.gray}会话已重置。${ansi.reset}`);
        break;
      case "exit":
      case "quit":
      case "q":
        this.shutdown();
        return;
      case "cwd":
        this.lines.push(`${ansi.gray}${this.cwd}${ansi.reset}`);
        break;
      case "switch": {
        if (!arg) {
          this.lines.push(`${ansi.gray}当前目录：${this.cwd}${ansi.reset}`);
          this.lines.push(`${ansi.gray}用法：/switch <目录路径>${ansi.reset}`);
        } else {
          this.switchDirectory(arg);
        }
        break;
      }
      case "term": {
        if (arg === "clear") {
          this.term.clear();
        } else if (arg === "focus") {
          this.termVisible = true;
          this.termFocus = true;
        } else {
          this.termVisible = !this.termVisible;
          if (!this.termVisible) this.termFocus = false;
          this.lines.push(
            `${ansi.gray}终端面板：${this.termVisible ? "显示" : "隐藏"}（Shift+Tab 或鼠标点击切换焦点）${ansi.reset}`,
          );
        }
        break;
      }
      case "auto": {
        const next =
          arg === "on" ? true : arg === "off" ? false : !this.autoApprove;
        this.autoApprove = next;
        this.options.config.autoApprove = next;
        try {
          saveConfig(this.options.config);
        } catch (err) {
          this.lines.push(
            `${ansi.yellow}⚠ 配置保存失败：${err instanceof Error ? err.message : String(err)}${ansi.reset}`,
          );
        }
        this.lines.push(
          next
            ? `${ansi.gray}自动批准：${ansi.brightYellow}开${ansi.reset}${ansi.gray} —— 所有工具（含写文件、执行命令）将直接执行，不再询问；已写入配置。${ansi.reset}`
            : `${ansi.gray}自动批准：关 —— 写文件 / 编辑文件 / 执行命令前会请求确认；已写入配置。${ansi.reset}`,
        );
        break;
      }
      case "intent": {
        const next =
          arg === "on" ? true : arg === "off" ? false : !this.intentEnabled;
        this.intentEnabled = next;
        this.options.config.intent = {
          ...(this.options.config.intent ?? { enabled: false }),
          enabled: next,
        };
        try {
          saveConfig(this.options.config);
        } catch (err) {
          this.lines.push(
            `${ansi.yellow}⚠ 配置保存失败：${err instanceof Error ? err.message : String(err)}${ansi.reset}`,
          );
        }
        this.lines.push(
          next
            ? `${ansi.gray}意图分析：${ansi.brightGreen}开${ansi.reset}${ansi.gray} —— 每条消息会先用模板包裹并请求模型，返回的分析结果作为本次输入；已写入配置。${ansi.reset}`
            : `${ansi.gray}意图分析：关 —— 直接使用你输入的内容；已写入配置。${ansi.reset}`,
        );
        break;
      }
      case "model": {
        const entries = effectiveModels(this.options.config).sort(
          (a, b) => b.weight - a.weight,
        );
        const weightText =
          this.modelWeight !== undefined ? `（权重 ${this.modelWeight}）` : "";
        this.lines.push(
          `${ansi.gray}当前模型：${ansi.reset}${this.modelProviderLabel} / ${this.modelLabel}${ansi.gray}${weightText}${ansi.reset}`,
        );
        if (entries.length > 0) {
          this.lines.push(`${ansi.gray}已配置模型（按权重降序）：${ansi.reset}`);
          for (const entry of entries) {
            const current = entry.model === this.modelLabel ? " ← 当前" : "";
            this.lines.push(
              `${ansi.gray}  · ${entry.id}　权重 ${entry.weight}${current}${ansi.reset}`,
            );
          }
        }
        this.lines.push(
          `${ansi.gray}管理模型（新增 / 删除 / 调整权重）：${ansi.reset}xzh model${ansi.reset}`,
        );
        break;
      }
      default:
        this.lines.push(`${ansi.yellow}未知命令：/${command}，输入 /help 查看帮助。${ansi.reset}`);
    }
    this.scheduleRender();
  }

  /** 切换当前工作目录（/switch） */
  private switchDirectory(input: string): void {
    const expanded = expandHome(input.trim());
    const target = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(this.cwd, expanded);

    if (!fs.existsSync(target)) {
      this.lines.push(`${ansi.red}✗ 目录不存在：${target}${ansi.reset}`);
      this.scheduleRender();
      return;
    }
    if (!fs.statSync(target).isDirectory()) {
      this.lines.push(`${ansi.red}✗ 不是目录：${target}${ansi.reset}`);
      this.scheduleRender();
      return;
    }

    let resolved = target;
    try {
      resolved = fs.realpathSync(target);
    } catch {
      // 保留原始路径
    }

    this.cwd = resolved;
    // 目标目录若尚无项目目录，就地初始化（.xuanzhu 只属于当前项目路径，不做向上查找）
    const project = ensureProjectDir(resolved);
    this.agent.setCwd(resolved);
    this.term.setCwd(resolved);
    this.termScroll = 0;
    this.lines.push(`${ansi.green}✓ 已切换项目目录：${resolved}${ansi.reset}`);
    if (project.created) {
      this.lines.push(
        `${ansi.gray}  已初始化项目目录 ${project.paths.dir}（memory/ 记忆 · rules.md 规则）${ansi.reset}`,
      );
    }
    this.lines.push(
      `${ansi.gray}  后续文件与命令操作将基于该目录；对话上下文已保留（可用 /reset 清空）。${ansi.reset}`,
    );
    this.scheduleRender();
  }

  /**
   * 切换鼠标捕获。
   *
   * 开启鼠标上报后终端会把拖拽事件交给应用，原生选择与复制随之失效；
   * 关闭后可以像普通终端一样框选复制，代价是滚轮不再滚动输出区。
   */
  private toggleMouseCapture(): void {
    this.mouseCapture = !this.mouseCapture;
    process.stdout.write(
      this.mouseCapture ? "\x1b[?1000h\x1b[?1006h" : "\x1b[?1000l\x1b[?1006l",
    );
    this.lines.push(
      this.mouseCapture
        ? `${ansi.gray}鼠标捕获：${ansi.reset}开 ${ansi.gray}— 滚轮可滚动输出区。` +
            `但右键菜单与原生框选会被接管，要选文本请按住 ${ansi.reset}Shift${ansi.gray} 拖拽。` +
            `再输入 ${ansi.reset}/mouse${ansi.gray} 关闭。${ansi.reset}`
        : `${ansi.gray}鼠标捕获：${ansi.reset}${ansi.brightGreen}关${ansi.reset}` +
            `${ansi.gray} — 鼠标全部功能可用（右键菜单、框选复制、滚轮由终端处理）。` +
            `滚动输出区请用 ${ansi.reset}PgUp/PgDn${ansi.gray}，或用 ${ansi.reset}/mouse${ansi.gray} 换回滚轮。${ansi.reset}`,
    );
  }

  /**
   * 把输出区内容写入系统剪贴板（OSC 52）。
   *
   * 为什么需要它：全屏 TUI 开启了鼠标上报，且工作在备用屏上 ——
   * 原生拖拽选择被禁用，即便选中，退出备用屏后内容也会消失。
   * OSC 52 让程序主动把文本交给终端转发给系统剪贴板，不依赖原生选择。
   * 部分终端（如默认配置的 GNOME Terminal）出于安全会忽略该序列，
   * 所以提示里同时给出 Shift+拖拽的兜底办法。
   *
   * 用法：
   *   /copy            最近 30 行
   *   /copy 100        最近 100 行
   *   /copy 100-200    第 100 到第 200 行（按输出区行号）
   *   /copy last       最近一次对话（含提问，不含更早的历史）
   *   /copy all        全部
   */
  private copyOutput(arg: string): void {
    const trimmed = arg.trim().toLowerCase();
    const total = this.lines.length;

    let selected: string[];
    let label: string;

    if (trimmed === "all") {
      selected = this.lines.slice();
      label = "全部";
    } else if (trimmed === "last") {
      selected = this.lines.slice(Math.min(this.lastAnswerStart, total));
      label = "最近一次对话";
    } else if (/^\d+-\d+$/.test(trimmed)) {
      const [fromText, toText] = trimmed.split("-");
      const from = Math.max(1, Number(fromText));
      const to = Math.min(total, Number(toText));
      if (from > to) {
        this.lines.push(
          `${ansi.yellow}行号范围无效：${trimmed}${ansi.reset}` +
            `${ansi.gray}（输出区当前 ${total} 行）${ansi.reset}`,
        );
        return;
      }
      selected = this.lines.slice(from - 1, to);
      label = `第 ${from}-${to} 行`;
    } else {
      const count = /^\d+$/.test(trimmed) ? Number(trimmed) : 30;
      selected = this.lines.slice(-Math.max(1, count));
      label = `最近 ${Math.min(Math.max(1, count), total)} 行`;
    }

    // sanitizeControl 会剥掉颜色与其余控制字符，剪贴板里只留纯文本
    const plain = sanitizeControl(selected.join("\n")).trim();
    if (!plain) {
      const extra =
        trimmed === "last" && total === 0 ? "，尚未进行过对话" : "";
      this.lines.push(
        `${ansi.yellow}没有可复制的内容${ansi.reset}` +
          `${ansi.gray}（输出区当前 ${total} 行${extra}）。${ansi.reset}`,
      );
      return;
    }

    const payload = Buffer.from(plain, "utf8").toString("base64");
    process.stdout.write(`\x1b]52;c;${payload}\x07`);

    const lineCount = plain.split("\n").length;
    this.lines.push(
      `${ansi.green}✓ 已复制${label}（${lineCount} 行）到剪贴板${ansi.reset}` +
        `${ansi.gray}（OSC 52）。若粘贴出来是空的，说明本终端禁用了该序列，` +
        `请改用 ${ansi.reset}Shift${ansi.gray}+鼠标拖拽选择。${ansi.reset}`,
    );
  }

  private printHelp(): void {
    const help = [
      `${ansi.bold}玄猪 内置命令${ansi.reset}`,
      `  /help          显示本帮助`,
      `  /clear         清空屏幕`,
      `  /copy [N|A-B|last|all]  复制输出区到系统剪贴板（默认最近 30 行）`,
      `  /mouse         切换鼠标捕获：关闭后可用鼠标直接框选复制`,
      `  /reset         重置对话上下文`,
      `  /cwd           显示当前工作目录`,
      `  /switch <目录> 切换当前对话的项目目录`,
      `  /term          显示/隐藏右侧终端面板（/term clear 清空输出）`,
      `  /model         显示当前模型与权重、已配置模型列表`,
      `  /auto [on|off] 切换自动批准（on：所有工具直接执行，写入配置）`,
      `  /intent [on|off] 切换意图分析（on：每条消息先做意图分析再处理，写入配置）`,
      `  /exit          退出玄猪`,
      `${ansi.bold}快捷键${ansi.reset}`,
      `  Enter 提交 · Ctrl+Enter / Shift+Enter 换行（Ctrl+J、Alt+Enter 亦可）`,
      `  ↑/↓ 历史 · Ctrl+A/Ctrl+E 行首/行尾 · PgUp/PgDn 翻页 · Shift+↑/↓ 逐行`,
      `  Home/End 跳到最早/最新`,
      `  ${ansi.gray}鼠标${ansi.reset}：默认交还终端 —— 右键菜单、框选复制、中键粘贴都可用；` +
        `滚动输出区用 ${ansi.reset}PgUp/PgDn${ansi.gray}。`,
      `      输入 ${ansi.reset}/mouse${ansi.gray} 可改为让玄猪接管滚轮（此时用 ${ansi.reset}Shift+拖拽${ansi.gray} 选择文本）。${ansi.reset}`,
      `  ${ansi.gray}粘贴${ansi.reset}：支持多行整段粘贴（不会逐行提交）；也可用 ${ansi.reset}/copy${ansi.gray} 复制输出区。${ansi.reset}`,
      `  Shift+Tab 切换焦点（对话 ⇄ 右侧终端）· 鼠标点击亦可`,
      `  Ctrl+C 中断任务 / 清空输入 / 退出（空闲且输入为空时退出）`,
      `  Ctrl+D 结束本轮正在进行的对话 · 任何情况下都不会退出玄猪`,
      `  Ctrl+L 清屏`,
      `  注：若 Ctrl/Shift+Enter 无效（部分 IDE 内置终端会把二者编成与 Enter 相同的字节），`,
      `      请改用 ${ansi.bold}Alt+Enter${ansi.reset} 或 Ctrl+J —— 它们走终端原生编码，各终端通用。`,
      `${ansi.bold}右侧终端${ansi.reset}`,
      `  Enter 执行命令 · ↑/↓ 命令历史 · Ctrl+C / Ctrl+D 中断运行中的命令 · Ctrl+L 清空`,
      `  PgUp/PgDn / Shift+↑↓ / Home/End 回看历史输出（滚动不影响正在运行的命令）`,
      `  命令在当前项目目录下执行；cd 生效（面板自行维护工作目录）`,
    ];
    this.lines.push(...help.map((line) => `${ansi.gray}${line}${ansi.reset}`));
    this.lines.push("");
  }

  /**
   * 顶部固定头部（始终显示，不参与对话滚动）。
   *
   * 信息行与末尾分隔线分开返回：分隔线是「顶部信息区」与「对话区」的分界，
   * 高度受限时必须保留（见 render 的头部裁剪），故不能被一起裁掉。
   */
  private buildHeaderLines(width: number): { info: string[]; divider: string } {
    const weightText =
      this.modelWeight !== undefined ? ` · 权重 ${this.modelWeight}` : "";
    const modelText = truncate(
      `${this.modelProviderLabel} / ${this.modelLabel}${weightText}`,
      Math.max(10, width - 8),
    );
    const dirText = truncate(this.cwd, Math.max(10, width - 8));
    const divider = `${ansi.gray}${"─".repeat(Math.max(0, width))}${ansi.reset}`;
    const info = [
      `${ansi.brightMagenta}${ansi.bold}  玄猪 XuanZhu${ansi.reset} ${ansi.gray}v${VERSION} · 终端 AI 编码 Agent${ansi.reset}`,
      `${ansi.gray}  模型：${ansi.reset}${modelText}${ansi.reset}`,
      `${ansi.gray}  目录：${ansi.reset}${dirText}${ansi.reset}`,
      `${ansi.gray}  输入 ${ansi.reset}${ansi.brightGreen}/help${ansi.reset}${ansi.gray} 查看命令与快捷键${ansi.reset}`,
      `${ansi.gray}  ${ansi.reset}Ctrl+D${ansi.gray} 结束本轮对话（不退出）· ${ansi.reset}Ctrl+C${ansi.gray} 中断/清空/退出${ansi.reset}`,
      `${ansi.gray}  ${ansi.reset}Shift+Tab${ansi.gray} 切终端 · ${ansi.reset}PgUp${ansi.gray}/滚轮回看历史${ansi.reset}`,
    ];
    return { info, divider };
  }

  // ------------------------------------------------------------------ 渲染

  private scheduleRender(): void {
    if (this.needsRender || this.exited) return;
    this.needsRender = true;
    setTimeout(() => {
      this.needsRender = false;
      this.render();
    }, 16);
  }

  private render(): void {
    if (this.exited) return;
    // 每帧先裁剪输出区：lines 从不回收会让长会话内存无界增长，
    // 而 render 每帧都要对全部行重折一遍，行数越多越卡。
    this.trimOutputLines();
    const columns = Math.max(40, process.stdout.columns || 80);
    const rows = Math.max(8, process.stdout.rows || 24);

    // 分栏布局：左侧（头部 / 对话 / 输入）+ 分隔线 + 右侧终端面板，底部状态栏横跨全宽
    const termWidth = this.resolveTermWidth(columns);
    const leftWidth =
      termWidth > 0 ? Math.max(20, columns - termWidth - 1) : columns;
    this.lastLeftWidth = leftWidth;

    const inputBlock = this.pendingConfirm
      ? this.layoutConfirm(leftWidth)
      : this.layoutInput(leftWidth);
    const inputRows = inputBlock.lines.length;
    const statusRows = 1;

    // 固定头部：始终显示，高度不超过终端高度的 1/3。
    // 高度不足时从信息行开始裁剪（保留最上面的品牌行），但末尾分隔线**必须**保留，
    // 否则「顶部信息区」与「对话区」之间没有分界线。
    const header = this.buildHeaderLines(leftWidth);
    const maxHeaderRows = Math.max(1, Math.floor(rows / 3));
    const infoRows = Math.min(
      header.info.length,
      Math.max(0, maxHeaderRows - 1),
    );
    const headerLines = [...header.info.slice(0, infoRows), header.divider];
    const headerRows = headerLines.length;
    const outputRows = Math.max(3, rows - headerRows - inputRows - statusRows);

    // 滚动：scrollOffset 表示「视口底部距最新行的物理行数」，0 即跟随最新输出。
    const allLines = this.physicalLines(leftWidth);
    const count = allLines.length;
    // 视口锚定：已上翻时新到达的行不应把正在阅读的历史顶走，
    // 故把偏移量同步增加新增的物理行数（等于把视口固定在原位置）。
    if (
      this.lastPhysicalCount >= 0 &&
      this.scrollOffset > 0 &&
      count > this.lastPhysicalCount
    ) {
      this.scrollOffset += count - this.lastPhysicalCount;
    }
    this.lastPhysicalCount = count;
    const maxScroll = Math.max(0, count - outputRows);
    if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
    const end = count - this.scrollOffset;
    const start = Math.max(0, end - outputRows);
    const visible = allLines.slice(start, end);
    while (visible.length < outputRows) visible.unshift("");

    const bodyRows = rows - 1;
    const panel =
      termWidth > 0
        ? this.buildTermPanel(termWidth, bodyRows)
        : { rows: [] as string[], cursorRow: 0, cursorCol: 0 };

    const inputStart = headerRows + outputRows;

    let out = cursor.hide;
    for (let i = 0; i < bodyRows; i++) {
      let left: string;
      if (i < headerRows) {
        left = headerLines[i];
      } else if (i < headerRows + outputRows) {
        left = visible[i - headerRows];
      } else if (i < inputStart + inputRows) {
        left = inputBlock.lines[i - inputStart];
      } else {
        left = "";
      }

      out += cursor.to(i + 1, 1) + "\x1b[2K";
      if (termWidth > 0) {
        out +=
          padEnd(truncate(left, leftWidth), leftWidth) +
          `${ansi.gray}│${ansi.reset}` +
          truncate(panel.rows[i] ?? "", termWidth);
      } else {
        out += left;
      }
    }

    out += cursor.to(rows, 1) + "\x1b[2K" + this.renderStatus(columns);

    if (this.pendingConfirm) {
      out += cursor.hide;
    } else if (this.termFocus && termWidth > 0 && panel.cursorRow > 0) {
      // 焦点在右侧终端：光标定位到终端输入行（面板从 leftWidth+2 列开始）
      const row = panel.cursorRow;
      const col = Math.min(columns, leftWidth + 1 + panel.cursorCol);
      out += cursor.to(row, col) + cursor.show;
    } else {
      const row = inputStart + inputBlock.cursorRow + 1;
      const col = Math.min(leftWidth, inputBlock.cursorCol + 1);
      out += cursor.to(row, col) + cursor.show;
    }

    process.stdout.write(out);
  }

  /** 右侧终端面板宽度（0 表示不显示：手动隐藏或终端过窄） */
  private resolveTermWidth(columns: number): number {
    if (!this.termVisible || columns < 80) return 0;
    return Math.min(64, Math.max(32, Math.floor(columns * 0.4)));
  }

  /**
   * 生成右侧终端面板：标题（工作目录 + 运行状态）、输出区（可滚动）、输入行。
   * cursorRow / cursorCol 为面板内 1-based 坐标，供聚焦时定位光标。
   */
  private buildTermPanel(
    width: number,
    height: number,
  ): { rows: string[]; cursorRow: number; cursorCol: number } {
    if (width <= 0 || height <= 0) {
      return { rows: [], cursorRow: 0, cursorCol: 0 };
    }

    const rows: string[] = [];
    const running = this.term.isRunning();

    // 标题行：终端标识 + 当前工作目录 + 运行状态
    const label = this.termFocus
      ? `${ansi.bgBlue}${ansi.brightWhite} 终端 ${ansi.reset}`
      : `${ansi.gray} 终端 ${ansi.reset}`;
    const status = running ? `${ansi.brightYellow} ● 运行中${ansi.reset}` : "";
    const room = Math.max(6, width - 9 - (running ? 5 : 0));
    rows.push(
      `${label}${ansi.gray}${truncate(this.term.getCwd(), room)}${ansi.reset}${status}`,
    );

    // 输出区（物理行，按高度裁切，支持滚动）
    const outputHeight = Math.max(1, height - 3);
    const physical: string[] = [];
    for (const line of this.term.visibleLines()) {
      physical.push(...wrapText(line, width));
    }
    // 视口锚定：与左栏同理，命令持续输出时保持用户正在查看的历史不动
    if (
      this.lastTermPhysicalCount >= 0 &&
      this.termScroll > 0 &&
      physical.length > this.lastTermPhysicalCount
    ) {
      this.termScroll += physical.length - this.lastTermPhysicalCount;
    }
    this.lastTermPhysicalCount = physical.length;
    const maxScroll = Math.max(0, physical.length - outputHeight);
    if (this.termScroll > maxScroll) this.termScroll = maxScroll;
    const end = physical.length - this.termScroll;
    const start = Math.max(0, end - outputHeight);
    const slice = physical.slice(start, end);
    while (slice.length < outputHeight) slice.unshift("");
    rows.push(...slice);

    // 分隔线 + 输入行（超宽时从左侧滚动，保证光标可见）
    rows.push(`${ansi.gray}${"─".repeat(width)}${ansi.reset}`);
    const promptWidth = 2;
    const avail = Math.max(1, width - promptWidth);
    let text = this.termInput;
    let cursorWidth = textWidth(text.slice(0, this.termInputCursor));
    while (cursorWidth > avail && text.length > 0) {
      text = text.slice(1);
      cursorWidth = textWidth(text.slice(0, this.termInputCursor));
    }
    const prompt = this.termFocus
      ? `${ansi.brightCyan}❯${ansi.reset} `
      : `${ansi.gray}❯${ansi.reset} `;
    rows.push(truncate(`${prompt}${text}`, width));

    const cursorRow = rows.length;
    const cursorCol = Math.min(width, promptWidth + cursorWidth + 1);

    while (rows.length < height) rows.push("");
    return { rows: rows.slice(0, height), cursorRow, cursorCol };
  }

  private physicalLines(width: number): string[] {
    const result: string[] = [];
    for (const line of this.lines) {
      result.push(...wrapText(line, width));
    }
    if (this.streamingPreview) {
      result.push(...wrapText(this.streamingPreview, width));
    }
    return result;
  }

  private renderStatus(width: number): string {
    const left = ` 玄猪 `;
    const autoMark = this.autoApprove ? "⚡auto · " : "";
    const intentMark = this.intentEnabled ? "⌁intent · " : "";
    const focusMark = this.termVisible
      ? this.termFocus
        ? "终端▸ "
        : "对话▸ "
      : "";
    const weightMark =
      this.modelWeight !== undefined ? ` w${this.modelWeight}` : "";
    // 滚动指示：偏移量 > 0 时提示已上翻的行数，便于发现「有历史可回看 / 需按 End 回到最新」
    const scrollMark =
      this.scrollOffset > 0
        ? `${ansi.brightYellow}↑${this.scrollOffset}${ansi.reset}${ansi.bgBlue} `
        : "";
    const termScrollMark =
      this.termScroll > 0
        ? `${ansi.brightYellow}⇡${this.termScroll}${ansi.reset}${ansi.bgBlue} `
        : "";
    const right = ` ${autoMark}${intentMark}${focusMark}${scrollMark}${termScrollMark}${this.modelLabel}${weightMark} │ ${this.statusText}${this.statusDetail ? " · " + this.statusDetail : ""} `;
    const middle = ` ${this.cwd} `;
    const elapsed = this.busy ? `${ansi.brightYellow}● 运行中${ansi.reset}${ansi.bgBlue}` : "";
    // elapsed 的显示宽度必须计入保留宽度，否则 busy 时状态栏必然超宽并走兜底截断
    const reserved =
      textWidth(left) + textWidth(right) + textWidth(elapsed) + 6;
    let text = `${ansi.bgBlue}${ansi.brightWhite}${left}${ansi.reset}${ansi.bgBlue}${ansi.brightWhite}${elapsed}${ansi.bgBlue}${ansi.gray}${truncate(middle, Math.max(0, width - reserved))}${ansi.bgBlue}${ansi.brightWhite}${right}${ansi.reset}`;
    const visible = textWidth(text);
    if (visible < width) {
      text += `${ansi.bgBlue}${" ".repeat(width - visible)}${ansi.reset}`;
    } else if (visible > width) {
      // 兜底：任何宽度计算误差都不允许状态栏超出终端宽度（否则会折行并推动整屏滚动）
      text = `${truncate(text, width)}${ansi.reset}`;
    }
    return text;
  }

  private layoutInput(width: number): InputLayout {
    const promptFirst = "❯ ";
    const promptRest = "  ";
    const maxRows = Math.max(1, Math.floor((process.stdout.rows || 24) / 2) - 1);
    const chars = Array.from(this.input);

    // 计算光标所在的 code point 索引
    let cursorCp = 0;
    {
      let count = 0;
      cursorCp = chars.length;
      for (let i = 0; i < chars.length; i++) {
        if (count >= this.inputCursor) {
          cursorCp = i;
          break;
        }
        count += chars[i].length;
      }
    }

    const physLines: string[] = [];
    let current = promptFirst;
    let currentWidth = textWidth(promptFirst);
    let cursorRow = 0;
    let cursorCol = currentWidth;

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === "\n") {
        physLines.push(current);
        current = promptRest;
        currentWidth = textWidth(promptRest);
        if (i === cursorCp) {
          cursorRow = physLines.length;
          cursorCol = currentWidth;
        }
        continue;
      }
      const w = textWidth(ch);
      if (currentWidth + w > width) {
        physLines.push(current);
        current = promptRest;
        currentWidth = textWidth(promptRest);
      }
      if (i === cursorCp) {
        cursorRow = physLines.length;
        cursorCol = currentWidth;
      }
      current += ch;
      currentWidth += w;
    }
    if (cursorCp >= chars.length) {
      cursorRow = physLines.length;
      cursorCol = currentWidth;
    }
    physLines.push(current);

    if (physLines.length > maxRows) {
      const start = Math.max(0, cursorRow - maxRows + 1);
      return {
        lines: physLines.slice(start, start + maxRows),
        cursorRow: cursorRow - start,
        cursorCol,
      };
    }
    return { lines: physLines, cursorRow, cursorCol };
  }

  private layoutConfirm(width: number): InputLayout {
    const pending = this.pendingConfirm!;
    const { request } = pending;
    const lines: string[] = [];
    const danger = request.danger;
    lines.push(
      `${danger ? ansi.brightRed : ansi.brightYellow}⚠ ${request.title}${ansi.reset}`,
    );
    const detailLines = request.detail.split("\n").slice(0, 12);
    for (const detail of detailLines) {
      for (const wrapped of wrapText(`${ansi.gray}${detail}${ansi.reset}`, width - 4)) {
        lines.push(`  ${wrapped}`);
      }
    }
    const allow = pending.selected
      ? `${ansi.inverse}${ansi.green} 允许 ${ansi.reset}`
      : `${ansi.gray} 允许 ${ansi.reset}`;
    const deny = !pending.selected
      ? `${ansi.inverse}${ansi.yellow} 拒绝 ${ansi.reset}`
      : `${ansi.gray} 拒绝 ${ansi.reset}`;
    lines.push(`  ${allow}  ${deny}   ${ansi.gray}← → 切换 · Enter 确认 · y/n 快捷${ansi.reset}`);
    return { lines, cursorRow: 0, cursorCol: 0 };
  }
}

// ------------------------------------------------------------ 扩展按键归一化

/** 修饰位（kitty 键盘协议与 xterm 一致：参数值 = 1 + 位掩码） */
const MOD_SHIFT = 1;
const MOD_ALT = 2;
const MOD_CTRL = 4;

/** 把「Ctrl + 字母/符号」还原为对应的控制字符；无法还原时返回 null */
function controlCharFrom(code: number, mods: number): string | null {
  if ((mods & MOD_CTRL) === 0) return null;
  const lower = code >= 65 && code <= 90 ? code + 32 : code;
  if (lower >= 97 && lower <= 122) return String.fromCharCode(lower - 96);
  switch (code) {
    case 32: // Ctrl+Space
    case 64: // Ctrl+@
      return "\x00";
    case 91:
      return "\x1b";
    case 92:
      return "\x1c";
    case 93:
      return "\x1d";
    case 94:
      return "\x1e";
    case 95: // Ctrl+_
    case 47: // Ctrl+/
      return "\x1f";
    default:
      return null;
  }
}

/** 「键码 + 修饰位」→ 本应用的按键语义；无法映射时返回 null（原样丢弃） */
function normalizeModifiedKey(code: number, mods: number): string | null {
  const modified = (mods & (MOD_SHIFT | MOD_CTRL | MOD_ALT)) !== 0;
  switch (code) {
    case 13: // Enter：带修饰键 → 换行；裸 Enter → 提交
      return modified ? "\n" : "\r";
    case 9: // Tab：Shift+Tab → 切换焦点
      return modified && (mods & MOD_CTRL) === 0 ? "\x1b[Z" : "\t";
    case 8: // 退格：Ctrl/Alt+退格一并按删除处理
    case 127:
      return "\x7f";
    default:
      return controlCharFrom(code, mods);
  }
}

/**
 * 归一化「修饰键 + Enter / Tab」等终端扩展序列。
 *
 * Enter 系按键在各终端下的编码完全不同，这里统一成本应用既有语义
 * （`\r` 提交、`\n` 换行、`\x1b[Z` 切换焦点）：
 * - `ESC CR`：legacy 终端的 Ctrl+Enter（xterm 系同时用它表示 Alt+Enter）；
 * - `CSI 13 ; <mod> u`：kitty 键盘协议（report-all-keys 模式）下的 Shift / Ctrl+Enter；
 * - `CSI 27 ; <mod> ; 13 ~`：xterm `modifyOtherKeys` 下的 Shift / Ctrl+Enter。
 *
 * 另外，处于上报模式的终端会把 Ctrl+字母也改成转义码，这里一并还原成控制字符，
 * 保证 Ctrl+C / Ctrl+A / Ctrl+E / Ctrl+J / Ctrl+L 等既有快捷键不受影响。
 */
function normalizeKey(key: string): string {
  // ESC + Enter：部分终端（Ctrl+Enter / Alt+Enter）沿用该传统编码
  if (key === "\x1b\r" || key === "\x1b\n") return "\n";

  // kitty 键盘协议 / CSI u：CSI <code>[:<alternate>] [;<mod>] u
  const csiU = /^\x1b\[(\d+)(?::\d+)?(?:;(\d+))?u$/.exec(key);
  if (csiU) {
    const mods = csiU[2] ? Number(csiU[2]) - 1 : 0;
    return normalizeModifiedKey(Number(csiU[1]), mods) ?? key;
  }

  // xterm modifyOtherKeys：CSI 27 ; <mod> [; <code>] ~（省略键码代表 ESC）
  const xtMod = /^\x1b\[27;(\d+)(?:;(\d+))?~$/.exec(key);
  if (xtMod) {
    const mods = Number(xtMod[1]) - 1;
    const code = xtMod[2] ? Number(xtMod[2]) : 27;
    return normalizeModifiedKey(code, mods) ?? key;
  }

  return key;
}

function summarizeToolCall(call: ToolCall): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(call.arguments || "{}");
    if (typeof parsed === "object" && parsed !== null) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    return truncate(call.arguments, 60);
  }
  const pick = (key: string): string | undefined => {
    const value = args[key];
    return typeof value === "string" ? value : undefined;
  };
  const detail =
    pick("path") ??
    pick("pattern") ??
    pick("command") ??
    pick("dirPath") ??
    "";
  return truncate(detail.replace(/\s+/g, " "), 80);
}
