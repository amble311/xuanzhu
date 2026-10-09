import * as http from "http";
import * as https from "https";

/**
 * 创建不使用连接复用的 HTTP Agent。
 *
 * 背景：openai SDK（node-fetch + agentkeepalive）默认创建一个全局共享、
 * `keepAlive: true`、`timeout: 5 分钟` 的连接池。当网络路径上存在代理
 * （如本地 Clash / V2Ray）或服务端在空闲时关闭长连接后，客户端复用这个
 * 已经"半关闭"的 socket，就会在读取响应流时抛出 `Premature close`
 * （Node 的 ERR_STREAM_PREMATURE_CLOSE）。
 *
 * 禁用 keep-alive 后每次请求重建连接，彻底规避该问题。
 */
export function createNonPoolingAgent(
  targetUrl: string,
): http.Agent | https.Agent {
  const isHttps = !/^http:\/\//i.test(targetUrl);
  const options: http.AgentOptions = { keepAlive: false };
  return isHttps ? new https.Agent(options) : new http.Agent(options);
}

const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

const RETRYABLE_KEYWORDS = [
  "premature close",
  "socket hang up",
  "other side closed",
  "fetch failed",
  "network error",
  "connection error",
  "connection reset",
  "terminated",
  "timeout",
  // OpenAI SDK 的 APIConnectionTimeoutError 文案是 "Request timed out."，
  // 不含 `timeout` 子串，漏掉它会导致超时类错误完全不重试。
  "timed out",
];

/**
 * 把文本中可能出现的凭据替换成掩码。
 *
 * 服务端或中间代理有时会把请求头原样回显进错误体（例如
 * `{"error":{"message":"... Bearer sk-xxx ..."}}`），而这段文本会打印到终端、
 * 甚至进入对话上下文，因此**任何对外暴露错误信息的地方都必须先过一遍这里**。
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return (
    text
      // Authorization 头：Bearer / Basic / Token xxx
      .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 ***")
      // 常见 Key 形态（sk- / sk-ant- / api-key / api_key 等）
      .replace(/\b(sk|pk|rk|api|key|token)[-_][A-Za-z0-9._-]{6,}/gi, "$1-***")
      // 查询串里的凭据
      .replace(/([?&](?:api[-_]?key|key|token|access_token|authorization)=)[^&\s"']+/gi, "$1***")
      // JSON 字段
      .replace(
        /("(?:api[-_]?key|apikey|token|secret|password|authorization)"\s*:\s*")[^"]*/gi,
        "$1***",
      )
  );
}

/**
 * 安全地把未知值读为字符串。
 * 自定义端点（如 llama.cpp / LM Studio / 各类代理）返回的错误体里
 * `code` / `status` 可能是数字，直接 `.toUpperCase()` 会抛 TypeError，
 * 从而把真正的错误原因掩盖成 "xxx is not a function"。
 */
function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

/** 安全地把未知值读为 HTTP 状态码（兼容数字 / 数字字符串） */
function asStatus(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

/** 尽可能从各种错误结构里取出可读的原始信息 */
function extractRawMessage(error: unknown): string {
  const err = error as { message?: unknown; error?: unknown; cause?: unknown };
  const direct = asString(err?.message);
  if (direct) return direct;

  // OpenAI SDK 有时把服务端返回体挂在 error.error 上
  const nested = err?.error as { message?: unknown } | undefined;
  const nestedMessage = asString(nested?.message);
  if (nestedMessage) return nestedMessage;

  const cause = err?.cause as { message?: unknown } | undefined;
  const causeMessage = asString(cause?.message);
  if (causeMessage) return causeMessage;

  if (error instanceof Error && error.message) return error.message;
  try {
    const json = JSON.stringify(error);
    if (json && json !== "{}") return json;
  } catch {
    // 忽略序列化失败
  }
  const text = String(error);
  return text === "[object Object]" ? "未知错误（无法解析错误详情）" : text;
}

/** 判断错误是否为可重试的瞬时网络错误 */
export function isRetryableError(error: unknown): boolean {
  const err = error as {
    message?: unknown;
    code?: unknown;
    status?: unknown;
  };

  const status = asStatus(err?.status);
  if (status !== undefined) {
    if (status === 408 || status === 409 || status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    if (status >= 400 && status < 500) return false;
  }

  const code = asString(err?.code).toUpperCase();
  if (code && RETRYABLE_CODES.has(code)) return true;

  // undici / fetch 会把真正的原因挂在 cause 上（如 ECONNREFUSED、ENOTFOUND），
  // 只看顶层会把这些当成普通失败处理。
  const cause = (err as { cause?: { code?: unknown; message?: unknown } })?.cause;
  const causeCode = asString(cause?.code).toUpperCase();
  if (causeCode && RETRYABLE_CODES.has(causeCode)) return true;

  const message = (
    asString(err?.message) ||
    asString(cause?.message) ||
    String(error)
  ).toLowerCase();
  return RETRYABLE_KEYWORDS.some((keyword) => message.includes(keyword));
}

/**
 * 把底层错误转换为对用户友好的中文提示。
 *
 * 统一在出口处做一次凭据脱敏：下面每个分支都可能把服务端的原始 message 原样返回，
 * 而某些网关会把 Authorization 头回显进错误体。
 */
export function friendlyError(error: unknown): string {
  return redactSecrets(friendlyErrorRaw(error));
}

/**
 * 判断错误是否为「配置类问题」—— 密钥无效、模型名不存在、端点地址错误等。
 *
 * 这类失败**重试与降权都没有意义**：配置不改就永远失败。
 * 若照常扣权重，一次配置错误会把所有可用模型一起拖到不可用
 * （权重耗尽还会触发全局重置），而用户真正需要做的是去修配置。
 */
export function isConfigError(error: unknown): boolean {
  const err = error as {
    message?: unknown;
    status?: unknown;
    cause?: { message?: unknown };
    error?: { message?: unknown };
  };

  const status = asStatus(err?.status);
  // 401 密钥无效 / 403 无权限 / 404 模型名或端点不存在
  if (status === 401 || status === 403 || status === 404) return true;

  const text = (
    asString(err?.message) ||
    asString(err?.error?.message) ||
    asString(err?.cause?.message) ||
    String(error)
  ).toLowerCase();

  return [
    "invalid api key",
    "incorrect api key",
    "api key not valid",
    "authentication",
    "unauthorized",
    "未知 provider",
    "unknown provider",
    "model not found",
    "unknown model",
    "no such model",
    "invalid base url",
    "缺少 api key",
  ].some((pattern) => text.includes(pattern));
}

/**
 * 判断错误是否为「上下文超出模型窗口」。
 *
 * 这类错误必须与其他调用失败区别对待：
 *   - 它不是模型的故障，**不该降权、不该切换模型** ——
 *     换个模型拿同样长的消息再发一次只会同样失败，还白白扣掉权重；
 *   - 它是可自愈的：收敛历史长度后重试即可。
 *
 * 三家 provider 措辞不同，这里做特征匹配而非精确匹配：
 *   OpenAI:    code=context_length_exceeded / "This model's maximum context length is N tokens"
 *   Anthropic: "prompt is too long" / "input length and max_tokens exceed context limit"
 *   Gemini:    "exceeds the maximum number of tokens"
 *
 * 只在 4xx 范围内判定（超限是客户端问题，5xx 属服务端故障、交给常规重试）。
 * 没有状态码时（部分 SDK 包装会丢掉）退化为纯文本匹配，误判代价只是「多试一次」。
 */
export function isContextLengthError(error: unknown): boolean {
  const err = error as {
    message?: unknown;
    code?: unknown;
    status?: unknown;
    cause?: { message?: unknown };
    error?: { code?: unknown; message?: unknown };
  };

  const status = asStatus(err?.status);
  if (status !== undefined && (status < 400 || status >= 500)) return false;

  const code = asString(err?.code) || asString(err?.error?.code);
  if (
    /context[_ ]?length|context[_ ]?size|max[_ ]?tokens?_exceeded|token[_ ]?limit/i.test(
      code,
    )
  ) {
    return true;
  }

  const text = (
    asString(err?.message) ||
    asString(err?.error?.message) ||
    asString(err?.cause?.message) ||
    String(error)
  ).toLowerCase();

  return [
    // ── 云端 API ──
    "context length", // OpenAI / vLLM / LM Studio
    "context_length",
    "maximum context",
    "context window",
    "prompt is too long", // Anthropic
    "exceed context limit",
    "exceeds the maximum number of tokens", // Gemini
    "reduce the length",
    "too many tokens",
    // ── 本地推理（llama.cpp / llama-server / Ollama 等）──
    // 这些用的措辞是 "context size" 而不是 "context length"，
    // 早期只匹配后者，导致本地模型超限时被当成普通故障：降权 + 切换模型，
    // 而换模型后再发同样长的内容必然同样失败，白白把权重耗光。
    "context size",
    "context_size",
    "exceeds the available context",
    "input length exceeds",
    "exceeds the context",
    "n_ctx",
    "n_keep",
    // ── 兜底 ──
    "too long",
  ].some((pattern) => text.includes(pattern));
}

/**
 * 判断错误是否为「该模型不支持图片输入」。
 *
 * 需要单独识别的理由：这类失败**不是模型故障**（不该降权、不该切换模型），
 * 也不该把整轮正文一起作废 —— 只要去掉图片重发一次就能继续。
 *
 * 自定义端点（OpenAI 兼容）的模型名由用户自填，视觉能力无从推断，因此默认按
 * 「支持」放行；真发出去被拒时，就靠这里识别并自动降级重试。
 *
 * 判定同样只在 4xx 范围内（不支持图片是客户端参数问题，5xx 属服务端故障）。
 * 措辞做特征匹配：显式模式命中即可，否则要求「提到图片」且「提到不支持」同时成立，
 * 避免把「图片格式非法」这类错误也当成模型不支持而静默丢图。
 */
export function isVisionUnsupportedError(error: unknown): boolean {
  const err = error as {
    message?: unknown;
    code?: unknown;
    status?: unknown;
    cause?: { message?: unknown };
    error?: { code?: unknown; message?: unknown };
  };

  const status = asStatus(err?.status);
  if (status !== undefined && (status < 400 || status >= 500)) return false;

  const text = (
    asString(err?.message) ||
    asString(err?.error?.message) ||
    asString(err?.cause?.message) ||
    String(error)
  ).toLowerCase();

  const explicit = [
    "does not support image",
    "doesn't support image",
    "not support image",
    "unsupported image",
    "image input is not supported",
    "images are not supported",
    "vision is not supported",
    "does not support vision",
    "not a multimodal",
    "not support multimodal",
    "unsupported content type",
    "invalid content type",
    "image_url is only supported",
    "only supported by certain models",
    "不支持图片",
    "不支持图像",
    "不支持多模态",
    "不支持视觉",
  ];
  if (explicit.some((pattern) => text.includes(pattern))) return true;

  const mentionsImage = /image|vision|multimodal|图片|图像|视觉/.test(text);
  const mentionsUnsupported =
    /not support|unsupported|only supported|不支持|无法处理/.test(text);
  return mentionsImage && mentionsUnsupported;
}

function friendlyErrorRaw(error: unknown): string {
  const err = error as {
    message?: unknown;
    code?: unknown;
    status?: unknown;
  };
  const raw = extractRawMessage(error);
  const lower = raw.toLowerCase();
  const code = asString(err?.code).toUpperCase();
  const status = asStatus(err?.status);

  if (isContextLengthError(error)) {
    return (
      "上下文超出模型窗口：本次请求的内容比模型能接受的长度更长。\n" +
      "玄猪已自动收敛历史后重试；若仍失败，可减少一次性读取的内容量，" +
      "或用 `xzh model context <id> <大小>` 调大该模型的上下文窗口。"
    );
  }
  if (lower.includes("premature close")) {
    return (
      "连接被提前关闭（Premature close）：网络或代理中断了响应流。\n" +
      "玄猪已自动重试；若仍频繁出现，通常是代理/网络不稳定导致，可检查代理或稍后再试。"
    );
  }
  if (code === "ECONNRESET" || lower.includes("socket hang up")) {
    return "连接被对端重置（ECONNRESET）：网络或代理中断了连接，请重试。";
  }
  if (code === "ETIMEDOUT" || lower.includes("timed out")) {
    return "请求超时：网络较慢或模型服务未响应，请稍后重试。";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "无法解析服务地址：请检查网络连接与代理设置（DNS 可能被拦截）。";
  }
  if (code === "ECONNREFUSED") {
    return "连接被拒绝：目标地址或端口不可达，请检查 baseUrl 与代理设置。";
  }
  if (
    status === 401 ||
    lower.includes("unauthorized") ||
    lower.includes("invalid api key") ||
    lower.includes("authentication")
  ) {
    return "认证失败：API Key 无效或已过期，请运行 `xzh model` 重新配置。";
  }
  if (status === 403) {
    return "访问被拒绝（403）：请检查 API Key 权限或服务商区域限制。";
  }
  if (
    status === 402 ||
    lower.includes("insufficient") ||
    lower.includes("balance")
  ) {
    return "账户额度不足：请检查服务商余额或配额。";
  }
  if (status === 429 || lower.includes("rate limit")) {
    return "请求过于频繁（限流）：请稍后再试。";
  }
  // 服务端资源类错误（显存 / 内存不足）——llama.cpp、LM Studio 等本地后端常见。
  // 明确标注来源与处理方向，避免用户误以为是玄猪（客户端）的问题。
  if (
    /out\s*of\s*(device\s*)?memory|outofdevicememory|outofmemory|vk::|cuda.*error|hip.*error|cannot allocate|insufficient memory/i.test(
      raw,
    )
  ) {
    return (
      `${raw}\n` +
      "以上是模型服务端（llama.cpp / LM Studio 等）报出的资源错误：显存或内存不足，与玄猪无关。\n" +
      "可尝试：减小上下文长度（llama.cpp 的 -c，例如 -c 8192）、降低 KV cache 精度\n" +
      "（--cache-type-k q8_0 --cache-type-v q8_0）、减少 GPU 卸载层数（-ngl）、\n" +
      "换更小的模型 / 量化，或先释放被其他进程占用的显存。\n" +
      "修好服务端后可用 `xzh model reset` 把被降掉的权重恢复为默认值。"
    );
  }
  if (typeof status === "number" && status >= 500) {
    return `模型服务端错误（HTTP ${status}）：服务暂时不可用，请稍后重试。`;
  }
  if (isVisionUnsupportedError(error)) {
    return (
      `${raw}\n` +
      "该模型不支持图片输入（玄猪已自动去掉图片重试一次，本轮正文不受影响）。\n" +
      "· 想彻底避免这次白试：`xzh model vision <id> off`\n" +
      "· 或改用 glm-4v / qwen-vl / gpt-4o / claude / gemini 等支持视觉的模型"
    );
  }
  if (status === 400) {
    // 去掉 SDK 拼在 message 前的重复状态码
    const detail = raw.replace(/^4\d\d\s*/, "");
    const hint = /model/i.test(detail)
      ? "\n提示：多半是模型名不被该端点支持。可用 `curl <baseUrl>/models` 查看端点支持的模型 id，" +
        "再用 `xzh model weight <id> 10` 后的 `xzh model` 更正模型名。"
      : "";
    return `请求被拒绝（HTTP 400）：${detail}${hint}`;
  }
  if (lower.includes("fetch failed") || lower.includes("network")) {
    return `网络请求失败：${raw}`;
  }
  return raw;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
