import * as fs from "fs";
import * as path from "path";
import { Agent, type AgentEvents } from "../core/agent";
import { goalContinuePrompt, goalStartPrompt } from "../core/goal";
import {
  appendSessionMessages,
  listSessions,
  loadSessionMessages,
  startSession,
} from "../core/sessions";
import { undoLastChange } from "../utils/backups";
import {
  activeModelEntry,
  effectiveModels,
  saveConfig,
  type ModelEntry,
  type XuanZhuConfig,
} from "../config/store";
import { findProvider } from "../llm";
import { friendlyError } from "../llm/http";
import {
  AUTOJS6_APP_SERVER_PORT,
  AUTOJS6_PC_SERVER_PORT,
  buildDeviceSetupGuide,
  detectAndroidAbi,
  DeviceBridge,
  findLocalApk,
  isRunningOnAndroid,
  resolveDevicePort,
} from "../device";
import { modelSupportsVision, type ImageAttachment } from "../llm";
import type { LLMProvider, ToolCall } from "../llm/types";
import { clipboardRequirements, currentPlatform } from "../skills/dependencies";
import { isRequirementMet, runShellInteractive } from "../skills/installer";
import { getToolSpecs, type ExecuteToolResult } from "../tools";
import type { ConfirmRequest, TodoItem } from "../tools/types";
import {
  MAX_CLIPBOARD_IMAGE_BYTES,
  readClipboardImage,
  readClipboardText,
  sniffImageMime,
  type ClipboardImage,
} from "../utils/clipboard";
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

/**
 * 目标模式（`/goal`）最多自动继续多少轮（含首轮）。
 *
 * 这是**安全阀**而不是正常结束条件：目标模式承诺「不完成不停」，但模型可能因为
 * 目标本身模糊而无限打转。到上限后停下并保留目标（`/goal continue` 可再来一组），
 * 避免无人值守时把 token 烧光。
 */
const GOAL_MAX_ITERATIONS = 40;

export interface TuiAppOptions {
  provider: LLMProvider;
  config: XuanZhuConfig;
  cwd: string;
  providerLabel: string;
  model: string;
  /** 启动时选中的模型条目，交由 Agent 在调用失败时沿列表回退 */
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

/** 输入区里的一次单选（当前只有 `/model`）：↑ ↓ 移动、数字直选、Enter 确认、Esc 取消 */
interface PendingSelect {
  title: string;
  /** 列表上方的说明行（可省） */
  detail?: string;
  options: PendingSelectOption[];
  /** 当前高亮的序号 */
  index: number;
  resolve: (value: string | undefined) => void;
}

interface PendingSelectOption {
  /** 展示文本 */
  label: string;
  /** 追加在 label 后的灰色说明（如「当前使用中」） */
  hint?: string;
  /** 选中后交给调用方的值 */
  value: string;
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
        "\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?7h" +
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
  /** 当前会话文件（JSONL）；/reset 与 /resume 会切换它 */
  private currentSessionFile: string;

  /** 当前模型（可能因调用失败回退而切换） */
  private modelProviderLabel: string;
  private modelLabel: string;

  private lines: string[] = [];
  private input = "";
  private inputCursor = 0;
  private scrollOffset = 0;
  private statusText = "就绪";
  private statusDetail = "";
  /** 当前任务列表（todo_write），显示在顶部信息区 */
  private todoItems: TodoItem[] = [];
  /**
   * 手机设备桥（`/device serve` 启动）。
   *
   * 桥跑在 xzh 进程内，同时注入给 Agent（见 `setDeviceBridge`），
   * 于是 Agent 的 `device_*` 工具和界面用的是同一个桥。
   */
  private deviceBridge?: DeviceBridge;
  /**
   * 本轮待发送的图片附件，key 为输入框里占位标记 `[图片N]` 中的编号。
   *
   * 之所以用「文本占位 + 侧表」而不是给输入框加真正的附件结构：这样光标移动、
   * 退格删除、历史回看等既有逻辑全都不用改 —— 删掉占位标记，提交时自然就不会
   * 引用到对应附件（见 takePendingImages）。
   */
  private pendingImages = new Map<number, ImageAttachment>();
  private imageSeq = 0;
  /**
   * 界面是否已临时挂起（把终端交还给 shell）。
   *
   * 只在需要 sudo 密码的安装期间为 true —— 此时绝不能渲染，否则界面输出会与
   * 安装命令的输出互相踩踏。
   */
  private suspended = false;
  private busy = false;
  private exited = false;
  /** 本次退出是被谁触发的（写进「上一轮已中止」说明，便于事后分辨断线 / 被终止） */
  private shutdownReason?: string;
  private autoApprove: boolean;
  /** 是否启用意图分析（界面内用 /intent 切换并写回配置） */
  private intentEnabled: boolean;

  /** 目标模式（`/goal`）的自动推进循环是否正在运行 */
  private goalLoopActive = false;
  /**
   * 本轮目标执行是否被用户中断（Ctrl+C / Ctrl+D）。
   *
   * 循环看到它就不再自动继续，但**保留目标** —— 用户可以 `/goal continue`
   * 接着推进，或 `/goal off` 清除。
   */
  private goalCancelled = false;
  /** 目标模式已执行到第几轮（含首轮），用于展示与安全阀判断 */
  private goalIterations = 0;

  private history: string[] = [];
  private historyIndex = -1;

  private pendingConfirm?: PendingConfirm;
  /**
   * 输入区里打开的单选列表（`/model`）。
   *
   * 与 `pendingConfirm` 不同，它只由用户在输入框里主动触发，不会来自子代理，
   * 因此不需要排队；两者也不会同时出现（确认框打开时输入框被占用，
   * 而对话进行中 `submit()` 直接返回，压根进不到命令处理）。
   */
  private pendingSelect?: PendingSelect;
  /** 确认请求的串行链：并行子代理同时请求确认时排队，避免覆盖导致挂死 */
  private confirmChain: Promise<void> = Promise.resolve();
  private abortController?: AbortController;
  private keyBuffer = "";
  private escTimer?: NodeJS.Timeout;
  private projectDirCreated?: string;
  private needsRender = false;
  /**
   * 是否捕获鼠标（滚轮滚动输出区）。
   *
   * 初始值来自配置项 `mouseCapture`（默认 false），因此**不需要每次用 `/mouse` 切换**；
   * 用 `/mouse` 切换后也会写回配置，下次启动保持。
   *
   * 两者的取舍在终端层面无法两全：`?1000h` 是整体开关，没有「只捕获滚轮」的选项；
   * 而玄猪工作在备用屏上，不捕获时终端也没有回滚历史可滚。
   * 开启时仍可用 **Shift+拖拽** 做原生选择（多数终端会用 Shift 绕过应用级捕获）。
   */
  private mouseCapture: boolean;
  /** 最近一次对话在输出区中的起始行号（含用户提问），供 /copy last 使用 */
  private lastAnswerStart = 0;
  private streamingPreview = "";
  private termVisible = true;
  private termFocus = false;
  private termScroll = 0;
  private lastLeftWidth = 0;
  /** 上次渲染的物理行数，用于「视口锚定」（见 render） */
  private lastPhysicalCount = 0;

  /**
   * 上一次渲染中，每个物理行来自哪一条逻辑行（`this.lines` 的索引，-1 表示流式预览）。
   * 由 `physicalLines()` 填充，供鼠标拖拽选择反查用。
   */
  private lastPhysicalMap: number[] = [];
  /**
   * 上一次渲染中，屏幕行（0-based，整屏）→ `this.lines` 索引。
   * undefined 表示该屏幕行不是输出区内容（页头 / 输入区 / 右侧终端）。
   */
  private screenToLogical: (number | undefined)[] = [];
  /**
   * 鼠标选择状态：以 `this.lines` 的逻辑行索引表示。
   *
   * 只按**行**选择而非精确到字符 —— 输出区里的长行会折行、还含 ANSI 颜色与宽字符，
   * 做字符级映射的复杂度远高于收益；而实际使用中要复制的基本都是整段内容。
   */
  private selectionAnchor?: number;
  private selectionHead?: number;
  /** 是否正在拖拽选择（用于区分「单击」与「拖选」） */
  private dragging = false;
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
    // 从配置读取初始鼠标行为，避免每次启动都要 /mouse 切换
    this.mouseCapture = options.config.mouseCapture === true;
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
      onTodos: (items) => {
        this.todoItems = items;
        this.scheduleRender();
      },
      onIntent: (analysis, original) => this.handleIntent(analysis, original),
      onModelChange: (info) => this.handleModelChange(info),
      confirm: (request) => this.requestConfirm(request),
      // 轮次配额用尽时问一次，而不是硬性中断 —— 真实的重构任务常常超过默认轮数，
      // 直接停掉会让工作断在半路。复用同一套确认弹窗（y 继续 / n 结束）。
      // 目标模式例外：目标是「不完成不停」，这里直接追加配额；要停下来按 Ctrl+C。
      onRoundLimit: (used) => {
        if (this.goalLoopActive) {
          this.lines.push(
            `${ansi.gray}目标模式：已用满 ${used} 轮工具调用，自动追加配额继续。${ansi.reset}`,
          );
          this.scheduleRender();
          return Promise.resolve(true);
        }
        return this.requestConfirm({
          tool: "round_limit",
          title: `已调用 ${used} 轮工具，是否继续？`,
          detail:
            `本轮对话已执行 ${used} 轮工具调用（达到当前上限），任务可能尚未完成。\n\n` +
            `· 按 y 继续：再追加 ${this.options.config.maxToolRounds} 轮\n` +
            `· 按 n 结束：保留已有进展，本轮到此为止\n\n` +
            `想永久调整上限：编辑配置文件的 maxToolRounds 字段。`,
          danger: false,
        });
      },
    };
    // 会话持久化：每次提交历史都会增量写入该 JSONL，崩溃 / 退出后可用 /resume 恢复
    const sessionFile = startSession(options.cwd, VERSION);
    this.currentSessionFile = sessionFile;
    this.agent = new Agent(
      options.provider,
      options.config,
      options.cwd,
      events,
      options.activeModel,
      { sessionFile },
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

    // 接管鼠标时提示一次操作方式。拖拽选择是玄猪自己实现的，
    // 用户不看说明很难发现；同时说明 Shift 绕过可以拿到终端原生选择。
    if (this.mouseCapture) {
      this.lines.push(
        `${ansi.gray}鼠标已接管：滚轮滚动输出区，${ansi.reset}在输出区拖拽即可选中并复制${ansi.gray}（松开生效）。${ansi.reset}`,
        `${ansi.gray}想用终端原生的框选与右键菜单：按住 ${ansi.reset}Shift${ansi.gray} 拖拽，或输入 ${ansi.reset}/mouse${ansi.gray}。${ansi.reset}`,
        "",
      );
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
        // ?1000h 只上报「按下 / 释放」，**不含拖拽移动**；
        // ?1002h（按钮事件追踪）才会在按住左键拖动时持续上报 —— 框选依赖它。
        // ?1006h 让坐标使用 SGR 扩展格式（可表示超过 223 的行列）。
        (this.mouseCapture
          ? "\x1b[?1000h\x1b[?1002h\x1b[?1006h"
          : "\x1b[?1000l\x1b[?1002l\x1b[?1006l") +
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
    // SSH 断线时 sshd 关闭 pty：正常会收到 SIGHUP（见 cli/index.ts），
    // 这里再兜一层 stdin EOF —— 某些托管方式只关管道、不给信号。
    process.stdin.on("end", this.onInputClosed);
    process.stdin.on("close", this.onInputClosed);
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
    const dropped = this.lines.length - max;
    if (dropped <= 0) return;
    this.lines.splice(0, dropped);

    // 所有「指向 lines 的下标」都必须跟着前移，否则会指向错的逻辑行：
    //   - lastAnswerStart 不跟着走 → /copy last 会 slice 到空数组（用户什么都复制不到）
    //   - 选区不跟着走 → 高亮会套在无关的行上
    if (this.lastAnswerStart > 0) {
      this.lastAnswerStart = Math.max(0, this.lastAnswerStart - dropped);
    }
    const anchor = this.selectionAnchor;
    const head = this.selectionHead;
    if (anchor !== undefined || head !== undefined) {
      const fellOff =
        (anchor !== undefined && anchor < dropped) ||
        (head !== undefined && head < dropped);
      if (fellOff) {
        // 选区已被滚出保留窗口：整体作废（而不是把它夹到 0 指向别的行）
        this.selectionAnchor = undefined;
        this.selectionHead = undefined;
      } else {
        if (anchor !== undefined) this.selectionAnchor = anchor - dropped;
        if (head !== undefined) this.selectionHead = head - dropped;
      }
    }
  }

  private exitTerminal(): void {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = undefined;
    }
    process.stdin.off("data", this.onData);
    process.stdin.off("end", this.onInputClosed);
    process.stdin.off("close", this.onInputClosed);
    process.stdout.off("resize", this.onResize);
    // 终端可能**已经不存在了**（SSH 断线后 pty 被关闭）：此时 setRawMode 会抛
    // `EIO`、写 stdout 也会失败。退出路径上的这些失败必须吞掉 —— 否则一次正常的
    // 断线退出会变成未捕获异常（退出码 1、session.lock 残留，下次启动还会误报
    // 「上次异常退出」）。
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    } catch {
      // 终端已消失
    }
    try {
      process.stdout.write(
        // 关闭括号粘贴与鼠标上报、恢复自动换行，并把 modifyOtherKeys 还原为终端初始设置，
        // 再退出备用屏幕
        "\x1b[?2004l" +
          "\x1b[>4m" +
          "\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?7h" +
          ansi.reset +
          cursor.show +
          screen.exitAlt,
      );
    } catch {
      // 写不出去也无所谓：终端已经没了
    }
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

  /**
   * 由外部请求退出（`SIGTERM` / `SIGHUP` / stdin 关闭）。
   *
   * 必须走这条路径而不是直接 `process.exit()`：右侧终端里的命令是以 **detached 进程组**
   * 启动的，直接退出会把它们留成孤儿进程；设备桥与终端状态也需要正常收尾。
   * 典型场景就是 **SSH 断线**（sshd 关 pty → 内核发 SIGHUP）。
   */
  requestShutdown(reason: string): void {
    if (this.exited) return;
    this.shutdownReason = reason;
    // 先中断在跑的请求：否则 provider 的流式回调会继续往已销毁的界面上写
    this.abortController?.abort();
    try {
      this.shutdown();
    } catch {
      // 收尾阶段不该再抛异常（终端可能已经消失）：至少让等待 start() 的地方继续
      this.exited = true;
      try {
        restoreTerminalSafely();
      } catch {
        // 忽略
      }
      this.resolveExit?.();
    }
  }

  /** stdin 关闭（终端消失）—— 等同断线，按正常退出流程收尾 */
  private readonly onInputClosed = () => this.requestShutdown("终端连接已关闭");

  private shutdown(): void {
    if (this.exited) return;
    this.exited = true;
    // 本轮没收尾就退出：在会话文件里补一条说明，下次 /resume 才知道「上一轮没有结论」
    this.noteInterruptedTurn();
    // 设备桥持有监听中的 http/ws 句柄 —— 不关掉事件循环不会空，进程会退不出去
    const bridge = this.deviceBridge;
    this.deviceBridge = undefined;
    this.agent.setDeviceBridge(undefined);
    void bridge?.stop();
    // 右侧终端里的命令以 detached 独立进程组运行，不主动终止会成为孤儿进程
    this.term.dispose();
    this.exitTerminal();
    this.resolveExit?.();
  }

  /**
   * 若本轮对话还在进行中就把进程结束了（SSH 断线、`SIGTERM`、意外退出），
   * 往会话文件里补一条「上一轮已中止」的说明。
   *
   * 为什么需要：本轮的用户提问与工具调用都还没提交（见 `Agent.run` 的整轮回滚语义），
   * 会话文件里只有**上一轮**的内容 —— 下次 `/resume` 时模型会以为对话就停在那里，
   * 于是可能对着一个旧任务继续做。这条 system 说明让它在恢复后知道该轮已作废。
   */
  private noteInterruptedTurn(): void {
    if (!this.busy) return;
    try {
      appendSessionMessages(this.currentSessionFile, [
        {
          role: "system",
          content:
            `[上一轮已中止] ${this.shutdownReason ?? "会话在运行中被结束"}：` +
            `上一轮没有给出结论，该轮对话已作废。\n` +
            `中止前已经真实执行过的操作可能改变了文件或服务状态，不要凭假设重复执行；` +
            `请回应用户最新的消息。`,
        },
      ]);
    } catch {
      // 退出路径上写失败也不能挡住退出
    }
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

    // 失败时把原因显示出来。工具在 content 里写了可操作的提示
    //（如「未找到匹配文本，请先用 read_file 确认内容」），
    // 而失败时通常没有 summary —— 于是界面上只剩「失败」两个字，
    // 用户既不知道原因也无从下手。
    //
    // 取「前 3 行 + 后 3 行」而不是只取开头：两类工具的失败信息位置相反 ——
    // 文件类工具把结论写在第一行；而 `bash` 的 content 是命令输出，
    // 报错与堆栈大多在**末尾**（开头往往只是些正常的启动日志）。
    if (!result.ok && !result.denied && result.content?.trim()) {
      const all = sanitizeControl(result.content).trim().split("\n");
      const picked =
        all.length <= 6
          ? all
          : [...all.slice(0, 3), `…（省略 ${all.length - 6} 行）`, ...all.slice(-3)];
      for (const line of picked) {
        this.lines.push(`    ${ansi.gray}${line.slice(0, 120)}${ansi.reset}`);
      }
    }

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

  /** 模型因调用失败回退到下一个之后的界面更新 */
  private handleModelChange(info: {
    provider: string;
    model: string;
    reason: string;
  }): void {
    this.modelProviderLabel =
      findProvider(info.provider)?.label ?? info.provider;
    this.modelLabel = info.model;
    this.lines.push(
      `${ansi.yellow}⇄ 模型已切换为 ${info.provider}/${info.model}（${info.reason}）${ansi.reset}`,
    );
    this.scheduleRender();
  }

  /**
   * `/model` —— 查看 / 切换当前使用的模型。
   *
   * - 不带参数：列出已配置模型并**直接选**（↑ ↓ 或数字键，Enter 确认、Esc 取消）
   * - 带参数：`/model 2`、`/model <id>`、`/model <模型名>` 一步到位
   *
   * 之所以两种都留：列表交互适合「看一眼再选」，而带参数的形式在记熟之后更快，
   * 也方便脚本化（同 `/resume <编号>`）。
   */
  private async handleModelCommand(arg: string): Promise<void> {
    // 顺序即回退优先级：当前模型调用失败会沿这张表往后找下一个
    const entries = effectiveModels(this.options.config);
    if (entries.length === 0) {
      this.lines.push(
        `${ansi.yellow}还没有配置任何模型${ansi.reset}${ansi.gray} —— 用 ${ansi.reset}xzh model${ansi.gray} 添加。${ansi.reset}`,
      );
      this.scheduleRender();
      return;
    }

    const current = activeModelEntry(this.options.config);

    if (arg) {
      const entry = resolveModelChoice(entries, arg);
      if (!entry) {
        this.lines.push(
          `${ansi.yellow}没找到模型「${arg}」${ansi.reset}${ansi.gray} —— 输入 ${ansi.reset}/model${ansi.gray} 查看列表。${ansi.reset}`,
        );
        this.scheduleRender();
        return;
      }
      this.applyModelSwitch(entry);
      return;
    }

    if (entries.length === 1) {
      this.lines.push(
        `${ansi.gray}只配置了一个模型：${ansi.reset}${entries[0].id}` +
          `${ansi.gray}（用 ${ansi.reset}xzh model${ansi.gray} 添加更多）${ansi.reset}`,
      );
      this.scheduleRender();
      return;
    }

    const defaultIndex = Math.max(
      0,
      entries.findIndex((entry) => entry.id === current?.id),
    );
    const picked = await this.requestSelect(
      "选择模型",
      entries.map((entry) => ({
        label: entry.id,
        hint: entry.id === current?.id ? "当前使用中" : undefined,
        value: entry.id,
      })),
      "顺序即回退优先级；选中的模型会记入配置，下次启动继续用它",
      defaultIndex,
    );
    if (picked === undefined) {
      this.lines.push(`${ansi.gray}已取消，仍使用 ${current?.id ?? this.modelLabel}${ansi.reset}`);
      this.scheduleRender();
      return;
    }
    const entry = entries.find((item) => item.id === picked);
    if (entry) this.applyModelSwitch(entry);
  }

  /** 真正执行一次「手动切换模型」：更新 Agent、界面标签，并把选择写回配置 */
  private applyModelSwitch(entry: ModelEntry): void {
    // 会话进行中不切：本轮正用旧 provider 流式输出，中途换掉会让这一轮的行为前后不一致
    if (this.busy) {
      this.lines.push(
        `${ansi.yellow}本轮对话进行中 —— 先等它结束或 Ctrl+C 中断，再切换模型。${ansi.reset}`,
      );
      this.scheduleRender();
      return;
    }
    try {
      if (!this.agent.switchModel(entry)) {
        this.lines.push(`${ansi.gray}已经是当前模型：${entry.id}${ansi.reset}`);
        this.scheduleRender();
        return;
      }
      // 复用回退那条提示路径：标签更新 + 输出「⇄ 模型已切换为 …」
      this.handleModelChange({
        provider: entry.provider,
        model: entry.model,
        reason: "手动切换",
      });
    } catch (err) {
      this.lines.push(
        `${ansi.yellow}切换模型失败：${ansi.reset}${friendlyError(err)}`,
      );
      this.scheduleRender();
    }
  }

  /**
   * 请求用户确认。
   *
   * 确认框只有一个（`pendingConfirm`），而**并行的子代理可能同时请求确认** ——
   * 若直接覆盖，前一个 Promise 永远不会兑现，对应的子代理就此挂住，
   * 整个工具批次（`Promise.all`）也跟着卡死。因此这里把请求串成一条链：
   * 后来的排队等待，前一个答复后才显示。
   */
  private requestConfirm(request: ConfirmRequest): Promise<boolean> {
    const next = this.confirmChain.then(
      () =>
        new Promise<boolean>((resolve) => {
          this.pendingConfirm = { request, resolve, selected: true };
          this.scheduleRender();
        }),
    );
    // 链本身不能因异常断掉（确认 Promise 不会 reject，这里只是兜底）
    this.confirmChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
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
        this.armIncompleteTimer();
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

  /**
   * 缓冲里还剩「不完整的输入」时：决定等多久、超时后怎么办。
   *
   * 两种情形**不能一视同仁**：
   * - **括号粘贴未收全**（收到了 `\x1b[200~` 但还没等到 `\x1b[201~`）：一次长粘贴本来就可能
   *   跨多次 read 到达，按 40ms 丢弃等于把用户粘贴内容的前半段吃掉。这里给足宽限，
   *   超时也**把已收到的正文插入**而不是丢弃 —— 宁可内容不全，也不要静默吞掉。
   * - **其它转义序列前缀**（`\x1b`、`\x1b[`）：40ms 后判定。确实只是单独的 ESC 就当 ESC 处理，
   *   残缺序列丢弃（避免残留字节被当作输入插入）。
   */
  private armIncompleteTimer(): void {
    if (this.escTimer) clearTimeout(this.escTimer);
    this.escTimer = undefined;

    const pending = this.keyBuffer;
    if (pending.startsWith(PASTE_START)) {
      this.escTimer = setTimeout(() => {
        this.escTimer = undefined;
        const buffered = this.keyBuffer;
        if (!buffered.startsWith(PASTE_START)) return;
        this.keyBuffer = "";
        this.insertPastedText(buffered.slice(PASTE_START.length));
      }, PASTE_GRACE_MS);
      return;
    }

    if (pending.startsWith("\x1b")) {
      this.escTimer = setTimeout(() => {
        this.escTimer = undefined;
        const leftover = this.keyBuffer;
        this.keyBuffer = "";
        if (leftover === "\x1b") {
          this.handleKey("\x1b");
        }
      }, ESC_WAIT_MS);
    }
  }

  private readKey(): string | null {
    const buf = this.keyBuffer;
    if (buf.length === 0) return null;

    // 括号粘贴（bracketed paste）：终端把粘贴内容包在 \x1b[200~ … \x1b[201~ 之间。
    // 必须整段取出交给 handleKey 一次性插入 —— 否则其中的换行会被当成「提交」，
    // 粘贴一大段文本就会连发好几条消息。内容可能分多次到达，未收全时返回 null 等待。
    if (buf.startsWith(PASTE_START)) {
      const end = buf.indexOf(PASTE_END, PASTE_START.length);
      if (end === -1) return null;
      this.keyBuffer = buf.slice(end + PASTE_END.length);
      return buf.slice(0, end + PASTE_END.length);
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
    if (rawKey.startsWith(PASTE_START) && rawKey.endsWith(PASTE_END)) {
      this.insertPastedText(
        rawKey.slice(PASTE_START.length, rawKey.length - PASTE_END.length),
      );
      return;
    }

    // 归一化终端的扩展按键序列（Ctrl/Shift+Enter、modifyOtherKeys 下的 Ctrl+字母等）
    // Ctrl+J（裸的 \x0a）不绑定任何动作 —— 换行已有 Alt+Enter / Ctrl+Enter
    // 这类带修饰的按键，不再保留这个等价按键。
    //
    // ⚠ 必须在 normalizeKey **之前**判断：normalizeKey 会把 Alt+Enter 的
    // `ESC CR` 也归一化成 "\n"，而 "\n" 与 Ctrl+J 是**同一个字符** ——
    // 在归一化之后再判断，就无法区分「按了 Ctrl+J」和「按了 Alt+Enter」了。
    // （此前删掉 case "\x0a" 时漏了这一点，把 Alt+Enter 一起弄失效了。）
    if (rawKey === "\x0a") return;

    const key = normalizeKey(rawKey);
    if (this.pendingConfirm) {
      this.handleConfirmKey(key);
      return;
    }
    // 单选浮层（/model）优先吃掉按键：此时输入区已被列表取代，
    // 否则输入框会一边显示列表、一边把按键当文本插入
    if (this.pendingSelect) {
      this.handleSelectKey(key);
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
          // 目标模式下不能只中断当前一轮 —— 否则循环会立刻发下一条「继续」，
          // 表现成「按了 Ctrl+C 却停不下来」。标记取消，循环退出后目标仍保留。
          if (this.goalLoopActive) this.goalCancelled = true;
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
          // 同 Ctrl+C：目标模式下「结束本轮」意味着暂停整个目标循环
          if (this.goalLoopActive) this.goalCancelled = true;
          this.abortController?.abort();
          this.statusText = "中断中…";
          this.scheduleRender();
        }
        return;
      case "\x16": // Ctrl+V：粘贴
        // 优先把剪贴板里的**图片**作为附件；只有文本时退化为常规文本粘贴
        // （部分终端不自己处理 Ctrl+V，会把 \x16 原样上送）。
        void this.pasteFromClipboard();
        return;
      case "\r": // Enter
        void this.submit();
        return;
      // 换行：Alt+Enter 的 `ESC CR`、以及 Ctrl/Shift+Enter 经
      // modifyOtherKeys / kitty 协议上报的序列，都由 normalizeKey 归一到 "\n"。
      // 注意 "\n" 与 Ctrl+J 是同字符 —— 后者已在 handleKey 入口处拦截，
      // 因此走到这里的一定是带修饰的 Enter。
      case "\n":
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
    const row = Number(match[3]);
    const pressed = match[4] === "M";
    const termWidth = this.resolveTermWidth(process.stdout.columns || 80);
    const inTerm =
      this.lastLeftWidth > 0 &&
      termWidth > 0 &&
      column > this.lastLeftWidth + 1;

    if (process.env.XZH_DEBUG_KEYS) {
      this.logRawKeys(
        `MOUSE btn=${button} col=${column} row=${row} ` +
          `${pressed ? "press" : "release"} inTerm=${inTerm} ` +
          `logical=${this.logicalAtScreenRow(row)} mapLen=${this.screenToLogical.length} ` +
          `anchor=${this.selectionAnchor} head=${this.selectionHead} drag=${this.dragging}`,
      );
    }

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

    // 左键按下（排除拖拽的移动标志位）
    if (pressed && (button & 3) === 0 && (button & 32) === 0) {
      // 在左栏输出区按下 → 开始框选（这样「滚轮滚动」与「选中文本」可以并存，
      // 既不用 /mouse 切换，也不用 Shift 绕过）
      const logical = this.logicalAtScreenRow(row);
      if (!inTerm && logical !== undefined) {
        this.selectionAnchor = logical;
        this.selectionHead = logical;
        this.dragging = false;
        this.scheduleRender();
        return;
      }
      // 否则仍按原逻辑：焦点跟随点击的栏目
      if (inTerm !== this.termFocus) {
        this.termFocus = inTerm;
        this.scheduleRender();
      }
      return;
    }

    // 拖拽移动（button 带 32 标志）：扩展选区
    if (pressed && (button & 32) === 32 && this.selectionAnchor !== undefined) {
      const logical = this.logicalAtScreenRow(row);
      if (logical !== undefined && logical !== this.selectionHead) {
        this.selectionHead = logical;
        this.dragging = true;
        this.scheduleRender();
      }
      return;
    }

    // 松开左键：结束选择。真的拖过才复制，单纯点击则取消选区
    if (!pressed && this.selectionAnchor !== undefined) {
      if (this.dragging) this.finishSelection();
      else this.clearSelection();
    }
  }

  /** 屏幕行（1-based）→ `this.lines` 的逻辑行索引；不在输出区时为 undefined */
  private logicalAtScreenRow(row: number): number | undefined {
    return this.screenToLogical[row - 1];
  }

  /** 清除选区 */
  private clearSelection(): void {
    if (this.selectionAnchor === undefined) return;
    this.selectionAnchor = undefined;
    this.selectionHead = undefined;
    this.dragging = false;
    this.scheduleRender();
  }

  /**
   * 结束框选：把选中行写进系统剪贴板（OSC 52）。
   *
   * 复制的是 `this.lines` 里的**原始逻辑行**（而非屏幕上折行后的样子），
   * 因此长行不会被"截成几段"，比手动选择更完整。
   */
  private finishSelection(): void {
    const from = Math.min(this.selectionAnchor!, this.selectionHead!);
    const to = Math.max(this.selectionAnchor!, this.selectionHead!);
    const count = to - from + 1;
    const plain = sanitizeControl(this.lines.slice(from, to + 1).join("\n")).trim();

    // 只结束拖拽状态，**保留选区高亮** —— 否则松开后什么都没了，
    // 而剪贴板又看不见，用户会以为「白选了一场」。
    // 选区会在下次按下时被新选区替换。
    this.dragging = false;

    if (!plain) {
      this.scheduleRender();
      return;
    }

    const payload = Buffer.from(plain, "utf8").toString("base64");
    process.stdout.write(`\x1b]52;c;${payload}\x07`);
    this.lines.push(
      `${ansi.green}✓ 已复制 ${count} 行到剪贴板${ansi.reset}` +
        `${ansi.gray}（选中处仍保持高亮）。若粘贴出来是空的，说明本终端禁用了 OSC 52，` +
        `请改用 ${ansi.reset}/copy${ansi.gray} 或 Shift+拖拽。${ansi.reset}`,
    );
    this.scheduleRender();
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
    // 有命令正在运行时，按键**全部转发给子进程** —— 这是应答交互式提示的唯一途径
    // （`npm init` 的提问、y/n 确认、`read -p` 等）。此前按键只在本地命令行缓冲区里
    // 编辑，子进程永远收不到，于是「程序在等输入、用户却输不进去」，看起来像卡死。
    // Ctrl+C / Ctrl+D 例外：保留为中断命令。
    if (this.term.isRunning()) {
      if (key === "\x03" || key === "\x04") {
        this.term.interrupt();
        this.scheduleRender();
        return;
      }
      this.term.write(key);
      return;
    }

    switch (key) {
      case "\x04": // Ctrl+D：没有命令运行时无动作（不会退出玄猪）
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

  /**
   * 在输入区打开一个单选列表，返回选中项的 value（Esc / Ctrl+C 取消时 undefined）。
   *
   * 为什么不用 CLI 的 `promptSelect`：它要 `stdin.setRawMode(true)` 接管按键，
   * 而 TUI 已常驻 raw 模式、有自己的一套按键处理，两者会互相抢键
   * （`/resume` 当年就是因此改成「先列表、再带编号」）。这里改为「把输入区换成浮层」，
   * 复用 pendingConfirm 那套「界面内浮层 + 自己吃按键」的做法。
   */
  private requestSelect(
    title: string,
    options: PendingSelectOption[],
    detail?: string,
    defaultIndex = 0,
  ): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
      this.pendingSelect = {
        title,
        detail,
        options,
        index: Math.min(Math.max(0, defaultIndex), Math.max(0, options.length - 1)),
        resolve,
      };
      this.scheduleRender();
    });
  }

  private resolveSelect(value: string | undefined): void {
    const pending = this.pendingSelect;
    if (!pending) return;
    this.pendingSelect = undefined;
    pending.resolve(value);
    this.scheduleRender();
  }

  private handleSelectKey(key: string): void {
    const pending = this.pendingSelect!;
    const count = pending.options.length;
    switch (key) {
      case "\x1b[A": // Up
      case "k":
        pending.index = (pending.index - 1 + count) % count;
        this.scheduleRender();
        return;
      case "\x1b[B": // Down
      case "j":
        pending.index = (pending.index + 1) % count;
        this.scheduleRender();
        return;
      case "\r":
        this.resolveSelect(pending.options[pending.index]?.value);
        return;
      case "\x1b": // Esc
      case "\x03": // Ctrl+C
        this.resolveSelect(undefined);
        return;
      default:
        // 数字键直选（1..9）：列表通常只有几个模型，比连按方向键快
        if (/^[1-9]$/.test(key)) {
          const index = Number(key) - 1;
          if (index < count) this.resolveSelect(pending.options[index].value);
        }
    }
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

  /**
   * 插入一段粘贴内容（调用方已剥掉括号粘贴的标记）。
   *
   * 保留其中的换行（提交前用户还能改），但去掉会干扰渲染的控制字符 ——
   * 否则粘贴内容里的光标移动 / 清屏指令会破坏整屏。
   */
  private insertPastedText(pasted: string): void {
    const text = pasted
      .replace(/\r\n?/g, "\n")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    if (text) this.insertText(text);
  }

  /**
   * 把**剪贴板里的图片**加为本轮附件；剪贴板只有文本时退化为常规文本粘贴。
   *
   * 为什么必须由玄猪主动读取：终端与程序之间只有字节流，粘贴只能传文本，
   * 剪贴板里只有图片时多数终端在粘贴时**什么都不发送**，程序无从感知。
   * 因此改为向操作系统索取（Linux：wl-paste / xclip；Windows：PowerShell；
   * macOS：pngpaste / osascript）。
   */
  private async pasteFromClipboard(): Promise<void> {
    if (this.busy || this.termFocus) return;

    this.statusText = "读取剪贴板";
    this.statusDetail = "";
    this.scheduleRender();

    try {
      const result = await readClipboardImage();

      if (result.kind === "image") {
        this.attachClipboardImage(result.image);
        return;
      }

      // 没有图片（或剪贴板工具缺失）→ 当作普通粘贴：读剪贴板文本
      const text = await readClipboardText();
      if (text) {
        this.insertText(text);
        return;
      }

      if (result.kind === "unavailable") {
        // 缺工具就直接装 —— 而不是只丢一句「请安装 xxx」让用户自己折腾。
        // 装好后再读一次，成功的话本次粘贴照常完成。
        if (await this.ensureClipboardTool()) {
          const retry = await readClipboardImage();
          if (retry.kind === "image") {
            this.attachClipboardImage(retry.image);
            return;
          }
        }
        this.handleNotice(
          `未能读取剪贴板：${result.detail}\n` +
            `提示：也可以直接把图片文件拖进终端，把路径贴在输入框里。`,
        );
      }
    } finally {
      this.statusText = "就绪";
      this.statusDetail = "";
      this.scheduleRender();
    }
  }

  /**
   * 缺少剪贴板工具时**主动安装**（Linux 上的 `xclip` / `wl-clipboard`）。
   *
   * 安装系统包需要 sudo，而玄猪平时用管道执行命令、sudo 拿不到终端会直接失败 ——
   * 因此这里临时**挂起界面**（退出备用屏 + 关闭原始模式），把终端让给安装命令，
   * 让它能正常提示输入密码，装完再恢复界面并强制整屏重绘。
   *
   * macOS / Windows 有内置通路，`clipboardRequirements()` 返回空数组，这里直接跳过。
   */
  private async ensureClipboardTool(): Promise<boolean> {
    const requirements = clipboardRequirements();
    if (requirements.length === 0) return false;

    for (const requirement of requirements) {
      if (await isRequirementMet(requirement)) return true;

      const command = requirement.install[currentPlatform()];
      if (!command) continue;

      const approved = await this.requestConfirm({
        tool: "clipboard_install",
        title: `需要安装剪贴板工具：${requirement.name}`,
        detail:
          `Ctrl+V 粘贴图片需要读取系统剪贴板，当前缺少它。\n\n` +
          `安装命令：\n  ${command}\n\n` +
          `按 y 立即安装（会暂时离开界面，以便输入 sudo 密码）；按 n 跳过。`,
        danger: false,
      });
      if (!approved) {
        this.handleNotice(`已跳过安装。也可以手动执行：\n  ${command}`);
        return false;
      }

      this.handleNotice(
        `正在安装 ${requirement.name} …（可能需要输入 sudo 密码）`,
      );
      this.suspendUi();
      let result: { ok: boolean; output: string; timedOut: boolean };
      try {
        result = await runShellInteractive(command);
      } catch (err) {
        result = { ok: false, output: String(err), timedOut: false };
      } finally {
        this.resumeUi();
      }

      if (!result.ok) {
        this.handleNotice(
          `安装失败${result.timedOut ? "（超时）" : ""}${
            result.output.trim() ? `：${result.output.trim()}` : ""
          }\n可手动执行：\n  ${command}`,
        );
        return false;
      }
      if (await isRequirementMet(requirement)) {
        this.handleNotice(`✓ ${requirement.name} 安装完成`);
        return true;
      }
      this.handleNotice(
        `安装命令已执行，但检测仍未通过（可能需要重开终端刷新 PATH）。\n` +
          `可手动执行：\n  ${command}`,
      );
      return false;
    }
    return false;
  }

  /** 临时挂起界面：退出备用屏、关闭原始模式，把终端交还给 shell */
  private suspendUi(): void {
    this.suspended = true;
    this.exitTerminal();
    process.stdout.write(
      `${ansi.gray}[玄猪] 正在安装依赖，安装完成后会自动回到界面…${ansi.reset}\n\n`,
    );
  }

  /** 恢复界面：重新接管终端并强制整屏重绘 */
  private resumeUi(): void {
    this.enterTerminal();
    this.suspended = false;
    // 挂起期间终端内容已被安装输出改写，旧的行数记录不再可信 ——
    // 不重置会让「视口锚定」把滚动位置算错（-1 表示本次渲染跳过锚定）
    this.lastPhysicalCount = -1;
    this.lastTermPhysicalCount = -1;
    this.scheduleRender();
  }

  /** 校验并登记一张剪贴板图片，同时在输入框插入占位标记 */
  private attachClipboardImage(image: ClipboardImage): void {
    if (image.bytes > MAX_CLIPBOARD_IMAGE_BYTES) {
      this.handleNotice(
        `图片过大（${formatImageSize(image.bytes)}），超出上限 ` +
          `${formatImageSize(MAX_CLIPBOARD_IMAGE_BYTES)}，已忽略。`,
      );
      return;
    }

    // 模型不支持视觉时**提前拦住**：真发出去多半是一个 400，把整轮正文一起作废
    if (!this.currentModelSupportsVision()) {
      this.handleNotice(
        `当前模型 ${this.modelLabel} 未标注支持图片输入，未附加图片。\n` +
          `· 若该模型确实支持视觉：xzh model vision <id> on\n` +
          `· 或者切换到 glm-4v / qwen-vl / gpt-4o / claude 等支持视觉的模型`,
      );
      return;
    }

    const id = ++this.imageSeq;
    this.pendingImages.set(id, {
      mimeType: image.mimeType,
      data: image.base64,
    });
    this.insertText(`[图片${id}]`);
    this.handleNotice(
      `已附加图片${id}（${formatImageSize(image.bytes)}，${image.mimeType}）；` +
        `回车发送，退格删掉占位即可移除。`,
    );
  }

  /**
   * 从输入框文本里取出图片占位标记，返回剥离后的正文与对应附件。
   *
   * 未被任何占位引用的附件（用户把标记删掉了）一并丢弃 —— 否则会发出
   * 一张用户以为已经取消的图片。
   */
  private takePendingImages(raw: string): {
    text: string;
    images: ImageAttachment[];
  } {
    const images: ImageAttachment[] = [];
    const text = raw
      .replace(/\[图片(\d+)\]/g, (_match, digits: string) => {
        const image = this.pendingImages.get(Number(digits));
        if (image) images.push(image);
        return "";
      })
      // 标记被移除后可能留下连续空格，顺手收敛一下
      .replace(/[ \t]{2,}/g, " ")
      .trim();

    this.pendingImages.clear();
    return { text, images };
  }

  /**
   * 把「整行就是一个图片文件路径」的输入转成附件（拖拽文件到终端时最常见）。
   *
   * 为什么值得做：拖拽在**所有终端**上都能拿到路径（粘贴路径是纯文本，不依赖任何协议），
   * 而 Ctrl+V 在部分终端会被终端自己吃掉。只处理「整行就是路径」这一种形态 ——
   * 一旦行内还有别的文字，更可能是用户想操作这个文件，不该擅自吞掉路径。
   */
  private absorbImagePaths(text: string): {
    text: string;
    images: ImageAttachment[];
  } {
    if (!/\.(png|jpe?g|gif|webp)\b/i.test(text)) return { text, images: [] };

    const images: ImageAttachment[] = [];
    const kept: string[] = [];
    for (const line of text.split("\n")) {
      const file = normalizeDroppedPath(line);
      const image = file ? readImageFile(file, this.cwd) : null;
      if (image) images.push(image);
      else kept.push(line);
    }
    return { text: kept.join("\n").trim(), images };
  }

  /** 当前模型是否支持图片输入（显式配置优先，否则按模型名推断） */
  private currentModelSupportsVision(): boolean {
    const entry = this.agent.getActiveModel();
    return entry ? modelSupportsVision(entry) : false;
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
    let next = this.inputCursor + delta;
    next = Math.max(0, Math.min(this.input.length, next));
    // 不要停在代理对中间（emoji 等）：落在低位代理上时按方向跨过整个字符，
    // 否则随后的 insertText 会把这个字符切成两半。
    // 退格早已处理了这一点（见 backspace），这里必须对齐。
    if (delta > 0 && next > 0 && next < this.input.length) {
      const prev = this.input.charCodeAt(next - 1);
      if (prev >= 0xd800 && prev <= 0xdbff) next += 1;
    } else if (delta < 0 && next < this.input.length) {
      const here = this.input.charCodeAt(next);
      if (here >= 0xdc00 && here <= 0xdfff) next -= 1;
    }
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
    const raw = this.input.trim();
    if (!raw) return;

    this.input = "";
    this.inputCursor = 0;
    this.scrollOffset = 0;
    this.historyIndex = -1;

    if (raw.startsWith("/")) {
      this.history.push(raw);
      // 斜杠命令不发送图片；这里清掉侧表，避免留下永远发不出去的孤儿附件
      this.pendingImages.clear();
      this.handleCommand(raw);
      return;
    }

    let { text, images } = this.takePendingImages(raw);

    // 拖拽/粘贴进来的图片文件路径也算附件（不依赖任何终端协议，覆盖面最广）
    const fromPaths = this.absorbImagePaths(text);
    if (fromPaths.images.length > 0) {
      text = fromPaths.text;
      images = [...images, ...fromPaths.images];
    }

    // 模型不支持视觉时**丢弃图片而不是让请求失败**：整轮 400 会把用户的正文一起作废。
    // 之所以在这里再查一次而不是只在附加时查：用户可能在附加之后切换了模型。
    if (images.length > 0 && !this.currentModelSupportsVision()) {
      this.lines.push(
        `${ansi.yellow}⚠ 当前模型 ${this.modelLabel} 未标注支持图片输入，已忽略 ${images.length} 张图片。${ansi.reset}`,
      );
      this.lines.push(
        `${ansi.gray}  · 若该模型确实支持视觉：xzh model vision <id> on${ansi.reset}`,
      );
      this.lines.push(
        `${ansi.gray}  · 或改用 glm-4v / qwen-vl / gpt-4o / claude 等支持视觉的模型${ansi.reset}`,
      );
      images = [];
    }

    // 占位标记被删掉、正文也空 —— 没有可发送的内容
    if (!text && images.length === 0) {
      this.lines.push(`${ansi.gray}（没有可发送的内容）${ansi.reset}`);
      this.scheduleRender();
      return;
    }

    this.history.push(text || `${images.length} 张图片`);

    // 记录本轮在输出区中的起点（从用户提问那行算起），供 /copy last 精确复制整轮对话
    this.lastAnswerStart = this.lines.length;

    // 用户输入：绿底块标记 + 亮绿加粗正文，便于在历史记录中一眼定位
    const badge = `${ansi.bgGreen}${ansi.black}${ansi.bold} ❯ ${ansi.reset}`;
    // 只发图片时正文为空，回显里补一行说明，否则界面上只剩下一个空的 ❯
    const echoText =
      images.length > 0
        ? `${text}${text ? "\n" : ""}[图片 × ${images.length}]`
        : text;
    const [firstLine, ...restLines] = echoText.split("\n");
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

    // 快照本次请求使用的模型：run 内部可能因失败而回退到别的模型，
    // 出错时应报告「实际发起请求时」用的模型，否则会把旧模型的错误归到新模型头上。
    const requestModel = { label: this.modelLabel };

    try {
      await this.agent.run(
        text,
        this.abortController.signal,
        images.length > 0 ? images : undefined,
      );
    } catch (err) {
      const [first, ...rest] = friendlyError(err).split("\n");
      this.lines.push(`${ansi.red}✗ ${first}${ansi.reset}`);
      for (const extra of rest) {
        this.lines.push(`${ansi.gray}  ${extra}${ansi.reset}`);
      }
      // 附上本次请求实际使用的模型（用快照，避免被回退切换后的值覆盖）
      this.lines.push(
        `${ansi.gray}  本次请求使用的模型：${this.modelProviderLabel} / ${requestModel.label}${ansi.reset}`,
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
      case "tools":
        this.printTools();
        break;
      case "device":
        // 手机设备桥（AutoX.js）：启动 / 查看 / 推脚本 / 看日志。异步，故不阻塞按键处理。
        void this.handleDeviceCommand(arg);
        break;
      case "copy":
        this.copyOutput(arg);
        break;
      case "image":
      case "img":
      case "paste":
        // 兜底入口：部分终端把 Ctrl+V 自己吃掉（当作文本粘贴），此时 \x16 到不了这里，
        // 只能靠显式命令读取剪贴板。
        void this.pasteFromClipboard();
        break;
      case "mouse":
        this.toggleMouseCapture();
        break;
      case "reset":
        // Agent.reset() 会一并清除目标（目标属于这段对话）
        this.agent.reset();
        this.goalIterations = 0;
        // 重置后开一个新的会话文件：旧文件保留为存档，/resume 仍能找回重置前的对话
        this.currentSessionFile = startSession(this.cwd, VERSION);
        this.agent.restoreSession([], this.currentSessionFile);
        this.lines.push(`${ansi.gray}会话已重置。${ansi.reset}`);
        break;
      case "undo":
        this.lines.push(undoLastChange(this.cwd));
        break;
      case "resume":
        this.handleResumeCommand(arg);
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
      case "model":
        // 查看 / 切换当前模型；选中的模型会写回配置，下次启动继续用它
        void this.handleModelCommand(arg);
        break;
      case "goal":
        // 目标模式：设定目标后由自动循环持续推进，直到模型调用 goal_complete
        this.handleGoalCommand(arg);
        break;
      default:
        this.lines.push(`${ansi.yellow}未知命令：/${command}，输入 /help 查看帮助。${ansi.reset}`);
    }
    this.scheduleRender();
  }

  /**
   * /goal —— 目标模式。
   *
   * - `/goal <目标>`：设定目标并**立刻开始**自动推进；
   * - `/goal` / `/goal status`：查看当前目标与轮次；
   * - `/goal continue`：继续一个已暂停的目标（中断 / 达到安全阀后）；
   * - `/goal off`：清除目标（别名 stop / clear / cancel）。
   *
   * 「不完成不停」的实现不在 Agent 内部：`agent.run` 仍然是「一次请求 + 其工具轮」，
   * 循环由界面驱动（见 `runGoalLoop`）。这样中断、渲染、确认框全部复用既有机制，
   * 也不会让 Agent 的主循环变成无法从外部收手的死循环。
   */
  private handleGoalCommand(arg: string): void {
    const text = arg.trim();
    const sub = text.toLowerCase();
    const goal = this.agent.getGoal();

    if (!text || sub === "status") {
      if (!goal) {
        this.lines.push(`${ansi.bold}目标模式${ansi.reset} ${ansi.gray}（当前没有目标）${ansi.reset}`);
        this.lines.push(
          `${ansi.gray}用法：/goal <目标描述> —— 设定后玄猪会持续自动推进，` +
            `直到它调用 goal_complete 声明完成；Ctrl+C 可随时中断。${ansi.reset}`,
        );
        return;
      }
      const state = goal.completed
        ? "已完成"
        : this.goalLoopActive
          ? "执行中"
          : "已暂停";
      this.lines.push(
        `${ansi.bold}当前目标${ansi.reset} ${ansi.gray}（${state} · 已执行 ${this.goalIterations} 轮）${ansi.reset}`,
      );
      for (const line of goal.text.split("\n")) {
        this.lines.push(`  ${line}`);
      }
      if (!goal.completed) {
        this.lines.push(
          `${ansi.gray}  · /goal continue 继续自动执行 · /goal off 清除目标${ansi.reset}`,
        );
      }
      return;
    }

    if (["off", "stop", "clear", "cancel", "end"].includes(sub)) {
      if (this.goalLoopActive) {
        // 循环正在跑：标记取消 + 中断当前这一轮，finally 里会收尾并提示
        this.goalCancelled = true;
        this.abortController?.abort();
      }
      this.agent.clearGoal();
      this.lines.push(
        `${ansi.gray}已清除目标${this.goalLoopActive ? "，正在中断执行…" : "。"}${ansi.reset}`,
      );
      return;
    }

    if (["continue", "resume", "go"].includes(sub)) {
      if (!goal) {
        this.lines.push(`${ansi.yellow}当前没有目标。用法：/goal <目标描述>${ansi.reset}`);
        return;
      }
      if (goal.completed) {
        this.lines.push(`${ansi.gray}该目标已完成；要开始新目标请用 /goal <目标描述>。${ansi.reset}`);
        return;
      }
      if (this.busy) {
        this.lines.push(
          `${ansi.yellow}本轮对话进行中 —— 先等它结束，或按 Ctrl+C 中断后再继续目标。${ansi.reset}`,
        );
        return;
      }
      void this.runGoalLoop();
      return;
    }

    // 其余情况：把整段参数当作新目标
    if (this.busy) {
      this.lines.push(
        `${ansi.yellow}本轮对话进行中 —— 先等它结束，或按 Ctrl+C 中断后再设定目标。${ansi.reset}`,
      );
      return;
    }
    if (goal && !goal.completed) {
      this.lines.push(`${ansi.gray}已用新目标替换原目标。${ansi.reset}`);
    }
    this.agent.setGoal(text);
    this.goalCancelled = false;
    this.goalIterations = 0;
    this.printGoalBanner(text);
    // 未开启自动批准时，写文件 / 执行命令仍会弹确认框 —— 提前说明，避免用户以为卡住了
    if (!this.options.config.autoApprove) {
      this.lines.push(
        `${ansi.gray}  · 当前未开启自动批准：遇到写文件 / 执行命令时会请求确认，确认后继续自动推进。${ansi.reset}`,
      );
    }
    void this.runGoalLoop();
  }

  /** 目标模式启动时的醒目横幅 */
  private printGoalBanner(goal: string): void {
    const badge = `${ansi.bgMagenta}${ansi.brightWhite}${ansi.bold} ◎ GOAL ${ansi.reset}`;
    const [first, ...rest] = goal.split("\n");
    this.lines.push(`${badge} ${ansi.brightMagenta}${ansi.bold}${first}${ansi.reset}`);
    for (const line of rest) {
      this.lines.push(`${ansi.brightMagenta}${ansi.bold}│${ansi.reset} ${line}`);
    }
    this.lines.push(
      `${ansi.gray}  目标模式：玄猪会持续自动推进，直到调用 goal_complete 声明完成。` +
        `Ctrl+C 中断（目标保留，/goal continue 可继续）。${ansi.reset}`,
    );
    this.lines.push("");
  }

  /**
   * 目标模式的自动推进循环。
   *
   * 每一轮都是一次完整的 `agent.run`（含其内部的工具轮次）：
   * 1. 首轮发 `goalStartPrompt`，之后每轮发 `goalContinuePrompt`；
   * 2. 如果模型调用了 `goal_complete` → 收尾并清除目标；
   * 3. 正常结束但没有完成标记 → 自动发下一条「继续」，**中间不停**；
   * 4. 用户中断（`goalCancelled`）→ 退出循环，目标保留为「已暂停」；
   * 5. 本轮因重复调用 / 模型错误中止（`getAbortReason`）→ 退出循环并提示，
   *    不再盲目重试（否则同一个死循环会被无限自动继续放大）。
   */
  private async runGoalLoop(): Promise<void> {
    const initial = this.agent.getGoal();
    if (!initial || initial.completed || this.busy) return;
    // 目标可能在本轮执行中被 /goal 替换，用文本快照判断是否还是同一个目标
    const goalText = initial.text;

    this.goalLoopActive = true;
    this.goalCancelled = false;
    this.busy = true;
    this.statusText = "目标执行中";
    this.statusDetail = "";
    this.scheduleRender();

    let done = false;
    let paused = false;
    let hitLimit = false;

    try {
      for (;;) {
        const current = this.agent.getGoal();
        if (this.goalCancelled || !current || current.completed || current.text !== goalText) {
          break;
        }
        if (this.goalIterations >= GOAL_MAX_ITERATIONS) {
          hitLimit = true;
          break;
        }

        this.goalIterations += 1;
        const first = this.goalIterations === 1;
        if (!first) {
          this.lines.push(
            `${ansi.gray}▷ 目标未完成，自动继续（第 ${this.goalIterations} 轮）${ansi.reset}`,
          );
        }
        const prompt = first
          ? goalStartPrompt(goalText)
          : goalContinuePrompt(goalText, this.goalIterations - 1, this.agent.getTodos());

        this.statusText = first ? "目标执行中" : "目标自动继续";
        this.statusDetail = `第 ${this.goalIterations} 轮`;
        this.abortController = new AbortController();
        this.scheduleRender();

        let threw = false;
        try {
          await this.agent.run(prompt, this.abortController.signal);
        } catch (err) {
          threw = true;
          const [firstLine, ...rest] = friendlyError(err).split("\n");
          this.lines.push(`${ansi.red}✗ ${firstLine}${ansi.reset}`);
          for (const extra of rest) {
            this.lines.push(`${ansi.gray}  ${extra}${ansi.reset}`);
          }
        } finally {
          this.abortController = undefined;
          const tail = this.markdown.flush();
          if (tail.length > 0) this.lines.push(...tail);
          this.streamingPreview = "";
          this.lines.push("");
        }

        const after = this.agent.getGoal();
        if (after?.completed) {
          done = true;
          break;
        }
        if (this.goalCancelled) {
          paused = true;
          break;
        }
        if (!after || after.text !== goalText) {
          // 目标在执行中已被替换 / 清除
          break;
        }
        // 本轮非正常收尾（重复调用中止、模型调用失败等）不再自动继续
        const abortReason = this.agent.getAbortReason();
        if (threw || abortReason) {
          paused = true;
          this.lines.push(
            `${ansi.yellow}⚠ 目标已暂停${abortReason ? `（${abortReason}）` : ""}：` +
              `自动继续会放大同一个问题，故停下等你处理。${ansi.reset}`,
          );
          break;
        }
      }
    } finally {
      this.goalLoopActive = false;
      this.busy = false;
      this.abortController = undefined;
      this.statusText = "就绪";
      this.statusDetail = "";

      const final = this.agent.getGoal();
      if (done && final) {
        this.lines.push(`${ansi.brightGreen}${ansi.bold}✓ 目标已完成${ansi.reset}`);
        this.lines.push(`${ansi.gray}  共执行 ${this.goalIterations} 轮。${ansi.reset}`);
        if (final.summary) {
          for (const line of final.summary.split("\n")) {
            this.lines.push(`${ansi.gray}  ${line}${ansi.reset}`);
          }
        }
        // 完成即退出目标模式：后续普通对话不再注入目标提示词
        this.agent.clearGoal();
      } else if (final && !final.completed) {
        if (hitLimit) {
          this.lines.push(
            `${ansi.yellow}已达目标模式的安全上限（${GOAL_MAX_ITERATIONS} 轮），已暂停。${ansi.reset}`,
          );
        }
        if (paused && !hitLimit) {
          this.lines.push(`${ansi.gray}目标已暂停：${final.text}${ansi.reset}`);
        }
        this.lines.push(
          `${ansi.gray}  · /goal continue 继续自动执行 · /goal off 清除目标 · /goal 查看状态${ansi.reset}`,
        );
      }
      this.scheduleRender();
    }
  }

  /**
   * /resume —— 恢复历史会话。
   *
   * 不带参数：列出当前项目的会话（新的在前），提示用 `/resume <编号>` 恢复；
   * 带编号：整体替换对话历史，并开启**新的**会话文件继续增量记录
   * （旧文件保留为存档，恢复后的内容不写入旧文件）。
   *
   * 之所以不用交互式选择器：TUI 常驻 raw 模式并有自有按键处理，
   * 与 promptSelect 的按键监听会互相干扰；「先列表后带编号」是同一套输入框就能完成的交互。
   */
  private handleResumeCommand(arg: string): void {
    const sessions = listSessions(this.cwd).filter(
      (session) => session.file !== this.currentSessionFile,
    );
    if (sessions.length === 0) {
      this.lines.push(`${ansi.gray}没有可恢复的历史会话。${ansi.reset}`);
      return;
    }

    if (!arg) {
      this.lines.push(
        `${ansi.bold}历史会话${ansi.reset} ${ansi.gray}(新的在前，输入 /resume <编号> 恢复)${ansi.reset}`,
      );
      sessions.slice(0, 10).forEach((session, index) => {
        const when = session.startedAt ?? "未知时间";
        this.lines.push(
          `  ${index + 1}. ${ansi.cyan}${when}${ansi.reset} ${ansi.gray}· ${ansi.reset}${(session.bytes / 1024).toFixed(1)} KB`,
        );
      });
      return;
    }

    const index = Number.parseInt(arg, 10) - 1;
    const picked = Number.isInteger(index) ? sessions[index] : undefined;
    if (!picked) {
      this.lines.push(
        `${ansi.yellow}无效编号：${arg}。先运行 /resume 查看列表。${ansi.reset}`,
      );
      return;
    }

    const messages = loadSessionMessages(picked.file);
    if (messages.length === 0) {
      this.lines.push(
        `${ansi.yellow}该会话文件里没有可恢复的消息。${ansi.reset}`,
      );
      return;
    }

    const file = startSession(this.cwd, VERSION);
    this.currentSessionFile = file;
    // restoreSession 会一并清除目标（旧历史与旧目标无关）
    this.agent.restoreSession(messages, file);
    this.goalIterations = 0;
    this.lines.push(
      `${ansi.green}✓ 已恢复 ${messages.length} 条消息的对话历史。${ansi.reset}`,
      `${ansi.gray}继续对话即可；此后内容会写入新的会话文件。${ansi.reset}`,
    );
  }

  /**
   * 切换项目（/switch）。
   *
   * 语义是「切换项目 = 在该项目重新开局」：除了换 cwd / 规则 / 记忆 / 终端目录，
   * 还会**载入目标目录最近一次会话**接着聊，会话文件也随之换到该项目名下。
   *
   * 为什么必须连会话文件一起换：会话文件按项目分目录（`sessionDirFor(cwd)`），
   * 而 `/resume` 只列**当前项目**目录下的文件 —— 若切了目录却沿用原会话文件，
   * 在新项目里聊的内容会一直记在原项目名下，从新项目里永远 `/resume` 不到。
   * 代价是当前对话就此中断：它已增量存档在原项目的会话文件里，切回去即可找回。
   */
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

    // 载入目标目录最近一次会话（排除当前正在写的这份，防止 /switch 回原目录时自我套娃）
    const previous = listSessions(resolved).filter(
      (session) => session.file !== this.currentSessionFile,
    )[0];
    const messages = previous ? loadSessionMessages(previous.file) : [];
    const file = startSession(resolved, VERSION);
    this.currentSessionFile = file;
    // restoreSession 会一并清除目标：切项目 = 在新项目重新开局
    this.agent.restoreSession(messages, file);
    this.goalIterations = 0;
    if (messages.length > 0) {
      this.lines.push(
        `${ansi.gray}  已载入该项目上次会话（${messages.length} 条消息，${previous.startedAt ?? "未知时间"}），` +
          `接着聊即可；原对话已存档，切回后 /resume 可找回。${ansi.reset}`,
      );
    } else {
      this.lines.push(
        `${ansi.gray}  该项目还没有历史会话，全新开局；后续文件与命令操作将基于该目录。${ansi.reset}`,
      );
    }
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
    // 写回配置：一次切换即永久生效，不必每次启动都敲 /mouse
    this.options.config.mouseCapture = this.mouseCapture;
    try {
      saveConfig(this.options.config);
    } catch {
      // 写盘失败不影响本次会话内的切换效果
    }
    process.stdout.write(
      this.mouseCapture
        ? "\x1b[?1000h\x1b[?1002h\x1b[?1006h"
        : "\x1b[?1000l\x1b[?1002l\x1b[?1006l",
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
    let trimmed = arg.trim().toLowerCase();

    // `/copy term …` 复制**右侧终端**的输出。
    //
    // 存在的意义：终端原生的 Shift+拖选是「矩形选择」，而界面分两栏 ——
    // 一旦拖过中缝就会把另一栏的文字一起带走。命令式复制按**栏**取内容，
    // 从根上避开了这个问题；两个区域各有一条通路。
    let source = this.lines;
    let areaLabel = "";
    if (trimmed === "term" || trimmed.startsWith("term ")) {
      source = this.term.visibleLines();
      areaLabel = "终端输出 ";
      trimmed = trimmed.slice(4).trim();
    }
    const total = source.length;

    let selected: string[];
    let label: string;

    if (trimmed === "all") {
      selected = source.slice();
      label = "全部";
    } else if (trimmed === "last") {
      selected =
        source === this.lines
          ? this.lines.slice(Math.min(this.lastAnswerStart, total))
          : source.slice(-30);
      label = source === this.lines ? "最近一次对话" : "最近 30 行";
    } else if (/^\d+-\d+$/.test(trimmed)) {
      const [fromText, toText] = trimmed.split("-");
      const from = Math.max(1, Number(fromText));
      const to = Math.min(total, Number(toText));
      if (from > to) {
        this.lines.push(
          `${ansi.yellow}行号范围无效：${trimmed}${ansi.reset}` +
            `${ansi.gray}（${areaLabel || "输出区"}当前 ${total} 行）${ansi.reset}`,
        );
        return;
      }
      selected = source.slice(from - 1, to);
      label = `第 ${from}-${to} 行`;
    } else {
      const count = /^\d+$/.test(trimmed) ? Number(trimmed) : 30;
      selected = source.slice(-Math.max(1, count));
      label = `最近 ${Math.min(Math.max(1, count), total)} 行`;
    }
    label = areaLabel + label;

    // sanitizeControl 会剥掉颜色与其余控制字符，剪贴板里只留纯文本
    const plain = sanitizeControl(selected.join("\n")).trim();
    if (!plain) {
      const extra =
        trimmed === "last" && total === 0 && source === this.lines
          ? "，尚未进行过对话"
          : "";
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

  /**
   * 构造设备桥（含事件接线），供 `/device serve` 与 `/device connect` 共用。
   *
   * 事件分工：**设备上下线进对话区**（重要、低频），**脚本日志只进右侧面板**
   * （console.log 可能很密，刷进对话区会把正文淹掉）。
   */
  private createDeviceBridge(controlPort: number): DeviceBridge {
    return new DeviceBridge({
      port: controlPort,
      baseDir: this.cwd,
      // 桥自身的状态只进右侧面板：启动信息下面会单独排版，避免重复刷对话区
      onStatus: (message) => this.term.notice(`${ansi.gray}${message}${ansi.reset}`),
      onDeviceAttach: (device) => {
        const kind = device.kind === "autojs6" ? "AutoJs6" : "AutoX.js";
        this.handleNotice(`设备已连接：${device.name}（${kind}）`);
        this.term.notice(
          `${ansi.brightGreen}●${ansi.reset} 设备已连接：${ansi.bold}${device.name}${ansi.reset}` +
            `${ansi.gray}（${kind}）${ansi.reset}`,
        );
      },
      onDeviceDetach: (device) => {
        this.handleNotice(`设备已断开：${device.name}`);
        this.term.notice(`${ansi.yellow}○${ansi.reset} 设备已断开：${device.name}`);
      },
      onLog: (entry) =>
        this.term.notice(
          `${ansi.gray}[${entry.device}]${ansi.reset} ${sanitizeControl(entry.text)}`,
        ),
    });
  }

  /** 把「首次连接手机」的引导打进对话区（ABI 探测 + 官方下载地址 + 本机缓存） */
  private pushDeviceSetupGuide(address?: string): void {
    const detection = detectAndroidAbi();
    const guide = buildDeviceSetupGuide({
      where: isRunningOnAndroid() ? "phone" : "pc",
      abi: detection.abi,
      address,
      localApk: findLocalApk(detection.abi),
    });
    this.lines.push(
      `${ansi.yellow}需要先装 AutoJs6${ansi.reset}${ansi.gray}（${detection.detail}）${ansi.reset}`,
    );
    for (const line of guide.split("\n")) {
      if (line) this.lines.push(`${ansi.gray}  ${line}${ansi.reset}`);
    }
  }

  /**
   * `/device` —— 手机设备桥（AutoX.js / Auto.js）。
   *
   * 与 `xzh device` 的 CLI 子命令等价，区别是桥跑在**本进程内**：
   *   - 手机端连上后，脚本日志实时显示在**右侧终端面板**（不刷进对话区）；
   *   - 桥实例同时交给 Agent，于是可以直接说"把这个脚本推到手机跑一遍"。
   *
   * 用法：`/device`（状态） · `/device serve [端口]` · `/device stop` ·
   *       `/device list` · `/device push <文件>` · `/device run <文件>` · `/device logs [N]`
   */
  private async handleDeviceCommand(arg: string): Promise<void> {
    const [sub, ...rest] = arg.trim().split(/\s+/);
    const value = rest.join(" ").trim();
    const bridge = this.deviceBridge;

    switch (sub) {
      case "":
      case "status": {
        if (!bridge?.isRunning() && !bridge?.status().autojs6) {
          this.lines.push(`${ansi.yellow}设备桥未启动${ansi.reset}`);
          this.lines.push(
            `${ansi.gray}  · 连接 AutoJs6（推荐）：/device connect <手机IP>（手机本机运行时不用填）${ansi.reset}`,
          );
          this.lines.push(
            `${ansi.gray}  · 或等 AutoX.js 连过来：/device serve${ansi.reset}`,
          );
          break;
        }
        const status = bridge.status();
        this.lines.push(
          `${ansi.brightGreen}●${ansi.reset} 设备桥运行中 ${ansi.gray}端口 ${status.port}${ansi.reset}`,
        );
        if (status.autojs6) {
          this.lines.push(
            `${ansi.gray}  AutoJs6：${ansi.reset}${status.autojs6.address} ` +
              (status.autojs6.connected
                ? `${ansi.brightGreen}已连接${ansi.reset}`
                : `${ansi.yellow}连接中/等待重试${ansi.reset}`),
          );
        }
        for (const url of status.urls) {
          this.lines.push(`${ansi.gray}  手机端 AutoX.js 填写：${ansi.reset}${url}`);
        }
        this.lines.push(
          `${ansi.gray}  已连接设备：${ansi.reset}${status.devices.length}`,
        );
        for (const device of status.devices) {
          const kind = device.kind === "autojs6" ? "AutoJs6" : "AutoX.js";
          this.lines.push(
            `    ${ansi.cyan}${device.name}${ansi.reset} ${ansi.gray}${device.id} · ${kind}${ansi.reset}`,
          );
        }
        break;
      }

      case "connect": {
        if (bridge?.isRunning() || bridge?.status().autojs6) {
          this.lines.push(
            `${ansi.yellow}设备桥已在运行${ansi.reset}${ansi.gray}（先 /device stop 再连）${ansi.reset}`,
          );
          break;
        }
        const onPhone = isRunningOnAndroid();
        let host = "";
        let port = AUTOJS6_APP_SERVER_PORT;
        if (value) {
          const match = /^(.*?)(?::(\d+))?$/.exec(value);
          host = (match?.[1] ?? value).trim();
          const parsedPort = match?.[2] ? Number.parseInt(match[2], 10) : NaN;
          if (Number.isFinite(parsedPort)) port = parsedPort;
        } else if (onPhone) {
          // 手机本机运行：AutoJs6 就在同一台设备上，不必让用户去查 IP
          host = "127.0.0.1";
        }

        if (!host) {
          this.lines.push(
            `${ansi.gray}用法：/device connect <手机IP>[:端口]（默认 ${AUTOJS6_APP_SERVER_PORT}）${ansi.reset}`,
          );
          this.pushDeviceSetupGuide();
          break;
        }

        const created = this.createDeviceBridge(resolveDevicePort());
        try {
          await created.connectAutoJs6(host, port);
        } catch (err) {
          this.lines.push(
            `${ansi.red}✗ 设备桥启动失败：${err instanceof Error ? err.message : String(err)}${ansi.reset}`,
          );
          break;
        }
        this.deviceBridge = created;
        this.agent.setDeviceBridge(created);
        // 手机连上后日志会打到右侧面板，面板关着就等于看不见 —— 自动展开
        if (!this.termVisible) this.termVisible = true;
        this.lines.push(
          `${ansi.brightGreen}●${ansi.reset} 正在连接手机 ${ansi.brightGreen}${host}:${port}${ansi.reset}` +
            `${ansi.gray}（AutoJs6 服务器模式）${ansi.reset}`,
        );

        // 等一小会儿：连不上就把「装 AutoJs6 + 开服务器模式 + 填 IP」的引导打出来。
        // 注意这不会终止连接尝试 —— 客户端仍在后台按退避重连。
        let connected = false;
        for (let i = 0; i < 20 && !connected; i++) {
          connected = created.status().autojs6?.connected ?? false;
          if (!connected) await new Promise((resolve) => setTimeout(resolve, 150));
        }
        if (connected) {
          this.lines.push(
            `${ansi.gray}  已连接。推送脚本：/device run <文件>；日志显示在右侧终端面板。${ansi.reset}`,
          );
        } else {
          const retrying = created.status().autojs6?.retrying ?? false;
          this.lines.push(
            retrying
              ? `${ansi.yellow}暂时没连上，仍在后台按退避重试${ansi.reset}${ansi.gray}（/device stop 可停止）${ansi.reset}`
              : `${ansi.red}连不上手机（已停止重试）${ansi.reset}${ansi.gray} —— 按下面步骤检查后，先 /device stop 再重新 /device connect${ansi.reset}`,
          );
          this.pushDeviceSetupGuide(`${host}:${port}`);
        }
        break;
      }

      case "serve":
      case "start": {
        if (bridge?.isRunning()) {
          this.lines.push(
            `${ansi.yellow}设备桥已在运行${ansi.reset}${ansi.gray}（端口 ${bridge.getPort()}）${ansi.reset}`,
          );
          break;
        }
        const port = value ? Number.parseInt(value, 10) : resolveDevicePort();
        const created = this.createDeviceBridge(
          Number.isFinite(port) && port > 0 ? port : resolveDevicePort(),
        );

        try {
          await created.start();
        } catch (err) {
          this.lines.push(
            `${ansi.red}✗ 设备桥启动失败：${err instanceof Error ? err.message : String(err)}${ansi.reset}`,
          );
          break;
        }
        this.deviceBridge = created;
        this.agent.setDeviceBridge(created);
        // 手机连上后日志会打到右侧面板，面板关着就等于看不见 —— 自动展开
        if (!this.termVisible) this.termVisible = true;

        this.lines.push(
          `${ansi.brightGreen}●${ansi.reset} 设备桥已启动 ${ansi.gray}（端口 ${created.getPort()}）${ansi.reset}`,
        );
        for (const url of created.urls()) {
          this.lines.push(
            `${ansi.gray}  手机端 AutoX.js 填写：${ansi.reset}${ansi.brightGreen}${url}${ansi.reset}`,
          );
        }
        // AutoJs6 那侧也监听上（手机「客户端模式」连过来）：与 9317 独立，
        // 端口被占（多半是 VSCode 的 AutoJs6 扩展）只提示、不中断 AutoX.js 那边。
        try {
          await created.startAutoJs6Listener();
          this.lines.push(
            `${ansi.brightGreen}●${ansi.reset} AutoJs6 监听已就绪 ${ansi.gray}（端口 ${AUTOJS6_PC_SERVER_PORT}）${ansi.reset}`,
          );
          for (const url of created.listenerUrls()) {
            this.lines.push(
              `${ansi.gray}  手机 AutoJs6「客户端模式」填：${ansi.reset}${ansi.brightGreen}${url}${ansi.reset}`,
            );
          }
        } catch (err) {
          this.lines.push(
            `${ansi.yellow}⚠ AutoJs6 监听未启动${ansi.reset}${ansi.gray}：${
              err instanceof Error ? err.message : String(err)
            }${ansi.reset}`,
          );
        }

        this.lines.push(
          `${ansi.gray}  脚本日志显示在右侧终端面板；推送脚本：/device run <文件>（或 /device push）。${ansi.reset}`,
        );
        this.lines.push(
          `${ansi.gray}  停止：/device stop${ansi.reset}`,
        );
        break;
      }

      case "stop": {
        if (!bridge?.isRunning()) {
          this.lines.push(`${ansi.gray}设备桥未在运行。${ansi.reset}`);
          break;
        }
        await bridge.stop();
        this.deviceBridge = undefined;
        this.agent.setDeviceBridge(undefined);
        this.lines.push(`${ansi.gray}设备桥已停止。${ansi.reset}`);
        break;
      }

      case "list":
      case "devices": {
        if (!bridge?.isRunning()) {
          this.lines.push(`${ansi.yellow}设备桥未启动${ansi.reset}${ansi.gray}（/device serve）${ansi.reset}`);
          break;
        }
        const devices = bridge.listDevices();
        if (devices.length === 0) {
          this.lines.push(`${ansi.gray}当前没有已连接的设备。${ansi.reset}`);
          break;
        }
        this.lines.push(`${ansi.gray}已连接设备（${devices.length}）：${ansi.reset}`);
        for (const device of devices) {
          this.lines.push(
            `  ${ansi.cyan}${device.name}${ansi.reset} ${ansi.gray}${device.id} · versionCode ${device.appVersionCode}${ansi.reset}`,
          );
        }
        break;
      }

      case "push":
      case "run": {
        if (!value) {
          this.lines.push(`${ansi.gray}用法：/device ${sub} <脚本文件>${ansi.reset}`);
          break;
        }
        if (!bridge?.isRunning()) {
          this.lines.push(`${ansi.yellow}设备桥未启动${ansi.reset}${ansi.gray}（/device serve）${ansi.reset}`);
          break;
        }
        const result =
          sub === "run" ? bridge.runScript(value) : bridge.pushScript(value);
        if (!result.ok) {
          this.lines.push(`${ansi.red}✗ ${result.message}${ansi.reset}`);
          break;
        }
        this.lines.push(
          `${ansi.green}✓${ansi.reset} ${
            sub === "run" ? "已推送到设备并开始运行" : "已保存到设备"
          }：${result.path}\n` +
            `${ansi.gray}  目标设备（${result.delivered}）：${result.devices.join("、")}${ansi.reset}`,
        );
        break;
      }

      case "logs": {
        if (!bridge?.isRunning()) {
          this.lines.push(`${ansi.yellow}设备桥未启动${ansi.reset}${ansi.gray}（/device serve）${ansi.reset}`);
          break;
        }
        const limit = Number.parseInt(value, 10);
        const entries = bridge.recentLogs(Number.isFinite(limit) && limit > 0 ? limit : 30);
        if (entries.length === 0) {
          this.lines.push(`${ansi.gray}暂无设备日志。${ansi.reset}`);
          break;
        }
        this.lines.push(`${ansi.gray}最近 ${entries.length} 条设备日志：${ansi.reset}`);
        for (const entry of entries) {
          this.lines.push(
            `${ansi.gray}[${entry.device}]${ansi.reset} ${sanitizeControl(entry.text)}`,
          );
        }
        break;
      }

      default:
        this.lines.push(
          `${ansi.gray}用法：/device [connect <手机IP>|serve|stop|list|push <文件>|run <文件>|logs]${ansi.reset}`,
        );
        break;
    }
    this.scheduleRender();
  }

  /**
   * 列出本轮实际发给模型的工具（`/tools`）。
   *
   * 用途：当某个工具「好像从来没被调用过」时，先确认它到底有没有发出去。
   * 玄猪把**全部内置工具**写进每次请求的 tools 字段，没有任何开关 ——
   * 如果列表里有它，那么用不用就完全取决于模型对工具描述与系统提示词的理解。
   */
  private printTools(): void {
    const specs = getToolSpecs();
    this.lines.push(
      `${ansi.bold}发给模型的工具（共 ${specs.length} 个）${ansi.reset}` +
        `${ansi.gray}（每次请求都会带上，无开关）${ansi.reset}`,
    );
    for (const spec of specs) {
      const brief = spec.description.split("\n")[0].replace(/\*\*/g, "");
      this.lines.push(
        `  ${ansi.cyan}${spec.name.padEnd(16)}${ansi.reset} ${ansi.gray}${truncate(brief, 60)}${ansi.reset}`,
      );
    }
    this.lines.push(
      `${ansi.gray}  是否被调用由模型决定；想强调某个工具，可写进项目规则（.xuanzhu/rules.md）。${ansi.reset}`,
    );
    this.scheduleRender();
  }

  private printHelp(): void {
    const help = [
      `${ansi.bold}玄猪 内置命令${ansi.reset}`,
      `  /help          显示本帮助`,
      `  /clear         清空屏幕`,
      `  /tools         列出本轮发给模型的工具（排查「某个工具似乎没被调用过」）`,
      `  /device        手机设备桥（先 /device serve 或 /device connect <手机IP>）`,
      `                 子命令：connect｜serve｜stop｜list｜push <文件>｜run <文件>｜logs [N]`,
      `                 体检与截图请用命令行：xzh device check / xzh device shot`,
      `  /copy [N|A-B|last|all]  复制左侧对话到系统剪贴板（默认最近 30 行）`,
      `  /copy term [N|A-B|all]  复制右侧终端输出（按栏取内容，不会串栏）`,
      `  /image         把系统剪贴板里的图片加为本轮附件（同 Ctrl+V；别名 /paste）`,
      `  /mouse         切换鼠标捕获：开启后可在输出区拖拽选择（按整行）`,
      `  /reset         重置对话上下文`,
      `  /undo          撤销玄猪对文件的最近一次修改（改前自动备份）`,
      `  /resume [编号]  列出 / 恢复历史会话（对话历史会自动保存）`,
      `  /cwd           显示当前工作目录`,
      `  /switch <目录> 切换项目（载入该项目上次会话接着聊）`,
      `  /term          显示/隐藏右侧终端面板（/term clear 清空输出）`,
      `  /model [编号|id|模型名]  查看 / 切换当前模型（不带参数：↑ ↓ 选择，Enter 确认）`,
      `  /goal <目标>   目标模式：持续自动执行直到完成（Ctrl+C 中断；/goal off 清除）`,
      `  /goal [status|continue|off]  查看当前目标 / 继续已暂停的目标 / 清除目标`,
      `  /auto [on|off] 切换自动批准（on：所有工具直接执行，写入配置）`,
      `  /intent [on|off] 切换意图分析（on：每条消息先做意图分析再处理，写入配置）`,
      `  /exit          退出玄猪`,
      `${ansi.bold}快捷键${ansi.reset}`,
      `  Enter 提交 · ${ansi.bold}Alt+Enter${ansi.reset} 换行（Ctrl/Shift+Enter 视终端而定）`,
      `  ↑/↓ 历史 · Ctrl+A/Ctrl+E 行首/行尾 · PgUp/PgDn 翻页 · Shift+↑/↓ 逐行`,
      `  Home/End 跳到最早/最新`,
      `  ${ansi.gray}鼠标${ansi.reset}：滚轮滚动输出区；${ansi.bold}在输出区拖拽即可选中并复制${ansi.reset}${ansi.gray}（松开写入剪贴板）。${ansi.reset}`,
      `      想用终端原生框选/右键菜单：${ansi.reset}Shift+拖拽${ansi.gray} 绕过，或 ${ansi.reset}/mouse${ansi.gray} 交还鼠标（滚动改用 PgUp/PgDn）。${ansi.reset}`,
      `      ⚠ 拖选是矩形选择，跨过中缝会把另一栏一起带走 ——` + `跨栏内容请改用 ${ansi.reset}/copy${ansi.gray}（左栏）或 ${ansi.reset}/copy term${ansi.gray}（右栏）。${ansi.reset}`,
      `  ${ansi.gray}粘贴${ansi.reset}：支持多行整段粘贴（不会逐行提交）；也可用 ${ansi.reset}/copy${ansi.gray} 复制输出区。${ansi.reset}`,
      `  ${ansi.bold}Ctrl+V${ansi.reset} ${ansi.gray}粘贴图片：读取系统剪贴板里的图片作为附件（输入框显示${ansi.reset}[图片N]${ansi.gray}，回车发送）。${ansi.reset}`,
      `       ${ansi.gray}终端只会传文本，图片拿不到，因此由玄猪主动读剪贴板：${ansi.reset}`,
      `       ${ansi.gray}Linux 缺 ${ansi.reset}wl-clipboard${ansi.gray}/${ansi.reset}xclip${ansi.gray} 时会询问后自动安装；Windows 用内置 PowerShell；macOS 用 ${ansi.reset}pngpaste${ansi.gray} 或内置 osascript。${ansi.reset}`,
      `       ${ansi.gray}若本终端把 Ctrl+V 当自己的粘贴键（如 Windows Terminal），改用 ${ansi.reset}/image${ansi.gray}。${ansi.reset}`,
      `       ${ansi.gray}需要模型支持视觉（glm-4v / qwen-vl / gpt-4o / claude 等）；可用 ${ansi.reset}xzh model vision <id> on${ansi.gray} 手动标注。${ansi.reset}`,
      `  Shift+Tab 切换焦点（对话 ⇄ 右侧终端）· 鼠标点击亦可`,
      `  Ctrl+C 中断任务 / 清空输入 / 退出（空闲且输入为空时退出）`,
      `  Ctrl+D 结束本轮正在进行的对话 · 任何情况下都不会退出玄猪`,
      `  Ctrl+L 清屏`,
      `  注：${ansi.bold}Alt+Enter${ansi.reset} 走终端原生编码，各终端通用；`,
      `      Ctrl/Shift+Enter 需要终端支持扩展键盘协议，部分终端（尤其 IDE 内置）不支持。`,
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
    const modelText = truncate(
      `${this.modelProviderLabel} / ${this.modelLabel}`,
      Math.max(10, width - 8),
    );
    const dirText = truncate(this.cwd, Math.max(10, width - 8));
    const divider = `${ansi.gray}${"─".repeat(Math.max(0, width))}${ansi.reset}`;
    // 目标模式：始终占一行显示目标，便于随时看清「它现在为什么还在跑」
    const goal = this.agent.getGoal();
    const goalState = goal
      ? goal.completed
        ? "已完成"
        : this.goalLoopActive
          ? `执行中 · 第 ${this.goalIterations} 轮`
          : "已暂停"
      : "";
    const goalLine = goal
      ? `${ansi.gray}  目标：${ansi.reset}${ansi.brightMagenta}${truncate(
          goal.text.replace(/\s+/g, " "),
          Math.max(10, width - 18),
        )}${ansi.reset}${ansi.gray}（${goalState}）${ansi.reset}`
      : null;
    const info = [
      `${ansi.brightMagenta}${ansi.bold}  玄猪 XuanZhu${ansi.reset} ${ansi.gray}v${VERSION} · 终端 AI 编码 Agent${ansi.reset}`,
      `${ansi.gray}  模型：${ansi.reset}${modelText}${ansi.reset}`,
      `${ansi.gray}  目录：${ansi.reset}${dirText}${ansi.reset}`,
      ...(goalLine ? [goalLine] : []),
      ...this.todoHeaderLines(width),
      `${ansi.gray}  输入 ${ansi.reset}${ansi.brightGreen}/help${ansi.reset}${ansi.gray} 查看命令与快捷键${ansi.reset}`,
      `${ansi.gray}  ${ansi.reset}Ctrl+D${ansi.gray} 结束本轮对话（不退出）· ${ansi.reset}Ctrl+C${ansi.gray} 中断/清空/退出${ansi.reset}`,
      `${ansi.gray}  ${ansi.reset}Shift+Tab${ansi.gray} 切终端 · ${ansi.reset}PgUp${ansi.gray}/滚轮回看历史${ansi.reset}`,
    ];
    return { info, divider };
  }

  /**
   * 任务列表在顶部信息区的展示行（无任务时返回空数组）。
   *
   * 只展开「进行中 + 待办」的前几项，已完成 / 已取消压缩成计数 ——
   * 信息区高度上限是终端高度的 1/3，全部展开会挤掉模型与目录信息。
   * 完整清单可由模型通过 todo_write 的返回值（回灌进对话）呈现。
   */
  private todoHeaderLines(width: number): string[] {
    if (this.todoItems.length === 0) return [];

    const done = this.todoItems.filter((item) => item.status === "completed").length;
    const cancelled = this.todoItems.filter(
      (item) => item.status === "cancelled",
    ).length;
    const total = this.todoItems.length - cancelled;
    const summary =
      `任务 ${done}/${total}` + (cancelled > 0 ? ` · 取消 ${cancelled}` : "");

    const lines = [`${ansi.gray}  ${ansi.reset}${ansi.bold}${summary}${ansi.reset}`];
    const active = this.todoItems.filter(
      (item) => item.status === "in_progress" || item.status === "pending",
    );
    const MAX_ITEMS = 3;
    for (const item of active.slice(0, MAX_ITEMS)) {
      const running = item.status === "in_progress";
      const mark = running
        ? `${ansi.brightCyan}▸${ansi.reset}`
        : `${ansi.gray}·${ansi.reset}`;
      const text = truncate(item.content, Math.max(8, width - 8));
      lines.push(`  ${mark} ${running ? ansi.bold : ansi.gray}${text}${ansi.reset}`);
    }
    if (active.length > MAX_ITEMS) {
      lines.push(`${ansi.gray}  …还有 ${active.length - MAX_ITEMS} 项${ansi.reset}`);
    }
    return lines;
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
    // 挂起期间（安装命令占着终端）绝不能输出，否则两边的内容会互相踩踏
    if (this.exited || this.suspended) return;
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
      : this.pendingSelect
        ? this.layoutSelect(leftWidth)
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

    // 记录「屏幕行(0-based 整屏) → 逻辑行」映射，供鼠标拖拽选择反查。
    // visible 前面可能被补过空行（unshift），用 pad 校正偏移。
    const pad = Math.max(0, outputRows - (end - start));
    const physicalMap = this.lastPhysicalMap;
    this.screenToLogical = [];
    for (let i = 0; i < bodyRows; i++) {
      const offset = i - headerRows;
      if (offset < 0 || offset >= outputRows) {
        this.screenToLogical.push(undefined);
        continue;
      }
      const phys = start + offset - pad;
      const logical =
        phys >= 0 && phys < physicalMap.length ? physicalMap[phys] : -1;
      // -1 表示流式预览（尚未进入 this.lines），不可选中
      this.screenToLogical.push(logical >= 0 ? logical : undefined);
    }

    // 选区高亮：给选中的物理行套反色，否则用户看不出拖拽选了什么
    if (this.selectionAnchor !== undefined && this.selectionHead !== undefined) {
      const selFrom = Math.min(this.selectionAnchor, this.selectionHead);
      const selTo = Math.max(this.selectionAnchor, this.selectionHead);
      for (let k = 0; k < visible.length; k++) {
        const phys = start + k - pad;
        if (phys < 0 || phys >= physicalMap.length) continue;
        const logical = physicalMap[phys];
        if (logical >= selFrom && logical <= selTo) {
          visible[k] = `${ansi.inverse}${visible[k]}${ansi.reset}`;
        }
      }
    }
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
        // 右栏隐藏时 leftWidth === columns，但**仍然必须截断 + 补齐**：
        // 头部那几条固定提示行（约 54 列）在窄终端下会超出宽度，
        // 而终端已关闭自动换行（?7l），超宽内容会在末列互相覆盖、错位。
        out += padEnd(truncate(left, columns), columns);
      }
    }

    out += cursor.to(rows, 1) + "\x1b[2K" + this.renderStatus(columns);

    if (this.pendingConfirm || this.pendingSelect) {
      // 浮层（确认框 / 单选列表）期间没有文本光标可定位
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
    // 标题行 = label + cwd(≤room) + status，三者之和必须 ≤ width。
    // 早期按 `width - 9 - (running ? 5 : 0)` 手算保留宽度，与实际文本宽度对不上
    // （「 终端 」6 列、「 ● 运行中」9 列）→ 运行中时固定超宽 1 列，被 render 截断掉字。
    const reserved = textWidth(label) + textWidth(status);
    const room = Math.max(6, width - reserved);
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
    // 超宽时从左侧滚动，保证光标可见。
    // ⚠️ 两处必须做对：① 按 **code point** 丢字符（否则会把 emoji 从中间切开）；
    // ② 丢掉的字符数要**同步从光标位置里扣掉**。早期实现用 `slice(1)` 丢字符、
    // 却仍按原来的 `termInputCursor` 算光标宽度，于是既多丢字符、光标又与真实插入点错位。
    const chars = Array.from(this.termInput);
    let cursorCp = chars.length;
    {
      let count = 0;
      for (let i = 0; i < chars.length; i++) {
        if (count >= this.termInputCursor) {
          cursorCp = i;
          break;
        }
        count += chars[i].length;
      }
    }
    let scrollFrom = 0;
    while (
      scrollFrom < cursorCp &&
      textWidth(chars.slice(scrollFrom, cursorCp).join("")) > avail
    ) {
      scrollFrom++;
    }
    const text = chars.slice(scrollFrom).join("");
    const cursorWidth = textWidth(chars.slice(scrollFrom, cursorCp).join(""));
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
    // 同时记录每个物理行来自哪一条逻辑行（this.lines 的索引），
    // 供鼠标拖拽选择时反查 —— 屏幕上的一行未必对应一条逻辑行（长行会折行）。
    const map: number[] = [];
    for (let index = 0; index < this.lines.length; index++) {
      const wrapped = wrapText(this.lines[index], width);
      result.push(...wrapped);
      for (let i = 0; i < wrapped.length; i++) map.push(index);
    }
    if (this.streamingPreview) {
      const wrapped = wrapText(this.streamingPreview, width);
      result.push(...wrapped);
      // 流式预览尚未进入 this.lines，标记为 -1：它不可被选中复制
      for (let i = 0; i < wrapped.length; i++) map.push(-1);
    }
    this.lastPhysicalMap = map;
    return result;
  }

  private renderStatus(width: number): string {
    const left = ` 玄猪 `;
    const autoMark = this.autoApprove ? "⚡auto · " : "";
    const intentMark = this.intentEnabled ? "⌁intent · " : "";
    // 目标模式标记：一眼看出当前处于「会自动继续」的状态
    const goalMark = this.agent.getGoal() ? "◎goal · " : "";
    const focusMark = this.termVisible
      ? this.termFocus
        ? "终端▸ "
        : "对话▸ "
      : "";
    // 滚动指示：偏移量 > 0 时提示已上翻的行数，便于发现「有历史可回看 / 需按 End 回到最新」
    const scrollMark =
      this.scrollOffset > 0
        ? `${ansi.brightYellow}↑${this.scrollOffset}${ansi.reset}${ansi.bgBlue} `
        : "";
    const termScrollMark =
      this.termScroll > 0
        ? `${ansi.brightYellow}⇡${this.termScroll}${ansi.reset}${ansi.bgBlue} `
        : "";
    // 选区提示：拖拽中标注「松开复制」，松开后选区仍保留（便于确认选了什么）
    const selectionMark =
      this.selectionAnchor !== undefined && this.selectionHead !== undefined
        ? `${ansi.brightYellow}已选 ${
            Math.abs(this.selectionHead - this.selectionAnchor) + 1
          } 行${this.dragging ? "（松开复制）" : "（已复制）"}${ansi.reset}${ansi.bgBlue} `
        : "";
    const right = ` ${autoMark}${intentMark}${goalMark}${focusMark}${selectionMark}${scrollMark}${termScrollMark}${this.modelLabel} │ ${this.statusText}${this.statusDetail ? " · " + this.statusDetail : ""} `;
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

  /** 单选浮层（`/model`）：高亮当前项，选项多时围绕它开窗，保证它始终可见 */
  private layoutSelect(width: number): InputLayout {
    const pending = this.pendingSelect!;
    const lines: string[] = [];
    lines.push(`${ansi.bold}${pending.title}${ansi.reset}`);
    if (pending.detail) {
      for (const wrapped of wrapText(`${ansi.gray}${pending.detail}${ansi.reset}`, width - 4)) {
        lines.push(`  ${wrapped}`);
      }
    }

    const MAX_ROWS = 10;
    const total = pending.options.length;
    const { start, end } = selectWindow(total, pending.index, MAX_ROWS);
    pending.options.slice(start, end).forEach((option, offset) => {
      const index = start + offset;
      const hint = option.hint ? `  ${ansi.gray}${option.hint}${ansi.reset}` : "";
      const text = ` ${index + 1}. ${option.label}`;
      lines.push(
        index === pending.index
          ? `${ansi.inverse}${text}${ansi.reset}${hint}`
          : `${ansi.gray}${text}${ansi.reset}${hint}`,
      );
    });
    if (total > MAX_ROWS) {
      lines.push(`  ${ansi.gray}…共 ${total} 个模型${ansi.reset}`);
    }
    lines.push(
      `  ${ansi.gray}↑ ↓ 选择 · 数字直选 · Enter 确认 · Esc 取消${ansi.reset}`,
    );
    return { lines, cursorRow: 0, cursorCol: 0 };
  }
}

/**
 * 单选列表的可视窗口：围绕高亮项开窗，保证它始终在屏上。
 *
 * 纯函数（而不是写在 layoutSelect 里）是因为这段下标的边界条件最容易写错，
 * 而 TUI 本身没有可跑的测试环境。
 */
export function selectWindow(
  total: number,
  index: number,
  maxRows: number,
): { start: number; end: number } {
  if (total <= maxRows) return { start: 0, end: Math.max(0, total) };
  const start = Math.min(
    Math.max(0, index - Math.floor(maxRows / 2)),
    total - maxRows,
  );
  return { start, end: start + maxRows };
}

/**
 * 把 `/model` 的参数解析成模型条目：先按序号，再按 id / 模型名（大小写不敏感）。
 *
 * 放在模块级（而不是 TUI 的私有方法）是为了能单独测 —— 它是这条命令里唯一
 * 有分支逻辑、又最容易写错的部分。
 */
export function resolveModelChoice(
  entries: ModelEntry[],
  arg: string,
): ModelEntry | undefined {
  const text = arg.trim();
  // 只有**纯数字**才当序号：否则 "gpt-4o" 这类名字会被 parseInt 误判成第 4 个
  if (/^\d+$/.test(text)) return entries[Number(text) - 1];
  const lower = text.toLowerCase();
  return (
    entries.find((entry) => entry.id === text) ??
    entries.find((entry) => entry.model === text) ??
    entries.find((entry) => entry.id.toLowerCase() === lower)
  );
}

// ------------------------------------------------------------ 输入分片容错

/** 括号粘贴的起止标记：终端把粘贴内容包在两者之间 */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** 不完整转义序列的等待时间：够覆盖按键分片，又不会让单独的 ESC 明显卡顿 */
const ESC_WAIT_MS = 40;
/** 括号粘贴未收全时的宽限：长粘贴可能跨多次 read 到达，不能按 40ms 丢弃 */
const PASTE_GRACE_MS = 2_000;

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
 * 保证 Ctrl+C / Ctrl+A / Ctrl+E / Ctrl+L 等既有快捷键不受影响。
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

/** 把字节数格式化成便于阅读的形式（用于图片体积提示） */
function formatImageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 把「拖拽/粘贴进来的一行」还原成文件路径；不像图片路径时返回 null。
 *
 * 终端插入路径的方式五花八门：整体加引号、把空格转义成 `\ `、带 `file://` 前缀。
 * 这里统一剥掉这些包装，只保留四种**能可靠嗅探**的图片扩展名
 * （bmp / tiff 不在其中：Anthropic 不接受，强行改 mime 只会把字节发错）。
 */
function normalizeDroppedPath(line: string): string | null {
  let value = line.trim();
  if (!value) return null;

  // 成对的引号（'…' / "…"）
  const quoted = /^(['"])(.*)\1$/.exec(value);
  if (quoted) value = quoted[2];

  if (value.startsWith("file://")) value = value.slice("file://".length);
  // 拖拽时空格常被反斜杠转义
  value = value.replace(/\\ /g, " ");

  if (!/\.(png|jpe?g|gif|webp)$/i.test(value)) return null;
  return value;
}

/** 读取图片文件为附件；不存在、非图片或过大时返回 null */
function readImageFile(file: string, cwd: string): ImageAttachment | null {
  try {
    const resolved = path.isAbsolute(file) ? file : path.resolve(cwd, expandHome(file));
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > MAX_CLIPBOARD_IMAGE_BYTES) return null;
    const data = fs.readFileSync(resolved);
    const mimeType = sniffImageMime(data);
    if (!mimeType) return null;
    return { mimeType, data: data.toString("base64") };
  } catch {
    return null;
  }
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
