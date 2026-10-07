import { ansi } from "../utils/ansi";

/**
 * 流式 Markdown 渲染器：把模型输出的增量文本按行转换为带 ANSI 颜色的行，
 * 并跟踪代码块状态（跨 chunk 保持正确）。
 */
export class MarkdownRenderer {
  private buffer = "";
  private inCodeBlock = false;
  private codeLang = "";

  /** 追加增量文本，返回新产生的、已完成渲染的行 */
  push(text: string): string[] {
    this.buffer += text;
    const lines: string[] = [];
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      lines.push(this.renderLine(line));
      newlineIndex = this.buffer.indexOf("\n");
    }
    return lines;
  }

  /** 窥视当前尚未完成的行（用于流式实时显示，不改变状态） */
  peek(): string {
    if (!this.buffer) return "";
    if (this.inCodeBlock) return `${ansi.cyan}${this.buffer}${ansi.reset}`;
    return this.buffer;
  }

  /**
   * 冲刷未完成的最后一行（流结束时调用）。
   *
   * 无论有无残余内容都必须复位代码块状态：若某轮输出在代码块中途结束
   * （被中断 / 被截断 / 结尾没有闭合 ```），`inCodeBlock` 会残留为 true，
   * 导致下一轮全部内容被渲染成青色代码、且下一个 ``` 被当成闭合而非开启。
   */
  flush(): string[] {
    if (this.buffer.length === 0) {
      this.inCodeBlock = false;
      this.codeLang = "";
      return [];
    }
    const line = this.buffer;
    this.buffer = "";
    const rendered = this.renderLine(line);
    this.inCodeBlock = false;
    this.codeLang = "";
    return [rendered];
  }

  private renderLine(rawLine: string): string {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trimStart();

    // 代码块围栏
    if (trimmed.startsWith("```")) {
      if (!this.inCodeBlock) {
        this.inCodeBlock = true;
        this.codeLang = trimmed.slice(3).trim();
        const label = this.codeLang ? ` ${this.codeLang} ` : "";
        return `${ansi.gray}┌─${label}${"─".repeat(Math.max(0, 6 - label.length))}${ansi.reset}`;
      }
      this.inCodeBlock = false;
      this.codeLang = "";
      return `${ansi.gray}└──${ansi.reset}`;
    }

    if (this.inCodeBlock) {
      return `${ansi.cyan}${line}${ansi.reset}`;
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const text = heading[2];
      const level = heading[1].length;
      if (level <= 2) return `${ansi.bold}${ansi.brightWhite}${text}${ansi.reset}`;
      return `${ansi.bold}${text}${ansi.reset}`;
    }

    // 引用
    if (trimmed.startsWith("> ")) {
      return `${ansi.gray}│ ${trimmed.slice(2)}${ansi.reset}`;
    }

    // 列表
    const list = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (list) {
      return `${list[1]}${ansi.blue}${list[2]}${ansi.reset} ${list[3]}`;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      return `${ansi.gray}${"─".repeat(20)}${ansi.reset}`;
    }

    return this.renderInline(line);
  }

  /** 处理行内的 **粗体**、`代码`、行内链接 */
  private renderInline(line: string): string {
    let result = line;
    // 行内代码
    result = result.replace(
      /`([^`]+)`/g,
      (_match, code: string) => `${ansi.cyan}${code}${ansi.reset}`,
    );
    // 粗体
    result = result.replace(
      /\*\*([^*]+)\*\*/g,
      (_match, text: string) => `${ansi.bold}${text}${ansi.reset}`,
    );
    // 剩余斜体标记去除
    result = result.replace(/(^|\s)\*([^*\s][^*]*)\*(?=\s|$)/g, "$1$2");
    return result;
  }
}
