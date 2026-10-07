#!/bin/sh
#
# 玄猪 一键发布脚本
#
# 用法：
#   ./release.sh                 # 版本尾号 +1（patch），发布到 npm 并推送 GitHub，然后更新本地 xzh
#   ./release.sh minor           # 中间位 +1（0.1.4 → 0.2.0）
#   ./release.sh major           # 首位 +1（0.1.4 → 1.0.0）
#   ./release.sh 1.2.3           # 直接指定版本号
#
# 环境变量：
#   XZH_RELEASE_DRY_RUN=1        只演练，不做任何写入（不改版本、不发布、不推送）
#   XZH_RELEASE_YES=1            跳过发布前的确认提示
#   XZH_RELEASE_WAIT=300        等待 npm registry 同步的最长秒数（默认 300）
#   XZH_RELEASE_SKIP_LOCAL=1     不更新本机的全局安装
#   XZH_RELEASE_SKIP_GIT=1       不推送到 GitHub
#
# 为什么需要这个脚本：发布一条链路要跨 npm 与 git，而且有几个反直觉的坑 ——
#   1. `npm publish` 返回成功 ≠ registry 已可见。npm 有个 staging 阶段，
#      期间 `npm view` / `npm install` 会报 notarget，直接更新本机会失败。
#   2. npm 客户端的元数据缓存还会额外滞后，必要时得用 tarball 直连绕过。
#   3. 版本号、GitHub 提交、npm 包三者必须一致，手工操作容易漏掉某一步。
# 脚本把这些都串起来并自动等待/重试。
#
# 退出码：0 成功；1 失败（失败时不会留下"发了一半"的本地状态）

set -eu

# ──────────────────────────── 输出 ────────────────────────────

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$(printf '\033[0m'); C_BOLD=$(printf '\033[1m')
  C_DIM=$(printf '\033[2m');   C_RED=$(printf '\033[31m')
  C_GREEN=$(printf '\033[32m'); C_YELLOW=$(printf '\033[33m')
  C_CYAN=$(printf '\033[36m')
else
  C_RESET='' C_BOLD='' C_DIM='' C_RED='' C_GREEN='' C_YELLOW='' C_CYAN=''
fi

step() { printf '\n%s==> %s%s\n' "$C_CYAN$C_BOLD" "$1" "$C_RESET"; }
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
info() { printf '  %s%s%s\n' "$C_DIM" "$1" "$C_RESET"; }
warn() { printf '  %s⚠%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
die()  { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$1" >&2; exit 1; }

# ──────────────────────────── 参数 ────────────────────────────

BUMP="${1:-patch}"
DRY_RUN="${XZH_RELEASE_DRY_RUN:-0}"
ASSUME_YES="${XZH_RELEASE_YES:-0}"
WAIT_SECONDS="${XZH_RELEASE_WAIT:-300}"
SKIP_LOCAL="${XZH_RELEASE_SKIP_LOCAL:-0}"
SKIP_GIT="${XZH_RELEASE_SKIP_GIT:-0}"

case "$BUMP" in
  patch|minor|major) ;;
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) die "无法识别的参数：$BUMP
    用法：./release.sh [patch|minor|major|X.Y.Z]" ;;
esac

# ──────────────────────── 1. 前置检查 ────────────────────────

step "检查环境"

[ -f package.json ] || die "当前目录没有 package.json，请在项目根目录运行"
[ -f bin/xzh.js ]   || die "找不到 bin/xzh.js，这似乎不是玄猪的仓库"

command -v node >/dev/null 2>&1 || die "未找到 node"
command -v npm  >/dev/null 2>&1 || die "未找到 npm"
command -v curl >/dev/null 2>&1 || die "未找到 curl（用于等待 registry 同步）"

PACKAGE=$(node -p "require('./package.json').name")
BIN_NAME=$(node -p "Object.keys(require('./package.json').bin || {xzh:''})[0]")
CURRENT=$(node -p "require('./package.json').version")
ok "包名 $PACKAGE  ·  命令 $BIN_NAME  ·  当前版本 $CURRENT"

if [ "$SKIP_GIT" != "1" ]; then
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "不是 git 仓库（或用 XZH_RELEASE_SKIP_GIT=1 跳过）"
  git remote get-url origin >/dev/null 2>&1 || die "未配置 origin 远程仓库"
  BRANCH=$(git branch --show-current)
  info "分支 $BRANCH  ·  远程 $(git remote get-url origin)"
  if [ "$BRANCH" != "main" ]; then
    warn "当前不在 main 分支上，确认这是你想发布的分支"
  fi
  CHANGES=$(git status --porcelain | wc -l | tr -d ' ')
  info "工作区有 $CHANGES 个未提交改动（会一并提交）"
fi

if [ "$SKIP_LOCAL" != "1" ] && [ "$DRY_RUN" != "1" ]; then
  npm whoami >/dev/null 2>&1 || die "npm 未登录（请先 npm login 或配置 token）"
  info "npm 身份 $(npm whoami)"
fi

# ──────────────────── 2. 计算新版本号 ────────────────────

step "计算新版本号"

# 线上最新版（带时间戳绕开 CDN 缓存）
PUBLISHED=$(curl -s "https://registry.npmjs.org/$PACKAGE?t=$(date +%s%N)" 2>/dev/null | node -e "
  let s = '';
  process.stdin.on('data', d => s += d).on('end', () => {
    try { process.stdout.write(JSON.parse(s)['dist-tags']?.latest ?? ''); } catch { /* 忽略 */ }
  });" 2>/dev/null || printf '')

# 若本地 package.json 的版本**领先于**线上，说明上次发布停在了
# 「已改版本号、但还没推送」这一步（例如在确认环节被取消，
# 或在 npm publish 之前中断）。此时必须直接发布该版本，
# 否则它会被永久跳过 —— npm 的版本号只能前进，补不回一个已越过的号。
NEEDS_BUMP=1
# 注意演练模式也要走这段：它只读远端信息、不改任何文件，
# 而「会不会被 +1」正是演练最需要提前看到的结论。
if [ -n "$PUBLISHED" ] && [ "$CURRENT" != "$PUBLISHED" ]; then
  if [ "$(printf '%s\n%s\n' "$CURRENT" "$PUBLISHED" | sort -V | tail -1)" = "$CURRENT" ]; then
    NEEDS_BUMP=0
    NEW_VERSION="$CURRENT"
    warn "线上最新为 $PUBLISHED，而本地 package.json 已是 $CURRENT"
    info "检测到此前改过版本号但未发布，本次直接发布 $CURRENT（不再 +1）"
  fi
fi

if [ "$NEEDS_BUMP" = "1" ]; then
  case "$BUMP" in
    patch|minor|major)
      if [ "$DRY_RUN" = "1" ]; then
        # 演练模式不修改文件：直接算给用户看
        NEW_VERSION=$(node -e "
          const [maj, min, pat] = require('./package.json').version.split('.').map(Number);
          const kind = process.argv[1];
          console.log(kind === 'major' ? (maj+1)+'.0.0'
                    : kind === 'minor' ? maj+'.'+(min+1)+'.0'
                    : maj+'.'+min+'.'+(pat+1));
        " "$BUMP")
      else
        npm version "$BUMP" --no-git-tag-version >/dev/null
        NEW_VERSION=$(node -p "require('./package.json').version")
      fi
      ;;
    *)
      NEW_VERSION="$BUMP"
      if [ "$DRY_RUN" != "1" ]; then
        npm version "$NEW_VERSION" --no-git-tag-version >/dev/null
      fi
      ;;
  esac
fi

ok "$CURRENT → $C_BOLD$NEW_VERSION$C_RESET"

# 起手先确认这个版本还没被占用，避免做到一半才失败
HTTP=$(curl -s -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/$PACKAGE/$NEW_VERSION")
if [ "$HTTP" = "200" ]; then
  die "版本 $NEW_VERSION 已存在于 npm（npm 的版本号不可覆盖，请换一个）"
fi

# ──────────────────────── 3. 确认 ────────────────────────

if [ "$ASSUME_YES" != "1" ] && [ "$DRY_RUN" != "1" ]; then
  printf '\n%s即将执行（npm 的发布不可撤销）：%s\n' "$C_YELLOW" "$C_RESET"
  printf '  1. npm version %s  →  %s\n' "$BUMP" "$NEW_VERSION"
  printf '  2. npm publish\n'
  [ "$SKIP_GIT" = "1" ]   || printf '  3. git commit + push（%s）\n' "$(git branch --show-current)"
  [ "$SKIP_LOCAL" = "1" ] || printf '  4. 更新本机全局安装的 %s\n' "$BIN_NAME"
  printf '\n继续？[y/N] '
  read -r ANSWER
  case "$ANSWER" in
    y|Y|yes|YES) ;;
    *) die "已取消" ;;
  esac
fi

if [ "$DRY_RUN" = "1" ]; then
  step "演练模式（DRY RUN）"
  info "以上步骤均未真正执行。去掉 XZH_RELEASE_DRY_RUN=1 即可正式发布。"
  exit 0
fi

# ──────────────────────── 4. 发布到 npm ────────────────────────

step "发布到 npm"
if ! npm publish 2>&1 | tail -12; then
  die "npm publish 失败（版本号已改为 $NEW_VERSION，请修正问题后重跑）"
fi
ok "npm publish 已提交"

# ────────────────── 5. 等待 registry 同步 ──────────────────

step "等待 npm registry 同步"
info "npm 有 staging 阶段，发布成功到可安装通常需要 1–3 分钟"

WAITED=0
SYNCED=0
while [ "$WAITED" -lt "$WAIT_SECONDS" ]; do
  # 加时间戳绕过 CDN 缓存
  FOUND=$(curl -s "https://registry.npmjs.org/$PACKAGE?t=$(date +%s%N)" 2>/dev/null | node -e "
    let s='';
    process.stdin.on('data', d => s += d).on('end', () => {
      try { process.stdout.write(JSON.parse(s).versions['$NEW_VERSION'] ? 'yes' : 'no'); }
      catch { process.stdout.write('no'); }
    });" 2>/dev/null || printf 'no')

  if [ "$FOUND" = "yes" ]; then
    SYNCED=1
    break
  fi

  printf '  %s…已等待 %ss%s\r' "$C_DIM" "$WAITED" "$C_RESET"
  sleep 10
  WAITED=$((WAITED + 10))
done
printf '%*s\r' 40 ''

if [ "$SYNCED" = "1" ]; then
  ok "registry 已可见 $NEW_VERSION（等待 ${WAITED}s）"
else
  warn "等待 ${WAIT_SECONDS}s 后仍未在 registry 上看到 $NEW_VERSION"
  warn "发布多半仍然成功了（只是同步慢），可稍后手工执行第 4 步"
fi

# ──────────────────────── 6. 推送 GitHub ────────────────────────

if [ "$SKIP_GIT" = "1" ]; then
  warn "已跳过 GitHub 推送（XZH_RELEASE_SKIP_GIT=1）"
else
  step "提交并推送到 GitHub"
  git add -A
  if git diff --cached --quiet; then
    info "没有需要提交的改动"
  else
    git -c user.name="$(git config --get user.name || echo "$PACKAGE")" \
        -c user.email="$(git config --get user.email || echo "$PACKAGE@users.noreply.github.com")" \
        commit -q -m "发布 $NEW_VERSION"
    ok "已提交"
  fi
  if git push 2>&1 | tail -3; then
    ok "已推送到 $(git remote get-url origin)"
  else
    warn "git push 失败，请手工执行 git push（本地提交已保留）"
  fi
fi

# ──────────────── 7. 更新本机全局安装 ────────────────

if [ "$SKIP_LOCAL" = "1" ]; then
  warn "已跳过更新本机安装（XZH_RELEASE_SKIP_LOCAL=1）"
else
  step "更新本机全局安装"
  if [ "$SYNCED" != "1" ]; then
    warn "registry 尚未同步，跳过更新；稍后可执行：npm i -g $PACKAGE@latest"
  else
    # 先清掉历史安装中断留下的暂存目录（形如 .<包名>-XXXXXX）。
    # npm 在安装前需要删除它们，而某些环境装有 safe-delete 之类的保护机制：
    # 目录体量大（几千个文件）时会被拒绝删除，安装随即失败 ——
    # 表现为「发布成功但本机没更新」，且错误容易被静默吞掉、难以排查。
    GLOBAL_ROOT=$(npm root -g 2>/dev/null || printf '')
    if [ -n "$GLOBAL_ROOT" ] && [ -d "$GLOBAL_ROOT" ]; then
      node -e "
        const fs = require('fs'); const path = require('path');
        let removed = 0;
        try {
          for (const entry of fs.readdirSync(process.argv[1])) {
            if (entry.startsWith('.$PACKAGE-')) {
              fs.rmSync(path.join(process.argv[1], entry), { recursive: true, force: true });
              removed++;
            }
          }
        } catch { /* 无权限等情况下忽略 */ }
        if (removed > 0) process.stdout.write('  已清理 ' + removed + ' 个残留暂存目录\n');
      " "$GLOBAL_ROOT" || true
    fi

    INSTALL_ERR=$(npm i -g "$PACKAGE@$NEW_VERSION" 2>&1) && INSTALL_OK=1 || INSTALL_OK=0
    if [ "$INSTALL_OK" != "1" ]; then
      # 元数据缓存偶尔滞后，用 tarball 直连绕过
      info "常规安装失败，尝试 tarball 直连…"
      INSTALL_ERR=$(npm i -g "https://registry.npmjs.org/$PACKAGE/-/$PACKAGE-$NEW_VERSION.tgz" 2>&1) \
        && INSTALL_OK=1 || INSTALL_OK=0
    fi

    if [ "$INSTALL_OK" = "1" ]; then
      ok "已安装 $PACKAGE@$NEW_VERSION"
    else
      # 失败必须把原因显示出来，否则「本机没更新」无从排查
      warn "本机安装失败，请手工执行：npm i -g $PACKAGE@latest"
      printf '%s\n' "$INSTALL_ERR" | tail -6 | sed 's/^/      /'
    fi

    if command -v "$BIN_NAME" >/dev/null 2>&1; then
      ok "$($BIN_NAME --version 2>&1 | tail -1)"
    fi
  fi
fi

# ──────────────────────── 完成 ────────────────────────

step "完成"
printf '  npm     : https://www.npmjs.com/package/%s/v/%s\n' "$PACKAGE" "$NEW_VERSION"
if [ "$SKIP_GIT" != "1" ]; then
  REPO=$(git remote get-url origin | sed 's#git@github.com:#https://github.com/#; s#\.git$##')
  printf '  GitHub  : %s\n' "$REPO"
  printf '  提交    : %s\n' "$(git --no-pager log --oneline -1)"
fi
printf '  版本    : %s\n' "$NEW_VERSION"
