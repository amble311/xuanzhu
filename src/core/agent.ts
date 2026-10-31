import {
  activeModelEntry,
  buildIntentPrompt,
  DEFAULT_INTENT_PROMPT,
  nextModelAfter,
  rememberModel,
  saveConfig,
  type ModelEntry,
  type XuanZhuConfig,
} from "../config/store";
import {
  calibrateBudget,
  calibratorFor,
  createProvider,
  estimateMessageTokens,
  IMAGE_FALLBACK_TEXT,
  isConfigError,
  isContextLengthError,
  isRetryableError,
  isSystemPromptTight,
  isModelUnavailableError,
  estimateTokens,
  inferContextWindow,
  isVisionUnsupportedError,
  keepFromValidStart,
  resolveConversationBudget,
  stripAllImages,
  stripStaleImages,
  type TokenCalibrator,
  trimMessagesToBudget,
} from "../llm";
import { friendlyError, redactSecrets } from "../llm/http";
import type {
  ChatMessage,
  ImageAttachment,
  LLMProvider,
  ToolCall,
  Usage,
} from "../llm/types";
import { appendSessionMessages } from "./sessions";
import {
  executeTool,
  findTool,
  getToolSpecs,
  TOOLS,
  toolsForSubAgent,
  type ExecuteToolResult,
} from "../tools";
import type {
  ConfirmRequest,
  GoalStore,
  RunStatus,
  StatusStore,
  SubAgentInput,
  TodoItem,
  TodoStore,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "../tools/types";
import type { DeviceBridge } from "../device";
import { findSubAgent, subAgentNames } from "../subagents";
import {
  normalizeSubagentReport,
  SUBAGENT_OUTPUT_RULE,
} from "../subagents/report";
import { mapWithConcurrency } from "../utils/concurrency";
import { recordErrorReport } from "../utils/error-reports";
import { expandHome, getConfigPath } from "../utils/paths";
import { captureGlobalMemoryFromUser } from "../workspace/global-capture";
import {
  appendLongTermTopicEntry,
  appendMemory,
  compactGlobalMemoryIfNeeded,
  compactLongTermMemoryIfNeeded,
  DEFAULT_GLOBAL_MEMORY_MAX_CHARS,
  DEFAULT_MEMORY_MAX_CHARS,
  loadProjectRules,
  pruneGlobalMemory,
  readGlobalMemory,
  readProjectMemory,
  resolveProjectPaths,
  selectRelevantGlobalMemory,
} from "../workspace";
import {
  addTaskDecision,
  addTaskDone,
  clearTaskLedger,
  createTaskLedger,
  formatTaskDigest,
  loadTaskLedger,
  saveTaskLedger,
  touchTaskLedger,
  type TaskLedger,
} from "./task-ledger";
import { goalSystemSection } from "./goal";
import { buildSystemPrompt, GLOBAL_MEMORY_EXCERPT_CHARS } from "./prompt";
import {
  buildSelfState,
  finishGatePrompt,
  isAwaitingUserConfirmation,
  isVerificationCommand,
} from "./state";
import * as fs from "fs";
import * as path from "path";

/** 只读类工具：默认免确认，但落在工作区外或敏感路径时需要确认 */
const READ_TOOLS = new Set(["read_file", "list_dir", "glob", "grep"]);

/**
 * 读取时需要额外确认的敏感路径：凭据、密钥、版本控制与云服务配置。
 * 典型场景是 `read_file ~/.xzh/config.json` —— 那里存着明文的模型 apiKey，
 * 一旦被读进上下文就等于把它发给了模型服务商。
 */
const SENSITIVE_PATH_PATTERN =
  /(^|\/)(\.env(\..+)?|\.npmrc|\.netrc|\.git-credentials|\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.xzh|\.xuanzhu|credentials|secrets?)(\/|$)|\.(pem|key|p12|pfx|jks)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i;

export interface AgentEvents {
  /** 模型输出的正文增量 */
  onText: (delta: string) => void;
  /** 模型的思考增量（部分模型支持） */
  onReasoning?: (delta: string) => void;
  /** 开始执行某个工具 */
  onToolStart: (call: ToolCall) => void;
  /** 工具执行结束 */
  onToolEnd: (call: ToolCall, result: ExecuteToolResult) => void;
  /** 状态变化（思考中 / 调用工具等） */
  onStatus: (status: string, detail?: string) => void;
  /**
   * 工具轮次配额用尽时询问是否继续；返回 true 则追加一轮配额。
   *
   * 未提供时（非交互场景）行为与以前一致：直接收尾。
   */
  onRoundLimit?: (used: number) => Promise<boolean>;
  /** 向输出区推送信息（工具内部日志等） */
  onNotice?: (message: string) => void;
  /** 意图分析完成（analysis 为分析结果，original 为用户原始消息） */
  onIntent?: (analysis: string, original: string) => void;
  /** 当前使用的模型发生变化（因调用失败而回退到下一个模型） */
  onModelChange?: (info: {
    provider: string;
    model: string;
    reason: string;
  }) => void;
  /** 任务列表更新（来自 todo_write） */
  onTodos?: (items: TodoItem[]) => void;
  /** 服务端返回的真实 token usage（每次模型请求一次） */
  onUsage?: (usage: Usage) => void;
  /** 请求用户确认危险操作 */
  confirm: (request: ConfirmRequest) => Promise<boolean>;
}

/**
 * 目标模式（`/goal`）的状态。
 *
 * 目标挂在 Agent 而不是界面上，原因有两点：
 * 1. `goal_complete` 工具要能把它标记为完成（经 `ToolContext.goal` 注入）；
 * 2. 系统提示词要在**每次请求**时注入目标与「不要中途停下」的规则 ——
 *    历史会被裁剪，只有系统提示词能贯穿整个目标执行过程。
 */
/** `/compact` 的结果 */
export interface CompactResult {
  compacted: boolean;
  before: number;
  after: number;
  summary?: string;
  reason?: string;
}

/** `/compact` 后保留的最近消息条数（从 user 边界开始） */
const COMPACT_KEEP_MESSAGES = 6;

/** `/context` 展示的上下文预算报告 */
export interface ContextReport {
  model: string;
  /** 模型窗口（token） */
  window: number;
  profile: "small" | "full";
  /** 系统提示词占用（不含只读状态块） */
  systemTokens: number;
  /** 工具 schema 占用 */
  toolsTokens: number;
  /** 已提交历史占用 */
  historyTokens: number;
  /** 只读状态块占用 */
  stateTokens: number;
  /** 上述四项合计 */
  inputTokens: number;
  /** 会话部分可用的 token 预算（不含系统提示词） */
  conversationBudget: number;
  /** inputTokens / window（0–1） */
  ratio: number;
  /** 历史是否已被裁剪过 */
  trimmed: boolean;
  maxOutputTokens?: number;
}

export interface GoalState {
  /** 目标正文 */
  text: string;
  /** 设定时间（ISO 字符串，界面展示用） */
  startedAt: string;
  /** 模型是否已通过 `goal_complete` 声明完成 */
  completed: boolean;
  /** 完成总结（来自 `goal_complete` 的 summary） */
  summary?: string;
}

/**
 * Agent 的可选项（主要供**子代理**使用）。
 *
 * 子代理与主代理共用同一套循环，差别只在两处：可用的工具集合，以及系统提示词
 * （子代理需要「独立完成并只回报结论」的角色设定）。
 */
export interface AgentOptions {
  /** 可用的工具集合，默认全部内置工具 */
  tools?: ToolDefinition[];
  /** 覆盖系统提示词（子代理使用；不传则按项目规则 + 项目记忆生成） */
  systemPrompt?: string;
  /**
   * 工具轮数上限覆盖（默认用 config.maxToolRounds）。
   *
   * 子代理不接受「到上限问用户」——到顶即收尾；且并行子代理**各有配额**，
   * 主配置的 200 轮叠加并发会把最坏情况放大数倍，因此给子代理更紧的默认值。
   */
  maxToolRounds?: number;
  /**
   * 会话文件（JSONL，见 src/core/sessions.ts）：设置后每次提交历史都会
   * **增量追加**到该文件，退出 / 崩溃后可用 `/resume` 恢复。只有主代理会传。
   */
  sessionFile?: string;
  /**
   * 是否在每轮结束时自动记录项目记忆（当日摘要，必要时并入长期记忆）。
   *
   * 子代理传 `false`：它的工作会由主代理汇总，自己写记忆既可能污染项目，
   * 也会在并行子代理之间产生重复条目。
   */
  autoMemory?: boolean;
  /**
   * 是否维护项目任务账本（默认 true）。
   *
   * 子代理传 `false`：否则每个子代理都会覆盖主任务账本，主代理的「做到哪了」
   * 会被子任务的 prompt/结论替换。
   */
  taskLedger?: boolean;
}

/**
 * 历史消息条数的**安全网**上限（不再是主要约束）。
 *
 * 实际裁剪由 token 预算决定（见 trimMessagesToBudget）—— 因为一条 30000 字符的
 * `bash` 输出和一条「好的」对上下文的占用天差地别，按条数裁无法反映真实开销。
 * 这里只兜住「contextWindow 被配置成极大值导致历史无限累积」这类异常情况。
 */
const MAX_HISTORY_MESSAGES = 400;

/**
 * 遇到「上下文超出窗口」时，把预算收敛到这个比例再重试一次。
 *
 * 取得比较激进是因为：既然已经超限，说明**实际** token 超过了估算，
 * 而估算本身已经留了 20% 余量 —— 大幅收敛能保证一次就过，避免反复失败。
 */
const CONTEXT_RETRY_BUDGET_RATIO = 0.5;

/**
 * 单次回复允许累积的最大字符数（约 100 万字符）。
 *
 * 正常情况下远达不到 —— 这是防御**失控输出**：本地推理引擎（llama.cpp / Ollama 等）
 * 在上下文错乱或陷入重复时会持续不断地吐 token，而流式累积
 * （`text += chunk.text`）本身没有任何上限，最终会把内存吃光，
 * 进程被系统 OOM Killer 直接杀掉 —— 表现就是界面毫无征兆地消失。
 * 本地模型与玄猪跑在同一台机器上，这类风险比云端 API 高得多。
 */
const MAX_RESPONSE_CHARS = 1_000_000;

/**
 * 连续「完全相同的工具调用」次数上限。
 *
 * 本地模型很容易陷入「反复调用同一个工具、拿到相同结果」的死循环 ——
 * 尤其是上下文被裁剪之后，它看不到自己刚才做过什么，于是一遍遍重试。
 * 后果是：白烧 token、上下文加速膨胀，最终撞上 maxToolRounds 戛然而止，
 * 用户看到的就是「重复几次之后程序突然停了」。
 *
 * 这里主动及早止损，并把决定权交回用户（而不是默默转到轮次上限）。
 * 阈值取 4：正常的重试（比如先失败再改参数）不会被误杀。
 */
const MAX_IDENTICAL_TOOL_CALLS = 4;

/**
 * 检测到死循环后，允许发起几次「自我修正」再中止。
 *
 * 取 1：先给它一次机会分析原因、换方案。成功的话任务能继续，
 * 失败（再次累计到阈值）才中止 —— 不至于让同一次卡顿反复消耗轮次。
 */
const MAX_SELF_CORRECTIONS = 1;

/**
 * 只读「调研类」工具。
 *
 * 它们的输出会**持续占用上下文**（几十屏的文件内容、搜索结果），正是子代理的适用场景，
 * 因此单独统计：本轮累积到一定规模时把「可改用子代理」明确摆到模型面前。
 */
const EXPLORATION_TOOLS = new Set(["read_file", "list_dir", "glob", "grep"]);

/**
 * 触发「建议改用子代理」提醒的阈值（满足任一条即触发，且整轮只提醒一次）。
 *
 * 为什么需要这道确定性提醒：提示词里写「大范围调研时用子代理」是**主观判断** ——
 * 模型判定不了「多大算大」，实际表现就是全程自己 read/grep，子代理从不被调用。
 * 改成按客观累积量触发后，「该用子代理」这件事一定会出现在模型眼前。
 *
 * 阈值取得比较宽松（8 次调用 / 累计 40k 字符），避免正常的小规模探索被频繁打断。
 */
const EXPLORATION_REMINDER_CALLS = 8;
const EXPLORATION_REMINDER_CHARS = 40_000;

/**
 * 子代理回报给主代理的报告长度上限（字符）。
 *
 * 报告会作为 `task` 工具结果进入主对话，因此它本质上是一段「要长期占用上下文」的内容。
 * 正常调研报告远小于此值；设上限是为了兜住失控输出（子代理陷入重复时可能吐几十万字），
 * 一旦发生，宁可截断报告也不要把主对话挤爆。
 */


/**
 * 子代理的**默认**工具轮数上限（覆盖 config.maxToolRounds，可用
 * `AgentOptions.maxToolRounds` 再覆盖）。
 *
 * 之所以不给子代理用主配置的 200 轮：子代理不接受「到上限问用户」
 * （`onRoundLimit` 恒为 false，到顶即收尾），而且并行子代理**各有配额** ——
 * 并发 4 个时最坏情况会被放大数倍。取 60：一次聚焦的调研（翻几十个文件）
 * 通常足够；真不够时主代理会看到「子代理达到轮数上限」的警告，可拆小任务重试。
 */
const SUBAGENT_MAX_TOOL_ROUNDS = 60;

/**
 * 子代理并发数的**硬上限**。
 *
 * `config.maxParallelAgents` 可以调，但再大也不会超过这里 —— 每个并行子代理
 * 各自持有一条对话流，配置写成 100 只会把服务商打爆并触发 429，反而更慢。
 */
const MAX_PARALLEL_AGENTS_CAP = 16;

/** `config.maxParallelAgents` 未设置时的默认并发数 */
const DEFAULT_PARALLEL_AGENTS = 4;

/** 窗口不超过该值视为「小上下文模型」，自动使用精简档 */
const SMALL_CONTEXT_WINDOW = 32_768;
/** 小上下文档的默认输出上限（给输入留空间） */
const SMALL_MAX_OUTPUT_TOKENS = 2048;
/**
 * 小上下文档保留的工具：读写、检索、执行、计划、状态与记忆。
 * 子代理 / 技能 / 记忆压缩等低频工具暂不下发，节省 schema token。
 */
const SMALL_TOOL_NAMES = new Set([
  "repo_map",
  "find_symbol",
  "read_symbol",
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "write_file",
  "edit_file",
  "bash",
  "todo_write",
  "memory_read",
  "memory_write",
  "memory_compact",
  "load_skill",
  "report_status",
]);

/**
 * 目标模式下，单次 `run` 允许「追加工具轮次配额」的次数。
 *
 * 目标模式里 `onRoundLimit` 会一直回答「继续」（这是「不完成不停」的实现方式），
 * 因此必须在这里加一道上限 —— 否则一次 `run` 可能无限跑下去，外层的
 * 自动继续循环（40 轮安全阀，见 `TuiApp`）根本没机会介入。
 * 取 3：默认 200 轮配额下最多 800 轮工具调用，足够一次长任务收尾。
 */
const GOAL_ROUND_LIMIT_EXTENSIONS = 3;

/** 被跳过（并未真正执行）的工具调用，其 `tool` 结果统一以此前缀开头 */
const SKIPPED_CALL_PREFIX = "[系统] 本次调用已跳过";

/** 「上一轮已中止」说明里最多列出的工具调用条数，其余只计数（提示本身也不能吃掉上下文） */
const ABORT_NOTE_MAX_CALLS = 12;

/** 「上一轮已中止」说明里单条工具调用参数的最大长度 */
const ABORT_NOTE_ARG_CHARS = 120;

/**
 * 「更早的对话已被裁剪」说明（`role: system`）。
 *
 * 为什么必须有：裁剪是**静默**的 —— `trimHistory()` 裁完就把丢掉的段落忘了，而模型看到的是
 * 一段从中途开始的历史：上文里一个没有结论的旧任务会显得像"用户正等我做完它"。
 * 实测表现（2026-10-14）：用户只发了句「在吗」，模型却接着执行上一轮被中断的任务
 * （起 API、查登录凭据），因为历史里那段"未完成"的痕迹看起来就是在等它继续。
 *
 * 因此一旦这次会话裁过历史，之后每次请求都附上这条说明：明确告诉模型"你看的不是完整历史"，
 * 残缺的旧任务不是待办，当前消息才是要做的事。
 */
function contextTrimmedNote(taskDigest?: string | null): ChatMessage {
  let content =
    "[上下文提醒] 更早的对话已因超出上下文窗口被裁剪，你看到的**不是完整历史**：\n" +
    "· 被裁掉的内容不要推测、不要补做；\n" +
    "· 上文里那些没有结论的旧任务只是残片，**不代表要接着做**；\n" +
    "· 只有当用户最新一条消息明确要求继续时才续做，否则先回答他当前这条消息；\n" +
    "· 若当前消息指向你已经看不到的上下文，先问清楚，再动手。";
  if (taskDigest) {
    content +=
      "\n\n[任务账本 · 历史裁剪后重建]\n" +
      taskDigest +
      "\n（以这份账本为准继续当前任务，不要重做已完成的部分。）";
  }
  return { role: "system", content };
}

/**
 * 把历史**中间**的 system 消息提前出来，交给系统提示词承载。
 *
 * 为什么必须做（2026-10-25 实测）：上一轮被 Ctrl+D 中止后，`rollbackTurn()` 会往历史里
 * 追加一条 `role: system` 的「[上一轮已中止]」说明；下一轮请求的消息序列变成
 * `system → user → assistant → system → user`。llama.cpp 的 chat template 严格要求
 * system 必须在最前面，于是直接返回 HTTP 500：
 * `Jinja Exception: System message must be at the beginning.`
 *
 * 为什么不直接把说明改成 user：那样会伪造一轮用户发言，也会让「系统指令」与用户意图混在一起。
 * 规范化到系统提示词既保持语义，又对三家 Provider 都合法（它们本来就会合并 system 消息）。
 *
 * 只提升**非开头**的 system：开头的裁剪提醒保持原位（`trim-notice.test.ts` 依赖该位置）。
 */
function localDateStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 从改动文件推导长期记忆的主题（按目录归并，最多两级）。
 *
 * 例：`src/core/a.ts` + `src/core/b.ts` → `src/core`；
 * 全在项目根（如 `README.md`）→ `项目`；文件在项目外也归到 `项目`。
 */
function deriveMemoryTopic(cwd: string, files: string[]): string {
  const dirs = files
    .map((file) => {
      const rel = path.relative(cwd, path.resolve(cwd, file));
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
        return [] as string[];
      }
      return path.dirname(rel).split(path.sep).filter(Boolean);
    })
    .filter((segments) => segments.length > 0);

  if (dirs.length === 0) return "项目";
  const common: string[] = [];
  for (let i = 0; ; i++) {
    const segment = dirs[0][i];
    if (!segment) break;
    if (dirs.every((segments) => segments[i] === segment)) common.push(segment);
    else break;
  }
  return common.length > 0 ? common.slice(0, 2).join("/") : "项目";
}

/** 从最终答复里提取一行适合写入记忆的结论 */
function summarizeMemoryConclusion(text: string): string {
  const cleaned = text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\r/g, "")
    .split("\n")
    // 标题本身不是结论（否则「## 结论」会把真正的第一段挤掉）
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .map((line) => line.replace(/^\s*(?:[>*+-]+|\d+\.)\s*/, "").trim())
    .find((line) => line.length > 0 && !/^```/.test(line));
  return (cleaned ?? "").replace(/\s+/g, " ").slice(0, 180);
}

export function hoistSystemNotes(conversation: ChatMessage[]): {
  conversation: ChatMessage[];
  notes: string[];
} {
  const notes: string[] = [];
  const kept: ChatMessage[] = [];
  let leading = true;

  for (const message of conversation) {
    if (message.role === "system") {
      if (leading) {
        kept.push(message);
      } else {
        notes.push(message.content);
      }
      continue;
    }
    leading = false;
    kept.push(message);
  }

  return { conversation: kept, notes };
}

export class Agent {
  private provider: LLMProvider;
  private readonly config: XuanZhuConfig;
  private cwd: string;
  private readonly events: AgentEvents;
  private systemPrompt: string;
  /** 是否已就「系统提示词撑满窗口」提示过（避免每条消息都刷一遍） */
  private warnedTightContext = false;
  /**
   * 本次会话的历史**是否被裁过**（裁剪是永久性的，裁掉的部分就没了）。
   *
   * 一旦为真，组装请求时会附上 `contextTrimmedNote()` —— 否则模型会把残缺的旧任务
   * 当成"还没做完、正等我继续"。见该函数的注释。
   */
  private historyTrimmed = false;
  private history: ChatMessage[] = [];
  /** 当前使用的模型条目（多模型：默认上次使用的，失败后沿列表回退） */
  private activeModel: ModelEntry | null;
  /** 可用的工具集合；未指定时使用全部内置工具（子代理会传入受限集合） */
  private readonly tools?: ToolDefinition[];
  /** 覆盖的系统提示词（子代理使用） */
  private readonly systemPromptOverride?: string;
  /** 工具轮数上限覆盖（子代理用；未设置时取 config.maxToolRounds） */
  private readonly maxToolRoundsOverride?: number;
  /** 会话文件（主代理用）；设置后每次提交历史都增量追加（见 src/core/sessions.ts） */
  private sessionFile: string | undefined;
  /** 当前会话的任务列表（todo_write 维护），随会话结束而丢弃 */
  private todos: TodoItem[] = [];
  /**
   * 目标模式（`/goal`）的目标；`undefined` 表示当前不在目标模式。
   *
   * 由界面设置 / 清除，界面在每轮 `run` 返回后据此判断「继续自动推进」还是「收尾」
   * （完成由模型调用 `goal_complete` 标记，见 `markGoalComplete`）。
   */
  private goal?: GoalState;
  /**
   * 最近执行过的工具（只留名称与成败），供只读状态块（`core/state.ts`）使用。
   *
   * 只记「实际执行过」的调用：被跳过 / 被用户拒绝的不算，否则状态块会显示
   * 一堆没有真正发生过的「动作」。
   */
  private recentActions: Array<{ name: string; ok: boolean }> = [];
  /** 本次会话改动过的文件（write_file / edit_file） */
  private sessionChangedFiles = new Set<string>();
  /** 上一次请求的上下文占用比例（0–1）；模型未返回 usage 时按估算值 */
  private contextUsage?: number;
  /** 本轮改动过的文件（验证门只看本轮，避免对着旧改动反复提醒） */
  private runChangedFiles = new Set<string>();
  /**
   * 本轮的动作序号：用来判断「改动之后有没有跑过验证」。
   *
   * 不能用布尔值：先跑测试、再改文件的情况下，布尔值会错误地认为已经验证过。
   */
  private runActionSeq = 0;
  private runLastChangeSeq = 0;
  private runLastVerifySeq = 0;
  /** 本轮是否已经发出过收尾提醒（验证 + 未完成清单合计，每次 run 最多一次） */
  private finishGateUsed = false;
  /** 本轮是否调用过 `todo_write`（未完成门只看本轮自己列的计划，避免对旧清单唠叨） */
  private runTouchedTodos = false;
  /**
   * 本轮模型主动上报的状态（`report_status`）。
   *
   * 每次 `run` 重置 —— 它是「这一轮发生了什么」的结论，不该跨轮累积。
   * 界面据此暂停目标（blocked / needs_input）或标注置信度（low_confidence）。
   */
  private runStatus?: RunStatus;
  /** 本轮各工具的真实执行次数（自动记忆摘要用） */
  private runToolCounts = new Map<string, number>();
  /** 当前任务账本（持久化到 <项目>/.xuanzhu/state/task.json） */
  private task?: TaskLedger;
  private taskLoaded = false;
  /** 本轮最后一次验证命令与结果（自动记忆摘要用） */
  private runVerifyCommand?: string;
  private runVerifyOk = false;
  /** 本轮模型是否已经主动写过记忆（写过就不再自动补一条） */
  private runWroteMemory = false;
  /** 系统提示词构建时的全局记忆快照（用于本轮相关性注入） */
  private globalMemory?: { longTerm: string; recentDaily: string } | null;
  /** 本轮用户消息（尚未提交进 history，供提示词相关性/全局提醒使用） */
  private turnUserText = "";
  /** 是否启用自动记忆（子代理关闭） */
  private autoMemory: boolean;
  /** 是否维护任务账本（子代理关闭，避免覆盖主任务） */
  private taskLedgerEnabled: boolean;
  /**
   * 手机设备桥（由界面在 `/device serve` 时注入）。
   *
   * 为空表示"xzh 进程内没有桥"—— 工具会回退到本地 HTTP 控制通道，
   * 因此用户在另一个终端跑 `xzh device serve` 时同样可用（见 `tools/device.ts`）。
   */
  private deviceBridge?: DeviceBridge;

  /**
   * 构造 / 切换目录时自动精简记忆产生的提示。
   *
   * 不能当场 emit：构造发生在终端接管之前（见 TuiApp.start 的 enterTerminal），
   * 那时往输出区写会污染启动画面。因此先攒着，等首轮 run 时再提示。
   */
  private pendingMemoryNotices: string[] = [];

  constructor(
    provider: LLMProvider,
    config: XuanZhuConfig,
    cwd: string,
    events: AgentEvents,
    activeModel?: ModelEntry | null,
    options?: AgentOptions,
  ) {
    this.provider = provider;
    this.config = config;
    this.cwd = cwd;
    this.events = events;
    this.activeModel = activeModel ?? activeModelEntry(config);
    this.tools = options?.tools;
    this.systemPromptOverride = options?.systemPrompt;
    this.maxToolRoundsOverride = options?.maxToolRounds;
    this.sessionFile = options?.sessionFile;
    this.autoMemory = options?.autoMemory ?? true;
    this.taskLedgerEnabled = options?.taskLedger ?? true;
    this.systemPrompt = this.composeSystemPrompt();
  }

  /** 当前使用的模型 */
  getActiveModel(): ModelEntry | null {
    return this.activeModel;
  }

  /**
   * 会话内**手动**切换当前模型（界面里的 `/model`）。
   *
   * 与「调用失败自动回退」共用同一套状态更新：重建 provider → 更新 activeModel →
   * `rememberModel()` 记住选择 → 写回配置文件，因此下次启动直接用它。
   *
   * 与回退的差别：**不做可用性校验**。这是用户主动选的，好不好用交给下一次调用的结果，
   * 失败了仍旧照常走回退链（回退不会因为「手动选过」而停用）。
   *
   * @returns 是否真的发生了切换；选中的就是当前模型时返回 false。
   * @throws 新模型的 provider 不可用时抛错（缺 API Key / 未知 provider 等），由调用方提示用户。
   */
  switchModel(entry: ModelEntry): boolean {
    if (this.activeModel && this.activeModel.id === entry.id) return false;
    this.provider = createProvider(this.config, entry);
    this.activeModel = entry;
    rememberModel(this.config, entry);
    this.persistConfig();
    return true;
  }

  /** 组合系统提示词（含当前工作目录下的项目规则与项目记忆） */
  private composeSystemPrompt(): string {
    // 子代理使用调用方给定的角色提示词（不注入项目规则与记忆 —— 它只做一件子任务），
    // 因此也不参与记忆精简：记忆归属主代理。
    if (this.systemPromptOverride) return this.systemPromptOverride;
    // 读记忆之前先做一次自动精简 / TTL，保证注入提示词的是精简后的版本
    this.autoCompactMemory();
    const globalMemory = readGlobalMemory();
    this.globalMemory = globalMemory;
    return buildSystemPrompt(
      this.cwd,
      this.config.systemPromptExtra,
      loadProjectRules(this.cwd),
      readProjectMemory(this.cwd),
      this.config.memoryMaxChars,
      Boolean(this.deviceBridge),
      this.contextProfile() === "small",
      globalMemory,
      this.config.globalMemoryMaxChars,
      Boolean(
        this.config.network?.proxy &&
          this.config.network.enabled !== false &&
          this.config.network.lastCheckOk !== false,
      ),
    );
  }

  /**
   * 本次请求实际使用的系统提示词。
   *
   * 目标模式下追加目标段落 —— 必须在**每次请求**时拼进去而不是在 `setGoal` 里改
   * `this.systemPrompt`：目标结束时只需清掉 `this.goal`，提示词自动恢复；
   * 而 `this.systemPrompt` 是 `/switch`、记忆精简等逻辑的基线，不该混入临时状态。
   */
  private effectiveSystemParts(): { static: string; dynamic: string } {
    const parts: string[] = [];
    if (this.goal && !this.goal.completed) {
      parts.push(goalSystemSection(this.goal.text));
    }
    // 全局记忆较长时，静态提示词里只有主题目录；这里按最近几轮用户消息挑相关小节。
    // 只看最后一条会让「继续」「然后呢」这类消息选不到上一轮主题。
    const recent = this.recentUserText();
    if (
      recent &&
      this.globalMemory?.longTerm &&
      this.globalMemory.longTerm.length > GLOBAL_MEMORY_EXCERPT_CHARS
    ) {
      const relevant = selectRelevantGlobalMemory(
        this.globalMemory.longTerm,
        recent,
        1_800,
      );
      if (relevant) parts.push(`## 本轮相关全局记忆\n${relevant}`);
    }
    const hint = this.globalMemoryHint();
    if (hint) parts.push(hint);
    return { static: this.systemPrompt, dynamic: parts.join("\n\n") };
  }

  private effectiveSystemPrompt(): string {
    const parts = this.effectiveSystemParts();
    return parts.dynamic ? `${parts.static}\n\n${parts.dynamic}` : parts.static;
  }

  /**
   * 当用户本轮消息明确提到「全局 / 所有项目 / 跨项目」时，追加一条记忆提醒。
   *
   * 这是**提示词层的确定性触发器**，不自动替用户写记忆：
   * 全局记忆会影响所有项目，误提取（尤其把密码原文写进去）代价很大，
   * 因此只提醒模型在本轮结束前判断并调用 memory_write target=global。
   */
  /** 最近 3 条用户消息（含本轮尚未提交的），用于主题检索 */
  private recentUserText(): string | undefined {
    const historyUsers = this.history
      .filter(
        (message) =>
          message.role === "user" && typeof message.content === "string",
      )
      .slice(-3)
      .map((message) => message.content);
    if (this.turnUserText.trim()) historyUsers.push(this.turnUserText);
    const text = historyUsers.filter(Boolean).join("\n").trim();
    return text || undefined;
  }

  private lastUserText(): string | undefined {
    if (this.turnUserText.trim()) return this.turnUserText;
    const lastUser = [...this.history]
      .reverse()
      .find(
        (message) =>
          message.role === "user" && typeof message.content === "string",
      );
    return lastUser && typeof lastUser.content === "string"
      ? lastUser.content
      : undefined;
  }

  private globalMemoryHint(): string | undefined {
    const text = this.lastUserText();
    if (!text) return undefined;
    if (
      !/(全局|所有项目|每个项目|跨项目|以后都|以后每次|统一用|统一使用|sudo|v2ray|本机代理|密码|凭据|all projects|across projects)/i.test(
        text,
      )
    ) {
      return undefined;
    }
    return (
      "## 本轮全局记忆提醒\n" +
      "系统已尝试自动捕获这条消息里明确的全局信息（凭据已加密）。" +
      "如果还有遗漏的跨项目稳定事实（用户偏好、代理地址、统一安装/构建方式），" +
      "请在本轮结束前用 `memory_write target=global` 补充；" +
      "只属于当前项目的内容仍写项目记忆。\n" +
      "**密码 / Token / UUID / API Key 原文绝对不能写进回复**；" +
      "写入记忆时工具会自动加密为 `[加密凭据 ...]`，不要复述或猜测其值。"
    );
  }

  /**
   * 长期记忆达到阈值即**自动精简**（去重 + 必要时裁剪最旧的追加块），不依赖模型主动调用。
   *
   * 触发点：会话构造、`/switch` 切换目录。之所以放在这两处而不是每轮：记忆文件只有几 KB，
   * 读一次成本极低，但每轮都读属于无谓开销；而「会话中把记忆写大」的路径已经由
   * `memory_write`（写入后自动精简）覆盖。
   *
   * `memoryMaxChars <= 0` 表示不限制长度，此时仍会去重（去重是无损的）。
   */
  private autoCompactMemory(): void {
    const report = (
      label: string,
      result: ReturnType<typeof compactLongTermMemoryIfNeeded>,
    ): void => {
      if (
        !result ||
        (result.removedDuplicates === 0 && result.removedOldest === 0)
      ) {
        return;
      }
      const parts: string[] = [];
      if (result.removedDuplicates > 0) {
        parts.push(`去除 ${result.removedDuplicates} 条重复记录`);
      }
      if (result.removedOldest > 0) {
        parts.push(`裁剪 ${result.removedOldest} 条最旧的追加记录`);
      }
      this.pendingMemoryNotices.push(
        `${label}长期记忆已自动精简（${parts.join("、")}，${result.before} → ${result.after} 字符）。` +
          `按主题整理的稳定小节不受自动裁剪影响；` +
          `若需要更彻底的压缩，可让玄猪用 memory_compact 重写为精简版本。`,
      );
    };

    report(
      "项目",
      compactLongTermMemoryIfNeeded(
        this.cwd,
        this.config.memoryMaxChars ?? DEFAULT_MEMORY_MAX_CHARS,
      ),
    );
    const ttlDays = this.config.globalMemoryTtlDays ?? 90;
    const pruned = pruneGlobalMemory(ttlDays);
    if (pruned > 0) {
      this.pendingMemoryNotices.push(
        `全局长期记忆已清理 ${pruned} 条超过 ${ttlDays} 天的自动记录（手工整理的小节不受影响）。`,
      );
    }
    report(
      "全局",
      compactGlobalMemoryIfNeeded(
        this.config.globalMemoryMaxChars ?? DEFAULT_GLOBAL_MEMORY_MAX_CHARS,
      ),
    );
  }

  get messages(): ChatMessage[] {
    return this.history;
  }

  reset(): void {
    this.history = [];
    this.historyTrimmed = false;
    // 任务列表属于本轮会话，清空对话时一并清掉，避免界面上残留上一轮的计划
    if (this.todos.length > 0) {
      this.todos = [];
      this.events.onTodos?.([]);
    }
    // 目标同样属于这段对话：上下文都没了还继续推进，只会凭残缺历史乱做
    this.clearGoal();
    // 状态块与验证门的数据同样按会话计：重置后不该再提旧动作 / 旧改动
    this.recentActions = [];
    this.sessionChangedFiles.clear();
    this.contextUsage = undefined;
    this.runStatus = undefined;
    this.turnUserText = "";
    // 新对话 = 新任务：旧账本不再适用于这段历史
    clearTaskLedger(this.cwd);
    this.task = undefined;
    this.taskLoaded = true;
  }

  /**
   * 提交消息进历史；设置了会话文件时**增量追加**到 JSONL
   * （图片降级为占位 —— 见 src/core/sessions.ts 的模块注释）。
   * 所有进入 history 的路径都必须走这里，保证会话文件与内存一致。
   */
  private appendHistory(messages: ChatMessage[]): void {
    for (const message of messages) this.history.push(message);
    if (this.sessionFile) appendSessionMessages(this.sessionFile, messages);
  }

  /**
   * 恢复会话（`/resume`）：整体替换历史，并把消息写入新的会话文件
   * （此后继续增量记录；旧文件保留为存档）。
   */
  restoreSession(messages: ChatMessage[], sessionFile: string): void {
    this.history = [...messages];
    this.sessionFile = sessionFile;
    // 恢复的会话文件本身可能已经是被裁过的版本，无从判断，故按「未裁过」重来：
    // 猜错只会少一条提醒，而凭空添加"历史不完整"的提醒会让模型无谓地畏手畏脚。
    this.historyTrimmed = false;
    // 换了一段历史，旧目标不再有对应上下文
    this.clearGoal();
    this.recentActions = [];
    this.sessionChangedFiles.clear();
    this.contextUsage = undefined;
    this.runStatus = undefined;
    // 恢复的是另一段历史，旧任务账本不应再注入
    clearTaskLedger(this.cwd);
    this.task = undefined;
    this.taskLoaded = true;
    appendSessionMessages(sessionFile, messages);
  }

  /** 当前任务列表（供界面或测试查询） */
  getTodos(): TodoItem[] {
    return this.todos;
  }

  /**
   * 设定目标（`/goal <目标>`）：进入目标模式。
   *
   * 只记录目标本身，**不**开始执行 —— 执行由界面循环驱动
   * （每轮 `run` 结束后判断是否需要自动继续）。
   */
  setGoal(text: string): GoalState {
    this.goal = {
      text: text.trim(),
      startedAt: new Date().toISOString(),
      completed: false,
    };
    if (this.taskLedgerEnabled) {
      this.ensureTaskLoaded();
      if (!this.task) this.task = createTaskLedger(text);
      this.task.goal = text.trim();
      this.task.status = "active";
      touchTaskLedger(this.cwd, this.task);
    }
    return this.goal;
  }

  /** 清除目标（`/goal off`，或目标完成后界面收尾时调用） */
  clearGoal(): void {
    this.goal = undefined;
  }

  /** 当前目标（供界面展示与测试查询） */
  getGoal(): GoalState | undefined {
    return this.goal;
  }

  /** 模型经 `goal_complete` 声明目标完成；返回是否真的在目标模式中 */
  private markGoalComplete(summary: string): boolean {
    if (!this.goal || this.goal.completed) return false;
    this.goal.completed = true;
    this.goal.summary = summary.trim();
    if (this.task) {
      addTaskDone(this.task, summary.trim());
      this.task.status = "completed";
      touchTaskLedger(this.cwd, this.task);
    }
    return true;
  }

  /** 目标模式的状态出口：交给 `goal_complete` 工具的引用 */
  private goalStore(): GoalStore {
    return {
      active: () => Boolean(this.goal && !this.goal.completed),
      complete: (summary) => {
        this.markGoalComplete(summary);
      },
    };
  }

  /** 本轮运行非正常收尾的原因（供界面判断是否该继续自动推进） */
  getAbortReason(): string | undefined {
    return this.abortReason;
  }

  /** 最近一次 `run` 实际执行的工具调用数（目标模式判断「有没有推进」） */
  getLastRunToolCallCount(): number {
    return this.lastRunToolCalls;
  }

  // ------------------------------------------------------------ 任务账本

  /** 懒加载任务账本；新进程启动时把上次的 active 降级为 paused（绝不自动继续） */
  private ensureTaskLoaded(): void {
    if (!this.taskLedgerEnabled || this.taskLoaded) return;
    this.taskLoaded = true;
    const loaded = loadTaskLedger(this.cwd);
    if (!loaded) return;
    if (loaded.status === "active") {
      loaded.status = "paused";
      saveTaskLedger(this.cwd, loaded);
    }
    this.task = loaded;
  }

  /** 当前任务账本（供界面展示；不存在时为 undefined） */
  getTaskLedger(): TaskLedger | undefined {
    this.ensureTaskLoaded();
    return this.task;
  }

  /** 每个用户轮次开始时确定「当前任务」；不自动恢复暂停任务 */
  private beginTask(userInput: string): void {
    if (!this.taskLedgerEnabled) return;
    this.ensureTaskLoaded();
    const continuation =
      /(^|[\s，,。])(继续|接着|继续吧|接着做|resume|continue|go on)\b/i.test(
        userInput,
      );
    // 目标模式自动继续时 even if task is paused (blocked) must not start a new task
    const goalRunning = Boolean(this.goal && !this.goal.completed);
    if (
      !this.task ||
      this.task.status === "completed" ||
      this.task.status === "abandoned" ||
      (this.task.status === "paused" && !continuation && !goalRunning)
    ) {
      this.task = createTaskLedger(userInput);
    } else {
      this.task.status = "active";
      this.task.lastUserMessage = userInput.slice(0, 500);
      // /focus 可能在任务开始前创建了占位账本；第一条用户消息用来定标题
      if (this.task.title === "未命名任务") {
        this.task.title = userInput.trim().slice(0, 120) || "未命名任务";
      }
    }
    this.task.status = "active";
    touchTaskLedger(this.cwd, this.task);
  }

  /** 把 todo 快照写进账本（todo_write 每次 set 都会调用） */
  private syncTaskTodos(): void {
    if (!this.taskLedgerEnabled || !this.task) return;
    this.task.plan = this.todos.map((item) => ({ ...item }));
    touchTaskLedger(this.cwd, this.task);
  }

  /** 一次 run 正常结束：记录结论 / 未决问题 / 目标完成状态 */
  private recordTaskConclusion(finalText: string): void {
    if (!this.taskLedgerEnabled || !this.task) return;
    const conclusion = summarizeMemoryConclusion(finalText);
    if (conclusion) {
      this.task.lastConclusion = conclusion;
      addTaskDone(this.task, conclusion);
    }
    // 从答复里提取显式写出的「决策：/ 决定：」，其余语义判断交给模型的 memory_write
    for (const line of finalText.split("\n")) {
      const match = /^\s*(?:[-*]\s*)?(?:决策|决定)[：:]\s*(.+)$/.exec(line);
      if (match?.[1]) addTaskDecision(this.task, match[1]);
    }
    const status = this.getRunStatus();
    if (status && (status.kind === "blocked" || status.kind === "needs_input")) {
      this.task.openQuestions = [status.summary];
      this.task.status = "paused";
    } else {
      this.task.openQuestions = [];
      this.task.status = this.goal?.completed ? "completed" : "active";
    }
    touchTaskLedger(this.cwd, this.task);
  }

  /** 中断 / 回滚：用户中断且 0 次工具调用视为误发放弃；出错或已产生副作用则暂停 */
  private markTaskInterrupted(reason = ""): void {
    if (!this.taskLedgerEnabled || !this.task || this.task.status !== "active") return;
    const userAbort = reason.includes("中断");
    this.task.status =
      userAbort && this.lastRunToolCalls === 0 ? "abandoned" : "paused";
    touchTaskLedger(this.cwd, this.task);
  }

  // ------------------------------------------------------------ 工作集（/focus）

  getFocusFiles(): string[] {
    if (!this.taskLedgerEnabled) return [];
    this.ensureTaskLoaded();
    return [...(this.task?.focusFiles ?? [])];
  }

  addFocusFile(file: string): { ok: boolean; message: string } {
    if (!this.taskLedgerEnabled) {
      return { ok: false, message: "子代理不维护工作集" };
    }
    this.ensureTaskLoaded();
    const raw = file.trim();
    if (!raw) return { ok: false, message: "用法：/focus <文件路径>" };
    const abs = path.isAbsolute(raw) ? raw : path.resolve(this.cwd, raw);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return { ok: false, message: `文件不存在：${raw}` };
    }
    if (!this.task) this.task = createTaskLedger("");
    const rel = path.relative(this.cwd, abs) || raw;
    if (this.task.focusFiles.includes(rel)) {
      return { ok: true, message: `已在工作集：${rel}` };
    }
    this.task.focusFiles.push(rel);
    if (this.task.focusFiles.length > 20) {
      this.task.focusFiles.splice(0, this.task.focusFiles.length - 20);
    }
    touchTaskLedger(this.cwd, this.task);
    return { ok: true, message: `已加入工作集：${rel}` };
  }

  removeFocusFile(file: string): boolean {
    if (!this.taskLedgerEnabled) return false;
    this.ensureTaskLoaded();
    if (!this.task) return false;
    const raw = file.trim();
    const before = this.task.focusFiles.length;
    this.task.focusFiles = this.task.focusFiles.filter(
      (item) => item !== raw && path.resolve(this.cwd, item) !== path.resolve(this.cwd, raw),
    );
    if (this.task.focusFiles.length === before) return false;
    touchTaskLedger(this.cwd, this.task);
    return true;
  }

  clearFocusFiles(): void {
    if (!this.taskLedgerEnabled) return;
    this.ensureTaskLoaded();
    if (!this.task || this.task.focusFiles.length === 0) return;
    this.task.focusFiles = [];
    touchTaskLedger(this.cwd, this.task);
  }

  /** 本轮模型主动上报的状态（`report_status`）；没有则为 `undefined` */
  getRunStatus(): RunStatus | undefined {
    return this.runStatus;
  }

  /** 状态上报出口：交给 `report_status` 工具的引用 */
  private statusStore(): StatusStore {
    return {
      report: (status) => {
        this.runStatus = { ...status, at: new Date().toISOString() };
        if (this.task && (status.kind === "blocked" || status.kind === "needs_input")) {
          this.task.openQuestions = [status.summary];
          this.task.status = "paused";
          touchTaskLedger(this.cwd, this.task);
        }
      },
      toolCalls: () => this.lastRunToolCalls,
      goalActive: () => Boolean(this.goal && !this.goal.completed),
    };
  }

  /**
   * 自动记录本轮记忆。
   *
   * 两层，目的不同：
   * 1. **当日日志**：每次有实际动作（≥2 次工具调用 / 改过文件 / 跑过验证）就写一条
   *    确定性摘要 —— 解决「下次开新会话不知道上次做到哪」；
   * 2. **长期记忆**：只有**代码真的被改动**时才写，并按改动目录归入
   *    `## 自动记录 · <topic>` 小节 —— 只读问答与调研不污染结论库。
   *
   * 模型已经主动 `memory_write` 时不再补写，避免同一轮出现两份记录。
   * 目标模式的中间轮次跳过（避免每轮都写），完成那一轮用 `goal.summary` 记一次。
   */
  private autoRecordRunMemory(finalText: string): void {
    if (!this.autoMemory) return;
    const goalCompleted = this.goal?.completed === true;
    if (this.goal && !goalCompleted) return;
    if (this.runWroteMemory) return;
    if (this.lastRunToolCalls === 0 && !goalCompleted) return;
    if (
      !goalCompleted &&
      this.lastRunToolCalls < 2 &&
      this.runChangedFiles.size === 0 &&
      !this.runVerifyCommand
    ) {
      return;
    }

    const conclusion = summarizeMemoryConclusion(
      goalCompleted ? (this.goal?.summary ?? finalText) : finalText,
    );
    if (!conclusion) return;
    // 自动写入会长期保留：先过一遍凭据脱敏，避免把模型复述的 Key 存进项目记忆
    const safeConclusion = redactSecrets(conclusion);
    const safeVerify = this.runVerifyCommand
      ? redactSecrets(this.runVerifyCommand)
      : undefined;

    const counts = [...this.runToolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, count]) => `${name}×${count}`);
    const runFiles = [...this.runChangedFiles];
    const longTermFiles = goalCompleted ? [...this.sessionChangedFiles] : runFiles;

    const daily = [
      `- 工具：${counts.length > 0 ? counts.join("、") : "无"}`,
      runFiles.length > 0
        ? `- 改动：${runFiles.slice(0, 4).join("、")}` +
          (runFiles.length > 4 ? ` 等 ${runFiles.length} 个` : "")
        : "",
      `- 验证：${
        safeVerify ? `${safeVerify}（${this.runVerifyOk ? "通过" : "失败"}）` : "未运行"
      }`,
      `- 结论：${safeConclusion}`,
    ]
      .filter(Boolean)
      .join("\n");

    let topic: string | undefined;
    try {
      appendMemory(this.cwd, daily, "daily");
      if (longTermFiles.length > 0) {
        topic = deriveMemoryTopic(this.cwd, longTermFiles);
        const filesShown = longTermFiles.slice(0, 3).join("、");
        const more =
          longTermFiles.length > 3 ? ` 等 ${longTermFiles.length} 个` : "";
        const entry =
          `- ${localDateStamp()}：${safeConclusion}（改动 ${filesShown}${more}）` +
          (safeVerify ? `；验证 ${safeVerify}` : "；未验证");
        const result = appendLongTermTopicEntry(
          this.cwd,
          topic,
          entry,
          this.config.memoryMaxChars,
        );
        if (!result.added) topic = undefined;
      }
    } catch {
      // 记忆是尽力而为：写不进去不能影响本轮答复
      return;
    }

    this.events.onNotice?.(
      topic
        ? `已自动记录当日摘要，并更新长期记忆（${topic}）`
        : "已自动记录当日摘要",
    );
  }

  /** 当前上下文策略：配置优先，否则按模型窗口自动判断 */
  private contextProfile(): "small" | "full" {
    if (this.config.contextProfile === "small") return "small";
    if (this.config.contextProfile === "full") return "full";
    const window =
      this.activeModel?.contextWindow ??
      inferContextWindow(this.activeModel?.model ?? "");
    return window > 0 && window <= SMALL_CONTEXT_WINDOW ? "small" : "full";
  }

  /** 本次请求的输出上限（配置优先，small 档默认 2048） */
  private requestMaxTokens(): number | undefined {
    const configured = this.config.maxOutputTokens;
    if (typeof configured === "number" && configured > 0) {
      return Math.floor(configured);
    }
    return this.contextProfile() === "small" ? SMALL_MAX_OUTPUT_TOKENS : undefined;
  }

  /** `/context` 的数据源：各区块的估算占用与实际窗口 */
  getContextReport(): ContextReport {
    const model = this.activeModel?.model ?? "";
    const window = this.activeModel?.contextWindow ?? inferContextWindow(model);
    const stateBlock = this.buildSelfStateBlock();
    const systemTokens = estimateMessageTokens({
      role: "system",
      content: this.effectiveSystemPrompt(),
    });
    const stateTokens = stateBlock
      ? estimateMessageTokens({ role: "system", content: stateBlock })
      : 0;
    const toolsTokens = estimateTokens(
      JSON.stringify(getToolSpecs(this.requestTools())),
    );
    const historyTokens = this.history.reduce(
      (sum, message) => sum + estimateMessageTokens(message),
      0,
    );
    const inputTokens = systemTokens + toolsTokens + historyTokens + stateTokens;
    return {
      model,
      window,
      profile: this.contextProfile(),
      systemTokens,
      toolsTokens,
      historyTokens,
      stateTokens,
      inputTokens,
      conversationBudget: this.conversationBudget(),
      ratio: window > 0 ? Math.min(1, inputTokens / window) : 0,
      trimmed: this.historyTrimmed,
      maxOutputTokens: this.requestMaxTokens(),
    };
  }

  /**
   * `/compact` —— 用一次模型调用把旧历史压成滚动摘要，保留最近几轮原文。
   *
   * 这是**显式**操作而不是自动触发：本地模型每次调用都贵，自动压缩会在用户
   * 不知情时多一轮请求；日常裁剪已由「任务账本 + contextTrimmedNote」兜底。
   * 摘要同时写入任务账本，`/resume`/下次会话仍能看到结论。
   */
  async compactHistory(signal?: AbortSignal): Promise<CompactResult> {
    const before = this.history.length;
    if (before <= COMPACT_KEEP_MESSAGES) {
      return {
        compacted: false,
        before,
        after: before,
        reason: "历史较短，无需压缩",
      };
    }

    this.ensureTaskLoaded();
    if (this.taskLedgerEnabled && !this.task) {
      const firstUser = this.history.find((message) => message.role === "user");
      this.task = createTaskLedger(firstUser?.content ?? "上下文压缩");
    }
    const digest = this.task ? formatTaskDigest(this.task, 900) : null;
    const transcript = this.history
      .map((message) => {
        let line = `[${message.role}] ${message.content}`;
        if (message.toolCalls?.length) {
          line += `\n(调用工具：${message.toolCalls.map((call) => call.name).join("、")})`;
        }
        return line;
      })
      .join("\n\n");

    const prompt =
      "把下面这段编码任务的对话压缩成一份可继续工作的摘要。要求：\n" +
      "1. 用中文，分点写：已完成、关键决策、改动文件、验证结果、未决问题、下一步；\n" +
      "2. 只保留事实与结论，不要复述寒暄、工具原始输出和代码全文；\n" +
      "3. 总长度不超过 600 字；没有内容的项可省略。\n\n" +
      (digest ? `当前任务账本（可参考，不要照抄）：\n${digest}\n\n` : "") +
      `对话：\n${transcript.length > 14000 ? `…（前文已省略）\n${transcript.slice(-14000)}` : transcript}`;

    let summary = "";
    const stream = this.provider.chat({
      messages: [
        { role: "system", content: "你是上下文压缩器，只输出摘要正文。" },
        { role: "user", content: prompt },
      ],
      tools: [],
      temperature: 0.2,
      maxTokens: Math.min(this.requestMaxTokens() ?? 900, 1200),
      signal,
    });
    for await (const chunk of stream) {
      if (chunk.type === "text") summary += chunk.text;
    }
    if (signal?.aborted) throw new Error("上下文压缩已被用户中断");
    summary = summary.trim();
    if (!summary) throw new Error("模型没有返回摘要内容");

    // 从 user 边界保留最近几轮，避免留下半截 tool / assistant
    let start = Math.max(0, this.history.length - COMPACT_KEEP_MESSAGES);
    while (start > 0 && this.history[start]?.role !== "user") start -= 1;
    const recent = this.history.slice(start);
    this.history = [
      {
        role: "system",
        content:
          "[对话摘要] 更早的逐字消息已被 /compact 压缩；最近几轮原文仍保留。\n\n" +
          summary,
      },
      ...recent,
    ];
    // 这是有意的摘要，不需要再附「历史被裁剪」的警告
    this.historyTrimmed = false;

    if (this.taskLedgerEnabled && this.task) {
      this.task.summary = summary;
      addTaskDone(this.task, summary.slice(0, 240));
      touchTaskLedger(this.cwd, this.task);
    }

    return {
      compacted: true,
      before,
      after: this.history.length,
      summary,
    };
  }

  /** 生成只读状态块（没有可写内容时返回 `null`） */
  private buildSelfStateBlock(): string | null {
    this.ensureTaskLoaded();
    return buildSelfState({
      goal: this.goal,
      todos: this.todos,
      recentActions: this.recentActions,
      changedFiles: [...this.sessionChangedFiles],
      contextUsage: this.contextUsage,
      status: this.runStatus,
      taskDigest: this.task ? (formatTaskDigest(this.task) ?? undefined) : undefined,
    });
  }

  /**
   * 重新生成系统提示词（清空 / 改写项目记忆后调用）。
   *
   * 系统提示词在构造与 `/switch` 时就已定稿并缓存，`/memory clear` 之后若不刷新，
   * 后续请求仍会带着**刚被删掉的旧记忆** —— 用户会以为清空没生效。
   */
  reloadSystemPrompt(): void {
    this.systemPrompt = this.composeSystemPrompt();
  }

  /** 注入 / 撤销设备桥（界面在 `/device serve` 与 `/device stop` 时调用） */
  setDeviceBridge(bridge?: DeviceBridge): void {
    const changed = Boolean(this.deviceBridge) !== Boolean(bridge);
    this.deviceBridge = bridge;
    // 工具集与系统提示词都随桥的状态变化：重新生成，避免提示词里还在讲不可用的工具
    if (changed) this.reloadSystemPrompt();
  }

  /**
   * 本次请求实际下发的工具集。
   *
   * 未连接设备桥时**不暴露** `device_*`：这 7 个工具的 schema 约 2.2KB，
   * 每轮都发会白白增加提示词（本地模型 prefill 很贵），模型也可能去调用
   * 一个根本连不上的设备。连接后再恢复。
   */
  private requestTools(): ToolDefinition[] {
    const tools = this.tools ?? TOOLS;
    const goalActive = Boolean(this.goal && !this.goal.completed);
    const small = this.contextProfile() === "small";
    return tools.filter((tool) => {
      // 未连接设备桥：不下发 device_*（schema 约 2.2KB，且模型调用必然失败）
      if (!this.deviceBridge && tool.name.startsWith("device_")) return false;
      // 非目标模式：不下发 goal_complete（模型没有目标可完成）
      if (!goalActive && tool.name === "goal_complete") return false;
      if (small) {
        // 小窗口下只保留核心工具；目标完成工具仅在目标模式保留
        if (tool.name === "goal_complete" && goalActive) return true;
        if (!SMALL_TOOL_NAMES.has(tool.name)) return false;
      }
      return true;
    });
  }

  /**
   * 任务列表存储：交给 `todo_write` 工具的引用。
   *
   * 工具是无状态函数，状态必须挂在 Agent 上；每次写入后同步通知界面刷新。
   */
  private todoStore(): TodoStore {
    return {
      get: () => this.todos,
      set: (items) => {
        // 防御：工具会先校验，但列表也可能被其它调用方直接写入。
        // 这里只保留第一个 in_progress，其余降级为 pending，保证界面语义一致。
        let seenRunning = false;
        this.todos = items.map((item) => {
          if (item.status !== "in_progress") return item;
          if (!seenRunning) {
            seenRunning = true;
            return item;
          }
          return { ...item, status: "pending" as const };
        });
        this.events.onTodos?.(this.todos);
        this.syncTaskTodos();
      },
    };
  }

  get messageCount(): number {
    return this.history.length;
  }

  /** 当前工作目录 */
  getCwd(): string {
    return this.cwd;
  }

  /** 切换工作目录：更新工具上下文、项目规则与系统提示词（保留对话历史） */
  setCwd(cwd: string): void {
    this.cwd = cwd;
    this.systemPrompt = this.composeSystemPrompt();
    // 换项目：重新加载该项目的任务账本（旧的 active 会被降级为 paused）
    this.task = undefined;
    this.taskLoaded = false;
  }

  /**
   * 执行一次用户请求（含多轮工具调用），直到模型给出最终答复。
   *
   * `images` 为用户随本轮消息附带的图片（多模态输入）；只在**本轮**携带，
   * 历史里的旧图片会在组装请求时降级为文本占位（见 `stripStaleImages`）。
   */
  /**
   * 本轮运行**非正常收尾**的原因；正常给出答复后为 `undefined`。
   *
   * 主代理自己有 onNotice 就能告知用户；但**子代理**的中止发生在独立实例上，
   * 主代理只能拿到它的文本回报 —— 不把原因暴露出来，一份烂尾报告
   * （比如因重复调用被中止前吐出的半截结论）就会被当成正常结论继续使用。
   * spawnSubAgent 据此在回报里加警告。
   */
  private abortReason: string | undefined;

  /**
   * 最近一次 `run` 中**实际执行**的工具调用数（被跳过 / 未执行的不算）。
   *
   * 目标模式据此判断「这一轮有没有实际推进」：模型可能连续多轮只输出文字、
   * 不调用任何工具，此时自动继续只会无限重复客套话，应由界面暂停（见 `TuiApp`）。
   */
  private lastRunToolCalls = 0;

  async run(
    userInput: string,
    signal?: AbortSignal,
    images?: ImageAttachment[],
  ): Promise<void> {
    // Agent 实例可能被复用（同一实例多次 run），先清掉上一轮的中止原因与工具计数
    this.abortReason = undefined;
    this.lastRunToolCalls = 0;
    // 验证门只看**本轮**的改动与验证；每次 run 允许提醒一次
    this.runChangedFiles.clear();
    this.runActionSeq = 0;
    this.runLastChangeSeq = 0;
    this.runLastVerifySeq = 0;
    this.finishGateUsed = false;
    this.runTouchedTodos = false;
    this.runStatus = undefined;
    this.runToolCounts.clear();
    this.runVerifyCommand = undefined;
    this.runVerifyOk = false;
    this.runWroteMemory = false;
    // 用户最新一条消息定义当前任务；旧任务暂停时不会自动继续
    this.beginTask(userInput);
    // 原始输入用于全局记忆相关性/提醒；意图分析后的 content 可能丢失关键词
    this.turnUserText = userInput;

    // 自动捕获全局信息（跨项目偏好、本机代理、sudo 等）。
    // 凭据值在写入前加密，记忆里只留引用；目标模式/子代理不参与，避免重复。
    if (this.autoMemory && !this.systemPromptOverride && !this.goal) {
      try {
        const captured = captureGlobalMemoryFromUser(userInput);
        if (captured.added) {
          this.events.onNotice?.(
            `已自动记录全局记忆` +
              (captured.credentialIds.length > 0
                ? `（${captured.credentialIds.length} 项凭据已加密）`
                : ""),
          );
        }
      } catch {
        // 自动记忆是尽力而为：失败不能影响本轮
      }
    }

    let content = userInput;

    // 补发构造 / 切换目录期间攒下的提示（构造时终端尚未接管，不能当场写输出区）
    if (this.pendingMemoryNotices.length > 0) {
      for (const notice of this.pendingMemoryNotices) {
        this.events.onNotice?.(notice);
      }
      this.pendingMemoryNotices = [];
    }

    // system prompt 自身就可能撑满窗口：项目规则（rules.md）与附加指令
    // （systemPromptExtra）都是全文注入、无长度上限。这种情况下再怎么裁历史也发不出去，
    // 必须让用户知道真正的原因，而不是只看到一句语焉不详的 400。
    if (
      !this.warnedTightContext &&
      isSystemPromptTight(
        this.activeModel?.contextWindow,
        this.activeModel?.model ?? "",
        this.effectiveSystemPrompt(),
      )
    ) {
      this.warnedTightContext = true;
      this.events.onNotice?.(
        "当前模型可用上下文过小：系统提示词已占去绝大部分窗口，历史与工具输出将无法发送。" +
          "可精简项目规则（.xuanzhu/rules.md）或 systemPromptExtra，" +
          "或改用窗口更大的模型（xzh model context <id> <大小>）。",
      );
    }

    // 意图分析（默认关闭，由配置 / --intent 控制）：
    // 先发起一次独立请求把用户消息改写为意图分析结果，再以它作为本轮输入。
    // 目标模式跳过：自动继续的输入本身就是结构化指令（见 core/goal.ts），
    // 再被「帮我分析这段话的意图」改写一次只会稀释目标与「不要停」的约束。
    if (this.config.intent?.enabled && !this.goal) {
      this.events.onStatus("分析意图中");
      const analysis = await this.analyzeIntent(userInput, signal);
      if (signal?.aborted) {
        this.events.onStatus("已中断");
        return;
      }
      if (analysis) {
        content = analysis;
        this.events.onIntent?.(analysis, userInput);
      } else {
        this.events.onNotice?.("意图分析未返回内容，已按原始输入继续。");
      }
    }

    // 本轮新增的消息先放进 turn、**不直接写入 this.history**，只在收尾时提交。
    // 这样提交点集中，且完全不受历史裁剪影响 —— 早先两版分别用「起点下标校正」和
    // 「按条数从尾部截断」，前者下标会漂移成负数并抛 Invalid array length 覆盖真实错误，
    // 后者在单轮消息数超过保留窗口时会把整段历史删光。
    // 只带图片没有正文时补一句兜底文本：部分端点要求 content 至少含一个非空文本块
    const hasImages = Boolean(images && images.length > 0);
    const turn: ChatMessage[] = [
      {
        role: "user",
        content: hasImages && !content.trim() ? IMAGE_FALLBACK_TEXT : content,
        images: hasImages ? images : undefined,
      },
    ];

    // maxToolRounds 为 0 / 负数时也要至少执行一次，否则用户只会看到「已达上限」而无任何回复。
    // 子代理可经 AgentOptions.maxToolRounds 覆盖（并行子代理各有配额，默认值应比主代理紧）
    const maxRounds = Math.max(
      1,
      Math.floor(this.maxToolRoundsOverride ?? this.config.maxToolRounds) || 1,
    );

    /** 成功收尾：把本轮全部消息提交进历史（并增量写入会话文件） */
    const commitTurn = (): void => {
      this.appendHistory(turn);
      this.trimHistory();
      this.turnUserText = "";
    };

    /**
     * 生成「上一轮已中止」的说明；本轮什么都没真正执行时返回 `null`（无可奉告）。
     *
     * 用 `system` 角色承载：它**不参与 user / assistant 的交替结构**。
     *
     * ⚠️ 但不能让它留在历史中间：llama.cpp 的 chat template 严格要求 system 必须在
     * 最前面，否则整轮 HTTP 500（2026-10-25 实测：`System message must be at the beginning`）。
     * 因此请求组装时由 `hoistSystemNotes()` 把这类消息提前并入系统提示词。
     */
    const abortNote = (reason: string): ChatMessage | null => {
      // 先建立 id → 参数 的索引：`tool` 消息本身不带参数，得回到 assistant 的 tool_calls 取
      const argsById = new Map<string, string>();
      for (const message of turn) {
        for (const call of message.toolCalls ?? []) argsById.set(call.id, call.arguments);
      }

      const executed: string[] = [];
      for (const message of turn) {
        if (message.role !== "tool") continue;
        // 被跳过（自我修正 / 重复检测）的调用只是占位，并没有真的执行
        if (message.content.startsWith(SKIPPED_CALL_PREFIX)) continue;
        const args = argsById.get(message.toolCallId ?? "") ?? "";
        const shown =
          args.length > ABORT_NOTE_ARG_CHARS
            ? `${args.slice(0, ABORT_NOTE_ARG_CHARS)}…`
            : args;
        executed.push(`${message.name ?? "工具"}(${shown})`);
      }
      if (executed.length === 0) return null;

      const listed = executed
        .slice(0, ABORT_NOTE_MAX_CALLS)
        .map((line) => `· ${line}`);
      if (executed.length > listed.length) {
        listed.push(`· …等共 ${executed.length} 次调用`);
      }
      return {
        role: "system",
        content:
          `[上一轮已中止] 上一轮${reason}，没有给出结论，该轮对话已作废 —— ` +
          `**不会被自动接着做**，除非用户明确要求继续。\n` +
          `中止前**已经真实执行**过的操作（以下是**已执行记录，不是待办清单**，` +
          `副作用仍然存在，不要重复执行）：\n` +
          listed.join("\n") +
          `\n请直接回应用户**最新的那条消息**：若它只是寒暄（「在吗」「你好」）或另一件事，` +
          `就照它回答；不要接着完成被中止的旧任务。`,
      };
    };

    /**
     * 中断/出错收尾：**本轮整体回滚**（turn 一条都不提交），另补一条说明。
     *
     * 为什么是整轮回滚：曾有一个「部分提交」版本，保留已完整配对的 user /
     * assistant(tool_calls) / tool 记录，只丢弃末尾对不齐的 assistant（理由是工具副作用
     * 真实存在、抹掉会让模型重做）。但那样历史里会留下一条**没有最终答复的 user 轮次** ——
     * 用户中断后发新消息时，模型看到的是「上一轮工具都跑完了却没收尾」，于是先把旧任务
     * 答完，表现为「发了新消息，模型却仍在回复被中断的那条」。用户按 `Ctrl+D` 的语义
     * 就是「这一轮不要了」，因此历史回到本轮起点。
     *
     * 为什么还要补说明：整轮回滚后模型看不见自己做过什么，若不告诉它，它会以为什么都没
     * 发生、**重复执行**已经生效的写文件 / 执行命令。说明只列真实执行过的调用
     * （跳过的不算），既保住「工具做过什么」这份信息，又不留下悬空的 user 轮次。
     */
    const rollbackTurn = (reason: string): void => {
      const note = abortNote(reason);
      // turn 是本轮私有的消息数组，且所有调用点随后都会 return（catch 分支则重新抛出），
      // 因此「回滚」在实现上就是什么都不提交；清空数组只是让语义显式。
      turn.length = 0;
      if (note) {
        this.appendHistory([note]);
        this.trimHistory();
      }
      // 用户中断：0 次工具调用视为误发放弃；有副作用则暂停，等显式继续
      this.markTaskInterrupted(reason);
    };

    // 死循环检测的跨轮状态：记录上一次的工具调用签名与连续出现次数。
    // 必须放在轮次循环之外 —— 模型陷入循环时，往往每轮只调一次同一个工具。
    let lastToolSignature = "";
    let identicalToolCalls = 0;

    // 本轮已成功执行过的调用（签名 → 次数）。
    //
    // 用途是**让模型能够自我修正**：本地模型在长任务里经常「丢失自己的计划」——
    // 它记得某一步做过（会说「✅ 已测试」），却把开头的「我来逐个测试…」重新说一遍，
    // 于是从头再来一轮。根因是上下文被裁剪后它看不到自己刚做了什么。
    // 单纯中止只是停下，问题并没有解决；这里改为在重复发生时把**既成事实**
    // 明确写进工具结果，模型看到「这是你第 N 次调用、参数与结果都相同、
    // 本轮已做过这些」就能接着往下走，而不是重新规划。
    const completedSignatures = new Map<string, number>();

    // 本轮的只读调研累计量，以及「是否已经建议过改用子代理」「是否已经在用子代理」。
    // 用途见 EXPLORATION_REMINDER_CALLS 的注释：把「该委托」从主观判断变成客观触发。
    let explorationCalls = 0;
    let explorationChars = 0;
    let delegationSuggested = false;
    let usedSubAgent = false;

    /** 记录一次只读调研；首次超过阈值时返回一段追加到工具结果末尾的提醒 */
    const explorationReminder = (toolName: string, output: string): string => {
      if (delegationSuggested || usedSubAgent) return "";
      if (!EXPLORATION_TOOLS.has(toolName)) return "";
      explorationCalls++;
      explorationChars += output.length;
      if (
        explorationCalls < EXPLORATION_REMINDER_CALLS &&
        explorationChars < EXPLORATION_REMINDER_CHARS
      ) {
        return "";
      }
      delegationSuggested = true;
      this.events.onStatus("建议改用子代理", `本轮已调研 ${explorationCalls} 次`);
      return (
        `\n\n[系统提醒] 本轮你已经做了 ${explorationCalls} 次只读调研（累计约 ` +
        `${Math.round(explorationChars / 1000)}k 字符），这些内容会一直占用你的上下文窗口。\n` +
        "· 若接下来还有**互不依赖**的调研任务，请改用 `task` 派生 `code-explorer` 子代理" +
        "（可一次并列多个、并行执行），只把结论带回来；\n" +
        "· 若只剩收尾工作，忽略本条即可。"
      );
    };

    // 已经用掉几次「自我修正」。检测到死循环时不会立刻中止，而是**主动发起一轮
    // 元对话**：把「你在重复、任务没有推进」明确告诉模型，要求它分析原因并换方案。
    // 只有修正之后仍然重复，才判定为无法自愈并中止 —— 直接中止只是止损，
    // 问题并没有被解决，重新问一次还会再来一遍。
    let selfCorrections = 0;

    // 轮次配额的当前上限。用尽时先询问用户是否继续，而不是硬性中断 ——
    // 真实的大型重构（读完一个模块、重写、反复跑测试）很容易超过默认轮数，
    // 直接停掉会让任务断在半路。只有用户明确不再继续才收尾。
    let roundLimit = maxRounds;
    // 目标模式下「自动继续」的已续期次数（见 GOAL_ROUND_LIMIT_EXTENSIONS）
    let roundExtensions = 0;

    try {
      for (let round = 0; ; round++) {
        if (round >= roundLimit) {
          if (signal?.aborted) {
            rollbackTurn("被用户中断");
            this.events.onStatus("已中断");
            return;
          }
          // 目标模式：口答「继续」是常态，但单次 run 不能无限续期
          const goalActive = Boolean(this.goal && !this.goal.completed);
          if (goalActive && roundExtensions >= GOAL_ROUND_LIMIT_EXTENSIONS) break;
          // 没有提供询问回调时（非交互场景）行为与以前一致：直接收尾
          const canContinue = this.events.onRoundLimit
            ? await this.events.onRoundLimit(round)
            : false;
          if (!canContinue) break;
          roundLimit += maxRounds;
          roundExtensions += 1;
        }

        if (signal?.aborted) {
          rollbackTurn("被用户中断");
          this.events.onStatus("已中断");
          return;
        }

        // 每轮裁剪「已提交」的历史；本轮未提交的 turn 由 buildConversation 在组装
        // 请求时一并裁剪，避免单轮内上下文突破模型窗口。
        this.trimHistory();

        this.events.onStatus("思考中", `第 ${round + 1} 轮`);

        const { text, toolCalls } = await this.streamAssistant(
          signal,
          new Set(),
          turn,
        );

        // streamAssistant 在中断时可能「正常返回」部分内容：
        // 此时不能把半截 assistant 提交，也不该继续执行工具 —— 本轮整体回滚
        if (signal?.aborted) {
          rollbackTurn("被用户中断");
          this.events.onStatus("已中断");
          return;
        }

        turn.push({
          role: "assistant",
          content: text,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        });

        if (toolCalls.length === 0) {
          // 收尾检查 = 验证门 + 未完成门，合计**只提醒一次**（第二次仍直接答复就尊重它）。
          // 模型已通过 report_status 声明受阻 / 待输入时不再拦截：它已经给过结构化原因了。
          const goalActive = Boolean(this.goal && !this.goal.completed);
          // 经方法读取：`runStatus` 在 run 开头被置为 undefined，直接读字段会被
          // 控制流分析窄化成 undefined（它实际由工具回调写入）。
          const currentStatus = this.getRunStatus();
          const reportedStop =
            currentStatus !== undefined && currentStatus.kind !== "low_confidence";
          if (!this.finishGateUsed && !reportedStop) {
            const verificationFiles =
              this.runChangedFiles.size > 0 &&
              this.runLastChangeSeq > this.runLastVerifySeq
                ? [...this.runChangedFiles]
                : [];
            // 未完成门只在普通对话生效：目标模式本来就由 goal 循环继续，
            // 再插一条「还有未完成项」只会重复打断。
            // 也只认**本轮自己列过**的计划，避免对上一件事留下的旧清单唠叨。
            const incompleteTodos =
              !goalActive && this.runTouchedTodos
                ? this.todos.filter(
                    (item) =>
                      item.status === "in_progress" || item.status === "pending",
                  )
                : [];
            // 模型在明确征求用户确认/选择时，未完成门不应催它继续 ——
            // 这正是在等用户拍板，强行继续反而会让它猜。验证门仍然生效。
            const awaitingUser =
              incompleteTodos.length > 0 &&
              isAwaitingUserConfirmation(text);
            const gateTodos = awaitingUser ? [] : incompleteTodos;
            if (verificationFiles.length > 0 || gateTodos.length > 0) {
              this.finishGateUsed = true;
              turn.push({
                role: "user",
                content: finishGatePrompt({
                  verificationFiles,
                  incompleteTodos: gateTodos,
                }),
              });
              const parts: string[] = [];
              if (gateTodos.length > 0) {
                parts.push(`${gateTodos.length} 项任务未完成`);
              }
              if (verificationFiles.length > 0) parts.push("改动尚未验证");
              this.events.onStatus("收尾检查", parts.join(" · "));
              this.events.onNotice?.(
                `收尾前检测到 ${parts.join("、")}，已要求模型继续完成或说明停下原因。`,
              );
              continue;
            }
          }
          // 任务账本只记录最终接受的那版结论；自动记忆随后执行
          this.recordTaskConclusion(text);
          // 自动记忆：当日摘要必写；代码有实际改动时再按主题并入长期记忆。
          this.autoRecordRunMemory(text);
          commitTurn();
          this.events.onStatus("就绪");
          return;
        }

        // 工具执行：**连续的可并行调用**（目前只有 `task`）会并发执行，其余按顺序串行。
        // 分批的依据是「是否有副作用、是否共享可变状态」：多个子代理各自是独立的
        // Agent 实例，并行能立刻缩短多路调研的等待；而写文件 / 执行命令可能互相依赖，
        // 一旦并行就会乱序甚至冲突，必须保持顺序。
        let index = 0;

        // 工具产出的图片要等**这条 assistant 的最后一个工具结果**之后再插入。
        //
        // 为什么不能紧跟各自的 tool 消息：若模型在一轮里并列多个调用，而**非最后一个**
        // 返回了图片（目前只有 device_screenshot 会带图），序列会变成
        // [tool, user(图), tool] —— OpenAI 协议要求所有 tool 消息紧跟自己那条 assistant，
        // 中间夹一条 user 会被服务端以 400 拒绝（"messages with role 'tool' must be a
        // response to a preceeding message with 'tool_calls'"）。统一挪到末尾即可。
        const imageNotes: ChatMessage[] = [];

        while (index < toolCalls.length) {
          const call = toolCalls[index];

          // 死循环检测：同一个工具 + 同一组参数连续出现多次即判定为卡住
          const signature = `${call.name}:${call.arguments}`;
          if (signature === lastToolSignature) {
            identicalToolCalls++;
          } else {
            lastToolSignature = signature;
            identicalToolCalls = 1;
          }
          if (identicalToolCalls >= MAX_IDENTICAL_TOOL_CALLS) {
            // 第一步：发起一次自我修正，而不是直接中止。
            if (selfCorrections < MAX_SELF_CORRECTIONS) {
              selfCorrections++;
              const repeats = identicalToolCalls;
              // 重置计数，让修正后的新方案有一个干净的判断起点；
              // 若它依旧重复，会重新累计到阈值，那时才中止。
              identicalToolCalls = 0;
              lastToolSignature = "";

              // assistant 消息里带了 tool_calls，因此**每个 call 都必须有对应的
              // tool 结果**，否则角色序列非法、下一次请求会被服务端拒绝。
              // 这次调用不执行，且**其后所有调用一并跳过**，都要补上说明。
              this.skipToolCalls(turn, toolCalls, index, (k) =>
                k === index
                  ? `[系统] 本次调用已跳过：它与前面 ${repeats} 次完全相同。`
                  : "[系统] 本次调用已跳过：同一轮内的重复调用触发了自我修正。",
              );
              turn.push({
                role: "user",
                content:
                  `[系统检测] 你连续 ${repeats} 次调用了 \`${call.name}\`（参数完全相同），` +
                  `但任务并没有因此推进。\n\n` +
                  `请先停下来分析，不要继续调用工具：\n` +
                  `1. 这个调用为什么没有推进任务？它的返回值里是不是**已经**有你需要的全部信息？\n` +
                  `2. 任务目前实际完成到哪一步了？把已经做完的部分列出来。\n` +
                  `3. 接下来应该做什么**不同**的事？\n\n` +
                  `分析完就按新方案继续，不要再做同一个调用。`,
              });

              this.events.onStatus("自我修正", `分析 ${call.name} 的重复`);
              this.events.onNotice?.(
                `检测到连续 ${repeats} 次重复调用（${call.name}），` +
                  `已请求模型自行分析原因并调整方案。`,
              );
              // 跳出工具循环 → 下一轮由模型来响应这条指令
              break;
            }

            // 第二步：修正过仍然重复，说明它无法自愈，这时才中止。
            // 同样要补齐剩余调用的 tool 结果，保持 assistant.tool_calls 与 tool 消息配对。
            this.skipToolCalls(
              turn,
              toolCalls,
              index,
              () => "[系统] 本次调用已跳过：本轮因重复调用而中止。",
            );
            commitTurn();
            this.events.onStatus("已中止", "重复调用且自我修正无效");
            this.events.onNotice?.(
              `检测到再次连续 ${identicalToolCalls} 次完全相同的工具调用` +
                `（${call.name}）。此前已请求过自我修正，但它没有调整过来，` +
                `故中止本轮。\n` +
                `· 这通常意味着上下文被裁得太多、它看不到自己刚做过什么\n` +
                `· 可调大该模型的上下文窗口：xzh model context <id> <大小>\n` +
                `· 也可以把任务拆小，或直接说「不要重复调用 ${call.name}」`,
            );
            this.abortReason = "陷入重复调用（自我修正无效）";
            return;
          }

          // —— 并行批次 ——
          // 收集连续的「可并行」调用，**批内签名必须互不相同**：同一条消息里并列
          // 同一个调用两次没有意义，还可能与重复检测的计数语义打架，因此遇到重复
          // 就结束本批、交给后面的串行路径处理。
          if (this.isParallelTool(call.name)) {
            const batch: ToolCall[] = [call];
            let next = index + 1;
            while (
              next < toolCalls.length &&
              batch.length < this.parallelLimit() &&
              this.isParallelTool(toolCalls[next].name) &&
              !batch.some(
                (item) =>
                  item.name === toolCalls[next].name &&
                  item.arguments === toolCalls[next].arguments,
              )
            ) {
              batch.push(toolCalls[next]);
              next++;
            }

            if (batch.length > 1) {
              // 与串行等价的计数推进：批内每个签名都与前一个不同，逐个把计数重置为 1
              for (let k = 1; k < batch.length; k++) {
                lastToolSignature = `${batch[k].name}:${batch[k].arguments}`;
                identicalToolCalls = 1;
              }

              this.events.onStatus("并行执行", `${batch.length} 个子代理`);
              const results = await this.runToolBatch(batch, signal);

              // 结果按**原调用顺序**回灌：tool 消息与 tool_calls 必须一一对应
              for (let k = 0; k < batch.length; k++) {
                const item = batch[k];
                const outcome = results[k];
                if (item.name === "task") usedSubAgent = true;
                if (outcome.ok) {
                  const itemSignature = `${item.name}:${item.arguments}`;
                  completedSignatures.set(
                    itemSignature,
                    (completedSignatures.get(itemSignature) ?? 0) + 1,
                  );
                }
                turn.push({
                  role: "tool",
                  content: outcome.content,
                  toolCallId: item.id,
                  name: item.name,
                });
                this.lastRunToolCalls += 1;
                this.events.onToolEnd(item, outcome);
              }

              if (signal?.aborted) {
                rollbackTurn("被用户中断");
                this.events.onStatus("已中断");
                return;
              }
              index = next;
              continue;
            }
          }

          // —— 串行执行（其余工具，或可并行调用只剩一个） ——
          const result = await this.runTool(call, signal);
          if (result.ok) {
            completedSignatures.set(
              signature,
              (completedSignatures.get(signature) ?? 0) + 1,
            );
          }

          // 重复到第 2 次就提醒 —— 早于中止阈值（4），先给它一次自我纠正的机会。
          // 只提醒「成功过的」调用：失败重试（改参数、重跑命令）是正常行为，不该干预。
          let toolContent = result.content;
          if (identicalToolCalls >= 2 && result.ok) {
            const done = [...completedSignatures.entries()]
              .map(([sig, n]) => `${sig.split(":")[0]}×${n}`)
              .join("、");
            toolContent +=
              `\n\n[系统提醒] 这是连续第 ${identicalToolCalls} 次调用 \`${call.name}\`，` +
              `参数与返回结果都与上一次完全相同 —— **这一步已经完成了，不要重复**。\n` +
              `本轮已成功执行的调用：${done}\n` +
              `请直接进行下一个未完成的部分；若任务本身已完成，请直接给出总结。`;
            this.events.onStatus("提醒重复", `${call.name} ×${identicalToolCalls}`);
          }

          if (call.name === "task") usedSubAgent = true;
          toolContent += explorationReminder(call.name, result.content);

          turn.push({
            role: "tool",
            content: toolContent,
            toolCallId: call.id,
            name: call.name,
          });
          this.lastRunToolCalls += 1;

          // 工具产出的图片（如手机截图）→ 收集起来，等本轮的 tool 消息**全部**写完后
          // 再作为一条额外的 user 消息追加（见上面 imageNotes 的说明）。
          //
          // 为什么不塞进 tool 消息：各家的 tool/function 消息都**不接受图片**，
          // 只有 user 消息能带图。
          // 模型不支持视觉时，下面 streamAssistant 里已有的"去掉图片重试"兜底会生效。
          if (result.images && result.images.length > 0) {
            imageNotes.push({
              role: "user",
              content: `（上面 ${call.name} 的返回附带了 ${result.images.length} 张图片）`,
              images: result.images,
            });
          }
          this.events.onToolEnd(call, result);
          if (signal?.aborted) {
            rollbackTurn("被用户中断");
            this.events.onStatus("已中断");
            return;
          }
          index++;
        }

        // 本轮所有 tool 消息已写完，此时再插入带图消息（见 imageNotes 的说明）
        if (imageNotes.length > 0) turn.push(...imageNotes);
      }

      // 达到工具轮次上限（用户选择不再继续）：工具已经真实执行过（有副作用），
      // 本轮记录要保留下来。
      commitTurn();
      // 用 onNotice 而非 onStatus：后者只更新状态栏，用户很容易忽略，
      // 于是「程序突然停了」而不知道为什么。
      this.events.onStatus("已达工具调用上限", `共 ${roundLimit} 轮`);

      // 统计本轮工具调用，让轮次去向可见 ——
      // 「40 轮」与屏幕上能看到的工具行数不成正比：一轮可以包含多个调用，
      // 而且输出区只显示最近若干屏，用户无法据此核验，只能靠猜。
      const toolUsage = new Map<string, number>();
      for (const message of turn) {
        for (const call of message.toolCalls ?? []) {
          toolUsage.set(call.name, (toolUsage.get(call.name) ?? 0) + 1);
        }
      }
      const totalCalls = [...toolUsage.values()].reduce((a, b) => a + b, 0);
      const usageText = [...toolUsage.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name} ×${count}`)
        .join("、");

      this.events.onNotice?.(
        `已达工具调用上限（共 ${roundLimit} 轮）而中止本轮。\n` +
          (usageText
            ? `· 本轮共 ${totalCalls} 次工具调用：${usageText}\n`
            : "") +
          `· 若模型在反复做同一件事，通常早已被重复调用检测提前中止\n` +
          // 子代理的上限来自代码里的默认值而非用户配置，"去改 config"的指引对它无意义
          (this.maxToolRoundsOverride
            ? `· 该上限是子代理的默认值（${maxRounds} 轮）：需要更长调研时，请在主对话里把任务拆小\n`
            : `· 想调大上限：编辑 ${getConfigPath()} 里的 maxToolRounds（当前 ${this.config.maxToolRounds}）\n`) +
          `· 或把任务拆成更小的步骤，每步单独提一次`,
      );
      this.abortReason = "达到工具调用上限";
    } catch (err) {
      // 先快照现场：rollbackTurn 会把 turn 清空（回滚语义），错误报告仍需要这轮消息
      const recent = [...this.history, ...turn].map((message) => ({
        role: message.role,
        content: message.content ?? "",
      }));
      // 中断也可能以异常形式到达（provider 在 abort 时 reject）
      rollbackTurn(signal?.aborted ? "被用户中断" : "因出错中止");
      if (signal?.aborted) {
        this.events.onStatus("已中断");
        this.abortReason = "已被用户中断";
        return;
      }
      // 本轮彻底失败（错误已走完整个回退链）：落一份错误报告供事后排查。
      // 分类只做粗判 —— config / 服务端 是用户侧可自行解决的，其余归为「未知」，
      // 由 `xzh errors` 里人工看堆栈判断是不是玄猪自己的 bug。
      const report = recordErrorReport({
        kind: "turn-failed",
        category: isConfigError(err)
          ? "config"
          : isRetryableError(err)
            ? "provider"
            : "unknown",
        error: err,
        cwd: this.cwd,
        project: resolveProjectPaths(this.cwd).dir,
        model: this.activeModel?.id,
        provider: this.activeModel?.provider,
        note: "本轮对话失败（已尝试过全部回退模型）",
        recent,
      });
      if (report) {
        this.events.onNotice?.(`已记录错误报告：${report}（运行 xzh errors 查看）`);
      }
      throw err;
    }
  }

  /**
   * 独立的意图分析请求。
   *
   * 用配置中的模板包裹用户消息（默认模板末尾即「消息：<内容>」），向模型请求一次，
   * 返回的正文作为后续主流程的输入。要点：
   * - 不携带工具声明（只是改写输入，不需要工具，也省 token）；
   * - 不写入对话历史，保持主流程上下文干净；
   * - 失败或返回为空时返回 null，调用方回退到原始输入；
   * - **不计入模型降权**：它是辅助请求，避免与主请求重复降权。
   */
  private async analyzeIntent(
    userInput: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const template =
      this.config.intent?.prompt?.trim() || DEFAULT_INTENT_PROMPT;
    const prompt = buildIntentPrompt(template, userInput);
    let text = "";

    try {
      const stream = this.provider.chat({
        messages: [{ role: "user", content: prompt }],
        // 空的工具声明：各 Provider 会据此跳过 tools 字段
        tools: [],
        temperature: this.config.temperature,
        signal,
      });
      for await (const chunk of stream) {
        if (chunk.type === "text") {
          text += chunk.text;
          // 与主回复同样的失控保护：分析请求也不该把内存吃光
          if (text.length > MAX_RESPONSE_CHARS) break;
        }
      }
    } catch (err) {
      if (signal?.aborted) return null;
      this.events.onNotice?.(
        `意图分析请求失败（${friendlyError(err).split("\n")[0]}），已按原始输入继续。`,
      );
      return null;
    }

    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private async streamAssistant(
    signal?: AbortSignal,
    tried: Set<string> = new Set(),
    extra: ChatMessage[] = [],
    budgetRatio = 1,
    dropImages = false,
  ): Promise<{ text: string; toolCalls: ToolCall[] }> {
    // 记录本次请求已经用过的模型，降级时不再重复尝试同一个
    if (this.activeModel) tried.add(this.activeModel.id);

    // extra 是「本轮尚未提交的消息」（见 run）：必须一并发给模型，
    // 否则多轮工具调用时模型看不到自己上一轮的 tool_calls 与工具结果。
    let conversation = this.buildConversation(extra, budgetRatio);
    // 上一次因「模型不支持图片」失败 → 这次整条链路都不带图片
    if (dropImages) conversation = stripAllImages(conversation);
    // 历史中间的 system 消息（如「[上一轮已中止]」）必须提前：llama.cpp 等严格模板
    // 只允许 system 出现在最前面，否则整轮 500（见 hoistSystemNotes 的说明）。
    const hoisted = hoistSystemNotes(conversation);
    conversation = hoisted.conversation;
    // 只读状态块：每轮按当前事实重新生成，**不写入历史**（与 contextTrimmedNote 同一套做法）。
    // 直接并入系统提示词而不是另起一条 system 消息：各家最终都会把它并进系统提示词，
    // 单独一条还会改变「对话首条 system 是裁剪提醒」的既有结构（历史裁剪提醒依赖该位置）。
    const stateBlock = this.buildSelfStateBlock();
    const system = this.effectiveSystemParts();
    const systemParts = [system.static];
    if (system.dynamic) systemParts.push(system.dynamic);
    if (hoisted.notes.length > 0) systemParts.push(...hoisted.notes);
    if (stateBlock) systemParts.push(stateBlock);
    const messages: ChatMessage[] = [
      { role: "system", content: systemParts.join("\n\n") },
      ...conversation,
    ];

    // 本次请求的**输入侧估算**：用于和 provider 返回的真实 usage 比对，
    // 回填校正估算误差（见 calibration.ts 的闭环说明）。
    const estimatedInput = messages.reduce(
      (sum, message) => sum + estimateMessageTokens(message),
      0,
    );

    let text = "";
    const toolCalls: ToolCall[] = [];
    // 是否已经产出过内容：已产出时不再换模型重试，避免重复输出
    let produced = false;

    // 本次请求里是否存在图片：用于「模型不支持图片」时决定要不要去掉图片重试。
    // 必须看**整条会话**而不只是本轮的 extra —— 上一轮发过的截图（已提交进 history）
    // 同样会被发出去；只看 extra 会让这条兜底在「本轮是纯文本」时完全不生效，
    // 于是每个模型都拿同一张旧图再撞一次。
    const hasImages = [...this.history, ...extra].some(
      (message) => (message.images?.length ?? 0) > 0,
    );

    try {
      const stream = this.provider.chat({
        messages,
        tools: getToolSpecs(this.requestTools()),
        temperature: this.config.temperature,
        maxTokens: this.requestMaxTokens(),
        systemCachePrefix: system.static,
        signal,
        onRetry: (retryAttempt, maxAttempts, error, info) => {
          // 区分「还没输出就失败」与「输出到一半断连后续传」——
          // 后者调用方已经看到了部分内容，提示必须说明是接着传而不是重来
          this.events.onStatus(
            info.resumed
              ? `响应中断，正在续传 (${retryAttempt}/${maxAttempts})`
              : `网络中断，正在重试 (${retryAttempt}/${maxAttempts})`,
            friendlyError(error).split("\n")[0],
          );
        },
      });

      for await (const chunk of stream) {
        if (signal?.aborted) break;
        produced = true;
        switch (chunk.type) {
          case "text":
            text += chunk.text;
            this.events.onText(chunk.text);
            if (text.length > MAX_RESPONSE_CHARS) {
              // 停止消费流（for-await 会自动关闭生成器），避免内存被无限增长吃光
              this.events.onNotice?.(
                `模型输出超过 ${MAX_RESPONSE_CHARS} 字符，已强制中断 —— ` +
                  `这通常意味着模型陷入了重复输出，建议检查上下文或换个提示。`,
              );
              return { text, toolCalls };
            }
            break;
          case "reasoning":
            this.events.onReasoning?.(chunk.text);
            break;
          case "tool_call":
            toolCalls.push(chunk.toolCall);
            break;
          case "done":
            if (chunk.usage) this.events.onUsage?.(chunk.usage);
            // 真实 usage 回填：把「本次估算 vs 服务端实际计入」的偏差记进校正器，
            // 下一次组装请求时据此收紧预算（只收紧、不放宽）。
            if (chunk.usage?.inputTokens) {
              this.tokenCalibrator().observe(estimatedInput, chunk.usage.inputTokens);
            }
            // 上下文占用：有真实 usage 用真实值，否则用本次估算；
            // 超过一半时状态块才会展示（见 core/state.ts）。
            {
              const window = this.activeModel?.contextWindow;
              if (window && window > 0) {
                const used = chunk.usage?.inputTokens ?? estimatedInput;
                this.contextUsage = Math.min(1, used / window);
              }
            }
            break;
        }
      }

      return { text, toolCalls };
    } catch (err) {
      // 用户主动中断不算模型失败，不触发回退
      if (signal?.aborted) throw err;

      // 上下文超限 → 收敛预算后重试一次。
      //
      // 必须放在 handleModelFailure **之前**：超限不是模型故障，切换模型是有害的 ——
      // 新模型会拿到同样长的消息，必然同样失败，结果只是把整条回退链白白走一遍
      // 并让用户长时间等待。
      //
      // 要求 !produced：已产出内容时不能重试，否则用户会看到重复输出。
      // （实践中超限通常在请求阶段就返回 400，不会走到产出。）
      if (
        !produced &&
        !signal?.aborted &&
        budgetRatio >= 1 &&
        isContextLengthError(err)
      ) {
        this.events.onStatus("上下文超限", "已收敛历史，正在重试");
        // 保留 dropImages：若上一次已经因为「模型不支持图片」去掉过图片，
        // 这里再把它塞回去只会重复撞同一个错误
        return this.streamAssistant(
          signal,
          tried,
          extra,
          CONTEXT_RETRY_BUDGET_RATIO,
          dropImages,
        );
      }

      // 模型不支持图片输入 → **去掉图片重试一次**，而不是让整轮失败。
      //
      // 这条兜底是「自定义端点默认按支持视觉放行」的前提：自定义端点的模型名由用户
      // 自填，推断无从下手，只能先发出去；真被拒时在这里自动降级，用户的正文不受影响。
      //
      // 同样必须放在 handleModelFailure 之前：这不是模型故障，切换模型没有意义
      // （换个模型拿同样的图片再发一次可能同样失败，还白走一遍回退链）。
      if (
        !produced &&
        !signal?.aborted &&
        !dropImages &&
        hasImages &&
        isVisionUnsupportedError(err)
      ) {
        this.events.onStatus("模型不支持图片", "已去掉图片重试");
        this.events.onNotice?.(
          `当前模型不支持图片输入（${friendlyError(err).split("\n")[0]}），已去掉图片重试一次。\n` +
            `· 想彻底避免这次白试：xzh model vision <id> off\n` +
            `· 或改用 glm-4v / qwen-vl / gpt-4o / claude / gemini 等支持视觉的模型`,
        );
        return this.streamAssistant(
          signal,
          tried,
          extra,
          budgetRatio,
          true,
        );
      }

      // 换一个模型重试：`tried` 会逐次增长，`nextModelAfter` 在全部试过后返回 null，
      // 因此这里不需要额外的次数上限 —— 终止条件就是「所有模型都试过了」。
      const switched = this.handleModelFailure(err, tried, !produced);
      if (switched) {
        return this.streamAssistant(signal, tried, extra, budgetRatio);
      }
      throw err;
    }
  }

  /**
   * 模型调用失败的处理：沿列表回退到**下一个尚未试过的**模型。
   *
   * - 还有没试过的模型 → 切换并返回 true，调用方带着新的 provider 重试
   * - 所有模型都试过（或不允许切换）→ 返回 false，调用方把错误抛给用户
   *
   * 与旧实现的区别：不再有「权重 -1，全部归零后集体重置」那一套。失败的模型只是
   * **本次请求内不再尝试**（记进 `tried`），既不写回配置、也不会被剔出列表 ——
   * 用户配置的列表顺序始终是权威。
   */
  private handleModelFailure(
    error: unknown,
    tried: Set<string>,
    allowSwitch = true,
  ): boolean {
    const current = this.activeModel;
    if (!current) return false;

    // 当前这个也记进去：同一次请求内不重复尝试同一个模型
    tried.add(current.id);
    const reason = friendlyError(error).split("\n")[0];

    // **provider 级**配置错误（密钥无效 / 无权限）不切换：配置不改就永远失败，
    // 沿着列表回退只会把每个模型都白试一遍，还把「当前使用的模型」换成另一个同样
    // 不可用的，反而掩盖真正的原因。
    //
    // 但 404（模型名在该端点不存在）是**模型级**问题：列表里的下一个模型很可能可用，
    // 必须照常回退 —— 否则「列表里一个模型名写错」就会中止整条回退链。
    if (isConfigError(error) && !isModelUnavailableError(error)) {
      this.events.onNotice?.(
        `⚠ 模型 ${current.id} 的配置可能有误（${reason}）。` +
          `已跳过模型回退 —— 请检查 provider、API Key 与 baseUrl。`,
      );
      return false;
    }

    // 已产出内容时不再切换：换模型重发必然造成重复输出（调用方会把错误抛给用户）
    if (!allowSwitch) return false;

    const next = nextModelAfter(this.config, current.id, tried);
    if (!next) {
      this.events.onNotice?.(
        `⚠ ${current.id} 调用失败（${reason}），且已配置的模型都试过了 —— 本轮无法完成。`,
      );
      return false;
    }

    try {
      this.provider = createProvider(this.config, next);
      this.activeModel = next;
      // 记住这次用的是哪个模型：下次启动直接用它，不必再从表头试一遍
      rememberModel(this.config, next);
      this.persistConfig();
      this.events.onNotice?.(
        `↻ ${current.id} 调用失败（${reason}），已切换到 ${next.id} 重试。`,
      );
      this.events.onModelChange?.({
        provider: next.provider,
        model: next.model,
        reason: "调用失败回退",
      });
      return true;
    } catch (err) {
      this.events.onNotice?.(`切换模型失败：${friendlyError(err)}`);
      return false;
    }
  }

  /** 把「当前使用的模型」写回配置文件；写盘失败不影响当前会话 */
  private persistConfig(): void {
    try {
      saveConfig(this.config);
    } catch {
      // 忽略：内存中的选择仍然生效
    }
  }

  /**
   * 判断只读工具的调用是否触及**凭据类文件**。
   * 命中时 runTool 会强制要求用户确认（即使在自动批准模式下）。
   *
   * 这里刻意**不**按「是否在工作区内」判定：那样会把「看一眼自己 home 下的
   * `~/.gitconfig`」或「读 /etc 下的配置」也算作危险操作，对刚上手的人是纯骚扰，
   * 而它们并无实际风险 —— 既然用户选择了自动批准，就不该被这类无关确认打断。
   *
   * 真正值得拦一次的只有凭据文件：它们一旦被读进上下文，就会随请求发送给
   * 模型服务商（`~/.xzh/config.json` 里就存着明文 apiKey）。这类读取极少发生，
   * 因此不会影响正常体验。
   */
  private touchesSensitivePath(toolName: string, rawArgs: string): boolean {
    if (!READ_TOOLS.has(toolName)) return false;

    let target = "";
    try {
      const args = JSON.parse(rawArgs) as Record<string, unknown>;
      if (typeof args.path === "string") target = args.path;
    } catch {
      // 参数不是合法 JSON 时交给 executeTool 报错，这里不额外拦截
      return false;
    }
    if (!target) return false;

    // 解析成绝对路径后再匹配，以便正确处理 ~ 与 ../ 这类写法
    return SENSITIVE_PATH_PATTERN.test(
      path.resolve(this.cwd, expandHome(target)),
    );
  }

  private async runTool(
    call: ToolCall,
    signal?: AbortSignal,
  ): Promise<ExecuteToolResult> {
    const tool = findTool(call.name, this.tools);
    if (!tool) {
      return { ok: false, content: `错误：未知工具 "${call.name}"` };
    }

    // 确认策略：
    //  1. autoApprove（**默认开启**）下所有工具直接执行 —— 包括执行命令、写文件、
    //     读取工作区外的文件。用户选择「全自动」意味着接受相应风险，
    //     不应再用逐项确认打断他（danger 字段仍用于确认框的醒目标记）。
    //  2. 读取**凭据类文件**（~/.ssh、.env、~/.xzh/config.json 等）默认也不拦。
    //     想恢复这道防线时把 `confirmSensitiveRead` 设为 true —— 它防的是
    //     「凭据被读进上下文、转手发给模型服务商」，与「是否信任模型执行命令」
    //     是两个问题，但默认关闭以免破坏「自动放行」的预期。
    //  3. 未开启自动批准时，声明了 requiresConfirmation 的工具逐项确认。
    const needsConfirm =
      (this.config.confirmSensitiveRead === true &&
        this.touchesSensitivePath(tool.name, call.arguments)) ||
      (Boolean(tool.requiresConfirmation) && !this.config.autoApprove);

    if (needsConfirm) {
      let argsPreview = call.arguments;
      try {
        argsPreview = JSON.stringify(JSON.parse(call.arguments), null, 2);
      } catch {
        // 保留原始字符串
      }
      const approved = await this.events.confirm({
        tool: call.name,
        title: `执行工具：${call.name}`,
        detail: argsPreview,
        danger: Boolean(tool.danger),
      });
      if (!approved) {
        return { ok: false, denied: true, content: "用户拒绝了此操作。" };
      }
    }

    if (signal?.aborted) {
      return { ok: false, content: "操作已被中断。" };
    }

    this.events.onToolStart(call);

    const ctx: ToolContext = {
      cwd: this.cwd,
      autoApprove: this.config.autoApprove,
      emit: (message) => this.events.onNotice?.(message),
      confirm: (request) => this.events.confirm(request),
      signal,
      todos: this.todoStore(),
      goal: this.goalStore(),
      status: this.statusStore(),
      memoryMaxChars: this.config.memoryMaxChars,
      globalMemoryMaxChars: this.config.globalMemoryMaxChars,
      limits: {
        maxReadLines: this.contextProfile() === "small" ? 300 : undefined,
        maxOutputChars: this.contextProfile() === "small" ? 6000 : undefined,
        artifactDir: path.join(this.cwd, ".xuanzhu", "artifacts"),
      },
      spawnAgent: (input) => this.spawnSubAgent(input, signal),
      deviceBridge: this.deviceBridge,
    };

    const outcome = await executeTool(call.name, call.arguments, ctx, this.tools);
    this.recordToolResult(call.name, call.arguments, outcome);
    return outcome;
  }

  /**
   * 记录一次**真实执行**的工具调用：只读状态块与验证门的数据源。
   *
   * 只从 `runTool` 的成功路径调用（用户拒绝 / 中断的早退不会走到这里），
   * 因此状态块里的「最近动作」都是确实发生过的。
   */
  private recordToolResult(
    name: string,
    argsJson: string,
    outcome: ExecuteToolResult,
  ): void {
    this.recentActions.push({ name, ok: outcome.ok });
    // 只留最近几条：状态块要短，旧动作对当前判断没有价值
    if (this.recentActions.length > 8) this.recentActions.shift();
    this.runActionSeq += 1;
    this.runToolCounts.set(name, (this.runToolCounts.get(name) ?? 0) + 1);
    if (name === "memory_write" && outcome.ok) this.runWroteMemory = true;

    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(argsJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // 参数不是合法 JSON 时只记动作名，不影响主流程
    }

    if (name === "write_file" || name === "edit_file") {
      const file = typeof args.path === "string" ? args.path.trim() : "";
      if (file) {
        this.sessionChangedFiles.add(file);
        this.runChangedFiles.add(file);
        this.runLastChangeSeq = this.runActionSeq;
      }
    }

    if (name === "bash") {
      const command = typeof args.command === "string" ? args.command : "";
      // 跑过验证即算（失败也算）：失败结果模型已经看到，重复提醒没有意义
      if (command && isVerificationCommand(command)) {
        this.runLastVerifySeq = this.runActionSeq;
        this.runVerifyCommand = command;
        this.runVerifyOk = outcome.ok;
      }
    }

    if (name === "todo_write" && outcome.ok) {
      this.runTouchedTodos = true;
    }

    // 任务账本：改动文件 / 验证状态是确定性事实，逐次落盘
    if (this.task) {
      if (
        (name === "write_file" || name === "edit_file") &&
        typeof args.path === "string" &&
        args.path.trim() &&
        !this.task.changedFiles.includes(args.path.trim())
      ) {
        this.task.changedFiles.push(args.path.trim());
        if (this.task.changedFiles.length > 50) {
          this.task.changedFiles.splice(0, this.task.changedFiles.length - 50);
        }
        touchTaskLedger(this.cwd, this.task);
      }
      if (this.runVerifyCommand) {
        this.task.verification = {
          command: redactSecrets(this.runVerifyCommand),
          ok: this.runVerifyOk,
          at: new Date().toISOString(),
        };
        touchTaskLedger(this.cwd, this.task);
      }
    }
  }

  /** 该工具是否可与其它可并行工具同时执行 */
  private isParallelTool(name: string): boolean {
    return findTool(name, this.tools)?.parallelSafe === true;
  }

  /** 并行执行的工具数量上限（配置值经夹取，防止误配置打爆服务商） */
  private parallelLimit(): number {
    const raw = Math.floor(
      this.config.maxParallelAgents ?? DEFAULT_PARALLEL_AGENTS,
    );
    if (!Number.isFinite(raw) || raw < 1) return 1;
    return Math.min(raw, MAX_PARALLEL_AGENTS_CAP);
  }

  /**
   * 并发执行一批工具调用，返回的结果**与输入顺序一一对应**。
   *
   * 单个调用抛错不影响整批 —— 转成失败结果，其余调用照常完成。
   */
  private async runToolBatch(
    calls: ToolCall[],
    signal?: AbortSignal,
  ): Promise<ExecuteToolResult[]> {
    return mapWithConcurrency(calls, this.parallelLimit(), async (call) => {
      try {
        return await this.runTool(call, signal);
      } catch (err) {
        return {
          ok: false,
          content: `工具执行异常：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    });
  }

  /**
   * 为 `calls[fromIndex..]` 中**未执行**的调用补上「已跳过」的 tool 结果。
   *
   * assistant 消息声明了 N 个 tool_call，就必须有 N 条 tool 消息与之对应，
   * 否则角色序列非法，下一次请求会被服务端直接拒绝（400）。
   */
  private skipToolCalls(
    turn: ChatMessage[],
    calls: ToolCall[],
    fromIndex: number,
    reason: (index: number) => string,
  ): void {
    for (let i = fromIndex; i < calls.length; i++) {
      turn.push({
        role: "tool",
        content: reason(i),
        toolCallId: calls[i].id,
        name: calls[i].name,
      });
    }
  }

  /**
   * 派生子代理执行子任务。
   *
   * 子代理是**新的 Agent 实例**：独立历史、独立工具循环，只有最终答复回到主对话。
   * 具体是哪个子代理、能用哪些工具、拿什么系统提示词，全部来自 `src/subagents`
   * 的注册表（`findSubAgent`）。关键设计：
   *   - 可用工具由子代理定义的 `toolNames` 白名单 + `toolsForSubAgent` 的禁用项决定，
   *     **恒不含 `task`** —— 否则可递归派生；
   *   - 子代理的正文不直接进主对话，而是汇总后作为 `task` 工具的返回值回灌，
   *     这样几十屏中间内容不会挤占主上下文（这正是子代理存在的意义）；
   *   - 子代理的工具活动以 `[子代理]` 前缀走 `onNotice` 展示，让用户能看到它在做什么；
   *   - 危险操作确认**转发给主代理**，不因「在子代理里」而绕过；
   *   - 轮次用尽时不询问用户（子代理无法交互），直接收尾并返回已有结论。
   */
  private async spawnSubAgent(
    input: SubAgentInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const definition = findSubAgent(input.subagentName);
    if (!definition) {
      return {
        ok: false,
        content: `错误：未知子代理 "${input.subagentName}"。可用：${subAgentNames().join("、")}`,
      };
    }

    let output = "";
    // 多个子代理并行时输出会交错，前缀里带上任务说明才能看出「哪一行是谁在说」
    const tag =
      input.description.length > 24
        ? `${input.description.slice(0, 24)}…`
        : input.description;
    const label = `[${definition.name}: ${tag}]`;

    const childEvents: AgentEvents = {
      onText: (delta) => {
        output += delta;
      },
      // 只回显工具名与参数预览（前 120 字符）—— 完整参数可能是一整段文件内容或
      // 上千字的 prompt，原样打进输出区会刷屏（这里只是给用户看「它在做什么」）。
      onToolStart: (call) => {
        const args =
          call.arguments.length > 120
            ? `${call.arguments.slice(0, 120)}…`
            : call.arguments;
        this.events.onNotice?.(`${label} ${call.name} ${args}`);
      },
      onToolEnd: () => undefined,
      onStatus: (status) => this.events.onStatus(`子代理：${status}`, tag),
      onNotice: (message) => this.events.onNotice?.(`${label} ${message}`),
      confirm: (request) => this.events.confirm(request),
      // 子代理不接受交互式追问：到上限即收尾，返回已有结论
      onRoundLimit: async () => false,
    };

    this.events.onStatus(`子代理执行中（${definition.name}）`, tag);

    const child = new Agent(this.provider, this.config, this.cwd, childEvents, this.activeModel, {
      tools: toolsForSubAgent(definition.toolNames),
      systemPrompt:
        definition.systemPrompt({
          cwd: this.cwd,
          description: input.description,
          prompt: input.prompt,
        }) +
        `\n\n## 输出约束\n${SUBAGENT_OUTPUT_RULE}`,
      maxToolRounds: SUBAGENT_MAX_TOOL_ROUNDS,
      // 子代理的工作由主代理汇总；自己写记忆 / 账本会污染项目，并在并行子代理之间重复
      autoMemory: false,
      taskLedger: false,
    });

    try {
      await child.run(input.prompt, signal);
    } catch (err) {
      // 带上中止原因（如「已被用户中断」），让主代理与用户能区分
      // 「模型调用失败」与「正常中断/达到上限」这两种完全不同的情形
      const reason = child.abortReason ? `（${child.abortReason}）` : "";
      throw new Error(
        `${reason}${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 子代理被中止（重复调用 / 轮数上限 / 用户中断）时，它吐出的文本是**烂尾**的：
    // 不加说明的话，主代理会把不完整的结论当成正常结论继续往下干活。
    const abortedNotice = child.abortReason
      ? `⚠ 子代理${child.abortReason}，以下内容可能不完整 —— ` +
        `必要时用更聚焦的 prompt 重试，或由你自己完成。\n\n`
      : "";

    const limit =
      this.contextProfile() === "small"
        ? 4000
        : (definition.maxReportChars ?? 12_000);
    const normalized = normalizeSubagentReport(output, limit);
    const report = normalized.text;
    if (!report) {
      return {
        ok: false,
        content:
          `${definition.name} 子代理未返回任何结论` +
          `${child.abortReason ? `（${child.abortReason}）` : "（可能被中断或在给出答复前用尽了轮次）"}。` +
          "可改用更聚焦的 prompt 重试，或直接自己完成。",
        summary: `子代理未返回结论：${input.description}`,
      };
    }
    return {
      ok: true,
      content: `${abortedNotice}${definition.name} 子代理「${input.description}」的结论：\n\n${report}`,
      summary:
        `${child.abortReason ? `子代理中止（${child.abortReason}）` : `子代理完成`}：${input.description}` +
        (normalized.truncated ? "（报告已按上下文预算截断）" : ""),
    };
  }

  /**
   * 当前模型对应的 token 估算校正器。
   *
   * 按模型 id 取、**进程内共享** —— 主代理与并行子代理用的是同一个实例，
   * 观测样本能互相累积（子代理的请求同样会回填真实 usage）。
   */
  private tokenCalibrator(): TokenCalibrator {
    const key = this.activeModel?.id ?? this.provider.model;
    return calibratorFor(key);
  }

  /**
   * 会话部分（不含 system prompt）可用的 token 预算。
   *
   * 随当前模型变化：切换模型后窗口不同，预算需重新计算。
   * 再叠加**真实 usage 回填**得到的收紧系数 —— 估算系统性偏低时提前裁剪，
   * 而不是等到撞上 400 再靠 `CONTEXT_RETRY_BUDGET_RATIO` 收敛重试。
   */
  private conversationBudget(): number {
    const raw = resolveConversationBudget(
      this.activeModel?.contextWindow,
      this.activeModel?.model ?? "",
      this.effectiveSystemPrompt(),
    );
    // 小窗口模型：system + tools + state + 输出预留必须先扣掉，否则
    // 「会话预算」看似 55% 窗口，加上工具 schema 后总量会超过窗口。
    const window =
      this.activeModel?.contextWindow ??
      inferContextWindow(this.activeModel?.model ?? "");
    if (this.contextProfile() === "small" && window > 0) {
      const fixed =
        estimateMessageTokens({
          role: "system",
          content: this.effectiveSystemPrompt(),
        }) +
        estimateTokens(JSON.stringify(getToolSpecs(this.requestTools()))) +
        (this.buildSelfStateBlock()
          ? estimateMessageTokens({
              role: "system",
              content: this.buildSelfStateBlock() ?? "",
            })
          : 0) +
        (this.requestMaxTokens() ?? 0);
      const available = Math.max(1, window - fixed);
      return calibrateBudget(
        Math.min(raw, available),
        this.tokenCalibrator().factor(),
      );
    }
    return calibrateBudget(raw, this.tokenCalibrator().factor());
  }

  /**
   * 组装发给模型的会话消息（system + 已提交历史 + 本轮未提交的 turn）。
   *
   * 裁剪在这里做、且**只作用于本次请求的副本**：`this.history` 不被改动，
   * 因此不涉及「回滚」语义。若只裁 `this.history` 而放过 `turn`，
   * 单轮内多轮工具调用会让 `turn` 单调增长并突破模型上下文窗口，
   * 一旦 provider 返回 context length exceeded，整轮（含已成功执行的工具）都会被丢弃。
   */
  private buildConversation(
    extra: ChatMessage[],
    budgetRatio = 1,
  ): ChatMessage[] {
    // 先降级旧图片：图片以 base64 携带，成本随轮次线性叠加，历史里每轮都留原图
    // 会迅速撑爆上下文（而且旧截图对后续对话没有价值）。
    // `this.history.length` 是「本轮起点」：只有本轮携带的图才保留原图，
    // 历史里的图一律降级 —— 否则一张旧截图会被每轮重发。
    const all = stripStaleImages([...this.history, ...extra], this.history.length);
    // 先按条数粗筛作为安全网（防止 contextWindow 被配成极大值时历史无限累积），
    // 再由 token 预算决定实际保留多少
    const capped =
      all.length > MAX_HISTORY_MESSAGES ? all.slice(-MAX_HISTORY_MESSAGES) : all;
    // budgetRatio < 1 用于「上下文超限后收敛重试」
    const budget = Math.max(1, Math.floor(this.conversationBudget() * budgetRatio));
    const trimmed = trimMessagesToBudget(capped, budget);
    // 本次请求自己丢了消息（条数上限或 token 预算）→ 记下来
    if (trimmed.length < capped.length) this.historyTrimmed = true;
    // 历史被裁过就附上说明 + 任务账本摘要：模型看到的不是完整历史，
    // 但「做到哪了 / 还差什么」由代码维护，不依赖它从残片里猜。
    this.ensureTaskLoaded();
    const digest = this.task ? formatTaskDigest(this.task) : null;
    return this.historyTrimmed
      ? [contextTrimmedNote(digest), ...trimmed]
      : trimmed;
  }

  /**
   * 控制历史长度，避免上下文无限增长。
   *
   * 按 token 预算裁（而非消息条数）：一条 30000 字符的 `bash` 输出与一条「好的」
   * 在旧实现里占同样的名额，于是「60 条以内」也可能轻松越过窗口上限。
   *
   * 另加一道 `MAX_HISTORY_MESSAGES` 条数上限：token 预算在「窗口被配成极大值」时形同虚设
   * （预算跟着涨），历史会一路堆到几十万 token 对应的条数，而每轮组装请求都要全量复制它。
   * 条数裁剪可能把起点切在 tool / assistant 上，故用 `keepFromUserBoundary` 拉回 user 边界。
   *
   * 返回被裁掉的条数（仅用于日志/调试，回滚不应依赖它，见 run 的说明）。
   */
  private trimHistory(): number {
    let kept = trimMessagesToBudget(this.history, this.conversationBudget());
    if (kept.length > MAX_HISTORY_MESSAGES) {
      kept = keepFromValidStart(kept.slice(kept.length - MAX_HISTORY_MESSAGES));
    }
    if (kept.length === this.history.length) return 0;
    const removed = this.history.length - kept.length;
    this.history = kept;
    // 裁剪是永久性的：记下来，之后每次请求都要提醒模型"这不是完整历史"
    this.historyTrimmed = true;
    return removed;
  }
}
