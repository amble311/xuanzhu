import { execFileSync, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * TUI pty 冒烟测试：
 * - 用 util-linux 的 `script` 分配伪终端，启动真实 CLI；
 * - 只验证启动、头部渲染与 /exit，不依赖模型服务；
 * - 没有 `script` 的平台跳过（Windows / 部分 macOS）。
 *
 * 为什么放在测试里而不是只靠手工 pty：顶部布局、状态栏、启动初始化这些
 * 都是「单元测试覆盖不到、但一改就坏」的地方。
 */

const root = path.resolve(__dirname, "..");
const scriptVersion = spawnSync("script", ["--version"], {
  encoding: "utf8",
});
const hasScript =
  scriptVersion.status === 0 &&
  /util-linux/i.test(`${scriptVersion.stdout}${scriptVersion.stderr}`);

const ansiPattern = /\x1b\[[0-9;?]*[a-zA-Z]/g;

describe.skipIf(!hasScript)("TUI pty 冒烟", () => {
  let home: string;
  let project: string;

  beforeAll(() => {
    // 测试可能在没有 dist 的干净 checkout 里运行；这里现构建一次。
    execFileSync("node", ["esbuild.js"], { cwd: root, stdio: "ignore" });
    home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-tui-home-"));
    project = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-tui-project-"));
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        version: 1,
        provider: "custom",
        model: "fake",
        models: [
          {
            id: "custom/fake",
            provider: "custom",
            model: "fake",
            baseUrl: "http://127.0.0.1:1/v1",
          },
        ],
        intent: { enabled: false },
        providers: { custom: { model: "fake", baseUrl: "http://127.0.0.1:1/v1" } },
        autoApprove: true,
      }),
    );
  });

  afterAll(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
    if (project) fs.rmSync(project, { recursive: true, force: true });
  });

  it("启动后渲染头部，并能用 /exit 退出", async () => {
    const cli = path.join(root, "bin", "xzh.js");
    const result = await new Promise<{ status: number | null; output: string }>(
      (resolve) => {
        const child = spawn(
          "script",
          ["-qec", `node ${cli} ${project}`, "/dev/null"],
          {
            cwd: root,
            env: { ...process.env, XZH_HOME: home },
          },
        );
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
        });
        // 等 TUI 完成初始化、进入 raw mode 后再发 /exit；spawnSync 的
        // input 会在启动前就写进 pty，部分终端会直接丢掉。
        setTimeout(() => child.stdin.write("/exit\r"), 1_200);
        const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        child.on("close", (status) => {
          clearTimeout(timer);
          resolve({ status, output });
        });
      },
    );

    expect(result.status).toBe(0);
    const text = result.output.replace(ansiPattern, "");
    expect(text).toContain("玄猪 XuanZhu");
    expect(text).toContain("目录：");
    expect(text).toContain("输入 /help");
  });
});
