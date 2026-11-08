import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  getApksDir,
  getBackupsDir,
  getConfigPath,
  getCrashLogPath,
  getErrorsDir,
  getGlobalMemoryDir,
  getSessionLockPath,
  getSessionsDir,
  getSkillStatePath,
  getUserSkillsDir,
  migrateConfigLayout,
} from "../src/utils/paths";

/**
 * 全局目录布局（config / data / state / runtime）。
 *
 * 布局迁移是**破坏性操作的唯一入口**：漏搬一项，用户升级后就会「配置丢了 /
 * 会话没了」。用例必须在临时 XZH_HOME 里跑，不能碰真实目录。
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-layout-"));
const originalHome = process.env.XZH_HOME;
process.env.XZH_HOME = home;

const write = (rel: string, content = "x"): void => {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

const exists = (rel: string): boolean => fs.existsSync(path.join(home, rel));

beforeEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.XZH_HOME;
  else process.env.XZH_HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("全局目录布局", () => {
  it("各类路径落在 config / data / state / runtime / vault 下", () => {
    expect(getConfigPath()).toBe(path.join(home, "config", "config.json"));
    expect(getSkillStatePath()).toBe(path.join(home, "config", "skills.json"));
    expect(getUserSkillsDir()).toBe(path.join(home, "data", "skills"));
    expect(getGlobalMemoryDir()).toBe(path.join(home, "data", "memory"));
    expect(getSessionsDir()).toBe(path.join(home, "data", "sessions"));
    expect(getBackupsDir()).toBe(path.join(home, "data", "backups"));
    expect(getApksDir()).toBe(path.join(home, "data", "apks"));
    expect(getErrorsDir()).toBe(path.join(home, "state", "errors"));
    expect(getCrashLogPath()).toBe(path.join(home, "state", "crash.log"));
    expect(getSessionLockPath()).toBe(path.join(home, "runtime", "session.lock"));
  });

  it("旧平铺布局一次性搬进分类目录，vault 保持在根", () => {
    write("config.json", "{}");
    write("config.json.bak-1", "old");
    write("skills.json", '{"version":1}');
    write("skills/demo/SKILL.md", "# demo");
    write("memory/MEMORY.md", "# memory");
    write("sessions/project-abc/s1.jsonl", "{}");
    write("backups/project-abc/manifest.jsonl", "{}");
    write("apks/autojs6.apk", "apk");
    write("errors/report.json", "{}");
    write("crash.log", "crash");
    write("keys.log", "keys");
    write("session.lock", "{}");
    write("vault/key", "secret");

    const result = migrateConfigLayout();

    expect(result.migrated).toBe(true);
    expect(exists("config/config.json")).toBe(true);
    expect(exists("config/config.json.bak-1")).toBe(true);
    expect(exists("config/skills.json")).toBe(true);
    expect(exists("data/skills/demo/SKILL.md")).toBe(true);
    expect(exists("data/memory/MEMORY.md")).toBe(true);
    expect(exists("data/sessions/project-abc/s1.jsonl")).toBe(true);
    expect(exists("data/backups/project-abc/manifest.jsonl")).toBe(true);
    expect(exists("data/apks/autojs6.apk")).toBe(true);
    expect(exists("state/errors/report.json")).toBe(true);
    expect(exists("state/crash.log")).toBe(true);
    expect(exists("state/keys.log")).toBe(true);
    expect(exists("runtime/session.lock")).toBe(true);
    // 凭据保持在全局根下（0700，不参与同步）
    expect(exists("vault/key")).toBe(true);

    // 旧位置已清空，且写了布局标记
    expect(exists("config.json")).toBe(false);
    expect(exists("sessions")).toBe(false);
    expect(exists("config/layout.json")).toBe(true);

    // 幂等：再跑一次什么都不搬
    const second = migrateConfigLayout();
    expect(second.migrated).toBe(false);
    expect(second.moved).toEqual([]);
  });

  it("目标已存在时不覆盖，保留旧条目并跳过", () => {
    write("config.json", "old");
    write("config/config.json", "new");

    const result = migrateConfigLayout();

    expect(result.migrated).toBe(false);
    expect(fs.readFileSync(path.join(home, "config", "config.json"), "utf8")).toBe("new");
    // 旧的没被删，留给用户手工处理
    expect(fs.readFileSync(path.join(home, "config.json"), "utf8")).toBe("old");
  });
});
