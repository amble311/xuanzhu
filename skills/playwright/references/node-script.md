# 备选方案：Node 脚本

> `playwright` 技能的伴随文件。当流程复杂（循环、条件、数据驱动）时，改用 Playwright 库写脚本更合适。

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

各取值与系统浏览器的对应关系见 `browser-choice.md` 的「与 Node 脚本的对应关系」。
