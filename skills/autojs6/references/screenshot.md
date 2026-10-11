# 截图（含**首次授权**，实测踩过）

> `autojs6` 技能的伴随文件。**日常优先用现成的 `device_screenshot` 工具**，本文件解释它为什么长这样、
> 以及什么时候需要自己写。

`captureScreen()` 走的是系统的 **MediaProjection**：会弹出
「AutoJs6 将开始截取您的屏幕上的所有内容 / **立即开始** / 取消」这种**系统弹窗**。

坑在于：`captureScreen()` 是**阻塞**的 —— 它一直等到授权框被点掉才返回。所以
**点击不能写在它后面**，必须**先开一个线程**去点，主线程再去截图：

```js
auto.waitFor(8000);

// ① 先起授权线程：等弹窗出现就点「立即开始」
var clicked = false;
var auth = threads.start(function () {
  var btn = text("立即开始").findOne(3000);      // 中文系统（OPPO/华为等）
  if (!btn) btn = text("开始现在").findOne(300);
  if (!btn) btn = text("允许").findOne(300);     // 部分系统
  if (!btn) btn = textMatches(/START NOW|Allow/i).findOne(300);  // 英文系统
  if (btn) { clicked = true; btn.click(); }
});

// ② 主线程截图（此时若弹窗出现，会被上面的线程点掉）
var img = captureScreen();
auth.join(1500);
console.log("【截图】是否点到授权弹窗=" + clicked);
if (!img) { console.log("【失败】未拿到图像（授权被拒或超时）"); exit(); }
```

## ⚠ 授权弹窗的副作用：**会抢走焦点**

实测（OPPO PHQ110 / Android 14）：授权框出现时**输入框焦点丢失、键盘收起**。
所以「点输入框 → 截图确认 → 再输入」这个顺序**必然失败** —— 要输入就别截图，
一个脚本里"点框 → 输入 →（要发就）发送"连着做完。

**治本开关**：让用户在 AutoJs6 的侧边栏「权限」里打开
「**前台服务**」中描述含"**屏幕录制和媒体投影**"的那一项 → 之后截图不再弹框
（实测该授权框是**每次**都弹，不是只有首次；所以这个开关很值）。

## 把截图送回来

`captureScreen()` 返回的 `Image` **留在手机上**，xzh 拿不到。两个办法：

- **图片内容**：缩图 + base64 后让手机自己发回来（体积小、可行）：
  ```js
  var small = images.scale(img, 0.28, 0.28);
  var b64 = images.toBase64(small, "jpg", 55);
  http.post("http://<电脑IP>:<端口>/", b64, { contentType: "text/plain" });
  ```
  （电脑侧要先有接收端；xzh 的桥**已有** `/shot` 接收端，`xzh device shot` 走的就是它。）
- **只要"界面长什么样"的文字信息**：直接读 UI 树更省事，也**不需要任何截图权限**
  → 用 `device_read_screen`。

> **xzh 已内置这套流程，优先用现成的，不要自己手写**：
> `device_screenshot` 工具 / `xzh device shot [文件]` —— 授权线程、缩图、回传、落盘都已封装。
> ⚠ 但工具**只把文件路径**给你，你**看不到图片内容**；要自己判断界面请用文本树。

## ⚠ 文本树 ≠ 截图

实测同一次操作里，文本树读到 85 条（计算器 / 相册 / 相机 …），而截图里桌面只显示了一个图标 ——
桌面类应用会把**其它分页 / 文件夹**的条目也挂在无障碍树上。
因此判断"当前界面是什么"时，**至少交叉验证两项**：`currentPackage()` / `currentActivity()`
与文本树，必要时再截图。

补充一条同类经验：无障碍读到的 `currentPackage()` / `currentActivity()` **也可能过期**
（实测截图明明在 A 应用，却报 B 应用）——**以截图为准**。
