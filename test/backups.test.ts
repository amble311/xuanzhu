import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshotForUndo, undoLastChange } from "../src/utils/backups";

describe("文件修改的撤销快照", () => {
  let home: string;
  let cwd: string;
  let target: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-backups-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-project-"));
    process.env.XZH_HOME = home;
    target = path.join(cwd, "sample.txt");
    fs.writeFileSync(target, "原始内容");
  });

  afterEach(() => {
    delete process.env.XZH_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("覆盖已有文件后可撤销，恢复为修改前的内容", () => {
    snapshotForUndo(target, cwd);
    fs.writeFileSync(target, "被玄猪改坏的内容");
    expect(fs.readFileSync(target, "utf8")).toBe("被玄猪改坏的内容");

    const message = undoLastChange(cwd);
    expect(message).toContain("已撤销");
    expect(fs.readFileSync(target, "utf8")).toBe("原始内容");
  });

  it("新建文件的撤销语义是删除", () => {
    const created = path.join(cwd, "created.txt");
    // 文件不存在 → 记录 backup: null（撤销 = 删除）
    snapshotForUndo(created, cwd);
    fs.writeFileSync(created, "新建的内容");

    const message = undoLastChange(cwd);
    expect(message).toContain("删除");
    expect(fs.existsSync(created)).toBe(false);
  });

  it("可以连续撤销多步", () => {
    snapshotForUndo(target, cwd);
    fs.writeFileSync(target, "第二次内容");
    snapshotForUndo(target, cwd);
    fs.writeFileSync(target, "第三次内容");

    expect(undoLastChange(cwd)).toContain("已撤销");
    expect(fs.readFileSync(target, "utf8")).toBe("第二次内容");
    expect(undoLastChange(cwd)).toContain("已撤销");
    expect(fs.readFileSync(target, "utf8")).toBe("原始内容");
  });

  it("没有可撤销记录时给出提示", () => {
    expect(undoLastChange(cwd)).toContain("没有可撤销的修改");
  });

  it("清单超过保留上限时裁掉最旧的", () => {
    // 连续 60 次快照，只保留最近 50 条
    for (let i = 0; i < 60; i++) {
      fs.writeFileSync(target, `内容 v${i}`);
      snapshotForUndo(target, cwd);
    }

    let undone = 0;
    for (;;) {
      const message = undoLastChange(cwd);
      if (message.includes("没有可撤销的修改")) break;
      // 每次撤销都必须成功 —— 快照名带序号，不会因同名覆盖而丢失
      expect(message).not.toContain("撤销失败");
      undone++;
      if (undone > 60) break; // 防御：避免测试挂死
    }
    expect(undone).toBe(50);
    // 只保留最近 50 份快照：最老的 10 份（v0..v9）已被裁掉，撤销到底恢复的是 v10
    expect(fs.readFileSync(target, "utf8")).toBe("内容 v10");
  });
});
