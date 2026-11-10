import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, describe, expect, it } from "vitest";
import { readOutbox, startOutbox } from "../src/gateway/outbox";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-outbox-"));

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("微信出站队列", () => {
  it("先落盘，发送成功后删除", async () => {
    const home = fs.mkdtempSync(path.join(root, "ok-"));
    const sent: string[] = [];
    const queue = startOutbox({
      gatewayHome: home,
      send: async (text) => {
        sent.push(text);
        return true;
      },
      intervalMs: 10,
    });
    queue.enqueue("消息一");
    queue.enqueue("消息二");
    expect(readOutbox(home)).toHaveLength(2);

    await new Promise((resolve) => setTimeout(resolve, 120));
    queue.stop();
    expect(sent).toEqual(["消息一", "消息二"]);
    expect(readOutbox(home)).toHaveLength(0);
  });

  it("发送失败时保留并退避重试", async () => {
    const home = fs.mkdtempSync(path.join(root, "fail-"));
    let attempts = 0;
    const queue = startOutbox({
      gatewayHome: home,
      send: async () => {
        attempts += 1;
        return false;
      },
      intervalMs: 10,
    });
    queue.enqueue("会失败的消息");
    await new Promise((resolve) => setTimeout(resolve, 80));
    queue.stop();
    const items = readOutbox(home);
    expect(items).toHaveLength(1);
    expect(items[0].attempts).toBeGreaterThan(0);
    expect(Date.parse(items[0].nextAt)).toBeGreaterThan(Date.now());
    expect(attempts).toBeGreaterThan(0);
  });

  it("重启后能读到未发送的消息", () => {
    const home = fs.mkdtempSync(path.join(root, "restart-"));
    const first = startOutbox({
      gatewayHome: home,
      send: async () => false,
      intervalMs: 10_000,
    });
    first.enqueue("重启后继续");
    first.stop();
    expect(readOutbox(home).map((item) => item.text)).toEqual(["重启后继续"]);
  });
});
