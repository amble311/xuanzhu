import * as fs from "fs";
import * as path from "path";
import { getBtcHome } from "../utils/paths";

/**
 * 决策指令（`~/.btc/policy.md`）。
 *
 * 解决的问题：后台巡检是**独立进程、独立轮次**，用户在 TUI 里说「以后别逆势，单笔最多 1%」
 * 这句话不会进下一轮巡检的上下文 —— 只答应一句「记住了」等于没记。
 * 所以长期要求必须落到一个两边都能读到的地方，并在每轮巡检的提示词里注入。
 *
 * 与项目记忆（`.xuanzhu/memory`）的区别：记忆是「发生过什么」，这份是「以后怎么做」，
 * 是**可执行约束**，所以要短（限制 4000 字符，超出按最旧条目丢弃），
 * 且写在提示词里靠前的位置。
 */

export const POLICY_MAX_CHARS = 4_000;

export function policyPath(home = getBtcHome()): string {
  return path.join(home, "policy.md");
}

export function readPolicy(home = getBtcHome()): string {
  try {
    return fs.readFileSync(policyPath(home), "utf8").trim();
  } catch {
    return "";
  }
}

function writePolicy(home: string, content: string): void {
  const file = policyPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = content.trim() ? `${content.trim()}\n` : "";
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, file);
}

interface PolicyLine {
  /** `- YYYY-MM-DD：内容` */
  raw: string;
  /** 是否为一条指令（标题 / 空行不算） */
  entry: boolean;
}

function splitLines(text: string): PolicyLine[] {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .map((raw) => ({ raw, entry: /^[-*]\s/.test(raw.trim()) }));
}

/**
 * 追加一条指令。
 *
 * 超出上限时**从最旧的条目开始丢**（标题与空行保留）：最新的要求通常最贴近用户当前意图，
 * 被自己的裁剪吃掉最难排查 —— 与长期记忆精简是同一套取舍。
 */
export function appendPolicy(
  home: string,
  instruction: string,
  now = new Date(),
): { text: string; dropped: number } {
  const clean = instruction.replace(/\s+/g, " ").trim();
  if (!clean) return { text: readPolicy(home), dropped: 0 };

  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const line = `- ${stamp}：${clean}`;

  const existing = readPolicy(home);
  const lines = existing ? splitLines(existing) : [];

  // 完全相同的指令不重复写（同一天说两遍很常见）
  if (lines.some((item) => item.raw.trim() === line)) {
    return { text: existing, dropped: 0 };
  }
  lines.push({ raw: line, entry: true });

  let text = lines.map((item) => item.raw).join("\n");
  let dropped = 0;
  while (text.length > POLICY_MAX_CHARS) {
    const index = lines.findIndex((item) => item.entry);
    if (index < 0) break;
    lines.splice(index, 1);
    dropped += 1;
    text = lines.map((item) => item.raw).join("\n");
  }

  writePolicy(home, text);
  return { text: text.trim(), dropped };
}

/** 整份替换（用于用户给出完整策略时） */
export function replacePolicy(
  home: string,
  content: string,
): { text: string; truncated: boolean } {
  let text = content.trim();
  let truncated = false;
  if (text.length > POLICY_MAX_CHARS) {
    // 保留末尾：最新的要求在最下面
    text = text.slice(text.length - POLICY_MAX_CHARS);
    truncated = true;
  }
  writePolicy(home, text);
  return { text, truncated };
}

export function clearPolicy(home = getBtcHome()): void {
  writePolicy(home, "");
}

/** 摘要：注入状态展示用（每条一行，最多 N 条） */
export function policySummary(home = getBtcHome(), limit = 5): string[] {
  return readPolicy(home)
    .split("\n")
    .filter((line) => /^[-*]\s/.test(line.trim()))
    .slice(-limit)
    .map((line) => line.trim());
}
