import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  buildAgentsDraft,
  buildDocsScaffold,
  extractAgentsMarkdown,
  parseAgentsRewriteResponse,
  writeAgentsFile,
  writeDocsFiles,
} from "../src/init/agents-rewrite";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "xzh-agents-"));

describe("对话内 init 的模型完善辅助", () => {
  it("确定性草稿来自项目扫描事实", () => {
    const cwd = tmp();
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "demo-agents",
        version: "1.2.3",
        scripts: { test: "vitest run", build: "tsc" },
      }),
    );
    const draft = buildAgentsDraft(cwd);
    expect(draft.content).toContain("demo-agents");
    expect(draft.content).toContain("## 常用命令");
    expect(draft.content).toContain("## 文档同步");
    expect(draft.facts.fileCount).toBeGreaterThan(0);
  });

  it("去掉模型多余的代码围栏和前置说明", () => {
    expect(
      extractAgentsMarkdown("```markdown\n# Demo\n\n- 约定\n```"),
    ).toBe("# Demo\n\n- 约定\n");
    expect(
      extractAgentsMarkdown("以下是结果：\n\n# Demo\n\n- 约定\n"),
    ).toBe("# Demo\n\n- 约定\n");
  });

  it("解析 AGENTS 与 docs 更新，拒绝白名单外路径", () => {
    const parsed = parseAgentsRewriteResponse(`
<AGENTS>
# Demo
</AGENTS>
<DOC path="docs/README.md">
# 文档
</DOC>
<DOC path="../secret.md">
# 不应写入
</DOC>
`);
    expect(parsed.content).toBe("# Demo\n");
    expect(parsed.docs).toHaveLength(1);
    expect(parsed.docs[0].path).toBe("docs/README.md");
  });

  it("初始化 docs 脚手架并可写入", () => {
    const cwd = tmp();
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "npm test" } }),
    );
    const scaffold = buildDocsScaffold(cwd);
    expect(scaffold.map((doc) => doc.path)).toContain("docs/README.md");
    writeDocsFiles(cwd, scaffold);
    expect(fs.existsSync(path.join(cwd, "docs", "README.md"))).toBe(true);
  });

  it("覆盖已有 AGENTS.md 前生成备份", () => {
    const cwd = tmp();
    const target = path.join(cwd, "AGENTS.md");
    fs.writeFileSync(target, "# Old\n");
    const result = writeAgentsFile(cwd, "# New\n");
    expect(fs.readFileSync(target, "utf8")).toBe("# New\n");
    expect(result.backup).toBeTruthy();
    expect(fs.readFileSync(result.backup!, "utf8")).toBe("# Old\n");
  });
});
