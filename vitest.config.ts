import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { defineConfig } from "vitest/config";

/**
 * 测试**一律跑在临时的全局目录**里。
 *
 * 为什么必须这么做：`getConfigPath()` 默认指向 `~/.xzh/config.json`，而 `Agent` 在模型
 * 调用失败回退时会 `rememberModel()` + `saveConfig()` 写盘。只要有一个测试构造了
 * **合成的 config**（假 provider / 假模型名）并让 Agent 跑到那一步，用户的真实配置就会被
 * 整个覆盖成测试夹具 —— 历史上已经发生过两次（`config.json.polluted-20261006`，
 * 以及 2026-10-13 又一次），每次都要靠翻记忆才能把配置拼回来，代价远高于这里重定向一行。
 *
 * 用固定的临时目录（每次运行前清空）而不是 `mkdtemp`：既不会在 /tmp 里堆垃圾，
 * 也不会让上一次运行的状态漏进下一次。
 */
const XZH_TEST_HOME = path.join(os.tmpdir(), "xzh-test-home");
fs.rmSync(XZH_TEST_HOME, { recursive: true, force: true });
fs.mkdirSync(XZH_TEST_HOME, { recursive: true });

export default defineConfig({
  test: {
    env: { XZH_HOME: XZH_TEST_HOME },
  },
});
