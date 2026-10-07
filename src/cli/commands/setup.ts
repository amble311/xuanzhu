import {
  getSkillRequirements,
  skillsWithRequirements,
  currentPlatform,
} from "../../skills/dependencies";
import { installRequirement, isRequirementMet } from "../../skills/installer";
import { ansi } from "../../utils/ansi";
import { promptConfirm } from "../prompt";

/**
 * `xzh setup` —— 检查并自动安装内置技能所需的外部 CLI。
 * 使安装玄猪后无需再单独安装这些工具。
 */
export async function setupCommand(): Promise<void> {
  const platform = currentPlatform();
  process.stdout.write(
    `\n${ansi.bold}玄猪技能依赖检查${ansi.reset} ${ansi.gray}(平台：${platform})${ansi.reset}\n\n`,
  );

  const installedNow: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  let checked = 0;

  for (const skillName of skillsWithRequirements()) {
    for (const requirement of getSkillRequirements(skillName)) {
      checked++;
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
          `  ${ansi.gray}所属技能：${skillName}${ansi.reset}\n` +
          `  ${ansi.gray}安装命令：${ansi.reset}${command}\n`,
      );

      const approved = await promptConfirm("  是否现在安装？", true);
      if (!approved) {
        skipped.push(requirement.name);
        continue;
      }

      const result = await installRequirement(
        requirement,
        platform,
        undefined,
        (line) => process.stdout.write(`${ansi.gray}    ${line}${ansi.reset}\n`),
      );

      if (result.ok) {
        process.stdout.write(`${ansi.green}  ✓ ${requirement.name} 安装完成${ansi.reset}\n`);
        installedNow.push(requirement.name);
      } else {
        process.stdout.write(`${ansi.red}  ✗ ${requirement.name} 安装失败${ansi.reset}\n`);
        failed.push(requirement.name);
      }
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
  if (checked === 0) {
    process.stdout.write(`  ${ansi.gray}没有声明外部依赖的内置技能。${ansi.reset}\n`);
  } else if (installedNow.length === 0 && skipped.length === 0 && failed.length === 0) {
    process.stdout.write(`  ${ansi.green}所有技能依赖均已就绪。${ansi.reset}\n`);
  }
  process.stdout.write("\n");
}
