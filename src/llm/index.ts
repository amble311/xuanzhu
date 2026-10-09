import {
  effectiveModels,
  type ModelEntry,
  type XuanZhuConfig,
} from "../config/store";
import { AnthropicProvider } from "./anthropic";
import { GeminiProvider } from "./gemini";
import { OpenAICompatProvider } from "./openai-compat";
import type { LLMProvider } from "./types";

export * from "./types";
export * from "./vision";
export {
  friendlyError,
  isConfigError,
  isContextLengthError,
  isRetryableError,
  isVisionUnsupportedError,
} from "./http";
export {
  DEFAULT_CONTEXT_WINDOW,
  estimateMessageTokens,
  estimateTokens,
  formatContextWindow,
  IMAGE_TOKENS_ESTIMATE,
  inferContextWindow,
  INPUT_BUDGET_RATIO,
  isSystemPromptTight,
  MIN_CONVERSATION_BUDGET,
  resolveConversationBudget,
  sliceToTokenBudget,
  squeezeStaleToolOutput,
  stripAllImages,
  stripStaleImages,
  trimMessagesToBudget,
} from "./context";

export type ProviderKind = "openai" | "anthropic" | "gemini";

export interface ProviderMeta {
  id: string;
  label: string;
  kind: ProviderKind;
  defaultBaseUrl?: string;
  defaultModel: string;
  /** 供 `xzh model` 展示的可选模型列表 */
  models: string[];
  requiresApiKey: boolean;
  /** 从哪个环境变量读取 API Key */
  envKey: string;
  apiKeyHint?: string;
  /** 是否需要用户手填 baseUrl（如自定义端点） */
  requiresBaseUrl?: boolean;
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: "deepseek",
    label: "DeepSeek 深度求索",
    kind: "openai",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    requiresApiKey: true,
    envKey: "DEEPSEEK_API_KEY",
    apiKeyHint: "sk-...",
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    kind: "anthropic",
    defaultModel: "claude-sonnet-4-5",
    models: [
      "claude-sonnet-4-5",
      "claude-opus-4-1",
      "claude-3-5-haiku-latest",
    ],
    requiresApiKey: true,
    envKey: "ANTHROPIC_API_KEY",
    apiKeyHint: "sk-ant-...",
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    models: ["gpt-4o", "gpt-4o-mini", "o4-mini"],
    requiresApiKey: true,
    envKey: "OPENAI_API_KEY",
    apiKeyHint: "sk-...",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    kind: "gemini",
    defaultModel: "gemini-2.0-flash",
    models: ["gemini-2.0-flash", "gemini-2.5-pro", "gemini-2.5-flash"],
    requiresApiKey: true,
    envKey: "GEMINI_API_KEY",
    apiKeyHint: "AIza...",
  },
  {
    id: "glm",
    label: "智谱 GLM",
    kind: "openai",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-plus",
    models: ["glm-4-plus", "glm-4-air", "glm-4-flash"],
    requiresApiKey: true,
    envKey: "GLM_API_KEY",
  },
  {
    id: "qwen",
    label: "通义千问 Qwen",
    kind: "openai",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-max",
    models: ["qwen-max", "qwen-plus", "qwen2.5-coder-32b-instruct"],
    requiresApiKey: true,
    envKey: "DASHSCOPE_API_KEY",
  },
  {
    id: "groq",
    label: "Groq",
    kind: "openai",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    models: ["llama-3.3-70b-versatile", "qwen-2.5-coder-32b"],
    requiresApiKey: true,
    envKey: "GROQ_API_KEY",
    apiKeyHint: "gsk_...",
  },
  {
    id: "ollama",
    label: "Ollama（本地）",
    kind: "openai",
    defaultBaseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen2.5-coder",
    models: ["qwen2.5-coder", "llama3.1", "deepseek-coder-v2"],
    requiresApiKey: false,
    envKey: "OLLAMA_API_KEY",
  },
  {
    id: "custom",
    label: "自定义（OpenAI 兼容端点）",
    kind: "openai",
    defaultModel: "",
    models: [],
    requiresApiKey: false,
    requiresBaseUrl: true,
    envKey: "XUANZHU_API_KEY",
  },
];

export function findProvider(id: string): ProviderMeta | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function resolveApiKey(meta: ProviderMeta, apiKey?: string): string {
  return apiKey || (meta.envKey ? process.env[meta.envKey] ?? "" : "");
}

export function resolveBaseUrl(
  meta: ProviderMeta,
  baseUrl?: string,
): string | undefined {
  return baseUrl || meta.defaultBaseUrl;
}

/** 校验单个模型条目是否可用于请求，返回问题列表 */
export function validateModelEntry(
  config: XuanZhuConfig,
  entry: ModelEntry,
): string[] {
  const problems: string[] = [];
  const meta = findProvider(entry.provider);
  if (!meta) {
    return [`模型 ${entry.id} 使用了未知 provider：${entry.provider}`];
  }
  const settings = config.providers[entry.provider] ?? {};
  if (
    meta.requiresApiKey &&
    !resolveApiKey(meta, entry.apiKey ?? settings.apiKey)
  ) {
    problems.push(
      `模型 ${entry.id} 缺少 API Key，请运行 \`xzh model\` 或设置环境变量 ${meta.envKey}`,
    );
  }
  if (
    meta.requiresBaseUrl &&
    !resolveBaseUrl(meta, entry.baseUrl ?? settings.baseUrl)
  ) {
    problems.push(`模型 ${entry.id} 需要配置 baseUrl`);
  }
  if (!entry.model) {
    problems.push(`模型 ${entry.id} 未指定模型名`);
  }
  return problems;
}

/** 校验全部已配置模型，返回问题列表（用于整体体检与提示） */
export function validateProviderConfig(config: XuanZhuConfig): string[] {
  const models = effectiveModels(config);
  if (models.length === 0) {
    return ["尚未配置任何模型，请运行 `xzh model add` 添加"];
  }
  return models.flatMap((entry) => validateModelEntry(config, entry));
}

/**
 * 根据配置创建 Provider 实例。
 * 传入 `entry` 时按该模型条目创建（多模型 / 降级切换场景）；
 * 否则沿用 config.provider 与 config.model（单模型兼容路径）。
 */
export function createProvider(
  config: XuanZhuConfig,
  entry?: ModelEntry,
): LLMProvider {
  const providerId = entry?.provider ?? config.provider;
  const meta = findProvider(providerId);
  if (!meta) {
    throw new Error(`未知的 provider：${providerId}`);
  }
  const settings = config.providers[providerId] ?? {};
  const apiKey = resolveApiKey(meta, entry?.apiKey ?? settings.apiKey);
  const baseUrl = resolveBaseUrl(meta, entry?.baseUrl ?? settings.baseUrl);
  const model =
    entry?.model || settings.model || config.model || meta.defaultModel;

  // 自定义端点必须校验 baseUrl：否则 OpenAICompatProvider 会静默回退到
  // https://api.openai.com/v1，把请求发到错误的服务上（降级切换时同样要拦住）。
  if (meta.requiresBaseUrl && !baseUrl) {
    throw new Error(
      `provider "${meta.label}" 需要配置 API 端点 baseUrl。运行 \`xzh model\` 补齐后再试。`,
    );
  }
  if (meta.requiresApiKey && !apiKey) {
    throw new Error(
      `provider "${meta.label}" 缺少 API Key。运行 \`xzh model\` 进行配置，或设置环境变量 ${meta.envKey}。`,
    );
  }
  if (!model) {
    throw new Error(`provider "${meta.label}" 未指定模型。运行 \`xzh model\` 选择模型。`);
  }

  switch (meta.kind) {
    case "anthropic":
      return new AnthropicProvider({ id: meta.id, apiKey, baseUrl, model });
    case "gemini":
      return new GeminiProvider({ id: meta.id, apiKey, baseUrl, model });
    case "openai":
    default:
      return new OpenAICompatProvider({
        id: meta.id,
        apiKey,
        baseUrl,
        model,
      });
  }
}
