import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  gatewayHome,
  gatewayPaths,
  isDefaultGatewayHome,
} from "../src/gateway/paths";
import { commandHelpLines } from "../src/core/help-text";
import {
  gatewayModeFile,
  isPidAlive,
  parseGatewayCommand,
  readGatewayMode,
  readGatewayState,
  systemdUnitFile,
  writeGatewayMode,
  writeGatewayState,
} from "../src/gateway/service";

describe("gateway", () => {
  let home: string;
  const origin = process.env.XZH_GATEWAY_HOME;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-gw-"));
    process.env.XZH_GATEWAY_HOME = home;
  });

  afterEach(() => {
    if (origin === undefined) delete process.env.XZH_GATEWAY_HOME;
    else process.env.XZH_GATEWAY_HOME = origin;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("目录可用环境变量重定向，且能识别「默认目录」", () => {
    expect(gatewayHome()).toBe(path.resolve(home));
    // 临时目录不是默认目录 → 不该去改写 systemd
    expect(isDefaultGatewayHome()).toBe(false);
    const paths = gatewayPaths();
    expect(paths.stateFile).toBe(path.join(path.resolve(home), "run", "gateway.json"));
    expect(paths.logFile).toBe(path.join(path.resolve(home), "logs", "gateway.log"));
  });

  it("状态文件写读一致，坏文件返回 null（不抛）", () => {
    const { run, stateFile } = gatewayPaths();
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(stateFile, "{ not json", "utf8");
    expect(readGatewayState()).toBeNull();

    writeGatewayState(
      {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: "test",
        cwd: home,
        port: 17890,
      },
      home,
    );
    const state = readGatewayState(home);
    expect(state?.pid).toBe(process.pid);
    expect(state?.port).toBe(17890);
  });

  it("pid 存活判断：自己活着，0/负数/非法值一律当死", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });

  it("systemd unit 带 Restart=always 与工作目录（常驻语义）", () => {
    const unit = systemdUnitFile("/usr/bin/node", "/opt/xzh/cli.js", "/home/u/.xzh_gateway");
    expect(unit).toContain("WorkingDirectory=/home/u/.xzh_gateway");
    expect(unit).toContain('ExecStart="/usr/bin/node" "/opt/xzh/cli.js" gateway run');
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("TimeoutStopSec=10");
  });

  it("解析对话内命令：/btc、/btc moni、/a、/xzh，普通文本返回 null", () => {
    expect(parseGatewayCommand("你好")).toBeNull();
    expect(parseGatewayCommand("  /a ")).toEqual({ kind: "a" });
    expect(parseGatewayCommand("/btc")).toEqual({ kind: "btc", paper: false });
    expect(parseGatewayCommand("/btc moni")).toEqual({ kind: "btc", paper: true });
    expect(parseGatewayCommand("/btc paper")).toEqual({ kind: "btc", paper: true });
    expect(parseGatewayCommand("/a")).toEqual({ kind: "a" });
    expect(parseGatewayCommand("/xzh")).toEqual({ kind: "xzh" });
    expect(parseGatewayCommand("/btc off")).toEqual({ kind: "xzh" });
    expect(parseGatewayCommand("/a off")).toEqual({ kind: "xzh" });
    expect(parseGatewayCommand("/help")).toEqual({ kind: "help" });
    expect(parseGatewayCommand("/info")).toEqual({ kind: "info" });
    expect(parseGatewayCommand("/nope")).toMatchObject({ kind: "usage" });
    // 中文输入法的全角斜杠也认作命令
    expect(parseGatewayCommand("／btc moni")).toEqual({ kind: "btc", paper: true });
    expect(parseGatewayCommand("／help")).toEqual({ kind: "help" });
  });

  it("/help 使用与 xzh 一致的帮助文本（含模式切换条目）", () => {
    const lines = commandHelpLines();
    expect(lines.length).toBeGreaterThan(30);
    expect(lines.some((line) => line.includes("/btc [moni]"))).toBe(true);
    expect(lines.some((line) => line.includes("xzh a serve"))).toBe(true);
  });

  it("模式持久化：写读一致，坏文件 / 非法模式返回 null", () => {
    writeGatewayMode({ name: "btc", paper: true });
    expect(readGatewayMode()).toEqual({ name: "btc", paper: true });

    writeGatewayMode({ name: "a" });
    expect(readGatewayMode()).toEqual({ name: "a" });

    fs.writeFileSync(gatewayModeFile(), "{ bad", "utf8");
    expect(readGatewayMode()).toBeNull();

    writeGatewayMode(null);
    expect(readGatewayMode()).toBeNull();
  });
});
