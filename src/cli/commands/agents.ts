import { activeModelEntry, loadConfig } from "../../config/store";
import {
  generateAgentsRewrite,
  writeAgentsFile,
} from "../../init/agents-rewrite";
import { applyProxyConfig } from "../../network/proxy";
import { ansi } from "../../utils/ansi";
import { promptConfirm } from "../prompt";

function printHelp(): void {
  process.stdout.write(`
${ansi.bold}xzh agents.md${ansi.reset} ${ansi.gray}—— 重写 / 整合项目根 AGENTS.md${ansi.reset}

${ansi.bold}用法${ansi.reset}
  ${ansi.green}xzh agents.md${ansi.reset}             分析项目并重写 AGENTS.md（写入前确认）
  ${ansi.green}xzh agents.md --dry-run${ansi.reset}   只预览，不写文件
  ${ansi.green}xzh agents.md --yes${ansi.reset}       跳过确认（脚本 / CI）

${ansi.bold}说明${ansi.reset}
  · 已存在 AGENTS.md：保留仍然有效的用户约定，合并重复/过时内容；
  · 不存在 AGENTS.md：直接根据扫描到的项目事实编写；
  · 会使用当前配置的模型分析项目结构；不会扫描依赖和构建产物；
  · 写入前会备份旧文件为 AGENTS.md.bak-<时间戳>。
`);
}

export async function agentsCommand(args: string[]): Promise<void> {
  const flags = new Set(args);
  if (flags.has("--help") || flags.has("-h")) {
    printHelp();
    return;
  }
  const allowed = new Set(["--dry-run", "-n", "--yes", "-y"]);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) {
    process.stdout.write(
      `${ansi.red}未知参数：${unknown.join(" ")}${ansi.reset}\n` +
        `${ansi.gray}用法：xzh agents.md [--dry-run] [--yes]${ansi.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const dryRun = flags.has("--dry-run") || flags.has("-n");
  const yes = flags.has("--yes") || flags.has("-y");
  const cwd = process.cwd();

  let draft;
  try {
    const config = loadConfig();
    // 与 TUI 启动一致：如果用户配置了可用代理，模型请求也走代理。
    applyProxyConfig(config);
    draft = await generateAgentsRewrite(
      cwd,
      config,
      activeModelEntry(config),
    );
  } catch (err) {
    process.stdout.write(
      `${ansi.red}生成 AGENTS.md 失败：${
        err instanceof Error ? err.message : String(err)
      }${ansi.reset}\n` +
        `${ansi.gray}请检查当前模型配置，或先运行 xzh model。${ansi.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `\n${ansi.bold}${draft.existing ? "重写" : "新建"} AGENTS.md${ansi.reset} ` +
      `${ansi.gray}（${draft.facts.fileCount} 个文件 · ${draft.facts.directories.length} 个顶层目录）${ansi.reset}\n`,
  );
  const preview =
    draft.content.length > 5_000
      ? `${draft.content.slice(0, 5_000)}\n…（已截断）`
      : draft.content;
  process.stdout.write(`\n${preview}\n`);

  if (dryRun) {
    process.stdout.write(
      `${ansi.gray}\n预览结束，未写入文件。去掉 --dry-run 才会写入。${ansi.reset}\n`,
    );
    return;
  }

  if (!yes) {
    const approved = await promptConfirm(
      `${draft.existing ? "将覆盖" : "将创建"} ${draft.targetPath}，继续？`,
      !draft.existing,
    );
    if (!approved) {
      process.stdout.write(`${ansi.gray}已取消，未修改 AGENTS.md。${ansi.reset}\n`);
      return;
    }
  }

  try {
    const result = writeAgentsFile(cwd, draft.content);
    process.stdout.write(
      `${ansi.green}✓ 已写入 ${result.target}${ansi.reset}\n` +
        (result.backup
          ? `${ansi.gray}  备份：${result.backup}${ansi.reset}\n`
          : ""),
    );
  } catch (err) {
    process.stdout.write(
      `${ansi.red}写入失败：${
        err instanceof Error ? err.message : String(err)
      }${ansi.reset}\n`,
    );
    process.exitCode = 1;
  }
}
