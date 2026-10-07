---
name: playwright
description: 使用 Playwright 驱动真实浏览器完成网页自动化与端到端测试：打开页面、点击、输入、按键、截图、断言。适用于需要浏览器操作、验证 Web 功能、抓取渲染后页面的场景。默认优先调用系统已安装的 Chrome（--browser chrome），以降低被网站反爬拦截的概率。
metadata:
  displayName: Playwright
  icon: browser
  category: browser-automation
  version: 1.2.0
  dependencies:
    cli: playwright-cli
    checkCommand: playwright-cli --version
    install:
      npm: npm install -g @playwright/cli@latest
      # 仅当环境里没有可用的系统 Chrome / Edge，才需要 Playwright 自带内核
      browsers: playwright-cli install-browser chromium
---

# playwright-cli

面向编码 Agent 的浏览器自动化 CLI。相比 MCP，命令式交互不会把庞大的工具 schema
与可访问性树塞进模型上下文，更省 token。

## 安装

先检查是否可用：

```bash
playwright-cli --version
```

若不可用：

```bash
npm install -g @playwright/cli@latest

# 仅当环境里没有可用的系统 Chrome / Edge 时才需要（见「浏览器选择」）
playwright-cli install-browser chromium
```

如果安装后仍然找不到命令，请打开新的终端会话（PATH 尚未刷新）。

## 浏览器选择（重要：优先使用系统已安装的浏览器）

`playwright-cli open --browser <值>` 接受 `chrome`、`msedge`、`firefox`、`webkit`
（帮助原文：*browser or chrome channel to use*）。

**默认加 `--browser chrome`。** 按以下顺序选择，能用前面的就不要用后面的：

| 优先级 | 取值 | 实际使用的浏览器 | 备注 |
| --- | --- | --- | --- |
| 1 | 系统默认浏览器对应的取值 | 视系统而定 | 若默认浏览器为 Chrome / Edge，就用对应的 `chrome` / `msedge`；为 Firefox 或 Safari 时**无法使用**（见下文） |
| 2 | **`chrome`** | **系统安装的 Google Chrome** | ✅ 首选，真实二进制与版本号 |
| 3 | **`msedge`** | **系统安装的 Microsoft Edge** | ✅ 同样走后系统安装 |
| 4 | `firefox` | ⚠️ **Playwright 自带**的定制 Firefox | **不是系统 Firefox**，见下文 |
| 5 | `webkit` | Playwright 自带的 WebKit | 仅用于 Safari 兼容性验证 |
| 6 | 不指定（默认） | Playwright 自带的 Chromium | 最后兜底 |

### 为什么不要用自带的 Chromium

不指定 `--browser` 时启动的是 Playwright 自带的 Chromium。它带有明显的自动化特征：
版本号与官方发布版不一致、缺少常见插件、暴露 `navigator.webdriver` 等。
Cloudflare、Akamai 以及各类风控系统很容易据此判定为机器人，返回验证页或直接拦截。

改用**系统安装的 Chrome / Edge** 后，浏览器指纹与普通用户一致，通过率显著提高 ——
这也是本技能把它列为默认选择的原因。

### 必须避开 snap 版本（Linux）

snap 包的浏览器运行在沙箱中，profile 目录写入、文件系统访问与 `--user-data-dir`
都可能异常，导致启动失败或行为不一致。**选择前先确认目标浏览器不是 snap 安装**：

```bash
for b in google-chrome google-chrome-stable microsoft-edge; do
  p=$(command -v "$b" 2>/dev/null) || continue
  case "$(readlink -f "$p")" in
    */snap/*) echo "$b → snap 安装（不要用）" ;;
    *)        echo "$b → 原生安装 ✓" ;;
  esac
done
```

若只有 snap 版本，**不要勉强使用**：宁可退回自带内核（`chromium`），也不要使用
受沙箱限制的 snap 浏览器。

### 关于 Firefox（重要限制）

**`--browser firefox` 使用的不是系统安装的 Firefox，而是 Playwright 自带的定制构建**
（位于 Playwright 的浏览器缓存目录，需先执行 `playwright-cli install-browser firefox`）。

原因是 Playwright 依赖定制补丁实现的浏览器控制协议，系统原版 Firefox 无法被驱动。
这一点对 Node 脚本同样成立：`channel: "firefox"` 依然指向自带构建，用 `executablePath`
指向系统 Firefox 也无法工作。

因此 **「使用系统已安装的 Firefox」在 Playwright 下是做不到的**。Firefox 的适用场景：
需要验证 Gecko 引擎兼容性，或 Chromium 系被某站点针对性拦截时换一个引擎再试。

### 与 Node 脚本的对应关系

| CLI 取值 | Node 脚本写法 | 实际浏览器 |
| --- | --- | --- |
| `--browser chrome` | `chromium.launch({ channel: "chrome" })` | 系统 Chrome |
| `--browser msedge` | `chromium.launch({ channel: "msedge" })` | 系统 Edge |
| `--browser firefox` | `firefox.launch()` | 自带 Firefox |
| `--browser webkit` | `webkit.launch()` | 自带 WebKit |
| （不指定） | `chromium.launch()` | 自带 Chromium |

## 基本用法

```bash
playwright-cli open https://example.com --browser chrome          # 打开页面（默认无头）
playwright-cli open https://example.com --browser chrome --headed # 带头显示，便于观察
playwright-cli type "Buy groceries"                # 向当前焦点元素输入文本
playwright-cli press Enter                         # 按下按键
playwright-cli screenshot                          # 截图（返回文件路径）
playwright-cli show                                # 打开会话面板，实时预览所有会话
```

`playwright-cli` 的命令会随版本演进。**不确定参数时不要猜测**，直接查询帮助：

```bash
playwright-cli --help
playwright-cli <command> --help
```

需要登录态或长期保持浏览器时，可配合 `--persistent` / `--profile <目录>` 复用用户数据目录。

## 推荐工作流

1. 明确目标：目标 URL、需要执行的交互步骤、期望结果。
2. **按上面的优先级确定可用的浏览器**（优先系统安装的 Chrome / Edge，避开 snap 版），
   然后 `open` 时带上 `--browser <值>`。
3. 逐步执行交互（`type` / `press` / 点击等），每步确认页面状态。
4. 对每个关键步骤（尤其是失败场景）执行 `screenshot` 留存证据。
5. 汇总结果：说明通过/失败的步骤，并给出截图文件路径。

## 备选方案：Node 脚本

当流程复杂（循环、条件、数据驱动）时，改用 Playwright 库编写脚本更合适。
同样应优先指定 `channel`：

```js
const { chromium } = require("playwright");

(async () => {
  // channel: "chrome" → 使用系统安装的 Chrome（不要用默认的 bundled chromium）
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  await page.goto("https://example.com");
  await page.screenshot({ path: "shot.png" });
  await browser.close();
})();
```

若环境里没有系统 Chrome / Edge，再退回 `chromium.launch()`。

## 注意事项

- 需要 Node.js >= 20。
- **默认加 `--browser chrome`**：既避免使用带自动化特征的 bundled Chromium 被反爬拦截，
  也省去下载内核的步骤（见「浏览器选择」）。
- 不要使用 snap 安装的浏览器（沙箱会破坏 profile 与文件访问）。
- 无头模式是默认行为；只有在需要观察或调试时才使用 `--headed`。
- 遇到验证码 / 风控页时，先确认是否漏了 `--browser chrome`，再考虑 `--headed` 人工介入。
- 截图等产物默认写入当前工作目录，注意不要污染项目源码目录。
- 一次会话无人交互会超时，长任务请分步执行。

## 参考

- 官方文档：https://playwright.dev/agent-cli/introduction
- 浏览器 channel 说明：https://playwright.dev/docs/browsers#google-chrome--microsoft-edge
- 仓库：https://github.com/microsoft/playwright-cli
