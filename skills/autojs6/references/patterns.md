# 常见套路（可照抄）

> `autojs6` 技能的伴随文件。所有片段都假定已按主文件约定：`console.log` 回报 + try/catch + 超时判空。

## 打开应用并等待界面就绪

```js
app.launchPackage("com.example.app");
if (!waitForPackage("com.example.app", 5000)) {   // 等应用起来
  console.log("【失败】应用未启动");
  exit();
}
sleep(1500);                                      // 再给界面渲染留时间
console.log("【结果】已进入，界面=" + currentActivity());
```

## 找元素的三级兜底（点名 → 坐标 → 图像）

```js
var target = text("确定").findOne(3000);           // 1. 按文本
if (!target) target = id("btn_ok").findOne(1000);  // 2. 按 id
if (target) {
  target.click();
} else {
  console.log("【失败】未找到控件，尝试坐标兜底");
  setScreenMetrics(1080, 2400);                    // 3. 按设计稿坐标
  click(540, 1800);
}
```

## 滑动找列表项

```js
var item = null;
for (var i = 0; i < 8 && !item; i++) {             // 最多滑 8 屏
  item = textContains("目标关键字").findOnce();
  if (!item) scrollDown();                         // 或 swipe(w/2, h*0.75, w/2, h*0.3, 400)
  sleep(600);
}
console.log(item ? "【结果】找到并点击" : "【失败】滑动 8 屏未找到");
if (item) item.click();
```

## 处理可能出现的弹窗

```js
var ok = text("允许").findOnce() || text("同意").findOnce() || text("确定").findOnce();
if (ok) { ok.click(); console.log("【信息】已处理弹窗"); sleep(500); }
```

## 读取界面信息（只读，最安全）

```js
auto.waitFor(8000);
var texts = textMatches(/.+/).find();
var result = [];
texts.forEach(function (el) { result.push(el.text()); });
console.log("【结果】当前界面文本：" + result.slice(0, 20).join(" | "));
```

> 优先用现成的 `device_read_screen` 工具 —— 它已经做了运行标记过滤（避免读到上一次的残留）
> 与数量上限（防止塞爆上下文）。

## 多开 / 克隆应用的选择弹窗

> ⚠ **三条禁止**（**主文件也写了**，这里给判据与代码）：
> 1. **不要点「取消」** —— 那是"放弃这次操作"，不是"关掉弹窗"；
> 2. **不要勾「不再询问」** —— **永久改变用户的系统设置**，不可逆，只有用户明确同意才能勾；
> 3. **不要替用户随机挑一个** —— 选错分身 = 操作了**另一个账号**，表面成功、实际全错。

很多手机支持应用分身（同名应用双开）。此时 `app.launchPackage()` 后会先弹一个**选择框**，
让你挑"用哪个打开" —— 不处理的话，脚本后面所有基于控件文本的操作都会失败。

**判据**：`currentPackage()` 不是目标应用（常见是 `com.android.systemui`、`com.oplus...`、
`android` / `com.android.intentresolver`），且界面上出现**多个含应用名的条目**。

```js
app.launchPackage("com.example.app");
sleep(2500);

var candidates = textContains("<应用名>").find();          // find() 返回集合，长度用 .length 属性
if (currentPackage() !== "com.example.app" && candidates.length >= 2) {
  console.log("【多开】检测到选择框，" + candidates.length + " 个候选");
  var store = storages.create("xzh_device");
  var want = store.get("app_clone", "");                   // 之前记住过的选择
  var picked = null;
  if (want) {
    candidates.forEach(function (el) { if (!picked && String(el.text()).indexOf(want) >= 0) picked = el; });
  }
  if (!picked) {
    // 没有记忆：**不要瞎猜** —— 把候选报给用户，脚本到此结束
    var names = [];
    candidates.forEach(function (el) { names.push(el.text()); });
    console.log("【多开】候选=" + names.join(" / ") + "（等用户指定，脚本结束）");
    exit();
  }
  (picked.clickable() ? picked : picked.parent()).click();   // 文字节点常不可点，要点父容器
  sleep(1500);
  console.log("【多开】已选择：" + picked.text());
}
```

**约定**：
- 首次遇到时把候选**报给用户**，让他说"用第二个 / 工作号"，
  然后 `storages.put("app_clone", "<用户选的名字>")` **记住**；
- 之后自动复用；候选与记忆对不上（应用升级 / 新增分身）时**重新问**，不要硬选第一个；
- ⚠ 有些系统的选择框**文字也读不到**（候选是图标）：此时只能**让用户手点**，
  或按用户给的坐标点（点之前务必离「不再询问」勾选框远一点）。

## 自绘界面（游戏 / Canvas）：**先识别，别在控件上耗时间**

有些应用（游戏、部分播放器、自定义渲染的列表）**根本不给无障碍节点**。
征兆很好认：读到的控件数极少或全是空容器。

```js
auto.waitFor(8000);
var nodes = classNameMatches(/.*/).find().length;
if (nodes < 5) {
  console.log("【判断】控件数=" + nodes + "，疑似自绘界面 → 不用选择器，改走图片/坐标");
  exit();      // 或转下面的兜底策略
}
```

兜底三招（按可靠性排序）：

1. **图片匹配**：`images.findImage(截图, 模板图)` / `images.matchTemplate(截图, 模板, {threshold: 0.8})`
   —— 模板图要**先放到手机存储**（例如 `/sdcard/Pictures/xxx.png`）。
   ⚠ **模型看不到截图**，所以模板图必须来自用户（让用户截一张要点的按钮图），
   或者由之前的成功操作留下的素材。
2. **颜色定位**：`images.findColor(img, "#ff0000", {threshold: 20})` —— 适合纯色按钮。
3. **坐标**：`setScreenMetrics(1080, 2400)` 后按设计稿坐标 `click(x, y)`。
   分辨率不同要按 `device.width / 设计宽度` 做换算，别写死像素。
   给模型的截图/OCR 结果若被缩放，坐标要按 `设备宽 / 图宽` 还原。

**判断顺序**：先读控件 → 够用就用选择器（最稳）→ 不足则**立刻**转图片/颜色/坐标，
并把"这是一个自绘界面"这个结论写进回报，免得后续每一轮都在选择器上白费时间。
