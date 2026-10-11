# API 速查（按 AutoJs6 源码核对）

> 这是 `autojs6` 技能的伴随文件。**先看主文件 `SKILL.md` 的三条硬约束**再动手。

## 全局与无障碍

| API | 说明 |
| --- | --- |
| `auto.waitFor([timeout])` | 等待无障碍就绪（**脚本首选**） |
| `auto.isRunning()` / `auto.isOperational()` / `auto.hasService()` | 无障碍状态 |
| `auto.currentPackage()` / `auto.currentActivity()` / `auto.currentComponent()` | 当前前台包名 / Activity |
| `auto.setMode("fast")` | 快速模式（部分设备可显著提速） |
| `auto.launchSettings()` | 打开 AutoJs6 的无障碍设置页 |
| `auto.start()` / `auto.stop()` / `auto.disable()` / `auto.enable()` | 服务开关 |

## 全局动作（需要无障碍）

| API | 说明 |
| --- | --- |
| `back()` / `home()` / `recents()` | 返回 / 桌面 / 最近任务 |
| `notifications()` / `quickSettings()` / `powerDialog()` | 通知栏 / 快捷设置 / 电源菜单 |
| `lockScreen()` / `takeScreenshot()` | 锁屏 / 截屏 |
| `click(x, y)` / `press(x, y, duration)` | 坐标点击 / 长按 |
| `swipe(x1, y1, x2, y2, [duration])` | 滑动 |
| `gesture(duration, [x1,y1], [x2,y2], …)` | 手势（多段轨迹；`gestures` 为多指） |
| `setScreenMetrics(w, h)` | **按设计稿坐标换算**（适配不同分辨率，强烈建议） |

> `back()` / `home()` 是**系统级**动作：会把当前应用整个退出（进入后台），
> 想"退一层界面"优先点界面上的返回箭头。

## 选择器（找到界面元素）

```js
text("确定");  textContains("确定");  textStartsWith("确定");  textMatches(/确定|OK/);
desc("更多");   id("com.xx:id/btn");   className("android.widget.Button");
packageName("com.tencent.mm");  bounds(0, 0, 100, 100);  clickable(true);
```

- 组合：`.text("确定").clickable(true)`、`text("A").find()`；
- 常见筛选：`clickable` / `longClickable` / `checkable` / `checked` / `enabled` / `focusable` /
  `focused` / `selected` / `scrollable` / `editable` / `visibleToUser` / `boundsInside` / `boundsContains` /
  `drawingOrder` / `multiLine` / `packageName`；
- 查找与等待：

| API | 说明 |
| --- | --- |
| `findOne([timeout])` | 找一个，找不到 / 超时返回 `null` |
| `findOnce()` | 立刻找一个（不等待） |
| `exists([timeout])` | 是否存在 |
| `waitFor()` | 阻塞直到出现（无超时，慎用） |
| `find()` | 返回 `UiObjectCollection`（可 `.forEach`，长度是 `.length` **属性**） |
| `untilFind()` | 阻塞直到至少找到一个 |
| `findOne().bounds()` | 拿到坐标（`bounds.centerX()` 等可做坐标兜底） |

- 高级：`.filter(fn)` / `.search(fn)` / `.algorithm(alg)` / `.maxDepth(n)`。

## UiObject 动作

`click()` · `longClick()` · `setText(text)` · `setSelection(a,b)` · `copy()` · `paste()` ·
`scrollUp()` · `scrollDown()` · `scrollForward()` · `scrollBackward()` · `scrollLeft()` · `scrollRight()` ·
`scrollTo(…)` · `select()` · `expand()` · `collapse()` · `dragStart()` / `dragDrop()` ·
`show()` · `dismiss()` · `performAction(code)` · `pressAndHold()` · `imeEnter()`

> `setText()` / `paste()` / `imeEnter()` 都属于**无障碍**路线，需要能读到那个节点；
> 读不到时的替代方案见 `input.md`。

## 应用、设备、按键、输入

| API | 说明 |
| --- | --- |
| `app.launch(packageName)` / `app.launchPackage(pkg)` | 启动应用（**开系统设置用 `app.launchPackage("com.android.settings")`**） |
| ⚠ `app.launchSettings(pkg)` | 是"**应用详情页**"（`launchAppDetailsSettings`），**必须带包名**，不带参数直接抛错 —— 真机实测踩过。想开 AutoJs6 自己的无障碍设置页，用 `auto.launchSettings()` |
| `app.getPackageName(name)` | 按应用名（中文）取包名 |
| `app.openAppSetting(pkg)` / `app.uninstall(pkg)` | 应用信息 / 卸载 |
| `app.openUrl(url)` / `app.viewFile(path)` | 打开链接 / 用系统应用打开文件 |
| `currentPackage()` / `currentActivity()` | 前台应用（全局版，等价 `auto.*`） |
| `device.width` / `device.height` / `device.model` / `device.brand` | 设备信息 |
| `device.getBrightness()` / `setBrightness(n)` / `device.vibrate(ms)` | 亮度 / 震动 |
| `device.keepScreenOn([timeout])` | 保持亮屏（长脚本必备） |
| `input(text)` / `press(x, y, ms)` / `KeyCode.*` | 文本输入 / 按键码 —— **前提与差异见 `input.md`** |
| `waitForActivity(name, [period])` / `waitForPackage(pkg, [period])` | 等界面 / 等应用 |
| `sleep(ms)` / `random(a, b)` / `exit()` | 延时 / 随机数 / 结束脚本 |

## 其它常用

| API | 说明 |
| --- | --- |
| `console.log(msg)` | **回报结果的主要手段**（走日志通道，屏幕上无气泡） |
| `toastLog(msg)` / `toast(msg)` | 弹气泡 + 打日志；**仅当必须让用户当场看到时用** |
| `captureScreen()` | 截屏返回 `Image`（需相应权限 / 前台服务，见 `screenshot.md`） |
| `images.*` | 图片处理（`images.findImage` / `images.matchTemplate` 可做图像识别兜底） |
| `threads.start(fn)` / `threads.shutDownAll()` | 多线程（`t.join(timeout)` 可给阻塞操作加超时） |
| `files.*` | 文件读写（`files.read` / `files.write` / `files.writeBytes` / `files.exists`） |
| `http.get(url)` / `http.post(url, data)` | 网络（手机侧发起的请求） |
| `storages.create(name)` | 持久化键值存储（跨脚本保存状态） |
| `clipboard` / `setClip(text)` / `getClip()` | 剪贴板（**不需要无障碍**） |
| `dialogs.alert/confirm/rawInput` | 对话框（会阻塞等用户操作，慎用） |
| `events.*` / `timers.*` | 事件监听 / 定时器 |
| `floaty.*` | 悬浮窗（可视调试用） |

## `$shell` 与特权命令

| API | 说明 |
| --- | --- |
| `$shell(cmd)` | 跑一条 shell 命令，返回 `{ code, result, error }`。**以 AutoJs6 自身 uid 运行** |
| `$shell("ls -l /sdcard/Download/")` | 例：列目录（实测可用，`code=0`） |
| `$shell("dumpsys …")` | ⚠ 需要 `DUMP` 权限，默认被拒（`code=1`） |
| `$shell("input text …")` / `$shell("input keyevent …")` | ⚠ 需要 `INJECT_EVENTS`（root / Shizuku / ADB），见 `input.md` |
| `Input(...)` / `Text(...)` / `KeyCode(...)` / `Tap(...)` | 全局函数，走 `$shell` 的 rootShell 族；**无权限时会卡住**，必须用 `threads` + `join` 兜住 |
| `$autojs.isRootAvailable()` / `$autojs.getRootMode()` | 查 root 状态 |
| `$shizuku.isInstalled(ctx)` / `$shizuku.hasPermission()` / `$shizuku.isRunning()` | 查 Shizuku 状态 |
