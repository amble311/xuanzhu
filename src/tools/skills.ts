import { discoverSkills, findSkill, loadSkillContent } from "../skills";
import { getSkillRequirements } from "../skills/dependencies";
import { ensureSkillRequirements } from "../skills/installer";
import type { ToolDefinition, ToolResult } from "./types";

/** list_skills —— 列出可用技能 */
export const listSkillsTool: ToolDefinition = {
  name: "list_skills",
  description:
    "列出玄猪当前可用的全部技能（名称与用途）。" +
    "技能是一份指导你使用特定外部 CLI 工具的指南。" +
    "当任务可能涉及某个领域（浏览器自动化、Office 文档、GitHub、数据库等）时，先调用本工具查看是否有对应技能。",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute(_args, _ctx): Promise<ToolResult> {
    const skills = discoverSkills();
    if (skills.length === 0) {
      return { ok: true, content: "当前没有可用技能。" };
    }
    const lines = skills.map((skill) => {
      const mark = skill.source === "user" ? "（用户）" : "";
      return `- ${skill.name}${mark}：${skill.description || "（无描述）"}`;
    });
    return {
      ok: true,
      content: `可用技能（${skills.length} 个）：\n${lines.join("\n")}`,
      summary: `${skills.length} 个技能`,
    };
  },
};

/** load_skill —— 加载技能指南，并确保其外部依赖已安装 */
export const loadSkillTool: ToolDefinition = {
  name: "load_skill",
  description:
    "加载指定技能的完整指南（SKILL.md 全文），随后请严格按指南中的步骤与命令操作。" +
    "若该技能依赖的外部命令尚未安装，玄猪会自动安装（可能需要用户确认一次）。" +
    "指南在本次对话中持续有效，同一个技能无需重复加载。",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "技能名称，例如 playwright、officecli",
      },
    },
    required: ["name"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const name = typeof args.name === "string" ? args.name : "";
    if (!name.trim()) {
      return { ok: false, content: "错误：缺少技能名称参数 name。" };
    }

    const skill = findSkill(name);
    if (!skill) {
      const available = discoverSkills()
        .map((item) => item.name)
        .join(", ");
      return {
        ok: false,
        content: `未找到技能 "${name}"。可用技能：${available || "（无）"}。可先调用 list_skills 查看。`,
      };
    }

    // 依赖检查与自动安装
    const notes: string[] = [];
    if (getSkillRequirements(skill.name).length > 0) {
      const report = await ensureSkillRequirements(skill.name, {
        signal: ctx.signal,
        onOutput: (line) => ctx.emit?.(line),
        confirm: async (requirement, command) => {
          if (ctx.autoApprove) return true;
          if (!ctx.confirm) return false;
          return ctx.confirm({
            tool: "load_skill",
            title: `安装技能依赖：${requirement.name}`,
            detail:
              `技能「${skill.name}」需要该命令，是否现在自动安装？\n\n${command}`,
            danger: true,
          });
        },
      });

      for (const item of report.installed) notes.push(`✓ 已安装并验证：${item}`);
      for (const item of report.skipped) notes.push(`⚠ 未安装（已跳过）：${item}`);
      for (const item of report.failed) notes.push(`✗ 安装失败：${item}`);
    }

    const content = loadSkillContent(skill);
    const noteBlock =
      notes.length > 0
        ? `> 依赖处理：\n${notes.map((note) => `> ${note}`).join("\n")}\n\n`
        : "";
    const installedCount = notes.filter((note) => note.startsWith("✓")).length;

    return {
      ok: true,
      content: `# 技能：${skill.name}\n\n${noteBlock}${content}`,
      summary:
        installedCount > 0
          ? `已加载 ${skill.name}（安装 ${installedCount} 项依赖）`
          : `已加载技能 ${skill.name}`,
    };
  },
};
