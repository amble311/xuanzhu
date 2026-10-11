# 输入文字：两条路，别混

> `autojs6` 技能的伴随文件。**结论先行**：`input()` 是"送文字"的常规 API，
> 但它要求无障碍**看得见那个输入框**；读不到节点时它**返回 `false` 而不报错**，
> 此时只能走"注入输入事件"（要 root / Shizuku / ADB）。

| 路 | 命令 | 前提 |
| --- | --- | --- |
| **无障碍**（目标窗口可见才有效） | `input("文本")`、`setText("文本")`、`node.setText()`、`node.paste()`、`imeEnter()` | 无障碍树里能找到那个可编辑节点。**跨用户空间的应用分身（如"小微信"）、以及对无障碍做了限制的 App**，节点数是 0 ⇒ `input()` 恒返回 `false` |
| **注入输入事件**（与窗口可见性无关） | `$shell("input text hi")`、`$shell("input keyevent 279")`、`KeyCode()` / `Text()` / `Input()` | **`INJECT_EVENTS` 权限** —— 只有 **root / Shizuku / ADB** 身份的进程才有 |

自查一行（在手机上跑）：

```js
console.log("input=" + input("test"));                       // false ⇒ 无障碍找不到目标节点
console.log("shell=" + $shell("echo ok").code);              // 0 ⇒ shell 通道正常（以自身 uid 跑）
console.log("root=" + $autojs.isRootAvailable());            // 无 root
console.log("shizuku=" + $shizuku.hasPermission());           // 无 Shizuku 授权
```

**无权限时的实测表现**：

- `$shell("echo hi")` → `code=0`（**shell 本身能用**，只是**没有提权**）；
- `$shell("input text hi")` → `code=255` +
  `SecurityException: Injecting input events requires … INJECT_EVENTS permission`；
- `KeyCode()` / `Input()` / `Text()` 走的是 `$shell.rootShell` —— **无权限时会卡住等 Shizuku binder**，
  所以**必须**用线程 + 超时兜住，否则整个脚本挂死：

```js
var done = false, out = "n/a";
var t = threads.start(function () { try { out = KeyCode("DEL"); } catch (e) { out = "" + e; } done = true; });
t.join(5000);
console.log("【KeyCode】完成=" + done + " 结果=" + out);   // 完成=false ⇒ 卡住了，别再等
```

## 给 AutoJs6 开权限（推荐 Shizuku：Android 11+ 无线调试启动，不必用电脑）

1. 装 Shizuku（GitHub Releases 里的 `shizuku-*.apk`；装完**别指望 App 内自己启动**，
   提权要靠 ADB / 无线调试）；
2. 开启开发者选项（设置 → 关于手机 → 版本信息 → 连点「版本号」7 次）；
3. 开发者选项 → 打开「**无线调试**」；
4. 打开 Shizuku →「**通过无线调试启动**」→ 按提示进「无线调试 → **使用配对码配对设备**」，
   取 6 位配对码回填 → 启动（**无线调试别关**；重启手机后要重新启动一次 Shizuku）；
5. AutoJs6 → 侧边栏「权限」→「**Shizuku 权限**」→ 授权（成功后 `$shizuku.hasPermission()` 为 `true`）。

顺带两个同页面的开关，很值：

- 「**前台服务**」里含"**屏幕录制和媒体投影**"的那项 → **截图不再弹系统授权框**
  （那个框会**抢走输入框焦点**，见 `screenshot.md`）；
- 「**转储系统信息 (DUMP)**」→ `dumpsys` 可用，**不截图**也能看焦点 / 输入法状态
  （`dumpsys input_method` 里的 `mInputShown`）。

## 中文输入：走剪贴板

`input text` **只支持 ASCII**。中文用剪贴板 + 粘贴键（`279` = `KEYCODE_PASTE`）：

```js
click(467, 2332);              // ① 先点输入框拿焦点（坐标点击不需要特权）
sleep(1200);
setClip("要发的中文");          // ② 写剪贴板（不需要无障碍）
$shell("input keyevent 279");  // ③ 注入粘贴（需要特权通道）
```

## 没有特权通道时的降级

- **请用户手动打字**（最稳）；
- 或**按坐标点软键盘键位**：键盘弹起后，键位是屏幕上的普通控件，
  用截图量坐标 + `click(x, y)` 点即可（ASCII 尚可；中文要拼音 + 候选词，非常脆，不推荐）。

⚠ 别用"点输入框 → 截图确认键盘 → 再输入"这个顺序：**截图（授权框）会让输入框失焦、键盘收起**。
