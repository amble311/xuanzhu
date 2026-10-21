import * as fs from "fs";
import * as path from "path";
import {
  clearErrorReports,
  errorReportsDir,
  findErrorReport,
  listErrorReports,
  MAX_ERROR_REPORTS,
  type ErrorReport,
} from "../../utils/error-reports";
import { ansi, truncate } from "../../utils/ansi";
import { promptConfirm } from "../prompt";

/**
 * `xzh errors` —— 查看 / 清理玄猪自己记录的错误报告。
 *
 * 报告由 `src/utils/error-reports.ts` 在异常路径上写入（未捕获异常、工具抛错、
 * 整轮失败），存放在 `~/.xzh/errors/`。这个命令只做三件事：列出来、看细节、清掉，
 * 目的是让用户反馈问题时能直接把文件（或 `show` 的输出）贴出来。
 */

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function fail(message: string): void {
  process.stderr.write(`${ansi.red}${message}${ansi.reset}\n`);
  process.exitCode = 1;
}

/** ISO 时间 → 本地 `MM-DD HH:MM:SS`（列表里不需要年份，报告内保留完整 ISO） */
function shortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 摘要前缀：先说是哪一类错误，再看消息（工具错误带上工具名） */
function kindLabel(report: ErrorReport): string {
  switch (report.kind) {
    case "tool-error":
      return report.tool ? `工具 ${report.tool}` : "工具";
    case "turn-failed":
      return "整轮失败";
    case "unhandled-rejection":
      return "Promise 拒绝";
    default:
      return "未捕获异常";
  }
}

function categoryLabel(report: ErrorReport): string {
  switch (report.category) {
    case "bug":
      return `${ansi.red}bug${ansi.reset}`;
    case "provider":
      return `${ansi.yellow}服务端${ansi.reset}`;
    case "config":
      return `${ansi.yellow}配置${ansi.reset}`;
    default:
      return `${ansi.gray}未知${ansi.reset}`;
  }
}

function printList(): void {
  const reports = listErrorReports();
  if (reports.length === 0) {
    out(`${ansi.gray}还没有错误报告（目录：${errorReportsDir()}）。${ansi.reset}`);
    return;
  }

  out(
    `${ansi.bold}玄猪错误报告${ansi.reset} ${ansi.gray}（${reports.length}/${MAX_ERROR_REPORTS} 份，最近的在前）${ansi.reset}`,
  );
  out(
    `${ansi.gray}  序号  最后出现            次数  类别    摘要${ansi.reset}`,
  );
  reports.forEach((report, index) => {
    const indexText = String(index + 1).padStart(3);
    const count = String(report.count).padStart(3);
    const summary = truncate(`${kindLabel(report)}｜${report.message}`, 44);
    out(
      `  ${ansi.cyan}${indexText}${ansi.reset}  ${ansi.gray}${shortTime(report.lastTime)}${ansi.reset}  ` +
        `${count}   ${categoryLabel(report)}  ${summary}`,
    );
  });
  out("");
  out(`${ansi.gray}看详情：${ansi.reset}xzh errors show <序号>${ansi.gray}　目录：${ansi.reset}${errorReportsDir()}`);
}

function printReport(report: ErrorReport): void {
  // 直接打 JSON：用户要贴到 issue 里，可读 + 可机读，不需要再设计一套渲染
  const file = path.join(errorReportsDir(), `${report.signature}.json`);
  out(`${ansi.gray}文件：${ansi.reset}${file}`);
  out("");
  try {
    out(fs.readFileSync(file, "utf8").trimEnd());
  } catch {
    out(JSON.stringify(report, null, 2));
  }
}

function show(selector: string | undefined): void {
  if (!selector) {
    fail("用法：xzh errors show <序号|签名>");
    return;
  }
  const report = findErrorReport(selector);
  if (!report) {
    fail(`没有找到报告「${selector}」。先运行 xzh errors 看列表。`);
    return;
  }
  printReport(report);
}

async function clear(yes: boolean): Promise<void> {
  const reports = listErrorReports();
  if (reports.length === 0) {
    out(`${ansi.gray}没有需要清理的报告。${ansi.reset}`);
    return;
  }
  if (
    !yes &&
    !(await promptConfirm(
      `删除全部 ${reports.length} 份错误报告（${errorReportsDir()}）？`,
      false,
    ))
  ) {
    out(`${ansi.gray}已取消。${ansi.reset}`);
    return;
  }
  const removed = clearErrorReports();
  out(`${ansi.gray}已删除 ${removed} 份报告。${ansi.reset}`);
}

function printHelp(): void {
  out(`${ansi.bold}xzh errors${ansi.reset} —— 查看玄猪记录的错误报告（~/.xzh/errors/）
  ${ansi.green}xzh errors${ansi.reset}              列出报告（最近的在前）
  ${ansi.green}xzh errors show <序号|签名>${ansi.reset}  查看一份报告的完整内容（JSON）
  ${ansi.green}xzh errors path${ansi.reset}         打印报告目录
  ${ansi.green}xzh errors clear [--yes]${ansi.reset} 删除全部报告

${ansi.gray}报告在出现未捕获异常、工具抛错或整轮请求失败时自动写入（已做密钥脱敏）。
反馈问题时把 ${ansi.reset}xzh errors show <序号>${ansi.gray} 的输出贴出来即可。${ansi.reset}`);
}

export async function errorsCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      printList();
      return;
    case "show":
    case "cat":
      show(rest[0]);
      return;
    case "path":
      out(errorReportsDir());
      return;
    case "clear":
    case "rm":
      await clear(rest.includes("--yes") || rest.includes("-y"));
      return;
    case "help":
    case "-h":
    case "--help":
      printHelp();
      return;
    default:
      fail(`未知子命令：${sub}\n用法：xzh errors [list|show|path|clear]`);
  }
}
