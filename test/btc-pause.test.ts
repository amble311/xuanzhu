import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPaused, pausePath, readPause, setPaused } from "../src/btc/pause";

describe("后端暂停开关（/stop）", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-btc-pause-"));
  const saved = process.env.XZH_BTC_HOME;

  beforeAll(() => {
    process.env.XZH_BTC_HOME = home;
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.XZH_BTC_HOME;
    else process.env.XZH_BTC_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("默认未暂停", () => {
    expect(isPaused(home)).toBe(false);
  });

  it("暂停后写入时间与来源，恢复后清除", () => {
    const paused = setPaused(home, true, "/stop");
    expect(paused.paused).toBe(true);
    expect(paused.at).toBeTruthy();
    expect(readPause(home).by).toBe("/stop");
    expect(isPaused(home)).toBe(true);

    setPaused(home, false);
    expect(isPaused(home)).toBe(false);
    expect(readPause(home).at).toBeUndefined();
  });

  it("文件损坏时按暂停处理（宁可不动，也不要自己恢复交易）", () => {
    fs.mkdirSync(path.dirname(pausePath(home)), { recursive: true });
    fs.writeFileSync(pausePath(home), "{ not json");
    const state = readPause(home);
    expect(state.paused).toBe(true);
    expect(state.by).toBe("unreadable");
  });
});
