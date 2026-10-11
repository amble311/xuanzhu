/**
 * 「读取手机当前界面内容」的**脚本模板**。
 *
 * 模型要"看见"界面，有两条路（真机实测后**只保留第二条为兜底**）：
 *
 * 1. **无障碍树**（首选）：把可见控件读成"类名 | 文本 | 是否可点击 | 坐标"。
 *    最快、最省事，但**只对标准 App 有效**；
 * 2. **截图 → 交给看图的人**（兜底）：微信、**应用分身**、游戏这类界面
 *    无障碍节点数为 **0**（Android 的应用分身跑在独立用户空间，主用户的无障碍服务
 *    看不到它的窗口），此时选择器与 `currentPackage()`/`currentActivity()` **全都不可信**
 *    （它们同样来自无障碍事件，可能是过期信息 —— 实测报了个早已不在的 AlertDialog）。
 *    这种情况改用 `device_screenshot` 截图，让**具备视觉能力的模型**或**用户**看图判断，
 *    再按坐标 `click(x, y)` 操作。
 *
 * 曾经的第三条路是**手机端 OCR**（Paddle OCR 插件 → 文字 + 坐标），已**放弃**：
 * 它要求用户额外安装插件，而且是 AIDL 跨进程服务，会被系统冻结/停止，
 * 表现为"时好时坏"（实测同一会话里前一次成功、几分钟后就报"未找到可用的插件"）——
 * 对新手用户太脆弱。少一个依赖，链路就短一截。
 *
 * 输出约定（工具据此过滤）：
 *   `【界面】…`   当前包名与 Activity（**仅当控件数正常时才可信**）
 *   `【控件】…`   每个可见控件一行：类名 | 文本或 desc | 是否可点击 | 坐标
 *   `【判断】…`   控件太少时的结论与替代做法
 *   `【完成】…`   结束标记（工具据此停止等待）
 *
 * 全部输出用 `console.log` 而**不用** `toastLog`：后者会在**用户屏幕上弹气泡**，
 * 读一次界面就弹好几个，而且 xzh 自己的提示混进界面里还会干扰判断
 * （见下面的 【 前缀过滤）。日志通道两者一致，模型都能读到。
 */

/** 单个工具行里最多报多少个控件（防止返回一大坨塞爆上下文） */
export const UI_DUMP_MAX_NODES = 60;

/** 控件数低于此值即认为"该界面读不到"（微信/分身/游戏），需要改走截图 */
export const UI_DUMP_MIN_USABLE = 3;

export function buildUiDumpScript(maxNodes = UI_DUMP_MAX_NODES, runId = ""): string {
  return [
    "// 由 xzh 生成：读取当前界面内容（模板见 src/device/ui-dump.ts）",
    "try {",
    // 本次运行的唯一标记：日志缓冲是**跨调用共享**的，调用方必须靠它区分
    // "这次读到的" 与 "上次残留的"，否则会报出过期界面（实测踩过）。
    `  console.log("【开始】${runId}");`,
    "  auto.waitFor(8000);",
    "  if (!auto.isRunning()) {",
    '    console.log("【界面】无障碍未就绪，无法读取界面");',
    "    exit();",
    "  }",
    '  console.log("【界面】" + currentPackage() + " / " + currentActivity());',
    "  var lines = [];",
    "  classNameMatches(/.*/).find().forEach(function (el) {",
    "    try {",
    "      var t = el.text();",
    "      var d = el.desc();",
    "      var label = (t && t.trim()) || (d && d.trim());",
    "      if (!label) return;",
    // 过滤掉**我们自己产出的诊断文案**：脚本的诊断输出约定统一以 【 开头，
    // 而它可能留在屏幕上、也进无障碍树 —— 不过滤的话"读数"会把上一次操作留下的提示
    // 当成界面内容，模型据此误判（实测踩过）。
    '      if (label.indexOf("【") === 0) return;',
    "      var b = el.bounds();",
    '      lines.push(el.className().replace(/^android\\.widget\\./, "") + " | " + label +',
    '        " | click=" + (el.clickable() ? "Y" : "N") +',
    '        " | [" + b.left + "," + b.top + "," + b.right + "," + b.bottom + "]");',
    "    } catch (e) {}",
    "  });",
    `  console.log("【控件】共 " + lines.length + " 个" + (lines.length > ${maxNodes} ? "（只列前 ${maxNodes} 个）" : ""));`,
    `  lines.slice(0, ${maxNodes}).forEach(function (line) { console.log("【控件】" + line); });`,
    // ── 读不到时的结论与替代做法（**不含 OCR**，也不在手机上截图）─────────────
    `  if (lines.length < ${UI_DUMP_MIN_USABLE}) {`,
    '    console.log("【判断】可用控件数=" + lines.length + " ⇒ 该界面无法通过无障碍读取");',
    '    console.log("【原因】微信、应用分身、游戏等自绘/跨用户界面不暴露无障碍节点（应用分身跑在独立用户空间）");',
    '    console.log("【提醒】此时 currentPackage()/currentActivity() **也不可信**（同样来自无障碍事件，可能是过期信息）");',
    '    console.log("【建议】改用 device_screenshot 截图：让具备视觉能力的模型看图判断，或把图给用户看；再按坐标 click(x,y) 操作");',
    "  }",
    '  console.log("【完成】界面内容已输出");',
    "} catch (e) {",
    '  console.log("【界面】读取失败：" + e);',
    "}",
    "",
  ].join("\n");
}
