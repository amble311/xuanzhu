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

  /**
   * 窥视当前尚未完成的行（用于流式实时显示）。
   *
   * 用与落定**完全相同**的规则渲染，否则同一行会先以原始 Markdown 出现在屏幕上
   * （例如看到 `**加粗**` 的星号、引用行的 `>`），落定的一瞬间又突然换一种样子，
   * 看起来就像"标记渲染错了"。
   *
   * 唯一的区别是**不改动代码块状态**：预览会把同一行处理两次（预览一次、落定一次），
   * 若预览就翻转了 `inCodeBlock`，落定时会再翻一次，围栏就错位了。
   */
  peek(): string {
    if (!this.buffer) return "";
    const savedInCodeBlock = this.inCodeBlock;
    const savedCodeLang = this.codeLang;
    try {
      return this.renderLine(this.buffer);
    } finally {
      this.inCodeBlock = savedInCodeBlock;
      this.codeLang = savedCodeLang;
    }
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
      // 行内片段结束后要恢复灰色，否则引用块里出现一个 `代码` 就"断色"
      return `${ansi.gray}│ ${this.renderInline(trimmed.slice(2), ansi.gray)}${ansi.reset}`;
    }

    // 列表
    const list = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (list) {
      // 列表内容同样要处理行内标记：否则 `命令` 会原样显示成带反引号的文本
      return `${list[1]}${ansi.blue}${list[2]}${ansi.reset} ${this.renderInline(list[3])}`;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      return `${ansi.gray}${"─".repeat(20)}${ansi.reset}`;
    }

    return this.renderInline(line);
  }

  /**
   * 处理行内的 **粗体**、`代码`、行内链接。
   *
   * `baseStyle` 是该行所在容器的样式（如引用块的灰色）。行内片段结束时必须**恢复**
   * 容器样式，而不是一律 `reset` 回默认色 —— 否则「引用块里的一个 `代码`」会让
   * 它之后的内容掉出灰色，整行看起来一半是引用、一半不是。
   */
  private renderInline(line: string, baseStyle = ""): string {
    const restore = baseStyle ? `${ansi.reset}${baseStyle}` : ansi.reset;
    let result = line;
    // 行内代码
    result = result.replace(
      /`([^`]+)`/g,
      (_match, code: string) => `${ansi.cyan}${code}${restore}`,
    );
    // 粗体
    result = result.replace(
      /\*\*([^*]+)\*\*/g,
      (_match, text: string) => `${ansi.bold}${text}${restore}`,
    );
    // 剩余斜体标记去除
    result = result.replace(/(^|\s)\*([^*\s][^*]*)\*(?=\s|$)/g, "$1$2");
    return result;
  }
}
