import * as readline from "readline/promises";
import { Writable } from "stream";
import { ansi } from "../utils/ansi";

export interface SelectOption<T> {
  label: string;
  value: T;
  hint?: string;
}

/** 什么都不输出的写入流：配合 readline 实现掩码输入（不回显所输内容） */
const mutedOutput = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

/** 把凭据类字符串打码，仅保留头尾用于辨认（如 sk-1234…abcd） */
function maskSecret(value: string): string {
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** 读取一行文本输入 */
export async function promptInput(
  label: string,
  defaultValue?: string,
  options: { mask?: boolean } = {},
): Promise<string> {
  // mask 模式：输入的字符不回显到终端，默认值也以降级形式展示，
  // 避免 API Key 出现在屏幕上（或被录屏 / script 录制捕获）。
  const rl = readline.createInterface({
    input: process.stdin,
    output: options.mask ? mutedOutput : process.stdout,
  });
  try {
    const shown =
      defaultValue && options.mask ? maskSecret(defaultValue) : defaultValue;
    const suffix = shown ? ` ${ansi.gray}(${shown})${ansi.reset}` : "";
    // 非交互环境（stdin 提前结束）时回落为默认值，避免静默挂起
    const answer = await Promise.race([
      rl.question(`${label}${suffix}: `),
      new Promise<string>((resolve) => rl.once("close", () => resolve(""))),
    ]);
    if (options.mask) process.stdout.write("\n");
    const trimmed = answer.trim();
    return trimmed || defaultValue || "";
  } finally {
    rl.close();
  }
}

/**
 * 从列表中选择一项（方向键 + 数字编号都可用）。
 *
 * 返回 `undefined` 表示用户**主动取消**（Esc / Ctrl+C）——
 * 调用方据此中止当前操作。之所以用可空返回而不是「取消即取默认项」：
 * 后者会让「按 Esc 想退出」变成「悄悄选中第一项并继续往下走」，
 * 与提示文案不符，也容易误改配置。
 */
export async function promptSelect<T>(
  label: string,
  options: SelectOption<T>[],
  defaultIndex = 0,
): Promise<T | undefined> {
  // 非交互环境（管道 / CI / stdin 已结束）没有方向键可发，
  // 回落为「读一行编号」的老行为，避免等不到按键而挂住。
  if (!process.stdin.isTTY) {
    return promptSelectByLine(label, options, defaultIndex);
  }
  return promptSelectInteractive(label, options, defaultIndex);
}

/** 渲染一行选项（\x1b[2K 先清整行，避免长短不一时残留） */
function renderOptionRow<T>(
  option: SelectOption<T>,
  index: number,
  selected: number,
): string {
  const marker =
    index === selected ? `${ansi.brightGreen}❯${ansi.reset}` : " ";
  const hint = option.hint ? ` ${ansi.gray}${option.hint}${ansi.reset}` : "";
  const number = `${ansi.gray}${String(index + 1).padStart(2)}.${ansi.reset}`;
  return `\x1b[2K  ${marker} ${number} ${option.label}${hint}\n`;
}

/**
 * 交互式选择：↑/↓ 移动高亮，数字键直达，Enter 确认。
 *
 * 为什么不用 `readline.question`：它工作在**行模式**下，只把整行交回来 ——
 * 方向键会被当作转义序列留在行里，无法用来移动光标。这里改用 raw 模式自己
 * 解析按键（与 TUI 同一套做法），因此两种输入方式可以并存：
 * 熟练的用户敲 `3` 回车，其他人按方向键再回车。
 */
async function promptSelectInteractive<T>(
  label: string,
  options: SelectOption<T>[],
  defaultIndex: number,
): Promise<T | undefined> {
  const cursor0 = Math.min(Math.max(defaultIndex, 0), options.length - 1);
  let cursor = cursor0;
  // 数字缓冲区：允许「12」这样的两位编号（选项可能超过 9 个）
  let typed = "";

  const menuRows = options.length;
  const totalRows = menuRows + 1; // 选项 + 提示行

  const paint = (): void => {
    for (let i = 0; i < options.length; i++) {
      process.stdout.write(renderOptionRow(options[i], i, cursor));
    }
    const hint = typed
      ? `${ansi.gray}↑/↓ 选择 · ${ansi.reset}编号 ${ansi.brightCyan}${typed}${ansi.reset}${ansi.gray} · Enter 确认 · Esc 取消${ansi.reset}`
      : `${ansi.gray}↑/↓ 选择 · 数字直达 · Enter 确认 · Esc 取消${ansi.reset}`;
    process.stdout.write(`\x1b[2K${hint}`);
  };

  process.stdout.write(`\n${ansi.bold}${label}${ansi.reset}\n`);
  paint();

  const stdin = process.stdin;
  const wasRaw = Boolean(stdin.isRaw);

  return new Promise<T | undefined>((resolve) => {
    const finish = (value: T | undefined): void => {
      stdin.off("data", onData);
      if (!wasRaw) stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      resolve(value);
    };

    const confirm = (): void => {
      const picked = typed ? Number.parseInt(typed, 10) - 1 : cursor;
      if (picked >= 0 && picked < options.length) {
        finish(options[picked].value);
      } else if (typed) {
        // 编号越界：不清场，提示后让用户重来
        typed = "";
        process.stdout.write(`\x1b[${totalRows}A`);
        paint();
      } else {
        finish(options[cursor].value);
      }
    };

    const onData = (chunk: string): void => {
      // 必须**逐字符 / 逐序列**解析，不能拿整个 chunk 去匹配：
      // 一次读取可能同时含多个按键（例如快速输入 "5\r"，或管道一次性送入），
      // 用 `chunk === "5"` 这样的严格相等判断会两头顶不上、什么都不做。
      let handled = false;
      let i = 0;

      while (i < chunk.length) {
        // 转义序列要先于「单独的 Esc」判断，否则 ESC[A 会被认成 Esc
        if (chunk.startsWith("\x1b[A", i) || chunk[i] === "k") {
          cursor = (cursor - 1 + options.length) % options.length;
          handled = true;
          i += chunk.startsWith("\x1b[A", i) ? 3 : 1;
        } else if (chunk.startsWith("\x1b[B", i) || chunk[i] === "j") {
          cursor = (cursor + 1) % options.length;
          handled = true;
          i += chunk.startsWith("\x1b[B", i) ? 3 : 1;
        } else if (chunk[i] === "\r" || chunk[i] === "\n") {
          confirm();
          return;
        } else if (chunk[i] === "\x03") {
          // Ctrl+C / Esc：取消整个操作。此前返回「光标所在项」会让流程继续往下走
          // （例如接着去问上下文大小），与「Esc 取消」的提示不符，也容易误改配置。
          finish(undefined);
          return;
        } else if (chunk[i] === "\x1b") {
          finish(undefined);
          return;
        } else if (chunk[i] === "\x7f" || chunk[i] === "\b") {
          typed = typed.slice(0, -1);
          handled = true;
          i += 1;
        } else if (/\d/.test(chunk[i])) {
          // 数字直达：最多累积两位（编号可能超过 9），回车才确认 ——
          // 若输入即选中，就再也输不了第二位数
          const next = typed + chunk[i];
          typed = next.length > 2 ? chunk[i] : next;
          handled = true;
          i += 1;
        } else {
          i += 1;
        }
      }

      if (handled) {
        process.stdout.write(`\x1b[${totalRows}A`);
        paint();
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}

/** 非交互环境的回落：读一行编号（保持原有行为） */
async function promptSelectByLine<T>(
  label: string,
  options: SelectOption<T>[],
  defaultIndex: number,
): Promise<T> {
  process.stdout.write(`\n${ansi.bold}${label}${ansi.reset}\n`);
  options.forEach((option, index) => {
    const marker = index === defaultIndex ? `${ansi.brightGreen}❯${ansi.reset}` : " ";
    const hint = option.hint ? ` ${ansi.gray}${option.hint}${ansi.reset}` : "";
    process.stdout.write(`  ${marker} ${index + 1}. ${option.label}${hint}\n`);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    // 非交互环境（stdin 已结束 / 管道输入）时回落为默认选项，避免 rl.question 悬挂
    const answer = await Promise.race([
      rl.question(`${ansi.gray}请输入编号 [${defaultIndex + 1}]: ${ansi.reset}`),
      new Promise<string>((resolve) => rl.once("close", () => resolve(""))),
    ]);
    const trimmed = answer.trim();
    if (!trimmed) return options[defaultIndex].value;
    const index = Number.parseInt(trimmed, 10) - 1;
    if (Number.isNaN(index) || index < 0 || index >= options.length) {
      process.stdout.write(`${ansi.yellow}无效编号，使用默认选项。${ansi.reset}\n`);
      return options[defaultIndex].value;
    }
    return options[index].value;
  } finally {
    rl.close();
  }
}

/** 询问是否（y/N） */
export async function promptConfirm(
  label: string,
  defaultValue = false,
): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const hint = defaultValue ? "[Y/n]" : "[y/N]";
    // 同 promptSelect：非交互环境回落为默认值，避免悬挂
    const answer = await Promise.race([
      rl.question(`${label} ${hint} `),
      new Promise<string>((resolve) => rl.once("close", () => resolve(""))),
    ]);
    const trimmed = answer.trim().toLowerCase();
    if (!trimmed) return defaultValue;
    return trimmed === "y" || trimmed === "yes";
  } finally {
    rl.close();
  }
}
