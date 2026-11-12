import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addTrigger,
  DEFAULT_TRIGGER_COOLDOWN_MIN,
  describeTrigger,
  evaluateTriggers,
  evaluateTriggersDetailed,
  inCooldown,
  indicatorKey,
  MAX_TRIGGER_EXPIRE_HOURS,
  MAX_TRIGGERS,
  readTriggers,
  recordEvaluation,
  removeTriggers,
  triggerFilePath,
  type Trigger,
} from "../src/btc/triggers";
import { appendTriggerAudit, readTriggerAudits } from "../src/btc/trigger-audit";

/**
 * 叫醒条件（触发器）。
 *
 * 这些规则的理由：
 * - 条件写错（RSI>500、价格≤0）不会报错但永远不命中，属于「静默失效」，必须挡住；
 * - 一次性条件命中后必须失效，否则每 5 分钟叫一次，变成烧钱循环；
 * - 过期条件要清理，否则文件里积一堆死条目，用户 `list` 时全是噪音。
 */
describe("叫醒条件", () => {
  let home: string;
  const now = Date.parse("2026-11-05T12:00:00Z");

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-btc-triggers-"));
    process.env.XZH_BTC_HOME = home;
  });

  afterEach(() => {
    delete process.env.XZH_BTC_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  describe("添加与校验", () => {
    it("写入价格条件并落到 run/triggers.json", () => {
      const result = addTrigger(
        home,
        {
          kind: "price",
          op: ">=",
          value: 80000,
          note: "到 8 万叫我看做空",
          sideHint: "short",
        },
        "live",
        now,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.trigger.once).toBe(true);
      expect(result.trigger.cooldownMin).toBe(DEFAULT_TRIGGER_COOLDOWN_MIN);
      expect(result.trigger.expiresAt).toBeDefined();
      expect(fs.existsSync(triggerFilePath(home, "live"))).toBe(true);
      expect(describeTrigger(result.trigger)).toContain("价格 >= 80000");
      expect(readTriggers(home, "live")).toHaveLength(1);
    });

    it("公式条件：写入校验（未知变量 / 下标 / 括号 / 缺表达式）", () => {
      const ok = addTrigger(
        home,
        {
          kind: "formula",
          op: ">=",
          value: 55,
          expression: "rsi_1h * 0.6 + adx_1h * 0.4",
        },
        "live",
        now,
      );
      expect(ok.ok).toBe(true);
      if (ok.ok) {
        expect(describeTrigger(ok.trigger)).toContain("公式 rsi_1h * 0.6 + adx_1h * 0.4");
      }

      const missing = addTrigger(
        home,
        { kind: "formula", op: ">=", value: 1 },
        "live",
        now,
      );
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error).toMatch(/expression/);

      const unknown = addTrigger(
        home,
        { kind: "formula", op: ">=", value: 1, expression: "rsi_1h + foo_1h" },
        "live",
        now,
      );
      expect(unknown.ok).toBe(false);
      if (!unknown.ok) expect(unknown.error).toMatch(/未知变量/);

      // 下标/字符串会让「公式」变成任意代码的入口，直接拒
      const subscript = addTrigger(
        home,
        { kind: "formula", op: ">=", value: 1, expression: "x[0]" },
        "live",
        now,
      );
      expect(subscript.ok).toBe(false);

      const unbalanced = addTrigger(
        home,
        { kind: "formula", op: ">=", value: 1, expression: "(rsi_1h + 1" },
        "live",
        now,
      );
      expect(unbalanced.ok).toBe(false);
      if (!unbalanced.ok) expect(unbalanced.error).toMatch(/括号/);
    });

    it("公式条件：值来自计算层，缺值时不命中", () => {
      const added = addTrigger(
        home,
        {
          kind: "formula",
          op: ">=",
          value: 55,
          expression: "rsi_1h * 0.6 + adx_1h * 0.4",
        },
        "live",
        now,
      );
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      const trigger = added.trigger;

      expect(
        evaluateTriggers([trigger], { formulas: { [trigger.id]: 62.5 }, now }),
      ).toHaveLength(1);
      expect(
        evaluateTriggers([trigger], { formulas: { [trigger.id]: 40 }, now }),
      ).toHaveLength(0);
      // 计算层没给值（求值失败）→ 不命中，而不是当成 0
      expect(evaluateTriggers([trigger], { formulas: {}, now })).toHaveLength(0);
    });

    it("链式条件：两步按顺序满足才叫醒，中间步只推进不叫醒", () => {
      const added = addTrigger(
        home,
        {
          kind: "chain",
          op: ">=",
          value: 0,
          steps: [
            { kind: "price", op: ">=", value: 80000 },
            { kind: "price", op: "<=", value: 79500 },
          ],
        },
        "live",
        now,
      );
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      const trigger = added.trigger;

      // 第一步未满足：不命中、不记录状态
      const first = evaluateTriggersDetailed([trigger], { price: 79000, now });
      expect(first.hits).toHaveLength(0);
      expect(first.states[trigger.id]).toBeUndefined();

      // 第一步满足：**不叫醒**，只把进度推进到第 2 步
      const armed = evaluateTriggersDetailed([trigger], { price: 80100, now });
      expect(armed.hits).toHaveLength(0);
      expect(armed.states[trigger.id]).toEqual({
        step: 1,
        armedAt: new Date(now).toISOString(),
      });

      // 带上进度：第二步满足 → 命中，进度重置
      const hit = evaluateTriggersDetailed(
        [{ ...trigger, chainState: armed.states[trigger.id] }],
        { price: 79400, now: now + 60_000 },
      );
      expect(hit.hits).toHaveLength(1);
      expect(hit.states[trigger.id]).toEqual({ step: 0 });
    });

    it("链式条件：前一步超过有效期就退回第一步（不拿旧信号拼假信号）", () => {
      const added = addTrigger(
        home,
        {
          kind: "chain",
          op: ">=",
          value: 0,
          steps: [
            { kind: "price", op: ">=", value: 80000 },
            { kind: "price", op: "<=", value: 79500 },
          ],
          chainExpireMin: 60,
        },
        "live",
        now,
      );
      if (!added.ok) throw new Error("add failed");
      const armed = {
        ...added.trigger,
        chainState: { step: 1, armedAt: new Date(now).toISOString() },
      };
      const late = evaluateTriggersDetailed([armed], {
        price: 79400,
        now: now + 61 * 60_000,
      });
      expect(late.hits).toHaveLength(0);
      expect(late.states[added.trigger.id]).toEqual({ step: 0 });
    });

    it("链式条件：步数不足/过多、缺数据不推进", () => {
      const two = [
        { kind: "price", op: ">=", value: 80000 },
        { kind: "price", op: "<=", value: 79500 },
      ];
      const one = addTrigger(
        home,
        { kind: "chain", op: ">=", value: 0, steps: two.slice(0, 1) },
        "live",
        now,
      );
      expect(one.ok).toBe(false);
      if (!one.ok) expect(one.error).toMatch(/2–3 步/);

      const four = addTrigger(
        home,
        { kind: "chain", op: ">=", value: 0, steps: [...two, ...two] },
        "live",
        now,
      );
      expect(four.ok).toBe(false);

      const bad = addTrigger(
        home,
        {
          kind: "chain",
          op: ">=",
          value: 0,
          steps: [{ kind: "price", op: ">=", value: -1 }, two[1]],
        },
        "live",
        now,
      );
      expect(bad.ok).toBe(false);

      // 链式条件里含指标步：缺数据时停在原处
      const withIndicator = addTrigger(
        home,
        {
          kind: "chain",
          op: ">=",
          value: 0,
          steps: [
            { kind: "indicator", op: "<=", value: 30, name: "rsi", timeframe: "1h" },
            { kind: "price", op: ">=", value: 80000 },
          ],
        },
        "live",
        now,
      );
      if (!withIndicator.ok) throw new Error("add failed");
      const missing = evaluateTriggersDetailed([withIndicator.trigger], {
        price: 79000,
        now,
      });
      expect(missing.hits).toHaveLength(0);
      expect(missing.states[withIndicator.trigger.id]).toBeUndefined();
    });

    it("链式条件的进度会写回文件（下一轮接着用）", () => {
      const added = addTrigger(
        home,
        {
          kind: "chain",
          op: ">=",
          value: 0,
          steps: [
            { kind: "price", op: ">=", value: 80000 },
            { kind: "price", op: "<=", value: 79500 },
          ],
        },
        "live",
        now,
      );
      if (!added.ok) throw new Error("add failed");
      const armedAt = new Date(now).toISOString();
      recordEvaluation(
        home,
        [added.trigger],
        { price: 80100, now },
        [],
        "live",
        { [added.trigger.id]: { step: 1, armedAt } },
      );
      const reloaded = readTriggers(home, "live");
      expect(reloaded[0].chainState).toEqual({ step: 1, armedAt });
    });

    it("拒绝永远不会命中的条件（负数价格、越界 RSI、非法 op）", () => {
      expect(
        addTrigger(home, { kind: "price", op: ">=", value: 0 }, "live", now).ok,
      ).toBe(false);
      expect(
        addTrigger(
          home,
          { kind: "indicator", name: "rsi", op: "<=", value: 120 },
          "live",
          now,
        ).ok,
      ).toBe(false);
      expect(
        addTrigger(
          home,
          { kind: "price", op: "==" as never, value: 100 },
          "live",
          now,
        ).ok,
      ).toBe(false);
      expect(readTriggers(home, "live")).toHaveLength(0);
    });

    it("同名条件不重复添加（模型被重复叮嘱时的高频情况）", () => {
      const first = addTrigger(home, { kind: "price", op: ">=", value: 80000 }, "live", now);
      const second = addTrigger(
        home,
        { kind: "price", op: ">=", value: 80000 },
        "live",
        now + 1000,
      );
      expect(first.ok && second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.duplicate).toBe(true);
      expect(readTriggers(home, "live")).toHaveLength(1);
    });

    it("上限 10 条，超了明确拒绝而不是默默丢一条", () => {
      for (let i = 0; i < MAX_TRIGGERS; i++) {
        const result = addTrigger(
          home,
          { kind: "price", op: ">=", value: 80000 + i },
          "live",
          now,
        );
        expect(result.ok).toBe(true);
      }
      const overflow = addTrigger(
        home,
        { kind: "price", op: ">=", value: 90000 },
        "live",
        now,
      );
      expect(overflow.ok).toBe(false);
      if (overflow.ok) return;
      expect(overflow.error).toContain(String(MAX_TRIGGERS));
    });

    it("失效时长被夹到上限，而不是照单全收", () => {
      const result = addTrigger(
        home,
        { kind: "price", op: ">=", value: 80000, expiresHours: 9999 },
        "live",
        now,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const expires = Date.parse(result.trigger.expiresAt ?? "");
      expect(expires - now).toBe(MAX_TRIGGER_EXPIRE_HOURS * 3_600_000);
    });

    it("时段窗口：只给一半或起止相同都拒绝（避免「看起来生效了」）", () => {
      expect(
        addTrigger(
          home,
          { kind: "price", op: ">=", value: 80000, windowStartHour: 21 },
          "live",
          now,
        ).ok,
      ).toBe(false);
      expect(
        addTrigger(
          home,
          {
            kind: "price",
            op: ">=",
            value: 80000,
            windowStartHour: 21,
            windowEndHour: 21,
          },
          "live",
          now,
        ).ok,
      ).toBe(false);

      const ok = addTrigger(
        home,
        {
          kind: "price",
          op: ">=",
          value: 80000,
          windowStartHour: 21,
          windowEndHour: 0,
        },
        "live",
        now,
      );
      expect(ok.ok).toBe(true);
      if (!ok.ok) return;
      expect(ok.trigger.window).toEqual({ startHour: 21, endHour: 0 });
      expect(describeTrigger(ok.trigger)).toContain("21:00–24:00");
    });

    it("live 与 paper 各存一份，模拟盘的条件不会叫醒实盘", () => {
      addTrigger(home, { kind: "price", op: ">=", value: 80000 }, "live", now);
      expect(readTriggers(home, "paper")).toHaveLength(0);
      addTrigger(home, { kind: "price", op: "<=", value: 70000 }, "paper", now);
      expect(readTriggers(home, "live")).toHaveLength(1);
      expect(readTriggers(home, "paper")).toHaveLength(1);
    });
  });

  describe("命中判定", () => {
    const priceTrigger: Trigger = {
      id: "t1",
      kind: "price",
      op: ">=",
      value: 80000,
      createdAt: new Date(now).toISOString(),
      once: true,
      cooldownMin: 30,
    };

    it("大于等于 / 小于等于都按字面判断", () => {
      expect(
        evaluateTriggers([priceTrigger], { price: 80000, now }),
      ).toHaveLength(1);
      expect(
        evaluateTriggers([priceTrigger], { price: 79999, now }),
      ).toHaveLength(0);
      expect(
        evaluateTriggers([{ ...priceTrigger, op: "<=", value: 70000 }], {
          price: 70000,
          now,
        }),
      ).toHaveLength(1);
    });

    it("缺数据不命中（取价失败 / 指标未算出来时不能瞎叫）", () => {
      expect(evaluateTriggers([priceTrigger], { now })).toHaveLength(0);
      const rsiTrigger: Trigger = {
        ...priceTrigger,
        kind: "indicator",
        name: "rsi",
        timeframe: "1h",
        op: "<=",
        value: 30,
      };
      expect(
        evaluateTriggers([rsiTrigger], {
          indicators: { [indicatorKey("4h", "rsi")]: 20 },
          now,
        }),
      ).toHaveLength(0);
      expect(
        evaluateTriggers([rsiTrigger], {
          indicators: { [indicatorKey("1h", "rsi")]: 28.5 },
          now,
        }),
      ).toHaveLength(1);
    });

    it("时段窗口：窗口外不评估（条件保留），窗口内正常命中", () => {
      // 2026-11-05T12:00Z = 北京 20:00
      const windowed: Trigger = {
        ...priceTrigger,
        window: { startHour: 21, endHour: 0 },
      };
      const beijing = (hour: number, minute = 0) =>
        Date.parse("2026-11-05T00:00:00Z") + ((hour - 8 + 24) % 24) * 3_600_000 +
        minute * 60_000;

      // 北京 20:59 不在窗口内
      expect(
        evaluateTriggers([windowed], { price: 90000, now: beijing(20, 59) }),
      ).toHaveLength(0);
      // 北京 21:00 起生效
      expect(
        evaluateTriggers([windowed], { price: 90000, now: beijing(21) }),
      ).toHaveLength(1);
      // 北京 23:59 仍在窗口内（止 = 0 表示 24:00）
      expect(
        evaluateTriggers([windowed], { price: 90000, now: beijing(23, 59) }),
      ).toHaveLength(1);
      // 北京 00:00 已出窗口
      expect(
        evaluateTriggers([windowed], { price: 90000, now: beijing(0) }),
      ).toHaveLength(0);
      // 跨午夜窗口（22 → 2）：北京 01:00 仍在窗口内
      const overnight: Trigger = {
        ...priceTrigger,
        window: { startHour: 22, endHour: 2 },
      };
      expect(
        evaluateTriggers([overnight], { price: 90000, now: beijing(1) }),
      ).toHaveLength(1);
      expect(
        evaluateTriggers([overnight], { price: 90000, now: beijing(3) }),
      ).toHaveLength(0);
    });

    it("过期条件不再命中", () => {
      const expired: Trigger = {
        ...priceTrigger,
        expiresAt: new Date(now - 1000).toISOString(),
      };
      expect(evaluateTriggers([expired], { price: 90000, now })).toHaveLength(0);
    });

    it("持续型在冷却期内不重复触发", () => {
      const repeat: Trigger = {
        ...priceTrigger,
        once: false,
        cooldownMin: 30,
        lastFiredAt: new Date(now - 10 * 60_000).toISOString(),
      };
      expect(inCooldown(repeat, now)).toBe(true);
      expect(evaluateTriggers([repeat], { price: 90000, now })).toHaveLength(0);

      const cooled: Trigger = {
        ...repeat,
        lastFiredAt: new Date(now - 31 * 60_000).toISOString(),
      };
      expect(evaluateTriggers([cooled], { price: 90000, now })).toHaveLength(1);
    });
  });

  describe("触发后的状态维护", () => {
    it("一次性条件命中即失效，不会每 5 分钟叫一次", () => {
      const added = addTrigger(home, { kind: "price", op: ">=", value: 80000 }, "live", now);
      expect(added.ok).toBe(true);
      const triggers = readTriggers(home, "live");
      const hits = evaluateTriggers(triggers, { price: 81000, now });
      expect(hits).toHaveLength(1);

      recordEvaluation(home, triggers, { price: 81000, now }, hits, "live");
      expect(readTriggers(home, "live")).toHaveLength(0);
    });

    it("持续型只更新触发时间，并记录最近观测值", () => {
      addTrigger(
        home,
        { kind: "price", op: ">=", value: 80000, once: false, cooldownMin: 60 },
        "live",
        now,
      );
      const triggers = readTriggers(home, "live");
      // 未命中时也要回写观测值（用户能看到「离条件多远」）
      recordEvaluation(home, triggers, { price: 79000, now }, [], "live");
      const [afterMiss] = readTriggers(home, "live");
      expect(afterMiss.lastSeenValue).toBe(79000);
      expect(afterMiss.lastFiredAt).toBeUndefined();

      const hits = evaluateTriggers([afterMiss], { price: 81000, now });
      expect(hits).toHaveLength(1);
      recordEvaluation(home, [afterMiss], { price: 81000, now }, hits, "live");
      const [afterHit] = readTriggers(home, "live");
      expect(afterHit.lastFiredAt).toBe(new Date(now).toISOString());
      expect(readTriggers(home, "live")).toHaveLength(1);
    });

    it("过期条目在评估时被清理", () => {
      addTrigger(
        home,
        { kind: "price", op: ">=", value: 80000, expiresHours: 1 },
        "live",
        now,
      );
      const triggers = readTriggers(home, "live");
      recordEvaluation(home, triggers, { now: now + 2 * 3_600_000 }, [], "live");
      expect(readTriggers(home, "live")).toHaveLength(0);
    });

    it("按 id 删单条、all 全清", () => {
      const first = addTrigger(
        home,
        { kind: "price", op: ">=", value: 80000 },
        "live",
        now,
      );
      addTrigger(home, { kind: "price", op: "<=", value: 70000 }, "live", now);
      if (!first.ok) throw new Error("准备数据失败");

      expect(removeTriggers(home, { id: first.trigger.id }, "live").removed).toHaveLength(1);
      expect(readTriggers(home, "live")).toHaveLength(1);
      expect(removeTriggers(home, { all: true }, "live").removed).toHaveLength(1);
      expect(readTriggers(home, "live")).toHaveLength(0);
    });
  });
});

describe("触发器审计", () => {
  it("写入与命中审计落盘，可按时间读取", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-btc-trigger-audit-"));
    try {
      appendTriggerAudit(
        {
          action: "add",
          actor: "inspect",
          role: "live",
          ok: true,
          triggerId: "t1",
          kind: "formula",
          expression: "rsi_1h > 70",
          reason: "超买",
        },
        dir,
      );
      appendTriggerAudit(
        { action: "hit", actor: "system", role: "live", ok: true, triggerId: "t1", observed: 71.2 },
        dir,
      );
      const rows = readTriggerAudits(5, dir);
      expect(rows).toHaveLength(2);
      expect(rows[0].action).toBe("add");
      expect(rows[1].observed).toBe(71.2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
