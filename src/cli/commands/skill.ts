import * as fs from "fs";
import * as path from "path";
import { ansi, padEnd, truncate } from "../../utils/ansi";
import { getConfigDir } from "../../utils/paths";
import {
  discoverSkills,
  setSkillDisabled,
  type SkillInfo,
} from "../../skills";
import { promptConfirm, promptSelect } from "../prompt";

/** 列表里描述的最大显示宽度（宽度感知，中文按 2 计） */
const DESCRIPTION_LIMIT = 52;

/**
 * `xzh skill` —— 技能的启用 / 禁用 / 删除。
 *
 * 无参数时进入交互菜单；`list` / `enable` / `disable` / `delete` 是同一套能力的
 * 非交互形式（便于脚本与远程使用）。
 *
 * 状态存放在 `~/.xzh/skills.json`（见 src/skills/state.ts）：
 *   - **禁用**：往名字清单里记一笔，`list_skills` / `load_skill` 就不再看见它
 *     （内置技能删不掉，禁用是唯一的隐藏手段）；
 *   - **删除**：只对**用户技能**（~/.xzh/skills/<name>）生效 —— 内置技能随包分发、
 *     重装即还原，删除没有意义，一律引导改用禁用。
 */

export async function skillCommand(args: string[]): Promise<void> {
  const sub = args[0]?.trim().toLowerCase();

  switch (sub) {
    case undefined:
      await interactiveMenu();
      return;
    case "list":
    case "ls":
      printSkillTable(true);
      return;
    case "enable":
    case "on":
      await toggleCommand(args.slice(1), true);
      return;
    case "disable":
    case "off":
      await toggleCommand(args.slice(1), false);
      return;
    case "delete":
    case "remove":
    case "rm":
      await deleteCommand(args.slice(1));
      return;
    case "help":
    case "-h":
    case "--help":
      printSkillHelp();
      return;
    default:
      process.stdout.write(
        `${ansi.red}未知子命令：${args[0]}${ansi.reset}\n`,
      );
      printSkillHelp();
      process.exitCode = 1;
  }
}

// ------------------------------------------------------------------ 列表

function printSkillTable(includeDisabled: boolean): void {
  const skills = discoverSkills({ includeDisabled: true });
  const visible = discoverSkills();
  const builtin = skills.filter((s) => s.source === "builtin").length;
  const user = skills.length - builtin;

  const statePath = path.join(getConfigDir(), "skills.json");
  process.stdout.write(
    `\n${ansi.bold}玄猪技能列表${ansi.reset} ` +
      `${ansi.gray}(内置 ${builtin} · 用户 ${user} · ` +
      `已禁用 ${skills.length - visible.length} · ${statePath})${ansi.reset}\n`,
  );

  if (skills.length === 0) {
    process.stdout.write(
      `  ${ansi.yellow}没有发现任何技能。${ansi.reset}\n` +
        `  ${ansi.gray}把含 SKILL.md 的目录放进 ` +
        `${ansi.reset}~/.xzh/skills/<name>${ansi.gray} 即可。${ansi.reset}\n`,
    );
    return;
  }

  for (const skill of skills) {
    const disabled = !visible.some((v) => v.name === skill.name);
    const mark = disabled ? `${ansi.yellow}✗${ansi.reset}` : `${ansi.green}✓${ansi.reset}`;
    const source = skill.source === "user" ? `${ansi.cyan}用户${ansi.reset}` : "内置";
    const state = disabled ? `${ansi.gray}（已禁用）${ansi.reset} ` : "";
    // padEnd 用 ansi 的宽度感知版本：技能名可能是中文（宽度按 2 计），普通 padEnd 会错位；
    // ANSI 码要包在 padEnd 结果外面，否则转义序列会被算进宽度
    const padded = padEnd(skill.name, 22);
    const name = disabled
      ? `${ansi.gray}${padded}${ansi.reset}`
      : `${ansi.bold}${padded}${ansi.reset}`;
    process.stdout.write(
      `  ${mark} ${name} ${source}  ${state}${ansi.gray}${truncate(skill.description, DESCRIPTION_LIMIT)}${ansi.reset}\n`,
    );
  }
}

// ------------------------------------------------------------------ 启用 / 禁用

async function toggleCommand(args: string[], enable: boolean): Promise<void> {
  const verb = enable ? "启用" : "禁用";
  const name = args.find((arg) => !arg.startsWith("-"));

  if (name) {
    const skill = discoverSkills({ includeDisabled: true }).find(
      (s) => s.name.toLowerCase() === name.trim().toLowerCase(),
    );
    if (!skill) {
      process.stdout.write(
        `${ansi.red}未找到技能：${name}${ansi.reset}\n` +
          `${ansi.gray}运行 ${ansi.reset}xzh skill list${ansi.gray} 查看全部技能。${ansi.reset}\n`,
      );
      process.exitCode = 1;
      return;
    }
    applyToggle(skill, enable);
    return;
  }

  // 未给名字：交互式挑一个（启用 → 只列已禁用的；禁用 → 只列启用中的）
  const visible = new Set(discoverSkills().map((skill) => skill.name));
  const candidates = discoverSkills({ includeDisabled: true }).filter(
    (skill) => (enable ? !visible.has(skill.name) : visible.has(skill.name)),
  );
  if (candidates.length === 0) {
    process.stdout.write(
      `${ansi.yellow}没有可${verb}的技能。${ansi.reset}\n` +
        `${ansi.gray}运行 ${ansi.reset}xzh skill list${ansi.gray} 查看当前状态。${ansi.reset}\n`,
    );
    return;
  }

  const picked = await promptSelect(
    `选择要${verb}的技能：`,
    [
      ...candidates.map((skill) => ({
        label: skill.name,
        value: skill.name,
        hint: `${skill.source === "user" ? "用户" : "内置"} · ${truncate(skill.description, 36)}`,
      })),
      { label: "取消", value: "" },
    ],
    0,
  );
  if (!picked) return;
  const skill = candidates.find((s) => s.name === picked);
  if (skill) applyToggle(skill, enable);
}

function applyToggle(skill: SkillInfo, enable: boolean): void {
  const changed = setSkillDisabled(skill.name, !enable);
  if (!changed) {
    process.stdout.write(
      `${ansi.yellow}技能「${skill.name}」本来就处于${enable ? "启用" : "禁用"}状态。${ansi.reset}\n`,
    );
    return;
  }
  const verb = enable ? `${ansi.green}已启用${ansi.reset}` : `${ansi.yellow}已禁用${ansi.reset}`;
  process.stdout.write(
    `${verb}技能「${ansi.bold}${skill.name}${ansi.reset}」` +
      `${ansi.gray}(来源：${skill.source === "user" ? "用户" : "内置"})${ansi.reset}\n` +
      `${ansi.gray}${enable ? "list_skills / load_skill 现在可以看到它了。" : "list_skills / load_skill 不再看到它（随时可再启用）。"}${ansi.reset}\n`,
  );
}

// ------------------------------------------------------------------ 删除

async function deleteCommand(args: string[]): Promise<void> {
  const yes = args.some((arg) => arg === "--yes" || arg === "-y");
  const name = args.find((arg) => !arg.startsWith("-"));

  let skill: SkillInfo | undefined;
  if (name) {
    skill = discoverSkills({ includeDisabled: true }).find(
      (s) => s.name.toLowerCase() === name.trim().toLowerCase(),
    );
    if (!skill) {
      process.stdout.write(
        `${ansi.red}未找到技能：${name}${ansi.reset}\n` +
          `${ansi.gray}运行 ${ansi.reset}xzh skill list${ansi.gray} 查看全部技能。${ansi.reset}\n`,
      );
      process.exitCode = 1;
      return;
    }
  } else {
    const userSkills = discoverSkills({ includeDisabled: true }).filter(
      (s) => s.source === "user",
    );
    if (userSkills.length === 0) {
      process.stdout.write(
        `${ansi.yellow}没有可删除的用户技能${ansi.gray}（~/.xzh/skills/ 下没有自建技能）。${ansi.reset}\n` +
          `${ansi.gray}内置技能不可删除，如需隐藏请用 ${ansi.reset}xzh skill disable <名称>${ansi.gray}。${ansi.reset}\n`,
      );
      return;
    }
    const picked = await promptSelect(
      "选择要删除的用户技能：",
      [
        ...userSkills.map((s) => ({
          label: s.name,
          value: s.name,
          hint: s.dir,
        })),
        { label: "取消", value: "" },
      ],
      0,
    );
    if (!picked) return;
    skill = userSkills.find((s) => s.name === picked);
  }

  if (!skill) return;

  // 内置技能随包分发：删 dist 没有意义（重装 / 升级即还原），一律引导用禁用
  if (skill.source !== "user") {
    process.stdout.write(
      `${ansi.yellow}「${skill.name}」是内置技能，不能删除。${ansi.reset}\n` +
        `${ansi.gray}如需隐藏，运行 ${ansi.reset}xzh skill disable ${skill.name}${ansi.gray}。${ansi.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (
    !yes &&
    !(await promptConfirm(
      `删除用户技能「${skill.name}」（整个目录 ${skill.dir}，不可恢复）？`,
      false,
    ))
  ) {
    process.stdout.write(`${ansi.gray}已取消。${ansi.reset}\n`);
    return;
  }

  try {
    fs.rmSync(skill.dir, { recursive: true, force: true });
  } catch (err) {
    process.stdout.write(
      `${ansi.red}删除失败：${err instanceof Error ? err.message : String(err)}${ansi.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }

  // 若它曾因重名覆盖了某个内置技能，删除后内置版会重新可见 —— 顺手清掉禁用标记，
  // 避免「删了用户版、内置版却被记成禁用」的困惑
  setSkillDisabled(skill.name, false);

  process.stdout.write(
    `${ansi.green}已删除用户技能「${ansi.bold}${skill.name}${ansi.reset}${ansi.green}」。${ansi.reset}\n` +
      `${ansi.gray}目录：${skill.dir}${ansi.reset}\n` +
      `${ansi.gray}若它曾覆盖同名内置技能，该内置技能现已恢复可见。${ansi.reset}\n`,
  );
}

// ------------------------------------------------------------------ 交互菜单

async function interactiveMenu(): Promise<void> {
  // 交互菜单依赖方向键与逐次按键；stdin 关闭（管道 / < /dev/null）时
  // promptSelect 会回落为「默认选项」，而默认项是个动作 —— 菜单循环会永远转下去。
  // 与 `xzh`（startChat）一样：非 TTY 直接拒绝，并指路非交互子命令。
  if (!process.stdin.isTTY) {
    process.stdout.write(
      `${ansi.yellow}交互式技能管理需要 TTY。${ansi.reset}\n` +
        `${ansi.gray}非交互场景请用：${ansi.reset}xzh skill list${ansi.gray} / ` +
        `${ansi.reset}xzh skill enable|disable <名称>${ansi.gray} / ` +
        `${ansi.reset}xzh skill delete <名称> [--yes]${ansi.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }

  for (;;) {
    printSkillTable(true);

    const action = await promptSelect(
      "请选择操作：",
      [
        { label: "启用 / 禁用技能", value: "toggle", hint: "切换可见性" },
        { label: "删除技能（仅用户技能）", value: "delete", hint: "不可恢复" },
        { label: "退出", value: "exit" },
      ],
      0,
    );

    switch (action) {
      case "toggle":
        await toggleCommand([], true);
        break;
      case "delete":
        await deleteCommand([]);
        break;
      default:
        process.stdout.write(`\n${ansi.gray}已退出技能管理。${ansi.reset}\n`);
        return;
    }
  }
}

// ------------------------------------------------------------------ 帮助

function printSkillHelp(): void {
  process.stdout.write(
    [
      "",
      `${ansi.bold}用法${ansi.reset}`,
      `  ${ansi.green}xzh skill${ansi.reset}                     交互式管理技能（启用 / 禁用 / 删除）`,
      `  ${ansi.green}xzh skill list${ansi.reset}                列出全部技能（含已禁用项与来源）`,
      `  ${ansi.green}xzh skill enable <名称>${ansi.reset}        启用技能`,
      `  ${ansi.green}xzh skill disable <名称>${ansi.reset}       禁用技能（list_skills / load_skill 不再可见）`,
      `  ${ansi.green}xzh skill delete <名称> [--yes]${ansi.reset}`,
      `                            删除技能（仅限用户技能；内置技能请改用 disable）`,
      "",
      `${ansi.bold}说明${ansi.reset}`,
      `  状态保存在 ${ansi.gray}${path.join(getConfigDir(), "skills.json")}${ansi.reset}。`,
      "  禁用 = list_skills / load_skill 不再可见（可随时恢复）；",
      "  删除 = 从磁盘移除技能目录，仅对用户技能（~/.xzh/skills/<name>）生效。",
      "",
    ].join("\n"),
  );
}
