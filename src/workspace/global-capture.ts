import {
  appendGlobalTopicEntry,
  DEFAULT_GLOBAL_MEMORY_MAX_CHARS,
} from "./index";
import {
  hasCredentialAssignment,
  protectSecretsInText,
} from "../secrets/vault";

/**
 * 从用户消息里自动提取「全局信息」并写入全局记忆。
 *
 * 为什么需要确定性提取：全局记忆对所有项目生效，不能靠模型“想起来”才写；
 * 但也不能把整段对话都存进去。这里只挑**同时满足**以下条件的行：
 *   - 明确提到全局 / 所有项目 / 跨项目 / 以后都 / 统一用；或
 *   - 出现 sudo / 本机 / 代理 相关且带凭据赋值；或
 *   - 出现本机代理端点（v2ray / Clash / socks5 / 127.0.0.1:端口）。
 *
 * 凭据值在写入前由 `protectSecretsInText()` 替换为加密引用，记忆里永远没有明文。
 * 这是启发式提取：拿不准的内容不写，交给模型用 memory_write target=global 补充。
 */

const GLOBAL_INTENT =
  /(全局|所有项目|每个项目|跨项目|以后都|以后每次|统一用|统一使用|本机|系统级)/i;
const PREFERENCE =
  /(记住|保存|记录|以后|统一|默认|习惯|偏好|路径|安装|使用|采用|都要|都用)/i;
const SUDO_OR_LOCAL = /(sudo|本机|系统级|代理|v2ray|clash|sing-box|proxy)/i;
const PROXY_ENDPOINT =
  /(socks5h?|https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])|v2ray|clash|sing-box|本机代理)/i;
const QUESTION_END = /(什么|怎么|如何|多少|是否|吗)\s*[?？]?\s*$/;

function isCandidateLine(line: string): boolean {
  const text = line.trim();
  if (!text || text.length < 4) return false;
  if (/^```/.test(text)) return false;

  const question = QUESTION_END.test(text);
  const global = GLOBAL_INTENT.test(text);
  const credential = hasCredentialAssignment(text);
  const proxy = PROXY_ENDPOINT.test(text) && /(代理|端口|proxy)/i.test(text);

  // 问句基本不写；只有「记住 / 保存 / 记录」这种明确指令才继续
  if (question && !/^(记住|保存|记录)/.test(text)) return false;
  if (global && (PREFERENCE.test(text) || credential || proxy)) return true;
  if (credential && SUDO_OR_LOCAL.test(text)) return true;
  return proxy;
}

function localDateStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

export interface GlobalCaptureResult {
  added: boolean;
  entry?: string;
  credentialIds: string[];
}

/** 扫描一条用户消息；有值得跨项目保留的内容时写入全局记忆 */
export function captureGlobalMemoryFromUser(
  text: string,
): GlobalCaptureResult {
  if (!text || text.length > 8_000) {
    return { added: false, credentialIds: [] };
  }

  const lines: string[] = [];
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (isCandidateLine(line)) lines.push(line);
  }

  if (lines.length === 0) return { added: false, credentialIds: [] };

  // 一条消息最多吸收 4 行 / 800 字符，避免把长文塞进全局记忆
  const selected = lines.slice(0, 4).join("；").slice(0, 800);
  const protectedText = protectSecretsInText(selected);
  const entry = `- ${localDateStamp()}：${protectedText.text}`;

  const result = appendGlobalTopicEntry(
    "全局信息",
    entry,
    DEFAULT_GLOBAL_MEMORY_MAX_CHARS,
  );

  return {
    added: result.added,
    entry: result.added ? entry : undefined,
    credentialIds: protectedText.credentialIds,
  };
}
