import * as path from "path";
import { describe, expect, it } from "vitest";
import { btcPythonPath, btcPythonRelPath } from "../src/btc/bootstrap";
import {
  windowsAutostartCommand,
  windowsLauncherPath,
  windowsLauncherScript,
  windowsStopFilePath,
} from "../src/gateway/service";
import { buildSpawnPlan } from "../src/tui/terminal";

/**
 * Windows 兼容：两处路径 / shell 分支必须按平台解析。
 *
 * 这里不启动子进程，只验证「组装出来的命令与路径」——真正的 Windows 行为
 * 需要 windows CI 冒烟，单元测试保证分支不被改回去。
 */

describe("Windows 兼容", () => {
  it("btc venv 解释器按平台解析（Scripts\\python.exe vs bin/python）", () => {
    const saved = process.env.XZH_BTC_PYTHON;
    delete process.env.XZH_BTC_PYTHON;
    try {
      expect(btcPythonRelPath("win32")).toBe(path.join("venv", "Scripts", "python.exe"));
      expect(btcPythonRelPath("linux")).toBe(path.join("venv", "bin", "python"));
      expect(btcPythonRelPath("darwin")).toBe(path.join("venv", "bin", "python"));

      const home = path.join(path.sep === "\\" ? "C:\\users\\demo" : "/home/demo", ".xzh_btc");
      expect(btcPythonPath(home, "win32")).toBe(
        path.join(home, "venv", "Scripts", "python.exe"),
      );
      expect(btcPythonPath(home, "linux")).toBe(path.join(home, "venv", "bin", "python"));
    } finally {
      if (saved !== undefined) process.env.XZH_BTC_PYTHON = saved;
    }
  });

  it("终端面板在 Windows 用 cmd.exe 的 /d /s /c，而不是 -c", () => {
    expect(buildSpawnPlan("cmd.exe", "dir", "win32")).toEqual({
      file: "cmd.exe",
      args: ["/d", "/s", "/c", "dir"],
    });
  });

  it("POSIX 仍走 script 或 shell -c，命令始终出现在参数里", () => {
    const plan = buildSpawnPlan("/bin/bash", "ls -la", "linux");
    expect(plan.args).toContain("ls -la");
    expect(["script", "/bin/bash"]).toContain(plan.file);
  });

  it("gateway 的 Windows 自启用 wscript 隐藏启动器 + 停止标记", () => {
    const saved = process.env.XZH_GATEWAY_HOME;
    const home = path.join(path.sep === "\\" ? "C:\\users\\demo" : "/home/demo", ".xzh_gateway");
    process.env.XZH_GATEWAY_HOME = home;
    try {
      const vbs = windowsLauncherPath(home);
      expect(vbs).toBe(path.join(home, "run", "autostart.vbs"));
      expect(windowsStopFilePath(home)).toBe(path.join(home, "run", "autostart.stop"));

      const command = windowsAutostartCommand(home);
      expect(command).toContain("wscript.exe //B //Nologo");
      expect(command).toContain(vbs);

      const script = windowsLauncherScript("C:\\node\\node.exe", "C:\\xzh\\bin\\xzh.js", home);
      expect(script).toContain('CreateObject("WScript.Shell")');
      expect(script).toContain("gateway run");
      expect(script).toContain("Loop While Not fso.FileExists(stopFile)");
      expect(script).toContain("C:\\node\\node.exe");
      expect(script).toContain("C:\\xzh\\bin\\xzh.js");
    } finally {
      if (saved === undefined) delete process.env.XZH_GATEWAY_HOME;
      else process.env.XZH_GATEWAY_HOME = saved;
    }
  });
});
