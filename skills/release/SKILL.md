---
name: release
description: 给一个项目做正式发版：改版本号 / 收 CHANGELOG / 构建与测试 / 发布到 npm / 等待 registry 同步 / 提交并推送到 GitHub / 发布后校验。当用户说「发版」「发布到 npm」「推送 GitHub」「bump 版本」时使用。
metadata:
  displayName: Release
  icon: package
  category: release
  version: 1.0.0
---

# 发布（npm + GitHub）

把一批本地改动变成**一个正式版本**：新版本号 → 校验 → npm 包 → GitHub 提交与推送。

本技能目录的绝对路径见 `load_skill` 的返回，用它可以拼出 `references/*.md` 的绝对路径。

## 先做这三件事（顺序不能反）

1. **先读仓库自带的发布脚本 / CI 工作流**：`ls *.sh .github/workflows/ 2>/dev/null`。
   多数项目早把「bump → 构建 → publish → push」串成了一个脚本或工作流，**有就照它走**，
   不要在脚本之外重复它的步骤 —— 否则会出现「版本号改两次」「包发了两次」这类事故。
2. **拿到用户对这次发布的明确同意**。发布不可撤销，不要因为改动做完就顺手发版。
   若仓库有「发布需用户同意」之类的项目规则，先遵守它。
3. **查线上已有的版本号**：`npm view <包名> version`。npm 的版本号只能前进。

## 红线（不可回退，动手前确认）

- **已发布的版本号不可覆盖、不可回退**。本地 `package.json` 的号**领先于**线上 =
  上次发布停在了「改了号还没发」这一步 → **直接发布该版本，不要再 +1**（跳过号永远补不回来）。
- **`npm publish` 成功 ≠ registry 已可见**：npm 有 staging 阶段，客户端的元数据缓存还会额外滞后，
  通常 1–3 分钟后才装得上。「看不见」时**不要重发同版本**（会 403），等或换查询方式，见 pitfalls。
- **发布脚本常用 `git add -A`**：提交前逐项确认未跟踪文件，**不要把凭据、本地记忆、
  只读参考源码、AI 工作产物带进公开仓库**。误推到公开仓库的密钥必须**轮换** —— 改历史无效。
- 不 `--force` 推送、不跳过 hooks、不 `--no-verify`，除非用户明确要求（`main` 上尤其禁止）。

## 标准顺序

1. 前置检查：当前分支、工作区状态、`npm whoami`、线上版本。
2. 改版本号（`package.json` 与 lock 文件保持一致），CHANGELOG 把 `[未发布]` 标成本次版本 + 日期。
3. 校验：按 `package.json` 的 scripts 跑类型检查 / 测试 / 构建；`npm pack --dry-run` 看真实包内容。
4. `npm publish`（scoped 包需要 `--access public`；启用 2FA 时带 `--otp`）。
5. 轮询等待 registry 可见（查询串加时间戳绕开 CDN 缓存）。
6. `git commit -m "发布 X.Y.Z"` 并 `git push`（需要 tag 时补 `git tag vX.Y.Z && git push --tags`）。
7. 发布后校验：`npm view <包名> version`；有条件就装一次跑 `--version` 确认可执行。

## 要做什么 → 读哪个文件

| 你要做的事 | 读这个 |
| --- | --- |
| 逐步命令清单（前置检查 / bump / 校验 / 发布 / 等待同步 / 推送 / 发布后校验） | `references/checklist.md` |
| 卡住了：registry 看不见、全局安装 ENOTEMPTY、2FA、镜像源、包内容不对、版本号冲突 | `references/pitfalls.md` |
