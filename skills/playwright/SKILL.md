---
name: playwright
description: 使用 Playwright 驱动真实浏览器完成网页自动化与端到端测试：打开页面、点击、输入、按键、截图、断言。适用于需要浏览器操作、验证 Web 功能、抓取渲染后页面的场景。默认优先调用系统已安装的 Chrome（--browser chrome），以降低被网站反爬拦截的概率。
metadata:
  displayName: Playwright
  icon: browser
  category: browser-automation
  version: 1.3.0
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
| 1 | 系统默认浏览器对应的取值 | 视系统而定 | 若默认浏览器为 Chrome / Edge，就用对应的 `chrome` / `msedge`；为 Firefox 或 Safari 时**无法使用**（见 `references/browser-choice.md`） |
| 2 | **`chrome`** | **系统安装的 Google Chrome** | ✅ 首选，真实二进制与版本号 |
| 3 | **`msedge`** | **系统安装的 Microsoft Edge** | ✅ 同样走后系统安装 |
| 4 | `firefox` | ⚠️ **Playwright 自带**的定制 Firefox | **不是系统 Firefox**，原因见 `references/browser-choice.md` |
| 5 | `webkit` | Playwright 自带的 WebKit | 仅用于 Safari 兼容性验证 |
| 6 | 不指定（默认） | Playwright 自带的 Chromium | 最后兜底 |

**为什么默认 `chrome`**：不指定时启动的是自带的 Chromium，它带明显自动化特征
（版本号不一致、缺插件、暴露 `navigator.webdriver`），Cloudflare / Akamai 等风控很容易据此拦截。
换成系统安装的 Chrome / Edge 后指纹与普通用户一致，通过率显著提高。
完整论证与边界见 `references/browser-choice.md`。

**必须避开 snap 版本（Linux）** —— snap 沙箱会破坏 profile 写入与 `--user-data-dir`：

```bash
for b in google-chrome google-chrome-stable microsoft-edge; do
  p=$(command -v "$b" 2>/dev/null) || continue
  case "$(readlink -f "$p")" in
    */snap/*) echo "$b → snap 安装（不要用）" ;;
    *)        echo "$b → 原生安装 ✓" ;;
  esac
done
```

若只有 snap 版本，**不要勉强使用**：宁可退回自带内核（`chromium`）。

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

## 需要时再读（按需 `read_file`，都在本技能目录下）

| 你要做的事 | 读这个 |
| --- | --- |
| 搞清"为什么要用系统 Chrome / Edge"、snap 的坑、Firefox 为何只能用自带版、CLI 取值与 Node `channel` 的对应 | `references/browser-choice.md` |
| 流程复杂（循环 / 条件 / 数据驱动）改用 Node 脚本 | `references/node-script.md` |

## 注意事项

- 需要 Node.js >= 20。
- **默认加 `--browser chrome`**：既避免使用带自动化特征的 bundled Chromium 被反爬拦截，
  也省去下载内核的步骤。
- 不要使用 snap 安装的浏览器（沙箱会破坏 profile 与文件访问）。
- 无头模式是默认行为；只有在需要观察或调试时才使用 `--headed`。
- 遇到验证码 / 风控页时，先确认是否漏了 `--browser chrome`，再考虑 `--headed` 人工介入。
- 截图等产物默认写入当前工作目录，注意不要污染项目源码目录。
- 一次会话无人交互会超时，长任务请分步执行。

## 参考

- 官方文档：https://playwright.dev/agent-cli/introduction
- 浏览器 channel 说明：https://playwright.dev/docs/browsers#google-chrome--microsoft-edge
- 仓库：https://github.com/microsoft/playwright-cli
