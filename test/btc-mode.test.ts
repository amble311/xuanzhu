import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allModes, createBtcMode, findMode, modeForHome } from "../src/modes";
import { buildSystemPrompt } from "../src/core/prompt";
import { discoverSkills, parseFrontmatter } from "../src/skills";
import { TOOLS, toolVisibleInMode } from "../src/tools";
import {
  btcSetupNeeded,
  btcVenvMarkPath,
  ensureBtcAssets,
} from "../src/btc/bootstrap";
import { activeExchange, intervalMs } from "../src/exchange";
import {
  platformPath,
  readPlatformSetting,
  setPlatformSetting,
} from "../src/exchange/platform";
import {
  acquireBackendLock,
  backendPaths,
  liveBackend,
  releaseBackendLock,
  writeBackendState,
} from "../src/btc/daemon";
import {
  appendPolicy,
  clearPolicy,
  POLICY_MAX_CHARS,
  readPolicy,
  replacePolicy,
} from "../src/btc/policy";
import {
  computeNextCheck,
  MAX_CHECK_MINUTES,
  MAX_QUEUE_SIZE,
  MIN_CHECK_MINUTES,
  nextScheduledEntry,
  pushSchedule,
  removeSchedules,
  readScheduleQueue,
  takeDueSchedule,
} from "../src/btc/schedule";

describe("专用模式注册表", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-btc-mode-"));
    process.env.XZH_BTC_HOME = home;
  });

  afterEach(() => {
    delete process.env.XZH_BTC_HOME;
    delete process.env.XZH_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("btc 的工作目录可被 XZH_BTC_HOME 重定向，且不跟随 XZH_HOME", () => {
    process.env.XZH_HOME = "/tmp/xzh-unrelated-home";
    const mode = createBtcMode();
    // XZH_HOME 只该影响 ~/.xzh（模型配置），不该把交易数据目录一起搬走
    expect(mode.home).toBe(fs.realpathSync(path.resolve(home)));
    expect(mode.home).not.toContain("xzh-unrelated-home");
  });

  it("findMode 大小写不敏感，未注册的模式返回 undefined", () => {
    expect(findMode("btc")?.name).toBe("btc");
    expect(findMode("BTC")?.name).toBe("btc");
    expect(findMode("note")).toBeUndefined();
    expect(findMode(undefined)).toBeUndefined();
  });

  it("modeForHome 能把固定目录认回对应模式（xzh ~/.btc 与 xzh btc 等价）", () => {
    const target = fs.realpathSync(path.resolve(home));
    expect(modeForHome(target)?.name).toBe("btc");
    // 普通目录不匹配任何模式
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-plain-"));
    try {
      expect(modeForHome(other)).toBeUndefined();
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("btc 模式锁定工作目录，并带一段模式说明", () => {
    const mode = createBtcMode();
    expect(mode.cwdLocked).toBe(true);
    expect(mode.promptSection).toContain("不可");
    expect(mode.promptSection).toContain(mode.home);
    // 注册表里每个模式都必须有唯一名字，否则 CLI 会命中错的那个
    const names = allModes().map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("模式说明进入系统提示词，且在项目规则之前", () => {
    const mode = createBtcMode();
    const prompt = buildSystemPrompt(
      mode.home,
      undefined,
      "## 项目规则\n禁止裸奔",
      null,
      undefined,
      false,
      false,
      undefined,
      undefined,
      false,
      { modeSection: mode.promptSection },
    );
    expect(prompt).toContain("当前模式：BTC 量化交易");
    // 先说明「现在是什么场景」，再补充项目细节，避免项目规则盖过模式约束
    expect(prompt.indexOf("当前模式：BTC 量化交易")).toBeLessThan(
      prompt.indexOf("项目规则（AGENTS.md"),
    );
  });
});

describe("技能的模式归属（frontmatter: modes）", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-skill-modes-"));
    process.env.XZH_HOME = home;
  });

  afterEach(() => {
    delete process.env.XZH_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeSkill(name: string, frontmatter: string): void {
    const dir = path.join(home, "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\n${frontmatter}---\n正文`,
    );
  }

  it("支持行内数组 / 单值 / 块列表三种写法", () => {
    expect(parseFrontmatter("---\nmodes: [btc, note]\n---\n").meta.modes).toEqual([
      "btc",
      "note",
    ]);
    expect(parseFrontmatter("---\nmodes: BTC\n---\n").meta.modes).toEqual(["btc"]);
    expect(
      parseFrontmatter("---\nmodes:\n  - btc\n  - note\n---\n").meta.modes,
    ).toEqual(["btc", "note"]);
    expect(parseFrontmatter("---\nname: demo\n---\n").meta.modes).toEqual([]);
  });

  it("声明了 modes 的技能只在对应模式可见，普通模式不可见", () => {
    writeSkill("common-skill", "");
    writeSkill("btc-only", "modes: [btc]\n");
    writeSkill("note-only", "modes: [note]\n");

    expect(discoverSkills().map((s) => s.name)).toEqual(["common-skill"]);
    expect(discoverSkills({ mode: "btc" }).map((s) => s.name)).toEqual([
      "btc-only",
      "common-skill",
    ]);
    expect(discoverSkills({ mode: "note" }).map((s) => s.name)).toEqual([
      "common-skill",
      "note-only",
    ]);
  });

  it("includeAllModes 供 xzh skill 管理命令看全量", () => {
    writeSkill("btc-only", "modes: [btc]\n");
    expect(discoverSkills({ includeAllModes: true }).map((s) => s.name)).toContain(
      "btc-only",
    );
  });

  it("模式过滤与禁用标记互不影响", () => {
    writeSkill("btc-only", "modes: [btc]\n");
    fs.writeFileSync(
      path.join(home, "skills.json"),
      JSON.stringify({ version: 1, disabled: ["btc-only"] }),
    );
    expect(discoverSkills({ mode: "btc" })).toEqual([]);
    expect(
      discoverSkills({ mode: "btc", includeDisabled: true }).map((s) => s.name),
    ).toEqual(["btc-only"]);
  });
});

describe("工具的模式归属", () => {
  it("btc_* 只在 btc 模式可见，通用工具在所有模式可见", () => {
    const btcTools = TOOLS.filter((tool) => tool.name.startsWith("btc_"));
    expect(btcTools.map((tool) => tool.name)).toEqual([
      "btc_price",
      "btc_status",
      "btc_sync",
      "btc_signal",
      "btc_backtest",
      "btc_schedule",
      "btc_unschedule",
      "btc_policy",
      "btc_trigger",
      "btc_renew",
      "btc_paper_status",
      "btc_paper_open",
      "btc_paper_close",
      "btc_paper_cancel",
      "btc_paper_reset",
      "btc_order",
      "btc_orders",
      "btc_close",
      "btc_cancel",
      "btc_transfer_profit",
    ]);
    for (const tool of btcTools) {
      expect(toolVisibleInMode(tool, "btc")).toBe(true);
      // 普通会话既不下发也执行不了：避免每个通用会话背交易工具 schema
      expect(toolVisibleInMode(tool, undefined)).toBe(false);
      expect(toolVisibleInMode(tool, "note")).toBe(false);
    }

    const bash = TOOLS.find((tool) => tool.name === "bash");
    expect(bash).toBeTruthy();
    if (bash) {
      expect(toolVisibleInMode(bash, undefined)).toBe(true);
      expect(toolVisibleInMode(bash, "btc")).toBe(true);
    }
  });
});

describe("交易所适配层", () => {
  afterEach(() => {
    delete process.env.BTC_EXCHANGE;
    delete process.env.BTC_USE_FUTURES;
  });

  it("默认解析到币安，并把通用符号转成平台符号", () => {
    const { exchange, error } = activeExchange();
    expect(error).toBeUndefined();
    expect(exchange.id).toBe("binance");
    expect(exchange.toNativeSymbol("BTC/USDT")).toBe("BTCUSDT");
    expect(exchange.toNativeSymbol("btc-usdt")).toBe("BTCUSDT");
    // 口径说明必须写清楚（技能 references 与状态输出都引用它）
    expect(exchange.notes).toContain("UTC");
  });

  it("BTC_EXCHANGE 写了不存在的平台时不静默回退", () => {
    process.env.BTC_EXCHANGE = "okx";
    const result = activeExchange();
    // 回退只是为了让调用方还能取到 label，但必须带 error，工具层据此直接拒绝执行
    expect(result.error).toContain("okx");
    expect(result.error).toContain("binance");

    process.env.BTC_EXCHANGE = "BINANCE";
    expect(activeExchange().error).toBeUndefined();
  });

  it("platform.json 生效，且环境变量优先于它", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-btc-platform-"));
    try {
      // 没设置时用默认平台
      expect(activeExchange(home).source).toBe("default");
      expect(activeExchange(home).exchange.id).toBe("binance");

      setPlatformSetting("binance", home);
      expect(readPlatformSetting(home)).toBe("binance");
      expect(activeExchange(home).source).toBe("config");

      // 环境变量优先（CI / 多环境脚本要能临时覆盖）
      process.env.BTC_EXCHANGE = "binance";
      expect(activeExchange(home).source).toBe("env");
    } finally {
      delete process.env.BTC_EXCHANGE;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("platform.json 里写了未接入的平台时报错，不静默回退", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-btc-platform-"));
    try {
      fs.writeFileSync(
        platformPath(home),
        JSON.stringify({ version: 1, platform: "huobi" }),
      );
      const result = activeExchange(home);
      expect(result.error).toContain("huobi");
      expect(result.error).toContain("binance");
      // 仍然回退到默认实现，避免调用方拿到 undefined
      expect(result.exchange.id).toBe("binance");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("周期长度只由通用 interval 决定，与平台无关", () => {
    expect(intervalMs("1d")).toBe(86_400_000);
    expect(intervalMs("1h")).toBe(3_600_000);
  });
});

describe("巡检调度（队列 + 定时器）", () => {
  const now = Date.parse("2026-11-03T00:00:00Z");
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-btc-schedule-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const push = (minutes: number, reason: string, slot: "next" | "extra", origin: "inspect" | "manual") =>
    pushSchedule(home, { minutes, reason, slot, origin, now });

  it("没给计划时默认 60 分钟；太短夹到 10 分钟，太长夹到 12 小时", () => {
    const fallback = computeNextCheck({ now });
    expect(fallback.nextCheckAt.getTime() - now).toBe(60 * 60_000);
    expect(fallback.clamped).toBe(false);

    const short = computeNextCheck({ now, minutes: 1 });
    expect(short.nextCheckAt.getTime() - now).toBe(MIN_CHECK_MINUTES * 60_000);
    expect(short.clamped).toBe(true);

    const long = computeNextCheck({ now, minutes: 60 * 24 * 7 });
    expect(long.nextCheckAt.getTime() - now).toBe(MAX_CHECK_MINUTES * 60_000);
    expect(long.clamped).toBe(true);

    // 非法时间点退回默认
    const broken = computeNextCheck({ now, at: "明天早上" });
    expect(broken.nextCheckAt.getTime() - now).toBe(60 * 60_000);
    expect(broken.clamped).toBe(true);
  });

  it("「下一跳」只有一条：前台改期会顶掉后台那条", () => {
    const first = push(60, "一小时后", "next", "inspect");
    expect(first.size).toBe(1);

    // 用户对话后认为 30 分钟后更合适
    const changed = push(30, "用户要求提前到 30 分钟后", "next", "manual");
    expect(changed.replaced).toBe(1);
    expect(changed.replacedEntries[0].reason).toBe("一小时后");

    const queue = readScheduleQueue(home);
    expect(queue).toHaveLength(1);
    expect(queue[0].reason).toBe("用户要求提前到 30 分钟后");
    expect(queue[0].origin).toBe("manual");
  });

  it("额外检查点与下一跳并存，同一分钟去重", () => {
    push(60, "后台下一跳", "next", "inspect");
    push(20, "顺便看一眼", "extra", "manual");
    expect(readScheduleQueue(home)).toHaveLength(2);

    const again = push(20, "重复说了一次", "extra", "manual");
    expect(again.replaced).toBe(1);
    const queue = readScheduleQueue(home);
    expect(queue).toHaveLength(2);
    expect(queue.map((entry) => entry.reason)).toEqual([
      "重复说了一次",
      "后台下一跳",
    ]);
  });

  it("取到期：未到点不取；到期只取最早一条，取出即出队", () => {
    push(10, "第一条", "next", "inspect");
    push(20, "第二条", "extra", "manual");

    expect(takeDueSchedule(home, now + 5 * 60_000)).toBeNull();

    const first = takeDueSchedule(home, now + 11 * 60_000);
    expect(first?.reason).toBe("第一条");
    expect(readScheduleQueue(home).map((entry) => entry.reason)).toEqual([
      "第二条",
    ]);

    expect(takeDueSchedule(home, now + 21 * 60_000)?.reason).toBe("第二条");
    expect(readScheduleQueue(home)).toHaveLength(0);
  });

  it("撤销：默认撤下一跳，额外检查点保留；all 清空；按 id 精确撤销", () => {
    const next = push(60, "下一跳", "next", "inspect");
    const extra = push(20, "额外点", "extra", "manual");

    const removedNext = removeSchedules(home, {});
    expect(removedNext.removed.map((entry) => entry.id)).toEqual([
      next.entry.id,
    ]);
    expect(removedNext.remaining).toBe(1);

    // 按 id 撤销剩下那条
    const removedById = removeSchedules(home, { id: extra.entry.id });
    expect(removedById.removed).toHaveLength(1);
    expect(readScheduleQueue(home)).toHaveLength(0);

    // 撤空之后再撤不报错
    expect(removeSchedules(home, { scope: "all" }).removed).toHaveLength(0);
  });

  it("队列超过上限时丢弃最远的", () => {
    const total = MAX_QUEUE_SIZE + 3;
    for (let i = 1; i <= total; i++) {
      push(10 + i, `第 ${i} 条`, "extra", "manual");
    }
    const queue = readScheduleQueue(home);
    expect(queue).toHaveLength(MAX_QUEUE_SIZE);
    expect(queue[0].reason).toBe("第 1 条");
    expect(queue.some((entry) => entry.reason === `第 ${total} 条`)).toBe(false);
  });
});

describe("btc 常驻后端（进程锁）", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-btc-daemon-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("只有 pid 指向活进程才算在跑，死进程的残留会被清掉", () => {
    expect(liveBackend(home)).toBeNull();

    // 2^31-1 不存在于任何系统，模拟「崩溃后留下的状态文件」
    writeBackendState(home, {
      pid: 2_147_483_647,
      startedAt: "2026-11-03T00:00:00Z",
      version: "0.0.0",
      home,
    });
    expect(liveBackend(home)).toBeNull();
    // 残留必须清掉，否则以后再也不会拉起新后端
    expect(fs.existsSync(backendPaths(home).stateFile)).toBe(false);

    writeBackendState(home, {
      pid: process.pid,
      startedAt: "2026-11-03T00:00:00Z",
      version: "0.0.0",
      home,
    });
    expect(liveBackend(home)?.pid).toBe(process.pid);
  });

  it("锁是原子的：第二次抢锁失败并报出持有者", async () => {
    expect((await acquireBackendLock(home)).ok).toBe(true);
    const second = await acquireBackendLock(home);
    expect(second.ok).toBe(false);
    expect(second.pid).toBe(process.pid);

    releaseBackendLock(home);
    expect(fs.existsSync(backendPaths(home).lockFile)).toBe(false);
    expect((await acquireBackendLock(home)).ok).toBe(true);
    releaseBackendLock(home);
  });

  it("持有者已死时能接管残留锁", async () => {
    fs.mkdirSync(backendPaths(home).dir, { recursive: true });
    fs.writeFileSync(backendPaths(home).lockFile, "2147483647");

    const result = await acquireBackendLock(home);
    expect(result.ok).toBe(true);
    releaseBackendLock(home);
  });
});

describe("决策指令（对话影响后台巡检）", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-btc-policy-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("追加一条带日期的指令，重复内容不重复写", () => {
    const now = new Date("2026-11-03T10:00:00Z");
    appendPolicy(home, "单笔风险不超过 1%", now);
    const text = readPolicy(home);
    expect(text).toContain("2026-11-03");
    expect(text).toContain("单笔风险不超过 1%");

    const again = appendPolicy(home, "单笔风险不超过 1%", now);
    expect(again.dropped).toBe(0);
    // 同一条说两遍不应该写两行
    expect(readPolicy(home).split("\n").filter((line) => line.includes("单笔风险")).length).toBe(1);
  });

  it("超过上限时丢弃最旧的条目，保留最新的", () => {
    for (let i = 0; i < 60; i++) {
      appendPolicy(home, `第 ${i} 条：${"很长的约束".repeat(20)}`, new Date("2026-11-03T10:00:00Z"));
    }
    const text = readPolicy(home);
    expect(text.length).toBeLessThanOrEqual(POLICY_MAX_CHARS);
    // 最新的必须还在，最早的要被丢掉
    expect(text).toContain("第 59 条");
    expect(text).not.toContain("第 0 条");
  });

  it("整份替换超长时保留末尾；清空后为空", () => {
    const long = `${"x".repeat(POLICY_MAX_CHARS)}尾部关键要求`;
    const result = replacePolicy(home, long);
    expect(result.truncated).toBe(true);
    expect(readPolicy(home).endsWith("尾部关键要求")).toBe(true);

    clearPolicy(home);
    expect(readPolicy(home)).toBe("");
  });
});

describe("两个后端角色互不干扰", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-btc-role-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("同一目录下，观察与模拟盘各有自己的锁与状态文件", async () => {
    const live = await acquireBackendLock(home, "live");
    const paper = await acquireBackendLock(home, "paper");
    expect(live.ok).toBe(true);
    // 同一个 home、不同角色：必须都能拿到锁，否则 moni 永远起不来
    expect(paper.ok).toBe(true);

    expect(backendPaths(home, "live").lockFile).not.toBe(
      backendPaths(home, "paper").lockFile,
    );
    expect(backendPaths(home, "live").stateFile).not.toBe(
      backendPaths(home, "paper").stateFile,
    );

    releaseBackendLock(home, "live");
    releaseBackendLock(home, "paper");
  }, 20_000);

  it("排期队列按角色分开，不会互相抢计划", () => {
    pushSchedule(home, { minutes: 30, reason: "观察的计划", origin: "manual" }, "live");
    expect(readScheduleQueue(home, "live")).toHaveLength(1);
    // 模拟盘队列必须是空的：否则两个后端会争抢同一条到期计划
    expect(readScheduleQueue(home, "paper")).toHaveLength(0);

    pushSchedule(home, { minutes: 45, reason: "模拟盘的计划", origin: "manual" }, "paper");
    expect(readScheduleQueue(home, "paper")).toHaveLength(1);
    expect(readScheduleQueue(home, "live")[0].reason).toBe("观察的计划");
  });
});

describe("btc 计算层 bootstrap", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-btc-assets-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("把随包计算脚本释放到 home，且重复调用不重复复制", () => {
    const first = ensureBtcAssets(home);
    expect(first.available).toBe(true);
    expect(first.copied).toBe(true);
    expect(fs.existsSync(path.join(home, "runner.py"))).toBe(true);
    expect(fs.existsSync(path.join(home, "core", "bt_engine.py"))).toBe(true);
    expect(fs.existsSync(path.join(home, "data"))).toBe(true);

    const second = ensureBtcAssets(home);
    expect(second.copied).toBe(false);
  });

  it("首次进入才需要准备环境，装好后只查标记（不每次起 python）", () => {
    expect(btcSetupNeeded(home)).toBe(true);

    ensureBtcAssets(home);
    // 脚本已释放，但没有「环境就绪」标记 —— 仍然需要跑一次 setup
    expect(btcSetupNeeded(home)).toBe(true);

    fs.writeFileSync(btcVenvMarkPath(home), "ok\n");
    expect(btcSetupNeeded(home)).toBe(false);
  });

  it("显式指定解释器时不由我们管理 venv", () => {
    process.env.XZH_BTC_PYTHON = "/usr/bin/python3";
    try {
      expect(btcSetupNeeded(home)).toBe(false);
    } finally {
      delete process.env.XZH_BTC_PYTHON;
    }
  });

  it("资产内容变化会重新同步（不依赖版本号）", () => {
    const src = path.join(home, "src-assets");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "runner.py"), "print('v1')\n");

    expect(ensureBtcAssets(home, { assetsDir: src }).copied).toBe(true);
    expect(fs.readFileSync(path.join(home, "runner.py"), "utf8")).toContain("v1");

    // 内容没变：不重复复制
    expect(ensureBtcAssets(home, { assetsDir: src }).copied).toBe(false);

    // 版本号没升、但内容变了（开发期最常见）：必须同步，
    // 否则 ~/.btc 里会一直是旧脚本（曾导致「未知命令 paper-status」）
    fs.writeFileSync(path.join(src, "runner.py"), "print('v2')\n");
    expect(ensureBtcAssets(home, { assetsDir: src }).copied).toBe(true);
    expect(fs.readFileSync(path.join(home, "runner.py"), "utf8")).toContain("v2");
  });

  it("旧版 stamp（没有内容指纹）会触发一次全量同步", () => {
    fs.writeFileSync(
      path.join(home, ".bootstrap.json"),
      JSON.stringify({ version: "0.8.9" }),
    );
    const result = ensureBtcAssets(home);
    expect(result.available).toBe(true);
    expect(result.copied).toBe(true);
    expect(fs.readFileSync(path.join(home, "runner.py"), "utf8")).toContain(
      "paper-status",
    );
  });

  it("上一版有、这一版删掉的资产文件会被清理，用户数据不受影响", () => {
    const src = path.join(home, "src-assets2");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "runner.py"), "print('x')\n");
    fs.writeFileSync(path.join(src, "paper.py"), "# paper\n");
    ensureBtcAssets(home, { assetsDir: src });
    expect(fs.existsSync(path.join(home, "paper.py"))).toBe(true);

    // 模拟升级时删掉了 paper.py
    fs.rmSync(path.join(src, "paper.py"));
    fs.writeFileSync(path.join(src, "runner.py"), "print('y')\n");
    ensureBtcAssets(home, { assetsDir: src });
    expect(fs.existsSync(path.join(home, "paper.py"))).toBe(false);

    // 用户数据仍在
    expect(fs.existsSync(path.join(home, "data"))).toBe(true);
  });

  it("不覆盖 home 里已有的数据与配置", () => {
    fs.writeFileSync(path.join(home, ".env"), "BTC_SYMBOL=ETH/USDT\n");
    fs.mkdirSync(path.join(home, "data"), { recursive: true });
    fs.writeFileSync(path.join(home, "data", "btc.db"), "keep");

    ensureBtcAssets(home);

    expect(fs.readFileSync(path.join(home, ".env"), "utf8")).toContain("ETH/USDT");
    expect(fs.readFileSync(path.join(home, "data", "btc.db"), "utf8")).toBe("keep");
  });
});
