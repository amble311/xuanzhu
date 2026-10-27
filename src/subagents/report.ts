/**
 * 子代理报告的统一格式约束与归一化。
 *
 * 子代理的完整正文不进入主上下文，只回灌一份报告；如果报告是一大段流水账，
 * 主代理仍然会被撑爆。这里做三件事：
 * 1. 提示词追加统一输出约束（结论最前、引用用 path:line、不要贴完整文件/日志）；
 * 2. 识别已有小节（结论 / 证据 / 失败清单 / 运行方式 / 风险…），保留结构；
 * 3. 按上下文档位截断（small 档更紧），并明确标注被截断。
 */

export const SUBAGENT_OUTPUT_RULE =
  "最终输出只保留**报告正文**：结论放在最前面；引用代码用 `文件路径:行号`；" +
  "不要粘贴完整文件、整段日志或大段代码；没有内容的栏目写「无」。";

const SECTION =
  /^#{1,4}\s*(结论|摘要|证据|已排查|未找到|失败清单|运行方式|环境问题|风险|未决|建议|假设)/m;

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

export interface NormalizedReport {
  text: string;
  /** 是否识别到了结构化小节 */
  structured: boolean;
  /** 原始字符数 */
  before: number;
  /** 截断后的字符数 */
  after: number;
  truncated: boolean;
}

/** 归一化子代理报告；`maxChars` 为进入主上下文的硬上限 */
export function normalizeSubagentReport(
  report: string,
  maxChars = 12_000,
): NormalizedReport {
  const clean = report.replace(ANSI, "").replace(/\r/g, "").trim();
  const before = clean.length;
  const structured = SECTION.test(clean);
  const body = structured
    ? clean
    : clean
      ? `## 结论\n${clean}`
      : "";
  const limit = Math.max(500, maxChars);
  if (body.length <= limit) {
    return { text: body, structured, before, after: body.length, truncated: false };
  }
  const text = `${body.slice(0, limit)}\n\n…（子代理报告过长，已截断 ${
    body.length - limit
  } 字符）`;
  return {
    text,
    structured,
    before,
    after: text.length,
    truncated: true,
  };
}
