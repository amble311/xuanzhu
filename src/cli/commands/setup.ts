import {
  getSkillRequirements,
  runtimeRequirements,
  skillsWithRequirements,
  currentPlatform,
  type SkillRequirement,
} from "../../skills/dependencies";
import { installRequirement, isRequirementMet } from "../../skills/installer";
import { ansi } from "../../utils/ansi";
import { promptConfirm } from "../prompt";

/**
 * `xzh setup` —— 检查并自动安装玄猪需要的外部 CLI。
 *
 * 覆盖两类依赖：
 *   1. **玄猪自身**的功能依赖（目前是 Linux 读取系统剪贴板所需的 `xclip` /
 *      `wl-clipboard`，用于 Ctrl+V 粘贴图片）；
 *   2. **内置技能**声明的 CLI（playwright-cli、officecli 等）。
 * 使安装玄猪后无需再单独安装这些工具。
 */
export async function setupCommand(): Promise<void> {
  const platform = currentPlatform();
  process.stdout.write(
    `\n${ansi.bold}玄猪依赖检查${ansi.reset} ${ansi.gray}(平台：${platform})${ansi.reset}\n\n`,
  );

  // 自身依赖排在前面：它是「玄猪能不能粘贴图片」的前提，比技能更基础
  const items: Array<{ requirement: SkillRequirement; owner: string }> = [
    ...runtimeRequirements(platform).map((requirement) => ({
      requirement,
      owner: "玄猪（Ctrl+V 粘贴图片）",
    })),
    ...skillsWithRequirements().flatMap((skillName) =>
      getSkillRequirements(skillName).map((requirement) => ({
        requirement,
        owner: `技能 ${skillName}`,
      })),
    ),
  ];

  const installedNow: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];

  for (const { requirement, owner } of items) {
    if (await isRequirementMet(requirement)) {
      process.stdout.write(
        `${ansi.green}✓${ansi.reset} ${requirement.name} ${ansi.gray}已安装${ansi.reset}\n`,
      );
      continue;
    }

    const command = requirement.install[platform];
    if (!command) {
      process.stdout.write(
        `${ansi.yellow}⚠${ansi.reset} ${requirement.name} ${ansi.gray}当前平台无自动安装命令${ansi.reset}\n`,
      );
      skipped.push(requirement.name);
      continue;
    }

    process.stdout.write(
      `\n${ansi.yellow}●${ansi.reset} ${ansi.bold}${requirement.name}${ansi.reset} ${ansi.gray}未安装${ansi.reset}\n` +
        `  ${ansi.gray}所属：${owner}${ansi.reset}\n` +
        `  ${ansi.gray}安装命令：${ansi.reset}${command}\n`,
    );

    const approved = await promptConfirm("  是否现在安装？", true);
    if (!approved) {
      skipped.push(requirement.name);
      continue;
    }

    // interactive：把终端交给安装命令，sudo 才能正常提示输入密码
    // （xclip / wl-clipboard 这类系统包必须走这条路）
    const result = await installRequirement(
      requirement,
      platform,
      undefined,
      (line) => process.stdout.write(`${ansi.gray}    ${line}${ansi.reset}\n`),
      { interactive: true },
    );

    if (result.ok) {
      process.stdout.write(`${ansi.green}  ✓ ${requirement.name} 安装完成${ansi.reset}\n`);
      installedNow.push(requirement.name);
    } else {
      process.stdout.write(`${ansi.red}  ✗ ${requirement.name} 安装失败${ansi.reset}\n`);
      failed.push(requirement.name);
    }
  }

  process.stdout.write(`\n${ansi.bold}结果${ansi.reset}\n`);
  if (installedNow.length > 0) {
    process.stdout.write(
      `  ${ansi.green}已安装 ${installedNow.length} 项${ansi.reset}：${installedNow.join("、")}\n`,
    );
  }
  if (skipped.length > 0) {
    process.stdout.write(
      `  ${ansi.yellow}已跳过 ${skipped.length} 项${ansi.reset}：${skipped.join("、")}\n`,
    );
  }
  if (failed.length > 0) {
    // 有安装失败时置非零退出码，便于脚本 / CI 判定（其余子命令都这么做）
    process.exitCode = 1;
    process.stdout.write(
      `  ${ansi.red}失败 ${failed.length} 项${ansi.reset}：${failed.join("、")}\n`,
    );
  }
  if (items.length === 0) {
    process.stdout.write(`  ${ansi.gray}当前平台没有需要检查的依赖。${ansi.reset}\n`);
  } else if (installedNow.length === 0 && skipped.length === 0 && failed.length === 0) {
    process.stdout.write(`  ${ansi.green}所有依赖均已就绪。${ansi.reset}\n`);
  }
  process.stdout.write("\n");
}
