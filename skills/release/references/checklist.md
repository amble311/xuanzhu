# 发版逐步清单（可复制）

> `release` 技能的伴随文件。**先读主文件**的红线与标准顺序；这里只给命令。
> 把 `<包名>` 换成 `node -p "require('./package.json').name"` 的结果。

## 0. 摸清仓库形态（每次都先做）

```bash
node -p "const p=require('./package.json');[p.name,p.version,p.scripts&&Object.keys(p.scripts).join(','),p.files&&p.files.join(',')].join('\n')"
ls -1 *.sh 2>/dev/null; ls -1R .github/workflows 2>/dev/null
```

- **有发布脚本 / CI 工作流** → 直接用它（脚本内部通常已处理 registry 等待、本机安装等）。
  只在脚本失败或需要人工决策时回到下面几步。
- **走 CI 发布（tag 触发）** → 本地只做「bump + CHANGELOG + 提交 + 打 tag + push」，
  不要本地再 `npm publish`。

## 1. 前置检查

```bash
git status --porcelain                 # 哪些改动会进这次提交；留意未跟踪文件
git branch --show-current              # 确认发布分支
git log --oneline -3
npm whoami                             # 未登录先 npm login
npm view <包名> version                # 线上最新版（发布前必查）
npm view <包名> versions --json | tail # 需要看历史版本时
```

## 2. 版本号

```bash
# 推荐：先不建 git tag（由后面的 git 步骤统一提交/打 tag）
npm version patch --no-git-tag-version   # 或 minor / major
git diff --stat package.json package-lock.json   # 确认 lock 同步更新
```

- 版本号要出现在哪几处？通常 `package.json` + lock 文件 + CHANGELOG。
  项目里若还有「版本常量 / 文档里的版本号 / 安装脚本里的号」，一并对齐（用 `grep` 找当前版本号）。
- **本地号领先线上号**：不要 bump，直接发布当前号（见主文件红线）。

## 3. CHANGELOG

把顶部的 `## [未发布]` 收成本次版本（保留一个新的空 `[未发布]` 段供下次用）：

```bash
grep -n '^## \[' CHANGELOG.md | head -3
```

若项目没有 CHANGELOG 约定，就在 `git commit` 信息里写清改动范围即可。

## 4. 校验（发出去之前）

```bash
npm run typecheck 2>/dev/null || true     # 有就一定要跑
npm test 2>/dev/null || true
npm run build 2>/dev/null || true         # 有 prepare/prepublishOnly 的项目 publish 时也会构建
npm pack --dry-run                        # 唯一可信的「包里到底有什么」清单
```

`npm pack --dry-run` 要重点看：**不该出现的文件**（测试、源码、凭据、大二进制）与
**缺失的文件**（构建产物、文档、bin 脚本）。包内容由 `files` 白名单 / `.npmignore` 决定。

## 5. 发布

```bash
npm publish                    # scoped 包：npm publish --access public
npm publish --otp 123456       # 启用 2FA 的账号
```

发布前确认 `npm config get registry` 指向**官方源**（`https://registry.npmjs.org/`）——
发布到镜像 / 内网源不算发布。

## 6. 等待 registry 可见（1–3 分钟）

```bash
PACKAGE=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
curl -s "https://registry.npmjs.org/$PACKAGE?t=$(date +%s%N)" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.versions['$VERSION']?'可见':'尚未同步')})"
```

带时间戳是为了绕开 CDN 缓存；循环重试即可（间隔 10s 左右，最多等几分钟）。

## 7. 提交并推送

```bash
git status --porcelain          # 再确认一次：这次要提交的东西是不是都想提交
git add -A
git diff --cached --stat
git commit -m "发布 $VERSION"
git push
git tag "v$VERSION" && git push --tags     # 需要 tag / 触发 CI 发布时
```

若项目用 `gh` 维护 Release：

```bash
gh release create "v$VERSION" --title "v$VERSION" --notes-file CHANGELOG.md --latest
```

## 8. 发布后校验

```bash
npm view <包名> version                                     # 应等于本次版本
npm i -g <包名>@<版本> && <命令> --version                   # 可执行 + 版本正确
npm view <包名> dist.tarball                                 # 出问题时可直连 tarball 安装
```
