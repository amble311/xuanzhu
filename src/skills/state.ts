import * as fs from "fs";
import * as path from "path";
import { ensureDir, getConfigDir } from "../utils/paths";

/**
 * 技能的启用 / 禁用状态，存放在全局目录的 `skills.json`。
 *
 * 为什么是「名字清单」而不是删目录：技能有两种来源 ——
 *   - 内置（随包分发，位于 dist/skills，重装 / 升级都会还原）；
 *   - 用户自建（~/.xzh/skills/<name>，归用户所有）。
 * 「禁用内置技能」不可能靠删文件实现，所以统一记名字；「删除」则只对用户技能生效。
 *
 * 与 `config.json` 分开的原因：config.json 是**模型配置**（provider / key / 模型列表），
 * 由 `xzh model` / `xzh config` 管理；技能状态自成一体，读写它的只有这里与 `xzh skill`，
 * 不给主配置增加结构（也不参与 config 的版本迁移）。
 */

export interface SkillState {
  version: number;
  /** 被禁用的技能名（匹配不区分大小写，见 isSkillDisabled） */
  disabled: string[];
}

export const SKILL_STATE_VERSION = 1;

export function getSkillStatePath(): string {
  return path.join(getConfigDir(), "skills.json");
}

/** 读取技能状态；文件缺失 / 损坏时返回默认值（损坏不报错 —— 状态丢了最多是全部恢复启用） */
export function loadSkillState(): SkillState {
  try {
    const raw = fs.readFileSync(getSkillStatePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<SkillState>;
    const disabled = Array.isArray(parsed.disabled)
      ? parsed.disabled.filter(
          (name): name is string => typeof name === "string" && name.trim() !== "",
        )
      : [];
    return { version: SKILL_STATE_VERSION, disabled };
  } catch {
    return { version: SKILL_STATE_VERSION, disabled: [] };
  }
}

export function saveSkillState(state: SkillState): void {
  ensureDir(getConfigDir());
  fs.writeFileSync(
    getSkillStatePath(),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

/** 全部被禁用的技能名 */
export function getDisabledSkillNames(): string[] {
  return loadSkillState().disabled;
}

/** 某技能当前是否被禁用（匹配不区分大小写） */
export function isSkillDisabled(name: string): boolean {
  const target = name.trim().toLowerCase();
  return loadSkillState().disabled.some((n) => n.toLowerCase() === target);
}

/**
 * 设置禁用 / 启用。
 * 返回是否真的发生了变化 —— 已经处于目标状态时为 `false`（不写盘），
 * 调用方据此给用户准确的反馈（「本来就是禁用的」vs「已禁用」）。
 */
export function setSkillDisabled(name: string, disabled: boolean): boolean {
  const state = loadSkillState();
  const target = name.trim().toLowerCase();
  const rest = state.disabled.filter((n) => n.toLowerCase() !== target);

  if (disabled) {
    if (rest.length !== state.disabled.length) return false; // 已在清单里
    saveSkillState({ version: SKILL_STATE_VERSION, disabled: [...rest, name.trim()] });
    return true;
  }

  if (rest.length === state.disabled.length) return false; // 本来就不在
  saveSkillState({ version: SKILL_STATE_VERSION, disabled: rest });
  return true;
}
