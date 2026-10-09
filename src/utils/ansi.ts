/**
 * 轻量 ANSI 终端工具：颜色、样式、文本宽度与折行。
 * 不依赖任何第三方库，保证 TUI 在任何 Node 环境可用。
 */

const ESC = "\x1b[";

export const ansi = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,
  underline: `${ESC}4m`,
  inverse: `${ESC}7m`,
  // 前景色
  black: `${ESC}30m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  white: `${ESC}37m`,
  gray: `${ESC}90m`,
  brightRed: `${ESC}91m`,
  brightGreen: `${ESC}92m`,
  brightYellow: `${ESC}93m`,
  brightBlue: `${ESC}94m`,
  brightMagenta: `${ESC}95m`,
  brightCyan: `${ESC}96m`,
  brightWhite: `${ESC}97m`,
  // 背景色
  bgRed: `${ESC}41m`,
  bgGreen: `${ESC}42m`,
  bgYellow: `${ESC}43m`,
  bgBlue: `${ESC}44m`,
  bgMagenta: `${ESC}45m`,
  bgCyan: `${ESC}46m`,
  bgGray: `${ESC}100m`,
};

export const cursor = {
  hide: `${ESC}?25l`,
  show: `${ESC}?25h`,
  up: (n = 1) => `${ESC}${n}A`,
  down: (n = 1) => `${ESC}${n}B`,
  right: (n = 1) => `${ESC}${n}C`,
  left: (n = 1) => `${ESC}${n}D`,
  to: (row: number, col: number) => `${ESC}${row};${col}H`,
  col: (col: number) => `${ESC}${col}G`,
  clearLine: `${ESC}2K`,
  clearToEnd: `${ESC}0K`,
  clearScreen: `${ESC}2J`,
};

export const screen = {
  enterAlt: `${ESC}?1049h`,
  exitAlt: `${ESC}?1049l`,
  save: `${ESC}s`,
  restore: `${ESC}u`,
};

/** 判断码点是否为全角（占 2 列） */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals / Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana..CJK Symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compat
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compat Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth Signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // Emoji
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  );
}

/** 计算字符串在终端中的显示宽度（忽略 ANSI 转义序列） */
export function textWidth(text: string): number {
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i);
    if (code === undefined) continue;
    if (code === 0x1b) {
      // CSI：终止符是 @~ 而非仅字母（漏掉 ESC[3~ 这类会被当成可见字符计入宽度）
      const csi = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(text.slice(i));
      if (csi) {
        i += csi[0].length - 1;
        continue;
      }
      // OSC：ESC ] ... BEL 或 ST
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/.exec(text.slice(i));
      if (osc) {
        i += osc[0].length - 1;
        continue;
      }
    }
    if (code > 0xffff) i++; // 代理对
    // 制表符按终端实际行为对齐到下一个 8 列制表位；算成 0 宽会让整行填充偏短
    if (code === 0x09) {
      width += 8 - (width % 8);
      continue;
    }
    if (code < 32) continue; // 其余控制字符不占宽度
    // 组合附加符号与变体选择符（如 ✏️ 尾部的 U+FE0F）不占列宽，
    // 逐码点当 1 宽会让含 emoji 的行提前截断或填充错位
    if (
      (code >= 0x0300 && code <= 0x036f) ||
      (code >= 0x20d0 && code <= 0x20ff) ||
      (code >= 0xfe00 && code <= 0xfe0f)
    ) {
      continue;
    }
    width += isWideCodePoint(code) ? 2 : 1;
  }
  return width;
}

/** 判断一个 token 是否为 SGR（颜色/样式）序列 */
function isSgr(token: string): boolean {
  return /^\x1b\[[0-9;]*m$/.test(token);
}

/**
 * 按显示宽度折行，并在折行处**封闭 / 重开** ANSI 样式。
 *
 * 为什么必须自己封闭与重开：每一物理行是**独立写出去的**（`cursor.to()` 定位 +
 * `\x1b[2K` 清行），不能假定终端会把上一行的 SGR 状态延续到下一行。若一段加粗
 * （或某个颜色）跨越折行点而续行没有重新打开样式，续行就会掉回默认色 ——
 * 表现为「同一句话，前半段是亮白、后半段莫名变灰」。同理，行尾不封闭会让样式
 * 泄漏到**后面的其它行**。
 *
 * 因此这里对每一行都保证：样式在本行内自洽（行尾补 reset，续行重新打开）。
 */
export function wrapText(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw === "") {
      lines.push("");
      continue;
    }
    let current = "";
    let width = 0;
    /** 当前处于「开启」状态的 SGR 序列，折行时用于在下一行重开（按出现顺序） */
    let active: string[] = [];

    // 逐 token（ANSI 序列视为整体）。
    // 使用 u 模式让 `.` 匹配完整码点，避免 emoji 等代理对被拆到两行之间。
    const tokens = raw.match(/\x1b\[[0-9;?]*[A-Za-z]|./gu) ?? [];
    for (const token of tokens) {
      const tokenWidth = textWidth(token);
      if (width + tokenWidth > maxWidth && current !== "") {
        lines.push(active.length > 0 ? `${current}${ansi.reset}` : current);
        current = active.join("");
        width = 0;
      }
      if (isSgr(token)) {
        if (token === ansi.reset || token === "\x1b[m") {
          active = [];
        } else {
          active.push(token);
        }
      }
      current += token;
      width += tokenWidth;
    }
    lines.push(active.length > 0 ? `${current}${ansi.reset}` : current);
  }
  return lines;
}

/**
 * 截断字符串到指定显示宽度，超出部分以省略号结尾。
 *
 * 按 token（ANSI 序列视为整体）迭代，而不是逐字符：
 * - 逐字符时 `textWidth("[31m" 的单个字符)` 会把转义参数当成可见宽度，导致提前截断；
 * - 更糟的是 `break` 可能落在序列内部，产出未终止的 CSI（如 `\x1b[44`），
 *   终端会继续吞掉后续字节直到遇到终止符，整行串码。
 * 末尾补 `reset`，避免被截断的颜色泄漏到后续内容。
 */
export function truncate(text: string, maxWidth: number): string {
  if (textWidth(text) <= maxWidth) return text;
  const tokens = text.match(/\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/gu) ?? [];
  let result = "";
  let width = 0;
  const limit = Math.max(0, maxWidth - 1); // 预留省略号占位
  for (const token of tokens) {
    const w = textWidth(token);
    if (width + w > limit) break;
    result += token;
    width += w;
  }
  return `${result}${ansi.reset}…`;
}

/** 用空格填充到指定显示宽度（左对齐） */
export function padEnd(text: string, targetWidth: number): string {
  const w = textWidth(text);
  return text + " ".repeat(Math.max(0, targetWidth - w));
}

/**
 * 净化来自模型 / 工具 / 剪贴板文本中的终端控制序列。
 *
 * 这些文本最终会被写进 stdout，而终端会把其中的 ESC 当真指令执行 ——
 * 模型回答里出现 `\x1b[2J`（清屏）或 `\x1b[?1049l`（退出备用屏）就能毁掉整个界面；
 * 读取一个含 ANSI 的文件、或经提示注入诱导模型输出转义码都能触发。
 * 玄猪自己的配色是渲染阶段拼接的，所以这里可以把 ESC 一律剥掉。
 * 保留 `\n`（换行）与 `\t`（制表符）。
 */
export function sanitizeControl(text: string): string {
  if (!text) return text;
  return (
    text
      // OSC：ESC ] ... BEL 或 ESC \
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
      // CSI：ESC [ 参数 中间 终止符
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      // 双字符转义：ESC 后跟单个字符（如 ESC c 复位）
      .replace(/\x1b[@-Z\\-_]/g, "")
      // 其余控制字符（保留 \n \t），以及 DEL
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
  );
}
