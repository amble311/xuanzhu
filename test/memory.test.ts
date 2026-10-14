import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  compactLongTermMemory,
  readProjectMemory,
  resolveProjectPaths,
} from "../src/workspace";

/**
 * 长期记忆精简（`compactLongTermMemory`）的回归测试。
 *
 * 目标形态是「文首维护说明 + 按主题整理的稳定小节 + 可选的 `## 时间戳` 追加块」，
 * 因此自动裁剪**只能删追加块**：主题小节的顺序是重要性而非时间，自动删掉等于
 * 静默抹掉项目事实（旧实现是从第 1 个块开始 shift，会先把主题小节删光）。
 *
 * 注：记忆写在临时项目目录里，不触碰 `~/.xzh` 与用户真实项目。
 */

const tmpProject = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), "xzh-memory-"));

const writeLongTerm = (cwd: string, text: string): string => {
  const file = resolveProjectPaths(cwd).longTermFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  return file;
};

const readLongTerm = (cwd: string): string =>
  readProjectMemory(cwd).longTerm;

const HEADER = "# 项目长期记忆\n\n> 本文件只留跨会话稳定的事实、口径与踩坑；最近整理 2026-10-13。";

const TOPIC_ENV = "## 环境与部署\n\n- 开发库＝生产库；改结构必须同步迁移脚本。\n- ⚠ 绝不在共享库上试删试改。";

const TOPIC_PERM = "## 权限机制\n\n- 判权唯一实现 `app/security/api_permission.py`；查不到即拒绝。\n- 角色权限真实来源是数据库 `角色映射表.api权限`。";

describe("长期记忆精简：只裁追加块", () => {
  it("超限时先丢弃最旧的追加块，主题小节完整保留", () => {
    const cwd = tmpProject();
    writeLongTerm(
      cwd,
      [
        HEADER,
        TOPIC_ENV,
        TOPIC_PERM,
        "## 2026-10-01 09:00\n\n- 早期结论甲：服务端口 8311。",
        "## 2026-10-02 09:00\n\n- 早期结论乙：前端 5173。",
      ].join("\n\n") + "\n",
    );

    const result = compactLongTermMemory(cwd, 200);
    expect(result).not.toBeNull();
    expect(result!.removedOldest).toBeGreaterThan(0);
    expect(result!.removedDuplicates).toBe(0);

    const after = readLongTerm(cwd);
    // 主题小节必须还在（旧实现会把它们当「最旧的块」删掉）
    expect(after).toContain("## 环境与部署");
    expect(after).toContain("## 权限机制");
    // 追加块被裁掉，且最新的追加块优先保留
    expect(after).not.toContain("## 2026-10-01 09:00");
    expect(after).toContain("## 2026-10-02 09:00");
  });

  it("只剩主题小节而仍然超限时：不裁剪、不改文件（交给 memory_compact）", () => {
    const cwd = tmpProject();
    const original =
      [HEADER, TOPIC_ENV, TOPIC_PERM].join("\n\n") + "\n";
    const file = writeLongTerm(cwd, original);

    const result = compactLongTermMemory(cwd, 200);
    expect(result).not.toBeNull();
    expect(result!.removedDuplicates).toBe(0);
    expect(result!.removedOldest).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it("主题小节本身就超限时，最新的追加块也要留下（刚写的结论不能被自动精简吃掉）", () => {
    const cwd = tmpProject();
    writeLongTerm(
      cwd,
      [
        HEADER,
        TOPIC_ENV,
        TOPIC_PERM,
        "## 2026-10-01 09:00\n\n- 早期结论甲：服务端口 8311。",
      ].join("\n\n") + "\n",
    );

    const result = compactLongTermMemory(cwd, 200);
    expect(result).not.toBeNull();
    expect(result!.removedOldest).toBe(0); // 唯一的追加块是最新的 → 不删

    const after = readLongTerm(cwd);
    expect(after).toContain("## 2026-10-01 09:00");
    expect(after).toContain("## 环境与部署");
  });

  it("去重对所有块生效（含主题小节），且不误删不同主题", () => {
    const cwd = tmpProject();
    writeLongTerm(
      cwd,
      [
        HEADER,
        TOPIC_ENV,
        TOPIC_ENV, // 完全重复的主题小节
        TOPIC_PERM,
        "## 2026-10-03 09:00\n\n- 结论丙：迁移命名 `<当前>_to_<新>.sql`。",
        "## 2026-10-04 09:00\n\n- 结论丙：迁移命名 `<当前>_to_<新>.sql`。", // 重复的追加块
      ].join("\n\n") + "\n",
    );

    const result = compactLongTermMemory(cwd, 100_000);
    expect(result).not.toBeNull();
    expect(result!.removedDuplicates).toBe(2);
    expect(result!.removedOldest).toBe(0); // 未超限，不裁剪

    const after = readLongTerm(cwd);
    expect(after.match(/## 环境与部署/g)).toHaveLength(1);
    expect(after.match(/结论丙/g)).toHaveLength(1);
    expect(after).toContain("## 权限机制");
  });
});
