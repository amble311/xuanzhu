/**
 * 模型是否支持**图片输入**（视觉/多模态）的判断。
 *
 * 为什么需要它：各家 OpenAI 兼容端点对图片的支持差异极大 —— `gpt-4o`、`glm-4v`、
 * `qwen-vl` 支持，而 `deepseek-chat`、`glm-4-plus`、`qwen-max` 不支持，且**不支持时
 * 往往是直接 400**（把整轮对话一起作废），而不是静默忽略图片。因此发送前先判断，
 * 不支持就明确告知用户，而不是让他白等一次失败请求。
 *
 * 判断顺序：**显式 `vision` 覆盖 → 自定义端点默认支持 → 否定关键词 → 肯定关键词 →
 * 默认不支持**。除了自定义端点，默认「不支持」是刻意的保守选择：宁可让用户手动标注一次，
 * 也不要把图片发出去换来 400。
 *
 * 自定义端点（任意 OpenAI 兼容端点）之所以例外，是因为它的模型名完全由用户自填，
 * 按名字推断必然失效 —— 全部拒绝等于「自定义模型永远用不了图片」。放行之后，真的
 * 不支持时由 `Agent` 识别该错误并去掉图片重试一次，正文不受影响。
 */

/** 明确**不支持**视觉的模型名（优先级高于肯定关键词，用于挡住泛匹配） */
const NO_VISION_HINTS: RegExp[] = [
  /^o1(-|$)/i,
  /^o3-mini/i,
  /deepseek-(chat|reasoner|coder)/i,
  /glm-4-(plus|air|flash|long)/i,
  /qwen-(max|plus|turbo)/i,
  /llama-?3/i,
  /mixtral|mistral-(small|medium|large|nemo)/i,
  /command-r(?!\+)/i,
];

/** 已知**支持**视觉的模型名 */
const VISION_HINTS: RegExp[] = [
  /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|chatgpt-4o/i,
  /^o3(-|$)|^o4(-|$)/i,
  /claude/i,
  /gemini/i,
  /glm-4v|glm-4\.\dv/i,
  /qwen[^/]*vl/i,
  /llava|bakllava|minicpm-v|pixtral|internvl|moondream|gemma-?3/i,
  /grok-[^/]*vision/i,
];

/** 按模型名推断是否支持视觉输入 */
export function inferVisionSupport(model: string): boolean {
  const name = model.trim();
  if (!name) return false;

  for (const pattern of NO_VISION_HINTS) {
    if (pattern.test(name)) return false;
  }
  for (const pattern of VISION_HINTS) {
    if (pattern.test(name)) return true;
  }
  return false;
}

/**
 * 「自定义端点」provider 的 id（必须与 `llm/index.ts` 的 `PROVIDERS` 中那条一致）。
 *
 * 这里写字面量而不是从 PROVIDERS 取，是因为 `llm/index.ts` 会 re-export 本模块，
 * 反向 import 会形成循环依赖。
 */
const CUSTOM_PROVIDER_ID = "custom";

/**
 * 模型条目是否支持视觉：显式 `vision` 字段优先，其次按 provider / 模型名推断。
 *
 * 显式字段存在的意义是覆盖推断 —— 私有部署或新模型名推断不出来时，
 * 用户可以在配置里手写 `"vision": true`。
 */
export function modelSupportsVision(entry: {
  provider?: string;
  model: string;
  vision?: boolean;
}): boolean {
  if (typeof entry.vision === "boolean") return entry.vision;

  // 自定义端点（任意 OpenAI 兼容端点）的模型名由用户自填，按名字推断必然失效 ——
  // 之前默认按「不支持」处理，导致自定义模型粘贴图片被直接拒绝。
  // 现在默认放行：真不支持时请求会被服务端拒绝，Agent 会识别出来并**自动去掉图片
  // 重试一次**（见 `isVisionUnsupportedError` + `stripAllImages`），本轮正文不受影响；
  // 想避免每次都白试一次，可用 `xzh model vision <id> off` 显式关闭。
  if (entry.provider === CUSTOM_PROVIDER_ID) return true;

  return inferVisionSupport(entry.model);
}

/** Anthropic 只接受这几种图片媒体类型 */
export type AnthropicMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

const ANTHROPIC_MEDIA_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** 归一化 Anthropic 的 media_type；不支持的格式退回 image/png */
export function normalizeAnthropicMediaType(mimeType: string): AnthropicMediaType {
  const normalized = mimeType.trim().toLowerCase();
  if (ANTHROPIC_MEDIA_TYPES.has(normalized)) {
    return normalized as AnthropicMediaType;
  }
  // image/bmp / image/tiff 等不在白名单：Anthropic 会直接报错，退回 PNG 至少有机会成功
  return "image/png";
}

/**
 * 带图片但正文为空时使用的兜底文本。
 *
 * 部分端点（以及 Anthropic）要求 content 至少含一个非空文本块，
 * 正文为空 + 只有图片会被判为非法请求。
 */
export const IMAGE_FALLBACK_TEXT = "请看这张图片。";
