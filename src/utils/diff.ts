/**
 * 极简行级 diff：只用于工具执行后给用户看「改了什么」，不追求完整 unified diff。
 *
 * 做法：去掉公共前缀/后缀，只展示中间变化块，并带少量上下文。
 * 这是 O(n) 的，不会为了一个 5 行修改去跑 Myers/LCS 把大文件扫两遍。
 */

const MAX_LINES = 16;
const CONTEXT = 2;

export function formatLineDiff(
  before: string,
  after: string,
  maxLines = MAX_LINES,
): string {
  if (before === after) return "";
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const lines: string[] = [];
  const contextStart = Math.max(0, start - CONTEXT);
  for (let i = contextStart; i < start; i++) lines.push(` ${a[i]}`);

  const removed = a.slice(start, endA + 1);
  const added = b.slice(start, endB + 1);
  for (const line of removed) lines.push(`-${line}`);
  for (const line of added) lines.push(`+${line}`);

  const contextEnd = Math.min(b.length, endB + 1 + CONTEXT);
  for (let i = endB + 1; i < contextEnd; i++) lines.push(` ${b[i]}`);

  if (lines.length > maxLines) {
    const head = lines.slice(0, Math.max(1, maxLines - 1));
    return [...head, `…（diff 已截断，共 ${lines.length} 行变化）`].join("\n");
  }
  return lines.join("\n");
}

/** 给工具结果追加的短 diff 块；没有变化时返回空字符串 */
export function diffNote(before: string, after: string): string {
  const diff = formatLineDiff(before, after);
  return diff ? `\n\n[变更]\n${diff}` : "";
}
