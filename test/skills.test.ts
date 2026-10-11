import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverSkills,
  parseFrontmatter,
  setSkillDisabled,
} from "../src/skills";
import { loadSkillState } from "../src/skills/state";

describe("parseFrontmatter", () => {
  it("提取单行 name 与 description", () => {
    const { meta, body } = parseFrontmatter(
      '---\nname: demo\ndescription: 演示技能\n---\n\n# 正文\n',
    );
    expect(meta.name).toBe("demo");
    expect(meta.description).toBe("演示技能");
    expect(body).toBe("\n# 正文\n");
  });

  it("支持 YAML 块状 description（>）", () => {
    const { meta } = parseFrontmatter(
      "---\nname: demo\ndescription: >\n  第一行\n  第二行\n---\n正文",
    );
    expect(meta.description).toBe("第一行 第二行");
  });

  it("没有 frontmatter 时原样返回正文", () => {
    const { meta, body } = parseFrontmatter("没有元信息的内容");
    expect(meta.name).toBeUndefined();
    expect(body).toBe("没有元信息的内容");
  });
});

describe("技能启用 / 禁用状态", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-skills-"));
    process.env.XZH_HOME = home;
  });

  afterEach(() => {
    delete process.env.XZH_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("默认没有任何禁用项", () => {
    expect(loadSkillState().disabled).toEqual([]);
  });

  it("setSkillDisabled 可切换并持久化到 skills.json", () => {
    expect(setSkillDisabled("demo", true)).toBe(true);
    // 重复禁用返回 false（状态未变化）
    expect(setSkillDisabled("demo", true)).toBe(false);

    const file = path.join(home, "skills.json");
    expect(fs.existsSync(file)).toBe(true);
    expect(loadSkillState().disabled).toContain("demo");

    expect(setSkillDisabled("demo", false)).toBe(true);
    expect(loadSkillState().disabled).not.toContain("demo");
  });

  it("禁用匹配不区分大小写，但清单保留原始写法", () => {
    setSkillDisabled("Demo", true);
    expect(loadSkillState().disabled).toContain("Demo");
    // 小写同名再次禁用 = 状态未变化
    expect(setSkillDisabled("demo", true)).toBe(false);
  });

  it("discoverSkills 默认过滤掉禁用项，includeDisabled 可看全量", () => {
    // 造一个用户技能
    const dir = path.join(home, "skills", "demo-skill");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: 演示\n---\n正文",
    );

    expect(discoverSkills().map((s) => s.name)).toContain("demo-skill");
    setSkillDisabled("demo-skill", true);
    expect(discoverSkills().map((s) => s.name)).not.toContain("demo-skill");
    expect(
      discoverSkills({ includeDisabled: true }).map((s) => s.name),
    ).toContain("demo-skill");
  });
});
