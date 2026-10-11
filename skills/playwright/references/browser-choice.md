# 浏览器选择：完整论证与边界

> `playwright` 技能的伴随文件。主文件的优先级表已给出结论，这里解释**为什么**、以及各类边界。

## 为什么不要用自带的 Chromium

不指定 `--browser` 时启动的是 Playwright 自带的 Chromium。它带有明显的自动化特征：
版本号与官方发布版不一致、缺少常见插件、暴露 `navigator.webdriver` 等。
Cloudflare、Akamai 以及各类风控系统很容易据此判定为机器人，返回验证页或直接拦截。

改用**系统安装的 Chrome / Edge** 后，浏览器指纹与普通用户一致，通过率显著提高 ——
这也是主文件把它列为默认选择的原因。

## 必须避开 snap 版本（Linux）

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

## 关于 Firefox（重要限制）

**`--browser firefox` 使用的不是系统安装的 Firefox，而是 Playwright 自带的定制构建**
（位于 Playwright 的浏览器缓存目录，需先执行 `playwright-cli install-browser firefox`）。

原因是 Playwright 依赖定制补丁实现的浏览器控制协议，系统原版 Firefox 无法被驱动。
这一点对 Node 脚本同样成立：`channel: "firefox"` 依然指向自带构建，用 `executablePath`
指向系统 Firefox 也无法工作。

因此 **「使用系统已安装的 Firefox」在 Playwright 下是做不到的**。Firefox 的适用场景：
需要验证 Gecko 引擎兼容性，或 Chromium 系被某站点针对性拦截时换一个引擎再试。

## 与 Node 脚本的对应关系

| CLI 取值 | Node 脚本写法 | 实际浏览器 |
| --- | --- | --- |
| `--browser chrome` | `chromium.launch({ channel: "chrome" })` | 系统 Chrome |
| `--browser msedge` | `chromium.launch({ channel: "msedge" })` | 系统 Edge |
| `--browser firefox` | `firefox.launch()` | 自带 Firefox |
| `--browser webkit` | `webkit.launch()` | 自带 WebKit |
| （不指定） | `chromium.launch()` | 自带 Chromium |
