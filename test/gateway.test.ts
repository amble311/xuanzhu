import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  gatewayHome,
  gatewayPaths,
  isDefaultGatewayHome,
} from "../src/gateway/paths";
import {
  isPidAlive,
  readGatewayState,
  systemdUnitFile,
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
});
