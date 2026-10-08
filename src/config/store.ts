import * as fs from "fs";
import { ensureDir, getConfigDir, getConfigPath } from "../utils/paths";

/** 单个 Provider 的配置 */
export interface ProviderSettings {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/** 单个模型的调用权重默认值 */
export const DEFAULT_MODEL_WEIGHT = 10;

/** 多模型列表中的一项 */
export interface ModelEntry {
  /** 唯一标识：`<provider>/<model>` */
  id: string;
  provider: string;
  model: string;
  /**
   * 调用权重：越高越优先。
   * - 启动时选择权重最高的模型
   * - 调用失败时 -1；降到 0 表示该模型暂不可用
   * - 所有模型都为 0 时视为「全部耗尽」，会被重置回默认权重
   */
  weight: number;
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
   * 是否「因调用失败被降过权」。
   * 用于把「失败降到 0」与「用户主动设为 0（暂不使用）」区分开：
   * 只有前者才参与「全部耗尽 → 重置」的判定，否则用户显式禁用会被静默推翻。
   * 用户手动设置权重后会清除该标记。
   */
  decayed?: boolean;
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
  /** 当前使用的 provider 标识（见 src/llm/index.ts PROVIDERS） */
  provider: string;
  /** 当前使用的模型名 */
  model: string;
  /**
   * 多模型列表（支持权重与降级）。
   * 为空时回退到 provider/model 单模型配置，以兼容旧版本配置文件。
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

function mergeConfig(partial: Partial<XuanZhuConfig>): XuanZhuConfig {
  const models = Array.isArray(partial.models)
    ? partial.models
        .filter(
          (entry): entry is ModelEntry =>
            Boolean(entry) &&
            typeof entry.provider === "string" &&
            typeof entry.model === "string",
        )
        .map((entry) => ({
          ...entry,
          id: entry.id || modelId(entry.provider, entry.model),
          weight:
            typeof entry.weight === "number" && Number.isFinite(entry.weight)
              ? entry.weight
              : DEFAULT_MODEL_WEIGHT,
        }))
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
      weight: entry.weight,
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
    systemPromptExtra: config.systemPromptExtra ?? "",
    providers,
  };
}

// ------------------------------------------------------------ 多模型与权重

/** 模型唯一标识：`<provider>/<model>` */
export function modelId(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/**
 * 生效的模型列表：
 * - `config.models` 非空时直接使用；
 * - 否则把旧的单模型配置（provider / model）视为一个默认权重的模型，
 *   以兼容历史配置文件。
 */
export function effectiveModels(config: XuanZhuConfig): ModelEntry[] {
  if (config.models && config.models.length > 0) {
    return config.models.map((entry) => ({ ...entry }));
  }
  const provider = config.provider;
  const model = config.providers[provider]?.model || config.model;
  if (provider && model) {
    return [
      {
        id: modelId(provider, model),
        provider,
        model,
        weight: DEFAULT_MODEL_WEIGHT,
      },
    ];
  }
  return [];
}

/** 可用模型（权重 > 0），按权重从高到低排序（同权重保持配置顺序） */
export function rankedModels(config: XuanZhuConfig): ModelEntry[] {
  return effectiveModels(config)
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight);
}

/**
 * 当前应使用的模型：权重最高者；没有可用模型时返回 null。
 * 传入 `exclude` 可跳过指定模型（用于「同一次请求内不重复尝试同一个模型」）。
 */
export function pickModel(
  config: XuanZhuConfig,
  exclude?: Iterable<string>,
): ModelEntry | null {
  const skip = new Set(exclude ?? []);
  return rankedModels(config).find((entry) => !skip.has(entry.id)) ?? null;
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

export interface DecayResult {
  /** 目标模型的 id */
  id: string;
  /** 降权后的权重（触发重置时为 0） */
  weight: number;
  /** 是否因「所有模型权重耗尽」而触发全局重置 */
  reset: boolean;
}

/**
 * 模型调用失败：权重 -1（最低 0）。
 * 当所有已配置模型的权重都变成 0 时，把全部权重重置回默认值，并返回 `reset: true`。
 */
export function decayModelWeight(
  config: XuanZhuConfig,
  id: string,
): DecayResult | null {
  const models = materializeModels(config);
  const target = models.find((entry) => entry.id === id);
  if (!target) return null;

  target.weight = Math.max(0, target.weight - 1);
  target.decayed = true;
  const decayedWeight = target.weight;

  // 只有「因失败降权过」的模型全部归零才算耗尽：
  // 用户主动设为 0（暂不使用）的模型不参与判定，也不会被重置复活。
  const failed = models.filter((entry) => entry.decayed === true);
  if (failed.length > 0 && failed.every((entry) => entry.weight <= 0)) {
    for (const entry of failed) {
      entry.weight = DEFAULT_MODEL_WEIGHT;
      entry.decayed = false;
    }
    return { id, weight: 0, reset: true };
  }
  return { id, weight: decayedWeight, reset: false };
}

/** 把全部模型权重重置为默认值（并清除失败降权标记） */
export function resetModelWeights(config: XuanZhuConfig): void {
  for (const entry of materializeModels(config)) {
    entry.weight = DEFAULT_MODEL_WEIGHT;
    entry.decayed = false;
  }
}

/** 新增模型（已存在则按需更新权重与覆盖项）；返回该条目 */
/** 判断上下文窗口值是否有效（有限正数） */
function hasContextWindow(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function upsertModel(
  config: XuanZhuConfig,
  input: {
    provider: string;
    model: string;
    weight?: number;
    apiKey?: string;
    baseUrl?: string;
    contextWindow?: number;
  },
): ModelEntry {
  const models = materializeModels(config);
  const id = modelId(input.provider, input.model);
  const hasWeight =
    typeof input.weight === "number" && Number.isFinite(input.weight);
  const existing = models.find((entry) => entry.id === id);

  if (existing) {
    if (hasWeight) {
      existing.weight = Math.max(0, Math.floor(input.weight!));
      existing.decayed = false;
    }
    if (input.apiKey) existing.apiKey = input.apiKey;
    if (input.baseUrl) existing.baseUrl = input.baseUrl;
    if (hasContextWindow(input.contextWindow)) {
      existing.contextWindow = Math.floor(input.contextWindow!);
    }
    return existing;
  }

  const created: ModelEntry = {
    id,
    provider: input.provider,
    model: input.model,
    weight: hasWeight ? Math.max(0, Math.floor(input.weight!)) : DEFAULT_MODEL_WEIGHT,
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(hasContextWindow(input.contextWindow)
      ? { contextWindow: Math.floor(input.contextWindow!) }
      : {}),
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
  const index = Number.parseInt(key, 10);
  if (!Number.isNaN(index) && index >= 1 && index <= models.length) {
    return index - 1;
  }
  return -1;
}

/** 删除模型；未找到返回 null */
export function removeModel(
  config: XuanZhuConfig,
  key: string,
): ModelEntry | null {
  const models = materializeModels(config);
  const index = findModelIndex(models, key);
  if (index < 0) return null;
  const [removed] = models.splice(index, 1);
  return removed ?? null;
}

/** 设置指定模型的权重；未找到返回 null */
export function setModelWeight(
  config: XuanZhuConfig,
  key: string,
  weight: number,
): ModelEntry | null {
  const models = materializeModels(config);
  const index = findModelIndex(models, key);
  if (index < 0) return null;
  models[index].weight = Math.max(0, Math.floor(weight));
  // 用户显式接管该模型的权重后，不再把它视为「失败降权」的产物
  models[index].decayed = false;
  return models[index];
}
