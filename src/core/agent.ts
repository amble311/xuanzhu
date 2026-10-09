import {
  buildIntentPrompt,
  decayModelWeight,
  DEFAULT_INTENT_PROMPT,
  DEFAULT_MODEL_WEIGHT,
  pickModel,
  saveConfig,
  type ModelEntry,
  type XuanZhuConfig,
} from "../config/store";
import {
  createProvider,
  IMAGE_FALLBACK_TEXT,
  isConfigError,
  isContextLengthError,
  isSystemPromptTight,
  isVisionUnsupportedError,
  resolveConversationBudget,
  stripAllImages,
  stripStaleImages,
  trimMessagesToBudget,
} from "../llm";
import { friendlyError } from "../llm/http";
import type {
  ChatMessage,
  ImageAttachment,
  LLMProvider,
  ToolCall,
} from "../llm/types";
import {
  executeTool,
  findTool,
  getToolSpecs,
  toolsForSubAgent,
  type ExecuteToolResult,
} from "../tools";
import type {
  ConfirmRequest,
  SubAgentInput,
  TodoItem,
  TodoStore,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "../tools/types";
import { findSubAgent, subAgentNames } from "../subagents";
import { mapWithConcurrency } from "../utils/concurrency";
import { expandHome, getConfigPath } from "../utils/paths";
import {
  compactLongTermMemoryIfNeeded,
  DEFAULT_MEMORY_MAX_CHARS,
  loadProjectRules,
  readProjectMemory,
} from "../workspace";
import { buildSystemPrompt } from "./prompt";
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
  /** 当前使用的模型发生变化（失败降级 / 权重耗尽重置） */
  onModelChange?: (info: {
    provider: string;
    model: string;
    weight: number;
    reason: string;
  }) => void;
  /** 任务列表更新（来自 todo_write） */
  onTodos?: (items: TodoItem[]) => void;
  /** 请求用户确认危险操作 */
  confirm: (request: ConfirmRequest) => Promise<boolean>;
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
/** 单次请求内因模型调用失败而切换模型的最大次数 */
const MAX_MODEL_SWITCHES = 3;

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
const MAX_SUBAGENT_REPORT_CHARS = 20_000;

/**
 * 子代理并发数的**硬上限**。
 *
 * `config.maxParallelAgents` 可以调，但再大也不会超过这里 —— 每个并行子代理
 * 各自持有一条对话流，配置写成 100 只会把服务商打爆并触发 429，反而更慢。
 */
const MAX_PARALLEL_AGENTS_CAP = 16;

/** `config.maxParallelAgents` 未设置时的默认并发数 */
const DEFAULT_PARALLEL_AGENTS = 4;

export class Agent {
  private provider: LLMProvider;
  private readonly config: XuanZhuConfig;
  private cwd: string;
  private readonly events: AgentEvents;
  private systemPrompt: string;
  /** 是否已就「系统提示词撑满窗口」提示过（避免每条消息都刷一遍） */
  private warnedTightContext = false;
  private history: ChatMessage[] = [];
  /** 当前使用的模型条目（多模型权重机制） */
  private activeModel: ModelEntry | null;
  /** 可用的工具集合；未指定时使用全部内置工具（子代理会传入受限集合） */
  private readonly tools?: ToolDefinition[];
  /** 覆盖的系统提示词（子代理使用） */
  private readonly systemPromptOverride?: string;
  /** 当前会话的任务列表（todo_write 维护），随会话结束而丢弃 */
  private todos: TodoItem[] = [];
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
    this.activeModel = activeModel ?? pickModel(config);
    this.tools = options?.tools;
    this.systemPromptOverride = options?.systemPrompt;
    this.systemPrompt = this.composeSystemPrompt();
  }

  /** 当前使用的模型（含权重） */
  getActiveModel(): ModelEntry | null {
    return this.activeModel;
  }

  /** 组合系统提示词（含当前工作目录下的项目规则与项目记忆） */
  private composeSystemPrompt(): string {
    // 子代理使用调用方给定的角色提示词（不注入项目规则与记忆 —— 它只做一件子任务），
    // 因此也不参与记忆精简：记忆归属主代理。
    if (this.systemPromptOverride) return this.systemPromptOverride;
    // 读记忆之前先做一次自动精简，保证注入提示词的是精简后的版本
    this.autoCompactMemory();
    return buildSystemPrompt(
      this.cwd,
      this.config.systemPromptExtra,
      loadProjectRules(this.cwd),
      readProjectMemory(this.cwd),
      this.config.memoryMaxChars,
    );
  }

  /**
   * 长期记忆达到阈值即**自动精简**（去重 + 必要时裁剪最旧条目），不依赖模型主动调用。
   *
   * 触发点：会话构造、`/switch` 切换目录。之所以放在这两处而不是每轮：记忆文件只有几 KB，
   * 读一次成本极低，但每轮都读属于无谓开销；而「会话中把记忆写大」的路径已经由
   * `memory_write`（写入后自动精简）覆盖。
   *
   * `memoryMaxChars <= 0` 表示不限制长度，此时仍会去重（去重是无损的）。
   */
  private autoCompactMemory(): void {
    const limit = this.config.memoryMaxChars ?? DEFAULT_MEMORY_MAX_CHARS;
    const result = compactLongTermMemoryIfNeeded(this.cwd, limit);
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
      parts.push(`裁剪 ${result.removedOldest} 条最旧记录`);
    }
    this.pendingMemoryNotices.push(
      `长期记忆已自动精简（${parts.join("、")}，${result.before} → ${result.after} 字符）。` +
        `若需要更彻底的压缩，可让玄猪用 memory_compact 重写为精简版本。`,
    );
  }

  get messages(): ChatMessage[] {
    return this.history;
  }

  reset(): void {
    this.history = [];
    // 任务列表属于本轮会话，清空对话时一并清掉，避免界面上残留上一轮的计划
    if (this.todos.length > 0) {
      this.todos = [];
      this.events.onTodos?.([]);
    }
  }

  /** 当前任务列表（供界面或测试查询） */
  getTodos(): TodoItem[] {
    return this.todos;
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
  }

  /**
   * 执行一次用户请求（含多轮工具调用），直到模型给出最终答复。
   *
   * `images` 为用户随本轮消息附带的图片（多模态输入）；只在**本轮**携带，
   * 历史里的旧图片会在组装请求时降级为文本占位（见 `stripStaleImages`）。
   */
  async run(
    userInput: string,
    signal?: AbortSignal,
    images?: ImageAttachment[],
  ): Promise<void> {
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
        this.systemPrompt,
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
    if (this.config.intent?.enabled) {
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

    // maxToolRounds 为 0 / 负数时也要至少执行一次，否则用户只会看到「已达上限」而无任何回复
    const maxRounds = Math.max(1, Math.floor(this.config.maxToolRounds) || 1);

    /** 成功收尾：把本轮全部消息提交进历史 */
    const commitTurn = (): void => {
      for (const message of turn) this.history.push(message);
      this.trimHistory();
    };

    /**
     * 中断/出错收尾：只提交本轮「已完整配对」的部分。
     *
     * 工具一旦执行就产生了真实副作用（文件已改、命令已跑），若把它从历史里抹掉，
     * 模型完全不知情，下一次很可能重复执行同样的破坏性操作。因此这里保留已完成的记录，
     * 只丢弃末尾那个「声明了 tool_calls 但结果不全」的 assistant 以维持结构合法
     * （否则 assistant 的 tool_calls 数与 tool 消息数不匹配，下一次请求会 400）。
     */
    const commitPartialTurn = (): void => {
      const done: ChatMessage[] = [];
      for (let i = 0; i < turn.length; i++) {
        const message = turn[i];
        done.push(message);
        if (message.role !== "assistant" || !message.toolCalls?.length) continue;

        // 这条 assistant 声明了 N 个 tool_call，检查其后是否已收到全部 N 条 tool 结果。
        // 中断通常发生在工具循环中间，此时 turn 末尾是 tool 而不是 assistant，
        // 所以必须主动回溯比对，不能只看最后一条。
        const needed = message.toolCalls.length;
        let received = 0;
        for (let j = i + 1; j < turn.length && received < needed; j++) {
          if (turn[j].role === "tool") received++;
        }
        if (received < needed) {
          // 结果不全：丢掉这条 assistant，保留它之前已完成的部分
          done.pop();
          break;
        }
      }

      // 只剩一条 user 说明本轮什么都没做成，整体不提交，避免留下孤立 user
      if (done.length > 1) {
        for (const message of done) this.history.push(message);
        this.trimHistory();
      }
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

    try {
      for (let round = 0; ; round++) {
        if (round >= roundLimit) {
          if (signal?.aborted) {
            commitPartialTurn();
            this.events.onStatus("已中断");
            return;
          }
          // 没有提供询问回调时（非交互场景）行为与以前一致：直接收尾
          const canContinue = this.events.onRoundLimit
            ? await this.events.onRoundLimit(round)
            : false;
          if (!canContinue) break;
          roundLimit += maxRounds;
        }

        if (signal?.aborted) {
          commitPartialTurn();
          this.events.onStatus("已中断");
          return;
        }

        // 每轮裁剪「已提交」的历史；本轮未提交的 turn 由 buildConversation 在组装
        // 请求时一并裁剪，避免单轮内上下文突破模型窗口。
        this.trimHistory();

        this.events.onStatus("思考中", `第 ${round + 1} 轮`);

        const { text, toolCalls } = await this.streamAssistant(
          signal,
          0,
          new Set(),
          turn,
        );

        // streamAssistant 在中断时可能「正常返回」部分内容：
        // 此时不能把半截 assistant 提交，也不该继续执行工具
        if (signal?.aborted) {
          commitPartialTurn();
          this.events.onStatus("已中断");
          return;
        }

        turn.push({
          role: "assistant",
          content: text,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        });

        if (toolCalls.length === 0) {
          commitTurn();
          this.events.onStatus("就绪");
          return;
        }

        // 工具执行：**连续的可并行调用**（目前只有 `task`）会并发执行，其余按顺序串行。
        // 分批的依据是「是否有副作用、是否共享可变状态」：多个子代理各自是独立的
        // Agent 实例，并行能立刻缩短多路调研的等待；而写文件 / 执行命令可能互相依赖，
        // 一旦并行就会乱序甚至冲突，必须保持顺序。
        let index = 0;
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
                this.events.onToolEnd(item, outcome);
              }

              if (signal?.aborted) {
                commitPartialTurn();
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
          this.events.onToolEnd(call, result);
          if (signal?.aborted) {
            commitPartialTurn();
            this.events.onStatus("已中断");
            return;
          }
          index++;
        }
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
          `· 想调大上限：编辑 ${getConfigPath()} 里的 maxToolRounds（当前 ${this.config.maxToolRounds}）\n` +
          `· 或把任务拆成更小的步骤，每步单独提一次`,
      );
    } catch (err) {
      // 中断也可能以异常形式到达（provider 在 abort 时 reject）
      commitPartialTurn();
      if (signal?.aborted) {
        this.events.onStatus("已中断");
        return;
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
    attempt = 0,
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
    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      ...conversation,
    ];

    let text = "";
    const toolCalls: ToolCall[] = [];
    // 是否已经产出过内容：已产出时不再换模型重试，避免重复输出
    let produced = false;

    try {
      const stream = this.provider.chat({
        messages,
        tools: getToolSpecs(this.tools),
        temperature: this.config.temperature,
        signal,
        onRetry: (retryAttempt, maxAttempts, error) => {
          this.events.onStatus(
            `网络中断，正在重试 (${retryAttempt}/${maxAttempts})`,
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
            break;
        }
      }

      return { text, toolCalls };
    } catch (err) {
      // 用户主动中断不算模型失败，不降权
      if (signal?.aborted) throw err;

      // 已经产出内容时本轮必然失败：仍然按规则降权并写盘，但不再切换模型
      // （切换只会让「当前模型」与实际出错的模型不一致，且重试会造成重复输出）。
      // 上下文超限 → 收敛预算后重试一次。
      //
      // 必须放在 handleModelFailure **之前**：超限不是模型故障，降权毫无意义，
      // 而切换模型更是有害 —— 新模型会拿到同样长的消息，必然同样失败，
      // 结果只是把可用模型的权重一个个耗光（这正是旧实现的行为）。
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
        return this.streamAssistant(
          signal,
          attempt,
          tried,
          extra,
          CONTEXT_RETRY_BUDGET_RATIO,
        );
      }

      // 模型不支持图片输入 → **去掉图片重试一次**，而不是让整轮失败。
      //
      // 这条兜底是「自定义端点默认按支持视觉放行」的前提：自定义端点的模型名由用户
      // 自填，推断无从下手，只能先发出去；真被拒时在这里自动降级，用户的正文不受影响。
      //
      // 同样必须放在 handleModelFailure 之前：这不是模型故障，降权与切换模型都没有意义
      // （换个模型拿同样的图片再发一次可能同样失败，白扣权重）。
      if (
        !produced &&
        !signal?.aborted &&
        !dropImages &&
        extra.some((message) => (message.images?.length ?? 0) > 0) &&
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
          attempt,
          tried,
          extra,
          budgetRatio,
          true,
        );
      }

      const switched = this.handleModelFailure(err, tried, !produced);
      if (switched && attempt < MAX_MODEL_SWITCHES) {
        return this.streamAssistant(signal, attempt + 1, tried, extra, budgetRatio);
      }
      throw err;
    }
  }

  /**
   * 模型调用失败的处理：当前模型权重 -1，并选出权重最高的可用模型。
   *
   * - 仍有可用模型（且与当前不同）→ 切换并返回 true，调用方会重试
   * - 全部模型权重耗尽 → 重置全部权重为默认值，返回 true
   * - 无模型条目（理论上不会发生）或切换失败 → 返回 false
   */
  private handleModelFailure(
    error: unknown,
    tried: Set<string>,
    allowSwitch = true,
  ): boolean {
    const current = this.activeModel;
    if (!current) return false;

    const reason = friendlyError(error).split("\n")[0];

    // 配置类错误（密钥无效 / 模型名不存在 / 端点地址错误）**不衰减、不写盘**。
    // 配置不改就永远失败，扣权重只会把其他可用模型一起拖到不可用；
    // 用户真正需要做的是去修配置，而不是让玄猪悄悄换一个模型继续撞同一面墙。
    if (isConfigError(error)) {
      this.events.onNotice?.(
        `⚠ 模型 ${current.id} 的配置可能有误（${reason}）。` +
          `已跳过权重衰减 —— 请检查 provider、API Key 与 baseUrl。`,
      );
      return false;
    }

    const result = decayModelWeight(this.config, current.id);
    if (!result) return false;

    this.persistConfig();

    if (result.reset) {
      this.events.onNotice?.(
        `⚠ 模型 ${current.id} 调用失败（${reason}）；所有模型权重均已耗尽，` +
          `已把全部权重重置为 ${DEFAULT_MODEL_WEIGHT}。`,
      );
      this.events.onStatus("权重已重置");
    } else {
      this.events.onNotice?.(
        `⚠ 模型 ${current.id} 调用失败（${reason}），权重降为 ${result.weight}。`,
      );
    }

    // 即使不再切换模型，也要把新权重同步给界面：
    // 否则状态栏与随后打印的错误信息会长期显示旧权重，误导诊断。
    this.events.onModelChange?.({
      provider: current.provider,
      model: current.model,
      weight: result.reset ? DEFAULT_MODEL_WEIGHT : result.weight,
      reason: "调用失败降权",
    });

    // 不允许切换时到此为止（已产出内容，本轮必定失败）
    if (!allowSwitch) return false;

    // 跳过本次请求已经用过的模型：若没有「另一个」模型可用，就不再重试。
    // 单模型（或权重耗尽重置后仍是它自己）时用完全相同的参数重试必然再次失败，
    // 例如认证失败、模型名不存在、baseUrl 错误等配置类问题——
    // 重试只会白白消耗权重并让用户长时间等待。
    const next = pickModel(this.config, tried);
    if (!next || next.id === current.id) {
      if (next) this.activeModel = next;
      return false;
    }

    try {
      this.provider = createProvider(this.config, next);
      this.activeModel = next;
      this.events.onNotice?.(
        `↻ 已切换到模型 ${next.id}（权重 ${next.weight}）重试。`,
      );
      this.events.onModelChange?.({
        provider: next.provider,
        model: next.model,
        weight: next.weight,
        reason: "调用失败降级",
      });
      return true;
    } catch (err) {
      this.events.onNotice?.(`切换模型失败：${friendlyError(err)}`);
      return false;
    }
  }

  /** 把权重变化写回配置文件；写盘失败不影响当前会话 */
  private persistConfig(): void {
    try {
      saveConfig(this.config);
    } catch {
      // 忽略：内存中的权重仍然生效
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
      memoryMaxChars: this.config.memoryMaxChars,
      spawnAgent: (input) => this.spawnSubAgent(input, signal),
    };

    return executeTool(call.name, call.arguments, ctx, this.tools);
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
      systemPrompt: definition.systemPrompt({
        cwd: this.cwd,
        description: input.description,
        prompt: input.prompt,
      }),
    });

    await child.run(input.prompt, signal);

    const report = output.trim();
    if (!report) {
      return {
        ok: false,
        content:
          `${definition.name} 子代理未返回任何结论（可能被中断或在给出答复前用尽了轮次）。` +
          "可改用更聚焦的 prompt 重试，或直接自己完成。",
        summary: `子代理未返回结论：${input.description}`,
      };
    }
    // 报告是要进主上下文的，失控输出（模型陷入重复）同样会把它撑爆，
    // 因此设一道上限；截断总比把主对话挤掉好。
    const clipped =
      report.length > MAX_SUBAGENT_REPORT_CHARS
        ? `${report.slice(0, MAX_SUBAGENT_REPORT_CHARS)}\n\n…（子代理报告过长，已截断 ${report.length - MAX_SUBAGENT_REPORT_CHARS} 字符）`
        : report;
    return {
      ok: true,
      content: `${definition.name} 子代理「${input.description}」的结论：\n\n${clipped}`,
      summary: `子代理完成：${input.description}`,
    };
  }

  /**
   * 会话部分（不含 system prompt）可用的 token 预算。
   *
   * 随当前模型变化：切换模型后窗口不同，预算需重新计算。
   */
  private conversationBudget(): number {
    return resolveConversationBudget(
      this.activeModel?.contextWindow,
      this.activeModel?.model ?? "",
      this.systemPrompt,
    );
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
    // 会迅速撑爆上下文（而且旧截图对后续对话没有价值）。只保留最后一张。
    const all = stripStaleImages([...this.history, ...extra]);
    // 先按条数粗筛作为安全网（防止 contextWindow 被配成极大值时历史无限累积），
    // 再由 token 预算决定实际保留多少
    const capped =
      all.length > MAX_HISTORY_MESSAGES ? all.slice(-MAX_HISTORY_MESSAGES) : all;
    // budgetRatio < 1 用于「上下文超限后收敛重试」
    const budget = Math.max(1, Math.floor(this.conversationBudget() * budgetRatio));
    return trimMessagesToBudget(capped, budget);
  }

  /**
   * 控制历史长度，避免上下文无限增长。
   *
   * 按 token 预算裁（而非消息条数）：一条 30000 字符的 `bash` 输出与一条「好的」
   * 在旧实现里占同样的名额，于是「60 条以内」也可能轻松越过窗口上限。
   *
   * 返回被裁掉的条数（仅用于日志/调试，回滚不应依赖它，见 run 的说明）。
   */
  private trimHistory(): number {
    const kept = trimMessagesToBudget(this.history, this.conversationBudget());
    if (kept.length === this.history.length) return 0;
    const removed = this.history.length - kept.length;
    this.history = kept;
    return removed;
  }
}
