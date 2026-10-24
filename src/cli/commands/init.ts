import { applyInit, planInit, previewPlan, summarizePlan } from "../../init";
import { ansi } from "../../utils/ansi";
import { promptConfirm } from "../prompt";

/**
 * `xzh init` —— 扫描项目并生成 / 补全 AGENTS.md 与 docs/。
 *
 * 安全策略：
 * - 默认**只追加缺失小节**，不覆盖已有内容；
 * - `--force` 才整体覆盖，覆盖前写 `.bak-<时间戳>` 备份；
 * - `--dry-run` 只打印预览、不写盘；
 * - `--yes` 跳过确认（脚本 / CI 用），默认确认是「否」。
 */

function colorize(line: string): string {
  if (line.startsWith("+")) return `${ansi.green}${line}${ansi.reset}`;
  if (line.startsWith("~")) return `${ansi.cyan}${line}${ansi.reset}`;
  if (line.startsWith("!")) return `${ansi.brightYellow}${line}${ansi.reset}`;
  if (line.startsWith("·")) return `${ansi.gray}${line}${ansi.reset}`;
  return line;
}

function printHelp(): void {
  process.stdout.write(`
${ansi.bold}xzh init${ansi.reset} ${ansi.gray}—— 扫描项目并生成 / 补全开发规范${ansi.reset}

${ansi.bold}用法${ansi.reset}
  ${ansi.green}xzh init${ansi.reset}                 生成 AGENTS.md 与 docs/（已有内容只补充缺失小节）
  ${ansi.green}xzh init --dry-run${ansi.reset}       只预览将生成的内容，不写任何文件
  ${ansi.green}xzh init --force${ansi.reset}         整体覆盖已有规范文件（覆盖前自动备份）
  ${ansi.green}xzh init --yes${ansi.reset}           跳过确认（脚本 / CI）

${ansi.bold}说明${ansi.reset}
  · 内容来自扫描：package.json scripts / 锁文件 / Makefile / 构建与测试配置 / 目录结构；
  · 不调用模型、不猜测命令；AGENTS.md 只放入口级约定，细节写入 docs/；
  · 已存在的文件按 \`## 小节\` 合并：同名小节保留原内容，只追加缺失的；
  · 重复运行是幂等的：内容无变化时不写盘。
`);
}

export async function initCommand(args: string[]): Promise<void> {
  const flags = new Set(args);
  if (flags.has("--help") || flags.has("-h")) {
    printHelp();
    return;
  }

  const allowed = new Set([
    "--dry-run",
    "-n",
    "--force",
    "-f",
    "--yes",
    "-y",
  ]);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) {
    process.stdout.write(
      `${ansi.red}未知参数：${unknown.join(" ")}${ansi.reset}\n` +
        `${ansi.gray}用法：xzh init [--dry-run] [--force] [--yes]${ansi.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const dryRun = flags.has("--dry-run") || flags.has("-n");
  const force = flags.has("--force") || flags.has("-f");
  const yes = flags.has("--yes") || flags.has("-y");

  const plan = planInit(process.cwd(), { force });
  process.stdout.write("\n");
  for (const line of summarizePlan(plan)) {
    process.stdout.write(`${colorize(line)}\n`);
  }

  if (plan.files.every((file) => file.action === "skip")) {
    process.stdout.write(
      `${ansi.gray}项目规范已是最新，未修改任何文件。${ansi.reset}\n\n`,
    );
    return;
  }

  if (dryRun) {
    for (const preview of previewPlan(plan)) {
      process.stdout.write(
        `\n${ansi.bold}----- ${preview.relPath} -----${ansi.reset}\n`,
      );
      const content =
        preview.content.length > 6000
          ? `${preview.content.slice(0, 6000)}\n…（已截断）`
          : preview.content;
      process.stdout.write(`${content}\n`);
    }
    process.stdout.write(
      `${ansi.gray}\n预览结束，未写入任何文件。去掉 --dry-run 即按上述变更写入。${ansi.reset}\n\n`,
    );
    return;
  }

  if (!yes) {
    const approved = await promptConfirm(
      `以上变更将写入项目（${plan.cwd}），继续？`,
      false,
    );
    if (!approved) {
      process.stdout.write(`${ansi.gray}已取消，未修改任何文件。${ansi.reset}\n\n`);
      return;
    }
  }

  let result;
  try {
    result = applyInit(plan);
  } catch (err) {
    process.stdout.write(
      `${ansi.red}写入失败：${err instanceof Error ? err.message : String(err)}${ansi.reset}\n\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write("\n");
  for (const item of result.written) {
    const verb =
      item.action === "create"
        ? "已新建"
        : item.action === "append"
          ? "已补充"
          : "已覆盖";
    process.stdout.write(`${ansi.green}✓ ${verb} ${item.relPath}${ansi.reset}\n`);
  }
  for (const backup of result.backups) {
    process.stdout.write(`${ansi.gray}  备份：${backup}${ansi.reset}\n`);
  }
  process.stdout.write(
    `${ansi.gray}\n后续可直接编辑 AGENTS.md 与 docs/；再次运行 xzh init 只会补充缺失小节。${ansi.reset}\n\n`,
  );
}
