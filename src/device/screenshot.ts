/**
 * 手机截图的**脚本模板**（在手机上执行的那一段）。
 *
 * 为什么必须内置而不是让每个调用方自己写：`captureScreen()` 走的是系统
 * **MediaProjection**，会弹出「AutoJs6 将开始截取您的屏幕上的所有内容 / **立即开始**」
 * 这种**系统授权框**，而 `captureScreen()` 本身是**阻塞**的 —— 它一直等到授权框被点掉
 * 才返回。因此**点击不能写在它后面**，必须**先开一个线程**去点，主线程再去截图。
 *
 * 真机实测（OPPO PHQ110 / Android 15）：这个授权框**每次截图都会弹**，不是只有首次 ——
 * 所以这段样板不是"首次体验优化"，而是每次都必须有的组成部分。
 *
 * 图片的送回：`captureScreen()` 得到的 `Image` 留在手机上，xzh 拿不到，
 * 因此缩图 + base64 之后由手机**主动 POST 回 xzh 桥的 `/shot` 端点**。
 * 缩到 30% 并压成 JPEG(q55) 后约 40~55 KB —— 足够看清界面布局与文字。
 */

/** 截图脚本的参数 */
export interface ScreenshotScriptOptions {
  /** 手机能访问到的 xzh 地址（一般是桥所在主机在手机同网段的 IP） */
  host: string;
  /** 桥的控制端口（手机把图片 POST 到这里） */
  port: number;
  /** 缩图比例（默认 0.3） */
  scale?: number;
  /** JPEG 质量（默认 55） */
  quality?: number;
}

/**
 * 生成在手机上执行的截图脚本。
 *
 * 刻意把授权线程写得多语言兜底（中文「立即开始」/「开始现在」/「允许」、英文 START NOW / Allow），
 * 因为不同系统/语言下的按钮文案不同，而这段代码一旦点不到就等于截图永远卡住。
 */
export function buildScreenshotScript(options: ScreenshotScriptOptions): string {
  const scale = options.scale ?? 0.3;
  const quality = options.quality ?? 55;
  const url = `http://${options.host}:${options.port}/shot`;
  return [
    "// 由 xzh 生成：截图并按授权框、回传到桥（勿手改，模板见 src/device/screenshot.ts）",
    "try {",
    "  auto.waitFor(8000);",
    "  var clicked = false;",
    "  var auth = threads.start(function () {",
    '    var btn = text("立即开始").findOne(3000);',
    '    if (!btn) btn = text("开始现在").findOne(300);',
    '    if (!btn) btn = text("允许").findOne(300);',
    '    if (!btn) btn = textMatches(/START NOW|Allow/i).findOne(300);',
    "    if (btn) { clicked = true; btn.click(); }",
    "  });",
    '  console.log("【截图】等待屏幕授权…");',
    "  var img = captureScreen();",
    "  auth.join(1500);",
    '  if (!img) { console.log("【截图】未拿到图像（授权被拒或超时，点到授权框=" + clicked + "）"); exit(); }',
    `  var small = images.scale(img, ${scale}, ${scale});`,
    `  var b64 = images.toBase64(small, "jpg", ${quality});`,
    `  var r = http.post("${url}", b64, { contentType: "text/plain" });`,
    '  console.log("【截图】" + img.width + "x" + img.height + " → " + small.width + "x" + small.height + "，回传=" + r.statusCode);',
    "} catch (e) {",
    '  console.log("【截图】失败：" + e);',
    "}",
    "",
  ].join("\n");
}
