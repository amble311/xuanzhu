import type { DeviceBridge } from "../device/server";
import type { ImageAttachment, JsonSchema } from "../llm/types";
import type { JobRegistry } from "./jobs";

/** 任务项状态 */
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

/** 一条任务项 */
export interface TodoItem {
  /** 任务内容（一句话，动词开头） */
  content: string;
  status: TodoStatus;
}

/**
 * 任务列表存储（由 Agent 注入）。
 *
 * 工具本身是无状态的函数，任务列表必须挂在会话上，因此通过 ToolContext
 * 传入一个可读写的引用；Agent 在 `set()` 时同步通知界面刷新。
 */
export interface TodoStore {
  get(): TodoItem[];
  set(items: TodoItem[]): void;
}

/**
 * 目标模式（`/goal`）的状态出口（由 Agent 注入）。
 *
 * 目标本身挂在 Agent 上（界面要跨多轮 `run` 保持它），工具只负责把
 * 「模型声明完成」这一事实写回去；工具不持有目标文本。
 */
export interface GoalStore {
  /** 当前是否有进行中的目标（没有时 `goal_complete` 直接报错，避免空转） */
  active(): boolean;
  /** 标记目标完成并记下总结 */
  complete(summary: string): void;
  /**
   * 标记目标「无需继续」（`report_status(dropped)`）。
   *
   * 与 `complete` 分开：目标循环要在这里停下来，但结论不是「做完了」——
   * 界面要能区分「✓ 已完成」与「⊘ 无需处理」，否则会把「查了半天发现不是缺陷」
   * 显示成一次成功交付。
   */
  drop(reason: string): void;
}

/**
 * 状态上报的类型（`report_status` 工具）。
 *
 * 前三种是「还能不能继续」的判定，后两种补上了原先缺失的两个语义：
 * - `dropped`：查清楚了，**这件事无需处理**（不是缺陷 / 已被别人修掉 / 需求已取消）。
 *   以前这种结论只能谎报「完成」，与「真做完了」混在一起；
 * - `waiting`：本轮结束但没有未决问题，等下一次触发（有意暂停）。
 *   以前只能不调用工具直接答复，循环会把它当成「没做完」继续催。
 */
export type RunStatusKind =
  | "blocked"
  | "needs_input"
  | "low_confidence"
  | "dropped"
  | "waiting";

/** 模型主动上报的状态 */
export interface RunStatusInput {
  /** blocked=外部条件不满足；needs_input=必须用户决定；low_confidence=能继续但结论不可靠；dropped=无需处理；waiting=等待下一次触发 */
  kind: RunStatusKind;
  /** 一句话说明 */
  summary: string;
  /** 已尝试什么、缺什么、建议的选项（可选） */
  detail?: string;
}

/** 带时间戳的状态记录（挂在 Agent 上） */
export interface RunStatus extends RunStatusInput {
  at: string;
}

/**
 * 状态上报出口（由 Agent 注入）。
 *
 * `toolCalls()` / `goalActive()` 用于**防滥用**：目标模式下一轮工具都没调就报
 * 「受阻 / 需要决定」，多半是想逃避困难步骤 —— 工具会直接拒绝并要求先实际尝试。
 */
export interface StatusStore {
  report(status: RunStatusInput): void;
  /** 本轮已执行的工具调用数 */
  toolCalls(): number;
  /** 当前是否在目标模式 */
  goalActive(): boolean;
}

/** 派生子代理的请求 */
export interface SubAgentInput {
  /** 要派生的子代理名称（见 src/subagents 注册表）；缺省用默认子代理 */
  subagentName?: string;
  /** 子任务的一句话说明（用于界面与结果摘要） */
  description: string;
  /** 交给子代理的完整任务描述 */
  prompt: string;
}

/**
 * 当前上下文档位对工具的限制。
 *
 * 小窗口模型（8k/16k）一次读 2000 行或一条 30k 输出的 bash 就会把上下文打满，
 * 因此由 Agent 按档位注入更紧的默认值；工具不自己猜模型大小。
 */
export interface ToolLimits {
  /** read_file 默认 / 最大读取行数 */
  maxReadLines?: number;
  /** bash 单次结果进入上下文的字符上限，超出则落 artifact */
  maxOutputChars?: number;
  /** artifact 存放目录（完整输出落盘，上下文只留摘要） */
  artifactDir?: string;
}

/** 工具执行上下文 */
export interface ToolContext {
  /** 当前工作目录 */
  cwd: string;
  /**
   * 专用模式名（如 `btc`）；普通模式为 undefined。
   *
   * 供 `list_skills` / `load_skill` 按模式裁剪技能范围 —— 这个过滤必须发生在工具层：
   * 提示词里说「只有 btc 技能」并不能阻止模型直接 `load_skill github`。
   */
  mode?: string;
  /** 是否自动批准（非危险）工具 */
  autoApprove: boolean;
  /** 向界面输出区推送实时信息 */
  emit?: (message: string) => void;
  /** 请求用户确认（由 Agent 注入），供工具内部执行危险操作前调用 */
  confirm?: (request: ConfirmRequest) => Promise<boolean>;
  /** 中断信号（由 Agent 注入） */
  signal?: AbortSignal;
  /** 当前会话的任务列表（由 Agent 注入），供 todo_write 使用 */
  todos?: TodoStore;
  /** 目标模式状态（由 Agent 注入），供 goal_complete 使用 */
  goal?: GoalStore;
  /** 状态上报出口（由 Agent 注入），供 report_status 使用 */
  status?: StatusStore;
  /** 长期记忆字符上限，超出时自动精简（由 Agent 注入） */
  memoryMaxChars?: number;
  /** 全局长期记忆字符上限（由 Agent 注入） */
  globalMemoryMaxChars?: number;
  /** 上下文档位对应的工具限额（由 Agent 注入） */
  limits?: ToolLimits;
  /** 派生子代理执行子任务（由 Agent 注入），未提供时 task 工具不可用 */
  spawnAgent?: (input: SubAgentInput) => Promise<ToolResult>;
  /**
   * 后台任务注册表（由**主代理**注入）。
   *
   * 子代理拿不到它 —— 子代理结束后它的后台进程没有归属，还会与主对话抢进程组，
   * 因此 `bash run_in_background` 在子代理里直接返回错误。
   */
  jobs?: JobRegistry;
  /** 向用户提问（由 Agent 注入），未提供时 ask_user 工具不可用 */
  askUser?: (request: AskUserRequest) => Promise<AskUserAnswer>;
  /**
   * 手机设备桥（由 Agent 注入）。
   *
   * 只有 **xzh 进程内**启动的桥才会出现在这里（TUI 的 `/device serve`）；
   * 若桥跑在别的进程（`xzh device serve`），工具会回退到本地 HTTP 控制通道，
   * 因此这个字段为空并不代表"用不了设备"，详见 `tools/device.ts`。
   */
  deviceBridge?: DeviceBridge;
}

/**
 * `ask_user` 的一次提问（一次只问**一个**具体问题）。
 *
 * 为什么要有它：在此之前模型想问「选 A 还是 B」时只能写在最终答复里 ——
 * 一个问题夹在一段总结中间，用户很容易漏掉；反过来模型也可能自己替用户
 * 拍板，或者反复重试到安全阀上限。
 */
export interface AskUserRequest {
  /** 一句话问题（必须能独立看懂，不要依赖上文） */
  question: string;
  /** 可选答案（2–4 个）：给出时界面用单选浮层，省掉用户打字 */
  options?: string[];
  /** 补充说明：已尝试什么、为什么必须由用户定（可选） */
  detail?: string;
}

/** `ask_user` 的答复 */
export interface AskUserAnswer {
  /** 选中的选项或用户输入的文本；取消时为 undefined */
  answer?: string;
  /** 用户按 Esc / Ctrl+C 跳过 */
  cancelled?: boolean;
}

/** 需要用户确认的请求 */
export interface ConfirmRequest {
  tool: string;
  /** 一行标题，例如 "写入文件" */
  title: string;
  /** 详情（命令 / diff 预览） */
  detail: string;
  /** 是否为危险操作 */
  danger: boolean;
}

/** 工具执行结果 */
export interface ToolResult {
  ok: boolean;
  /** 返回给模型的完整内容 */
  content: string;
  /** 供界面展示的简短摘要 */
  summary?: string;
  /**
   * 工具产出的**图片**（如手机截图）。
   *
   * 为什么单独开一个字段：`content` 只能装文本，而"让模型看见手机屏幕"必须把**图片**
   * 送进模型。Agent 会把这里的图片作为一条**额外的 user 消息**追加到工具结果之后
   * —— 各家的 `tool` 消息都不接受图片，只有 `user` 消息能带图。
   * 模型不支持视觉时，Agent 已有的"去掉图片重试"兜底会照常生效。
   */
  images?: ImageAttachment[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  /**
   * 归属的专用模式（如 `["btc"]`）；空 / 未声明 = 所有模式都可用。
   *
   * 语义与技能一致：声明了 modes 的工具**只在对应模式出现**，普通模式下既不下发给
   * 模型也不允许执行 —— 否则每个通用会话都会背上交易工具的 schema 占用，
   * 而模型在普通项目里也用不上它们。
   */
  modes?: string[];
  /** 执行前是否需要用户确认 */
  requiresConfirmation?: boolean;
  /**
   * 是否**可与其他可并行工具同时执行**。
   *
   * 默认 false：多数工具有副作用（写文件、执行命令）或互相依赖，必须按顺序跑。
   * 只有「不共享任何可变状态、彼此独立」的工具才应设为 true —— 目前只有 `task`
   * （每个子代理是独立的 Agent 实例）。模型在一轮里返回多个此类调用时，
   * Agent 会并发执行它们（并发上限见 config.maxParallelAgents）。
   */
  parallelSafe?: boolean;
  /**
   * 危险操作（执行命令 / 写文件 / 安装依赖）。
   *
   * 作用是**提示级别**：未开启自动批准时确认框会标为高危；开启自动批准
   * （默认）时与其他工具同样直接执行 —— 用户选择全自动即代表接受风险。
   */
  danger?: boolean;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult>;
}

export type { JsonSchema };
