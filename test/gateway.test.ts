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
import { createDeduper, DEDUP_TTL_MS, TEXT_DEDUP_MS } from "../src/gateway/weixin/channel";
import { assertSendOk } from "../src/gateway/weixin/client";
import {
  gatewayModeFile,
  isPidAlive,
  parseGatewayCommand,
  readGatewayMode,
  readGatewayState,
  readPeerModes,
  sameGatewayMode,
  writePeerMode,
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

  it("iLink 发送必须检查业务码，HTTP 200 也可能失败", () => {
    // 回归：sendmessage 返回 HTTP 200 + ret/errcode 非 0，曾被视为已送达
    expect(() => assertSendOk({})).not.toThrow();
    expect(() => assertSendOk({ ret: 0, errcode: 0 })).not.toThrow();
    expect(() => assertSendOk({ ret: -2, errmsg: "rate limited" })).toThrow(
      /ret=-2/,
    );
    expect(() => assertSendOk({ errcode: -14 })).toThrow(/errcode=-14/);
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
    // 其余命令统一交给 gateway 的命令路由（与终端 /help 列表一致）
    expect(parseGatewayCommand("/reset")).toEqual({ kind: "raw", name: "reset", arg: "" });
    expect(parseGatewayCommand("/reset moni 200000")).toEqual({
      kind: "raw",
      name: "reset",
      arg: "moni 200000",
    });
    expect(parseGatewayCommand("/nope")).toEqual({ kind: "raw", name: "nope", arg: "" });
    // 中文输入法的全角斜杠也认作命令
    expect(parseGatewayCommand("／btc moni")).toEqual({ kind: "btc", paper: true });
    expect(parseGatewayCommand("／help")).toEqual({ kind: "help" });
  });

  it("/help 使用与 xzh 一致的帮助文本（含模式切换条目）", () => {
    const lines = commandHelpLines();
    expect(lines.length).toBeGreaterThan(30);
    expect(lines.some((line) => line.includes("/btc [moni]"))).toBe(true);
    expect(lines.some((line) => line.includes("xzh a start"))).toBe(true);
    expect(lines.some((line) => line.includes("xzh a stop"))).toBe(true);
    expect(lines.some((line) => line.includes("xzh a serve"))).toBe(false);
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

describe("微信对端模式", () => {
  it("模式等价判断：btc 实盘 / 模拟盘不算同一个，普通模式只认 null", () => {
    expect(sameGatewayMode(null, null)).toBe(true);
    expect(sameGatewayMode({ name: "a" }, { name: "a" })).toBe(true);
    expect(sameGatewayMode({ name: "a" }, { name: "btc", paper: true })).toBe(false);
    expect(sameGatewayMode({ name: "btc", paper: true }, { name: "btc", paper: false })).toBe(false);
    expect(sameGatewayMode({ name: "btc", paper: true }, { name: "btc", paper: true })).toBe(true);
  });

  it("按 peer 保存最后对话模式，重启可恢复", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-gw-peer-"));
    try {
      writePeerMode("user-a", { name: "btc", paper: true }, dir);
      writePeerMode("user-b", { name: "a" }, dir);
      const store = readPeerModes(dir);
      expect(store.lastPeer).toBe("user-b");
      expect(store.modes["user-a"]).toEqual({ name: "btc", paper: true });
      expect(store.modes["user-b"]).toEqual({ name: "a" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("微信消息去重", () => {
  it("没有 msgId 时按文本去重，但 3 秒后同一条命令可以再次处理", () => {
    let now = 1_000_000;
    const remember = createDeduper(() => now);
    // 同一个 /info：先处理一次
    expect(remember("text:peer:/info", TEXT_DEDUP_MS)).toBe(true);
    // 1 秒内再来一次 = iLink 重复投递，丢掉
    now += 1_000;
    expect(remember("text:peer:/info", TEXT_DEDUP_MS)).toBe(false);
    // 6 秒后再发（切模式后重发 /info）= 新的操作，必须处理
    now += 5_000;
    expect(remember("text:peer:/info", TEXT_DEDUP_MS)).toBe(true);
  });

  it("有 msgId 时 5 分钟内只处理一次", () => {
    let now = 0;
    const remember = createDeduper(() => now);
    expect(remember("id:42", DEDUP_TTL_MS)).toBe(true);
    now += 60_000;
    expect(remember("id:42", DEDUP_TTL_MS)).toBe(false);
    now += 5 * 60_000;
    expect(remember("id:42", DEDUP_TTL_MS)).toBe(true);
  });
});

describe("摘要箱与本地令牌", () => {
  // 每个用例自己建/删临时目录：共用一个父目录时，第一个用例的 afterEach
  // 会把父目录删掉，第二个用例 mkdtemp 就 ENOENT。
  let home = "";
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
    home = "";
  });

  it("摘要按条累加、渲染最近 N 条、清空后提示消失", async () => {
    const dig = await import("../src/gateway/digest");
    home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-digest-"));
    expect(dig.digestCount(home)).toBe(0);
    expect(dig.digestHint(home)).toBe("");

    dig.appendDigest(home, { source: "巡检", text: "601988 中国银行 持有" });
    dig.appendDigest(home, { source: "巡检", text: "601398 工商银行 持有" });
    expect(dig.digestCount(home)).toBe(2);
    expect(dig.digestHint(home)).toContain("2 轮");

    const rendered = dig.formatDigest(home, 1);
    expect(rendered).toContain("未推送的巡检摘要 2 条");
    expect(rendered).toContain("601398");
    expect(rendered).not.toContain("601988"); // 只显示最近 1 条

    dig.clearDigest(home);
    expect(dig.digestCount(home)).toBe(0);
    expect(dig.digestHint(home)).toBe("");
  });

  it("令牌落盘 0600，缺失时重建；请求头解析支持两种写法", async () => {
    const auth = await import("../src/gateway/auth");
    home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-auth-"));
    const token = auth.ensureHttpToken(home);
    expect(token.length).toBeGreaterThan(20);
    expect(auth.readHttpToken(home)).toBe(token);
    expect(fs.statSync(auth.httpTokenPath(home)).mode & 0o777).toBe(0o600);
    // 幂等：再取一次还是同一个，不会把已在用的令牌换掉
    expect(auth.ensureHttpToken(home)).toBe(token);

    const make = (headers: Record<string, string>): import("node:http").IncomingMessage =>
      ({ headers } as unknown as import("node:http").IncomingMessage);
    expect(auth.authorizeRequest(make({ authorization: `Bearer ${token}` }), token)).toBe(true);
    expect(auth.authorizeRequest(make({ "x-xzh-token": token }), token)).toBe(true);
    expect(auth.authorizeRequest(make({}), token)).toBe(false);
    expect(auth.authorizeRequest(make({ authorization: "Bearer wrong" }), token)).toBe(false);
  });
});

describe("对端并发与 btc 角色上下文", () => {
  it("同一个对端严格串行，不同对端可以并发", async () => {
    const { createPeerQueues } = await import("../src/gateway/queues");
    const queues = createPeerQueues();
    const events: string[] = [];
    const first = queues.run("a", async () => {
      events.push("a1-start");
      await new Promise((resolve) => setTimeout(resolve, 60));
      events.push("a1-end");
    });
    const second = queues.run("a", async () => {
      events.push("a2");
    });
    const other = queues.run("b", async () => {
      events.push("b-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push("b-end");
    });
    await Promise.all([first, second, other]);

    // 同对端：第二条必须等第一条结束
    expect(events.indexOf("a2")).toBeGreaterThan(events.indexOf("a1-end"));
    // 不同对端：B 不必等 A 的 60ms
    expect(events.indexOf("b-end")).toBeLessThan(events.indexOf("a1-end"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queues.pending("a")).toBe(false);
  });

  it("一条任务失败不会堵住同对端的后续任务", async () => {
    const { createPeerQueues } = await import("../src/gateway/queues");
    const queues = createPeerQueues();
    const failed = queues.run("x", async () => {
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");
    await expect(queues.run("x", async () => "ok")).resolves.toBe("ok");
  });

  it("btc 角色按任务隔离：并发时互不串，任务外回到 env 兜底", async () => {
    const { withBtcRole, currentBtcRole } = await import("../src/btc/role");
    const before = process.env.XZH_BTC_ROLE;
    process.env.XZH_BTC_ROLE = "live";
    try {
      const seen: string[] = [];
      await Promise.all([
        withBtcRole("paper", async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          seen.push(`paper:${currentBtcRole()}`);
        }),
        withBtcRole("live", async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          seen.push(`live:${currentBtcRole()}`);
        }),
      ]);
      expect(seen.sort()).toEqual(["live:live", "paper:paper"]);
      // 上下文外仍读 env（CLI / 后端守护进程是单角色进程）
      expect(currentBtcRole()).toBe("live");
    } finally {
      if (before === undefined) delete process.env.XZH_BTC_ROLE;
      else process.env.XZH_BTC_ROLE = before;
    }
  });
});

describe("systemd 托管判定", () => {
  it("只有 Linux + 默认目录 + 单元已安装且 enabled 才交给 systemctl", async () => {
    const { shouldDelegateToSystemd } = await import("../src/gateway/service");
    const base = {
      platform: "linux" as NodeJS.Platform,
      defaultHome: true,
      unitInstalled: true,
      unitEnabled: true,
    };
    expect(shouldDelegateToSystemd(base)).toBe(true);
    // 非 Linux（Windows 用注册表 + VBS / macOS 用 launchd）
    expect(shouldDelegateToSystemd({ ...base, platform: "win32" })).toBe(false);
    // 自定义目录 = 多实例调试，不能去动默认单元的 systemd
    expect(shouldDelegateToSystemd({ ...base, defaultHome: false })).toBe(false);
    // 没装单元 / 装了但没 enable：自己 spawn 才是对的
    expect(shouldDelegateToSystemd({ ...base, unitInstalled: false })).toBe(false);
    expect(shouldDelegateToSystemd({ ...base, unitEnabled: false })).toBe(false);
  });
});
