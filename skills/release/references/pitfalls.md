# 发版踩坑（现象 → 原因 → 处理）

> `release` 技能的伴随文件。只在**卡住**时读；正常发布不需要它。

## 发布/安装类

**`npm publish` 成功，但 `npm install` / `npm view` 报 `notarget` 或看不到新版本**
原因：npm 的 staging 阶段 + CDN/客户端元数据缓存，通常 1–3 分钟后才可见。
处理：等一段时间再查；查询 URL 加时间戳（`?t=$(date +%s%N)`）绕缓存；
仍装不上时直接装 tarball：`npm i -g https://registry.npmjs.org/<包名>/-/<包名>-<版本>.tgz`。
**不要**因为看不见就重发同版本 —— 会因版本已存在而失败。

**`npm i -g` 报 `ENOTEMPTY: directory not empty, rename '.../<包名>' -> '.../.<包名>-XXXX'`**
原因：npm 给全局暂存目录起的是**固定名字**（`.<包名>-<哈希>`）。上次安装留下的残渣还在时，
后续**每一次**全局安装都会失败（不是偶发）。某些环境还有 safe-delete 之类的保护，
`rm -rf` **静默失败**（看似成功、目录还在），所以删完必须复查。
处理：删除（删不掉就移出 `node_modules`）该暂存目录后重装：

```bash
GLOBAL_ROOT=$(npm root -g)
ls -d "$GLOBAL_ROOT"/.<包名>-* 2>/dev/null      # 找到残渣
rm -rf "$GLOBAL_ROOT"/.<包名>-* 2>/dev/null; ls -d "$GLOBAL_ROOT"/.<包名>-* 2>/dev/null   # 复查
```

**发布报 403 `You do not have permission` / `cannot publish over previously published version`**
原因：① 账号不是该包/该 scope 的维护者（scoped 包还要 `--access public` 才是公开包）；
② 版本号已存在 —— npm 不允许覆盖，**只能换号**；③ token 权限不足（CI 的 `NPM_TOKEN` 需 publish 权限）。

**`EOTP` / 提示输入一次性密码**
原因：账号开启了 2FA。处理：`npm publish --otp <六位码>`；CI 里用 automation token 或带 provenance 的 Trusted Publishing。

**发布到了错误的源 / 镜像上**
处理：`npm config get registry` 确认是 `https://registry.npmjs.org/`；国内镜像只用于**安装**，
`publish` 要显式发官方源。`npm view` 看到的可能是镜像的滞后数据，判断「是否已发布」要用官方源 + 时间戳。

## 版本与仓库状态类

**版本号被跳过，补不回来**
npm 的版本号只能前进：0.4.2 发布后才发现有问题，只能发 0.4.3，不能回头改 0.4.2
（`npm unpublish` 有严格时限、会破坏别人的 lockfile，别用）。
所以发布前必须跑测试与 `npm pack --dry-run`。

**本地版本号比线上新：这是「上次发了一半」**
说明上次停在了「改了 `package.json` 但没 publish」这一步。直接发布当前号，**不要 +1**。

**发布脚本用 `git add -A`，把不该提交的东西一起推上去了**
常见：密钥 / `.env`、只读参考源码、AI 工作产物、本地记忆目录。
处理：**立即轮换泄露的凭据**（改历史无效，可能已被抓取/缓存）；然后把它们写进 `.gitignore`，
并在脚本的 `git add` 前加一次 `git status --ignored` 人工确认。

**commit 了但推送失败 / 只推了 tag 没推分支**
现象：本地有「发布 X.Y.Z」提交，远端没有。处理：`git push`（必要时 `git push --tags`）。
顺序上先 `publish` 后 `push` 时，会出现「包已公开、仓库还没跟上」的窗口 —— 补推即可；
反之（先 push 后 publish 失败）会留下「版本号已被占用、包却不存在」的悬空提交，只能补发该号。

## 包内容类

**包里多了测试/源码/大文件，或少了构建产物**
原因：内容由 `files` 白名单（或 `.npmignore`）决定，和 git 跟踪的文件**不是一回事**；
`prepare` / `prepublishOnly` 会在发布前触发构建，本地没构建也不一定缺产物。
处理：`npm pack --dry-run` 看清单再调 `files`；注意某些生命周期脚本
（`prepare` 在 `publish` 与本地 `install` 时都跑）会带来意外的副作用。

**monorepo / workspace 里发错包或漏带依赖**
处理：在目标包目录内发布（或用 `npm publish -w <子包>`），并确认 workspace 依赖
（`workspace:*`）在发布时被替换成真实版本号（`npm publish` 会做，`pnpm pack` 参数不同）。
