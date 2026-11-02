import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { grepTool } from "../src/tools/filesystem";

/**
 * grep 的翻页。
 *
 * 命中上限以前只说「已达 200 条上限」，模型只能盲目缩小范围或换关键词；
 * 现在给出 `offset` 续读参数，并且**明确是第几条到第几条**。
 */
describe("grep 翻页", () => {
  const withHits = (count: number): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-grep-"));
    fs.writeFileSync(
      path.join(dir, "a.txt"),
      Array.from({ length: count }, (_, i) => `hit ${i}`).join("\n"),
      "utf8",
    );
    return dir;
  };

  it("命中超过上限时给出 next offset，翻页能读到后面的匹配", async () => {
    const cwd = withHits(250);
    const ctx = { cwd, autoApprove: true };

    const first = await grepTool.execute({ pattern: "^hit" }, ctx);
    expect(first.content).toContain("hit 0");
    expect(first.content).toContain("用 offset=200 继续");

    const second = await grepTool.execute({ pattern: "^hit", offset: 200 }, ctx);
    expect(second.content).toContain("hit 200");
    // 翻页是跳过前面的，不是重头再来
    expect(second.content).not.toContain("hit 0\n");
    expect(second.content).toContain("已跳过前 200 条");
  });

  it("offset 越过末尾时明确说没有更多，而不是返回空内容", async () => {
    const cwd = withHits(5);
    const result = await grepTool.execute({ pattern: "^hit", offset: 99 }, {
      cwd,
      autoApprove: true,
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("没有更多匹配");
  });
});
