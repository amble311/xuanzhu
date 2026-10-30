import * as fs from "fs";
import { ensureDir, getConfigDir, getConfigPath } from "../utils/paths";
import {
  DEFAULT_GLOBAL_MEMORY_MAX_CHARS,
  DEFAULT_MEMORY_MAX_CHARS,
} from "../workspace";

/** 单个 Provider 的配置 */
export interface ProviderSettings {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/**
 * 多模型列表中的一项。
 *
 * **列表顺序就是优先级**：启动时使用「上次用过的那个」（记在 `config.provider` / `config.model`），
 * 它不可用时按列表顺序向后回退，直到全部试过。因此这里**没有权重字段** ——
 * 旧配置里的 `weight` / `decayed` 在读取时会被直接丢弃。
 */
export interface ModelEntry {
  /** 唯一标识：`<provider>/<model>`（内部用；展示优先用 alias） */
  id: string;
  provider: string;
  model: string;
  /** 展示别名（可选）；为空时展示 model */
  alias?: string;
  /** 可选：仅对该模型生效的 API Key（否则沿用 providers[provider].apiKey） */
  apiKey?: string;
  /** 可选：仅对该模型生效的 baseUrl */
  baseUrl?: string;
  /**
   * 上下文窗口大小（token）。用于按 token 预算裁剪历史，避免请求超过模型窗口。
   * 在 `xzh model add` 时询问；用户留空则由 `inferContextWindow()` 自动推断。
   * 未设置时按保守默认值处理（见 DEFAULT_CONTEXT_WINDOW）。
   */
  contextWindow?: number;
  /**
   * 该模型是否支持**图片输入**（视觉/多模态）。
   *
   * 未设置时按模型名自动推断（见 `src/llm/vision.ts`）。需要显式标注的场景：
   * 私有部署或新发布的模型名推断不出来 —— 此时默认按「不支持」处理，粘贴图片
   * 会被拒绝并给出提示。可用 `xzh model vision <id> on` 打开。
   */
  vision?: boolean;
}

/** 意图分析设置 */
export interface IntentSettings {
  /**
   * 是否启用意图分析（**默认关闭**）。
   * 启用后：每条用户消息都会先用模板包裹、向模型发起一次**独立请求**，
   * 返回的内容再作为本轮的用户输入交给主流程处理。
   */
  enabled: boolean;
  /**
   * 意图分析提示词模板。用占位符 `{{'用户发送过来的消息'}}` 标记用户消息的位置；
   * 省略时使用 DEFAULT_INTENT_PROMPT。
   */
  prompt?: string;
}

/** 意图分析模板中的用户消息占位符 */
export const INTENT_PLACEHOLDER = "{{'用户发送过来的消息'}}";

/** 意图分析默认提示词模板 */
export const DEFAULT_INTENT_PROMPT =
  "请分析下面消息的意图，以第一人称输出三段：【核心意图】一句话总结；" +
  "【需求拆解】逐条列出明确需求；【隐性意图】潜在诉求。不要增加原文不存在信息。 " +
  `消息： ${INTENT_PLACEHOLDER}`;

/**
 * 用模板包裹用户消息。
 * 模板含占位符时替换占位符；含其它 `{{…}}` 形式时替换第一个；
 * 完全没有占位符时在末尾追加「消息：<内容>」。
 */
export function buildIntentPrompt(template: string, message: string): string {
  // 一律使用函数形式替换：字符串形式会把 message 里的 `$&`、`$'`、`$1` 等
  // 当作反向引用展开，污染意图分析请求的内容。
  if (template.includes(INTENT_PLACEHOLDER)) {
    return template.replace(INTENT_PLACEHOLDER, () => message);
  }
  const generic = /\{\{\s*[^{}]*\s*\}\}/;
  if (generic.test(template)) {
    return template.replace(generic, () => message);
  }
  return `${template}\n消息：${message}`;
}

/** 玄猪主配置 */
export interface XuanZhuConfig {
  version: number;
  /** **上次使用的** provider 标识（见 src/llm/index.ts PROVIDERS）；空表示还没选过 */
  provider: string;
  /** **上次使用的**模型名；它与 provider 一起充当「记住上次用的模型」 */
  model: string;
  /**
   * 多模型列表，**顺序即优先级/回退顺序**：
   * - 启动时使用「上次用过的那个」（即上面的 provider / model）；
   * - 它不可用时按本列表顺序向后回退，直到全部试过；
   * - 为空时回退到 provider / model 单模型配置，以兼容旧版本配置文件。
   */
  models: ModelEntry[];
  /** 意图分析设置（默认关闭） */
  intent: IntentSettings;
  /** 各 provider 的独立配置 */
  providers: Record<string, ProviderSettings>;
  /** 单轮任务内工具调用的最大轮数 */
  maxToolRounds: number;
  /**
   * 是否自动批准工具调用。
   * true（默认）：所有工具（含写文件、执行命令）均不再询问，直接执行；
   * false：写文件 / 编辑文件 / 执行命令前需用户确认。
   */
  autoApprove: boolean;
  /**
   * 是否让玄猪接管鼠标（滚轮滚动输出区 + 拖拽选中复制）。
   *
   * true（默认）：
   *   - 滚轮滚动输出区；
   *   - **在输出区拖拽即可选中并复制**（松开时写入系统剪贴板，OSC 52）。
   * 框选是由玄猪自己实现的（见 tui/app.ts 的 handleMouse），
   * 因此不必再依赖终端原生选择，也不需要 Shift 绕过。
   *
   * false：把鼠标完全交还终端 —— 使用终端原生的框选与右键菜单，
   *   滚动输出区改用 `PgUp` / `PgDn`。
   *
   * 之所以仍提供开关：玄猪跑在**备用屏**上，不接管时终端没有回滚历史，
   * 滚轮也就滚不动；而接管后终端的原生选择会被屏蔽（`?1000h` 是整体开关）。
   * 两种取舍各有偏好，因此保留配置项，用 `/mouse` 切换并会写回这里。
   */
  mouseCapture?: boolean;
  /**
   * 读取凭据类文件时是否要求确认（`.env`、`~/.ssh`、`~/.xzh/config.json`、
   * `*.pem`、`id_rsa` 等）。
   *
   * false（默认）：**完全自动放行** —— 与其他工具一致，不再打断。
   * true：读取这类路径时确认一次。防的是「凭据被读进上下文、转手发给模型服务商」
   *   （`~/.xzh/config.json` 里就存着明文 API Key），与「是否信任模型执行命令」
   *   是两个问题。默认关闭是因为绝大多数使用场景并不涉及这些路径，
   *   而每次都弹确认对「全自动」的预期是一种破坏。
   */
  confirmSensitiveRead?: boolean;
  /**
   * 上下文策略：`auto`（默认）按模型窗口自动判断；`small` 强制精简档；`full` 强制完整档。
   */
  contextProfile?: "auto" | "small" | "full";
  /** 单次回复的最大输出 token 数；不设则用 Provider 默认值（small 档默认 2048） */
  maxOutputTokens?: number;
  /**
   * 长期记忆（MEMORY.md）的字符上限。默认 12000（见 workspace 的 DEFAULT_MEMORY_MAX_CHARS）。
   *
   * 超过后：`memory_write`（scope=long）会自动去重并丢弃最旧的**追加块**
   * （`## 时间戳`；按主题整理的稳定小节与最新追加块不参与裁剪）；仍然超限时，
   * `memory_write` 的返回与系统提示词都会要求模型用 `memory_compact` 做一次语义精简。
   * 设为 0 表示不限制（仍会去重）。
   */
  memoryMaxChars?: number;
  /**
   * 全局长期记忆（~/.xzh/memory/MEMORY.md）的字符上限。默认 4000。
   *
   * 全局记忆会注入**每个项目**的系统提示词，因此上限比项目记忆更紧；
   * 设为 0 表示不限制（仍会去重）。
   */
  globalMemoryMaxChars?: number;
  /**
   * 并行执行的子代理数量上限。默认 4。
   *
   * 主代理在一轮里并列发出多个 `task` 调用时，这些子代理会**并发运行**；
   * 上限用于避免一次性打爆服务商的速率限制（每个子代理各自持有一条对话流）。
   * 设为 1 表示退化为串行。
   */
  maxParallelAgents?: number;
  /** 采样温度 */
  temperature: number;
  /** 追加到系统提示词的额外内容 */
  systemPromptExtra?: string;
}

export const CONFIG_VERSION = 1;

export const DEFAULT_CONFIG: XuanZhuConfig = {
  version: CONFIG_VERSION,
  provider: "deepseek",
  model: "deepseek-chat",
  models: [],
  intent: { enabled: false },
  providers: {},
  // 单轮对话内允许的模型往返轮数。默认 200：
  // 真实的重构类任务（读模块 → 重写 → 反复跑测试 → 修错）动辄上百轮，
  // 上限太紧会让工作断在半路。失控风险已由「连续相同调用检测」兜住
  // （同一工具 + 同一参数连续 4 次即中止），且达到上限时还会询问是否继续，
  // 因此放宽是安全的。
  maxToolRounds: 200,
  autoApprove: true,
  // 默认接管鼠标：滚轮滚动输出区，且拖拽即可选中复制（选择由玄猪自己实现，
  // 所以不再以「失去原生选择」为代价）。想用终端原生选择则改为 false。
  mouseCapture: true,
  // 默认不拦凭据读取：autoApprove 为 true 时应当「完全自动放行」，
  // 否则「自动批准」的语义会被一个罕见的例外破坏。
  confirmSensitiveRead: false,
  // 长期记忆超过 12000 字符即触发精简（去重 + 丢弃最旧的追加块 + 提示模型语义压缩）
  memoryMaxChars: DEFAULT_MEMORY_MAX_CHARS,
  // 全局记忆注入每个项目，默认 4000 字符，避免跨项目把提示词顶爆
  globalMemoryMaxChars: DEFAULT_GLOBAL_MEMORY_MAX_CHARS,
  // 同一轮里并列的多个子代理最多同时跑 4 个：再多容易撞上服务商的速率限制，
  // 而收益有限（瓶颈通常就是那几个并发请求）。
  maxParallelAgents: 4,
  temperature: 0.2,
};

/** 读取配置；不存在时返回默认配置（不写盘） */
export function loadConfig(): XuanZhuConfig {
  const file = getConfigPath();
  try {
    if (!fs.existsSync(file)) {
      // 没有配置文件时不返回 DEFAULT_CONFIG 里的 provider / model 占位值：
      // 它们是"默认示例"而非用户配置过的模型，否则 effectiveModels() 的兼容回退
      // 会把 deepseek/deepseek-chat 当成一个已配置模型物化进 models。
      return { ...DEFAULT_CONFIG, provider: "", model: "", models: [] };
    }
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<XuanZhuConfig>;
    return mergeConfig(parsed);
  } catch (err) {
    throw new Error(
      `读取配置失败（${file}）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * 把配置文件里读到的模型条目规范化为当前结构：补齐 id、**丢弃已废弃的字段**。
 *
 * 旧版本用 `weight`（调用权重）与 `decayed`（失败降权标记）实现多模型降级，
 * 现在改为「列表顺序 + 记住上次使用」。这里**逐字段重建**而不是 `{...entry}` ——
 * 后者会让这两个字段一直挂在内存对象上，并在下次保存时又被写回配置文件。
 */
function sanitizeModelEntry(entry: ModelEntry): ModelEntry {
  const clean: ModelEntry = {
    id: entry.id || modelId(entry.provider, entry.model),
    provider: entry.provider,
    model: entry.model,
  };
  if (entry.apiKey) clean.apiKey = entry.apiKey;
  if (entry.baseUrl) clean.baseUrl = entry.baseUrl;
  if (typeof entry.alias === "string" && entry.alias.trim()) {
    clean.alias = entry.alias.trim().slice(0, 80);
  }
  if (hasContextWindow(entry.contextWindow)) {
    clean.contextWindow = Math.floor(entry.contextWindow!);
  }
  if (typeof entry.vision === "boolean") clean.vision = entry.vision;
  return clean;
}

function mergeConfig(partial: Partial<XuanZhuConfig>): XuanZhuConfig {
  const models = Array.isArray(partial.models)
    ? partial.models
        .filter(
          (entry): entry is ModelEntry =>
            Boolean(entry) &&
            typeof entry.provider === "string" &&
            typeof entry.model === "string",
        )
        .map((entry) => sanitizeModelEntry(entry))
    : DEFAULT_CONFIG.models;

  return {
    ...DEFAULT_CONFIG,
    ...partial,
    models,
    intent: {
      // 严格布尔：缺省一律视为关闭
      enabled: partial.intent?.enabled === true,
      ...(partial.intent?.prompt ? { prompt: partial.intent.prompt } : {}),
    },
    providers: { ...DEFAULT_CONFIG.providers, ...(partial.providers ?? {}) },
    maxToolRounds: partial.maxToolRounds ?? DEFAULT_CONFIG.maxToolRounds,
    autoApprove: partial.autoApprove ?? DEFAULT_CONFIG.autoApprove,
    mouseCapture: partial.mouseCapture ?? DEFAULT_CONFIG.mouseCapture,
    confirmSensitiveRead:
      partial.confirmSensitiveRead ?? DEFAULT_CONFIG.confirmSensitiveRead,
    memoryMaxChars: partial.memoryMaxChars ?? DEFAULT_CONFIG.memoryMaxChars,
    globalMemoryMaxChars:
      partial.globalMemoryMaxChars ?? DEFAULT_CONFIG.globalMemoryMaxChars,
    maxParallelAgents:
      partial.maxParallelAgents ?? DEFAULT_CONFIG.maxParallelAgents,
    temperature: partial.temperature ?? DEFAULT_CONFIG.temperature,
  };
}

/** 保存配置到 ~/.xzh/config.json（权限 600） */
export function saveConfig(config: XuanZhuConfig): void {
  ensureDir(getConfigDir());
  const file = getConfigPath();
  const data = JSON.stringify(config, null, 2) + "\n";

  // 原子写：先写同目录临时文件再 rename。
  // 直接覆盖原文件时，若进程在写盘途中被中断（Ctrl+C / 崩溃），
  // 会留下半截 JSON，下次 loadConfig 直接抛「读取配置失败」导致玄猪无法启动。
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // 某些文件系统不支持 chmod，忽略
  }
  fs.renameSync(tmp, file);

  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // 某些文件系统不支持 chmod，忽略
  }
}

/** 配置是否已存在 */
export function configExists(): boolean {
  return fs.existsSync(getConfigPath());
}

/** 对 apiKey 做脱敏，用于展示 */
export function maskKey(key?: string): string {
  if (!key) return "(未设置)";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/** 生成用于 xzh config 展示的脱敏副本 */
export function redactConfig(config: XuanZhuConfig): unknown {
  const providers: Record<string, unknown> = {};
  for (const [name, settings] of Object.entries(config.providers)) {
    providers[name] = {
      ...settings,
      apiKey: maskKey(settings.apiKey),
    };
  }
  return {
    version: config.version,
    provider: config.provider,
    model: config.model,
    models: effectiveModels(config).map((entry) => ({
      id: entry.id,
      ...(entry.alias ? { alias: entry.alias } : {}),
      ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
      ...(entry.vision === undefined ? {} : { vision: entry.vision }),
      ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      ...(entry.apiKey ? { apiKey: maskKey(entry.apiKey) } : {}),
    })),
    intent: {
      enabled: config.intent?.enabled === true,
      ...(config.intent?.prompt ? { prompt: config.intent.prompt } : {}),
    },
    temperature: config.temperature,
    maxToolRounds: config.maxToolRounds,
    autoApprove: config.autoApprove,
    memoryMaxChars: config.memoryMaxChars ?? DEFAULT_CONFIG.memoryMaxChars,
    globalMemoryMaxChars:
      config.globalMemoryMaxChars ?? DEFAULT_CONFIG.globalMemoryMaxChars,
    maxParallelAgents:
      config.maxParallelAgents ?? DEFAULT_CONFIG.maxParallelAgents,
    systemPromptExtra: config.systemPromptExtra ?? "",
    providers,
  };
}

// ------------------------------------------------------------ 多模型与回退

/** 模型唯一标识：`<provider>/<model>` */
export function modelId(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/** 展示名：优先 alias，其次真正的模型 ID。 */
export function modelDisplayName(entry?: ModelEntry | null): string {
  if (!entry) return "";
  return entry.alias?.trim() || entry.model || entry.id;
}

/**
 * 生效的模型列表（**顺序即优先级/回退顺序**）：
 * - `config.models` 非空时直接使用；
 * - 否则把旧的单模型配置（provider / model）视为唯一的模型，以兼容历史配置文件。
 *
 * 返回的是**浅拷贝**（防止调用方误改配置）：要写回必须用 `materializeModels()`。
 */
export function effectiveModels(config: XuanZhuConfig): ModelEntry[] {
  if (config.models && config.models.length > 0) {
    return config.models.map((entry) => ({ ...entry }));
  }
  const provider = config.provider;
  const model = config.providers[provider]?.model || config.model;
  if (provider && model) {
    return [{ id: modelId(provider, model), provider, model }];
  }
  return [];
}

/**
 * 启动 / 展示用的「当前模型」：**上次用过的那个**（记在 config.provider / config.model）；
 * 它已不在列表里（被删掉、或配置里没记录）时退回列表第一项；没有模型时返回 null。
 */
export function activeModelEntry(config: XuanZhuConfig): ModelEntry | null {
  const models = effectiveModels(config);
  if (models.length === 0) return null;
  const currentId =
    config.provider && config.model ? modelId(config.provider, config.model) : "";
  return models.find((entry) => entry.id === currentId) ?? models[0];
}

/**
 * 回退链上的下一个模型：从 `currentId` 在列表中的位置**向后**找，跳过 `tried` 里
 * 已经试过的；`currentId` 不在列表里时从表头开始。全部试过则返回 null。
 *
 * 为什么是**环形**查找而不是只取「后面一个」：列表末尾的模型失败时必须绕回表头继续试，
 * 否则「直到所有模型都尝试过」永远达不成。跳过的判定依据是本次请求内试过哪些，
 * 而不是把失败的模型从列表里剔掉 —— 那会破坏用户配置。
 */
export function nextModelAfter(
  config: XuanZhuConfig,
  currentId: string,
  tried: Iterable<string> = [],
): ModelEntry | null {
  const models = effectiveModels(config);
  if (models.length === 0) return null;
  const skip = new Set(tried);
  // 当前这个一定跳过：环形查找下若不跳过，单模型列表会返回它自己
  // （调用方即使忘传 tried 也不会「切到自己」）
  skip.add(currentId);
  const start = models.findIndex((entry) => entry.id === currentId);
  for (let offset = 1; offset <= models.length; offset++) {
    const entry = models[(start + offset + models.length) % models.length];
    if (!skip.has(entry.id)) return entry;
  }
  return null;
}

/**
 * 记住「这次用的是哪个模型」，供下次启动直接使用。
 *
 * 写在 `config.provider` / `config.model` 上（它们同时是旧版单模型配置的兼容字段），
 * 并顺手更新 `providers[provider].model` —— 那里是「该服务商最近用过的模型」，
 * `xzh model add` 的交互默认值取自它。
 */
export function rememberModel(config: XuanZhuConfig, entry: ModelEntry): void {
  config.provider = entry.provider;
  config.model = entry.model;
  config.providers = {
    ...config.providers,
    [entry.provider]: {
      ...(config.providers[entry.provider] ?? {}),
      model: entry.model,
    },
  };
}

/**
 * 就地物化模型列表（把兼容用的单模型配置写回 models 数组）。
 *
 * 注意：一旦修改了 config.provider / config.model，兼容回退就会取到新值，
 * 因此任何「先改 provider/model、再操作 models」的流程都必须先调用本函数。
 */
export function materializeModels(config: XuanZhuConfig): ModelEntry[] {
  if (!config.models || config.models.length === 0) {
    config.models = effectiveModels(config);
  }
  return config.models;
}

/** 判断上下文窗口值是否有效（有限正数） */
function hasContextWindow(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** 新增模型（已存在则更新覆盖项）；返回该条目 */
export function upsertModel(
  config: XuanZhuConfig,
  input: {
    provider: string;
    model: string;
    alias?: string | null;
    apiKey?: string;
    baseUrl?: string;
    contextWindow?: number;
    vision?: boolean;
  },
): ModelEntry {
  const models = materializeModels(config);
  const id = modelId(input.provider, input.model);
  const existing = models.find((entry) => entry.id === id);

  if (existing) {
    if (input.apiKey) existing.apiKey = input.apiKey;
    if (input.baseUrl) existing.baseUrl = input.baseUrl;
    if (input.alias !== undefined) {
      const alias = input.alias?.trim().slice(0, 80);
      if (alias) existing.alias = alias;
      else delete existing.alias;
    }
    if (hasContextWindow(input.contextWindow)) {
      existing.contextWindow = Math.floor(input.contextWindow!);
    }
    if (typeof input.vision === "boolean") existing.vision = input.vision;
    return existing;
  }

  const created: ModelEntry = {
    id,
    provider: input.provider,
    model: input.model,
    ...(input.alias?.trim() ? { alias: input.alias.trim().slice(0, 80) } : {}),
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(hasContextWindow(input.contextWindow)
      ? { contextWindow: Math.floor(input.contextWindow!) }
      : {}),
    ...(typeof input.vision === "boolean" ? { vision: input.vision } : {}),
  };
  models.push(created);
  return created;
}

/** 按 id / 模型名 / 序号（从 1 起）定位模型下标；未找到返回 -1 */
export function findModelIndex(models: ModelEntry[], key: string): number {
  const byId = models.findIndex((entry) => entry.id === key);
  if (byId >= 0) return byId;
  const byModel = models.findIndex((entry) => entry.model === key);
  if (byModel >= 0) return byModel;
  const byAlias = models.findIndex((entry) => entry.alias === key);
  if (byAlias >= 0) return byAlias;
  const index = Number.parseInt(key, 10);
  if (!Number.isNaN(index) && index >= 1 && index <= models.length) {
    return index - 1;
  }
  return -1;
}

/** 设置展示别名；空字符串表示清除。返回被修改的条目，未找到返回 null。 */
export function setModelAlias(
  config: XuanZhuConfig,
  key: string,
  alias: string,
): ModelEntry | null {
  const models = materializeModels(config);
  const index = findModelIndex(models, key);
  if (index < 0) return null;
  const entry = models[index];
  const clean = alias.trim().slice(0, 80);
  if (clean) entry.alias = clean;
  else delete entry.alias;
  return entry;
}

/** 修改模型条目的 baseUrl；空字符串表示清除条目级覆盖。 */
export function setModelBaseUrl(
  config: XuanZhuConfig,
  key: string,
  baseUrl: string,
): ModelEntry | null {
  const models = materializeModels(config);
  const index = findModelIndex(models, key);
  if (index < 0) return null;
  const entry = models[index];
  const clean = baseUrl.trim();
  if (clean) entry.baseUrl = clean;
  else delete entry.baseUrl;
  return entry;
}

export interface SetModelModelIdResult {
  entry?: ModelEntry;
  error?: string;
}

/**
 * 修改真正的模型 ID（API 的 `model` 字段）。
 *
 * 条目的内部 id 跟着变成 `<provider>/<新 model>`；如果它正是「当前使用」的模型，
 * 同步更新 config.provider / config.model，避免下次启动找不到它。
 * 若新 id 与另一个条目冲突则拒绝，防止覆盖别人的 baseUrl / key。
 */
export function setModelModelId(
  config: XuanZhuConfig,
  key: string,
  nextModel: string,
): SetModelModelIdResult {
  const models = materializeModels(config);
  const index = findModelIndex(models, key);
  if (index < 0) return { error: "未找到模型" };
  const entry = models[index];
  const clean = nextModel.trim();
  if (!clean) return { error: "模型 ID 不能为空" };

  const oldModel = entry.model;
  const nextId = modelId(entry.provider, clean);
  if (models.some((item, i) => i !== index && item.id === nextId)) {
    return { error: `模型 ID 已存在：${nextId}` };
  }

  entry.model = clean;
  entry.id = nextId;
  if (config.provider === entry.provider && config.model === oldModel) {
    config.model = clean;
  }
  const providerSettings = config.providers[entry.provider];
  if (providerSettings?.model === oldModel) {
    config.providers[entry.provider] = { ...providerSettings, model: clean };
  }
  return { entry };
}

/**
 * 删除模型；未找到返回 null。
 *
 * 删掉的若是「上次使用」的那个，顺手把记忆切到剩下的第一项 —— 否则配置里会留下一个
 * 指向已删除模型的死引用（虽然 `activeModelEntry()` 会兜底到第一项，但没有意义）。
 * ⚠️ 这里**直接读 `config.models`**（经 materializeModels），不能用 `effectiveModels()`：
 * 后者在 `models` 为空时会回退到 provider / model 兼容字段，导致刚删掉的模型被当成
 * 「仍然存在」写回去（历史上出现过「删除后模型又回来了」）。
 */
export function removeModel(
  config: XuanZhuConfig,
  key: string,
): ModelEntry | null {
  const models = materializeModels(config);
  const index = findModelIndex(models, key);
  if (index < 0) return null;
  const [removed] = models.splice(index, 1);

  const activeId =
    config.provider && config.model
      ? modelId(config.provider, config.model)
      : "";
  if (removed && removed.id === activeId) {
    const fallback = models[0];
    config.provider = fallback ? fallback.provider : "";
    config.model = fallback ? fallback.model : "";
  }
  return removed ?? null;
}
