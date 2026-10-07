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

/** 从列表中选择一项（输入编号） */
export async function promptSelect<T>(
  label: string,
  options: SelectOption<T>[],
  defaultIndex = 0,
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
