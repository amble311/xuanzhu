#!/bin/sh
#
# 玄猪（XuanZhu）一键全局安装脚本 —— Linux / macOS
#
# 用法一（推荐，从源码仓库直接安装）：
#   ./install.sh
#   脚本会识别自身所在的源码目录，直接从该目录全局安装（无需先发布到 npm）。
#
# 用法二（远程安装，需包已发布或给出可用的源）：
#   curl -fsSL https://raw.githubusercontent.com/amble311/xuanzhu/main/install.sh | sh
#   XZH_PACKAGE=xuanzhu sh install.sh
#
# 可用环境变量：
#   XZH_PACKAGE   手动指定安装源（会覆盖自动识别）。可填：
#                   xuanzhu                            npm 包名
#                   xuanzhu@0.1.0                     指定版本
#                   git+https://github.com/u/r.git    从 git 仓库安装
#                   ./xzh-0.1.0.tgz                   本地 tarball
#                   /path/to/xzh                      本地源码目录
#   XZH_VERSION   指定版本，等价于把包名写成 `xuanzhu@<版本>`
#   XZH_NPM_ARGS  追加给 npm 的额外参数，例如国内镜像：
#                   XZH_NPM_ARGS=--registry=https://registry.npmmirror.com
#   XZH_DRY_RUN   设为 1 时只打印将要执行的命令，不真正安装
#   NO_COLOR      设为任意值可禁用彩色输出
#
# 退出码：0 成功 | 1 环境不满足 | 2 安装失败

set -eu

# ─────────────────────────────── 输出 ───────────────────────────────

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD="$(printf '\033[1m')"
  DIM="$(printf '\033[2m')"
  RED="$(printf '\033[31m')"
  GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"
  CYAN="$(printf '\033[36m')"
  RESET="$(printf '\033[0m')"
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; CYAN=""; RESET=""
fi

step() { printf '\n%s==>%s %s\n' "$CYAN$BOLD" "$RESET" "$1"; }
ok()   { printf '%s  ✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '%s  !%s %s\n' "$YELLOW" "$RESET" "$1" >&2; }
die()  { printf '%s  ✗%s %s\n' "$RED" "$RESET" "$1" >&2; exit "${2:-1}"; }

printf '\n%s玄猪 XuanZhu%s %s— 终端 AI 编码 Agent%s\n' \
  "$BOLD" "$RESET" "$DIM" "$RESET"

# ────────────────────── 0. 拒绝以 root 身份安装 ──────────────────────
#
# 用 sudo 跑会把文件属主写成 root，之后普通用户升级/卸载都会失败；
# 而全局目录通常本来就属于当前用户，根本不需要 sudo。

if [ "$(id -u)" = "0" ]; then
  warn "检测到以 root（sudo）身份运行。"
  die "请不要用 sudo 安装。全局目录通常属于当前用户，无需提权；
    若确实不可写，脚本会自己提示设置用户级 prefix 的办法。" 1
fi

# ──────────────────────── 1. 决定安装源 ────────────────────────
#
# 优先级：
#   1. XZH_PACKAGE 环境变量（用户显式指定）
#   2. 脚本旁边的源码目录（./install.sh 这种用法）—— 此时包可能尚未发布到 npm，
#      直接从源码安装是唯一可行的路径
#   3. npm registry 上的 xuanzhu（curl | sh 这种没有本地源码的用法）

SOURCE=""
SOURCE_KIND=""
SELF_DIR=""

case "$0" in
  # 通过管道执行（curl | sh）时 $0 是解释器名，没有脚本文件
  sh|bash|dash|ash|zsh|-sh|*/bin/sh|*/bin/bash|*/bin/dash) SELF_DIR="" ;;
  */*) SELF_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)" ;;
  *)   SELF_DIR="$(pwd)" ;;
esac

if [ -n "${XZH_PACKAGE:-}" ]; then
  SOURCE="$XZH_PACKAGE"
  SOURCE_KIND="手动指定"
elif [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/package.json" ] && [ -f "$SELF_DIR/bin/xzh.js" ]; then
  SOURCE="$SELF_DIR"
  SOURCE_KIND="本地源码"
else
  SOURCE="xuanzhu"
  SOURCE_KIND="npm registry"
fi

# XZH_VERSION 只在源是普通包名时参与拼接，
# 免得把 git+https://...@main 这类本来就带 @ 的源改坏。
if [ -n "${XZH_VERSION:-}" ] && [ "$SOURCE_KIND" != "本地源码" ]; then
  case "$SOURCE" in
    *@*) : ;;
    *)   SOURCE="${SOURCE}@${XZH_VERSION}" ;;
  esac
fi

# ────────────────────────── 2. 检查运行环境 ──────────────────────────

step "检查运行环境"

MIN_NODE_MAJOR=18
RECOMMENDED_NODE_MAJOR=20

if ! command -v node >/dev/null 2>&1; then
  die "未找到 Node.js。请先安装 Node.js ${RECOMMENDED_NODE_MAJOR} 或更高版本：https://nodejs.org/" 1
fi

NODE_VERSION="$(node -v 2>/dev/null | sed 's/^v//')"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | cut -d. -f1)"

case "$NODE_MAJOR" in
  ''|*[!0-9]*) die "无法识别 Node.js 版本（node -v 输出：$NODE_VERSION）。" 1 ;;
esac

if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  die "Node.js 版本过低（当前 v$NODE_VERSION，需要 v$MIN_NODE_MAJOR 或更高）。请升级：https://nodejs.org/" 1
fi
ok "Node.js v$NODE_VERSION"

if [ "$NODE_MAJOR" -lt "$RECOMMENDED_NODE_MAJOR" ]; then
  warn "建议升级到 Node.js v$RECOMMENDED_NODE_MAJOR 或更高，以获得更好的兼容性。"
fi

if ! command -v npm >/dev/null 2>&1; then
  die "未找到 npm。它通常随 Node.js 一起安装，请检查 PATH。" 1
fi
ok "npm v$(npm -v 2>/dev/null)"

# ────────────────────────── 3. 检查现有安装 ──────────────────────────

step "检查现有安装"

if command -v xzh >/dev/null 2>&1; then
  ok "检测到已安装：$(command -v xzh)（将升级覆盖）"
else
  ok "尚未安装，将全新安装"
fi

# ───────────────────────── 4. 确认安装源可用 ─────────────────────────

step "确认安装源"

case "$SOURCE_KIND" in
  本地源码)
    if [ ! -f "$SOURCE/dist/cli.js" ]; then
      warn "源码尚未构建（缺少 dist/cli.js），安装过程会自动执行构建。"
    fi
    ok "$SOURCE  ${DIM}(本地源码目录)${RESET}"
    ;;
  手动指定)
    ok "$SOURCE  ${DIM}(来自 XZH_PACKAGE)${RESET}"
    ;;
  *)
    # 先探测包是否存在，避免装到一半才报 404 并给出误导性的排查方向
    if [ "${XZH_DRY_RUN:-0}" != "1" ] && ! npm view "$SOURCE" version >/dev/null 2>&1; then
      die "npm registry 上找不到 $SOURCE。

    可能的原因：
      · 包还没有发布到 npm —— 请改从源码安装：
          cd <仓库目录> && ./install.sh
      · 包名写错了，或用的是私有 registry：
          XZH_PACKAGE=<包名> XZH_NPM_ARGS=--registry=<镜像地址> sh install.sh" 2
    fi
    ok "$SOURCE  ${DIM}(npm registry)${RESET}"
    ;;
esac

# ───────────────────────── 5. 准备安装目录 ─────────────────────────

step "准备全局安装目录"

GLOBAL_PREFIX="$(npm config get prefix 2>/dev/null || true)"
SUDO=""

if [ -n "$GLOBAL_PREFIX" ] && [ -d "$GLOBAL_PREFIX" ] && [ ! -w "$GLOBAL_PREFIX" ]; then
  if command -v sudo >/dev/null 2>&1; then
    warn "全局目录 $GLOBAL_PREFIX 对当前用户不可写，安装将使用 sudo。"
    SUDO="sudo"
  else
    die "全局目录 $GLOBAL_PREFIX 不可写，且未找到 sudo。
    更推荐改为用户级安装（无需 root，也不会污染系统目录）：
      npm config set prefix ~/.npm-global
    然后确保 ~/.npm-global/bin 已加入 PATH。" 1
  fi
else
  ok "全局目录：${GLOBAL_PREFIX:-（npm 默认）}"
fi

# ──────────────────────────── 6. 安装 ────────────────────────────

step "安装 $SOURCE"

# XZH_NPM_ARGS 需要按空格拆成多个参数，因此这里刻意不加引号。
# shellcheck disable=SC2086
if [ "${XZH_DRY_RUN:-0}" = "1" ]; then
  printf '%s  [dry-run]%s %snpm install -g %s %s%s\n' \
    "$DIM" "$RESET" "${SUDO:+$SUDO }" "$SOURCE" "${XZH_NPM_ARGS:-}" ""
else
  NPM_LOG="$(mktemp 2>/dev/null || printf '/tmp/xzh-install-%s.log' "$$")"
  set +e
  # shellcheck disable=SC2086
  $SUDO npm install -g "$SOURCE" ${XZH_NPM_ARGS:-} >"$NPM_LOG" 2>&1
  STATUS=$?
  set -e

  if [ "$STATUS" -ne 0 ]; then
    grep -v '^$' "$NPM_LOG" | tail -20 >&2
    if grep -q "E404" "$NPM_LOG"; then
      die "安装失败：npm registry 上找不到该包（404）。
    若你确实想从 npm 安装，请确认包名或改用镜像：
        XZH_NPM_ARGS=--registry=https://registry.npmmirror.com
    未发布时请改用源码安装：cd <仓库目录> && ./install.sh" 2
    elif grep -qiE "EACCES|permission denied" "$NPM_LOG"; then
      die "安装失败：权限不足。
    请不要用 sudo（会把文件属主写成 root），改为用户级 prefix：
        npm config set prefix ~/.npm-global" 2
    else
      die "安装失败（npm 退出码 $STATUS），完整日志：$NPM_LOG" 2
    fi
  fi

  rm -f "$NPM_LOG"
  ok "安装完成"
fi

# ──────────────────────────── 7. 验证 ────────────────────────────

step "验证"

if command -v xzh >/dev/null 2>&1; then
  ok "命令可用：$(command -v xzh)"
else
  warn "xzh 尚未出现在当前 shell 的 PATH 中。"
  if [ -n "$GLOBAL_PREFIX" ]; then
    printf '%s    把下面一行加入 shell 配置（~/.bashrc 或 ~/.zshrc）后重开终端：%s\n' "$DIM" "$RESET"
    printf '%s      export PATH="%s/bin:$PATH"%s\n' "$DIM" "$GLOBAL_PREFIX" "$RESET"
  else
    printf '%s    新开一个终端窗口后重试即可。%s\n' "$DIM" "$RESET"
  fi
fi

# ──────────────────────────── 完成 ────────────────────────────

printf '\n%s安装完成%s\n\n' "$GREEN$BOLD" "$RESET"
printf '  %s启动%s       xzh\n' "$BOLD" "$RESET"
printf '  %s设置模型%s   xzh model\n' "$BOLD" "$RESET"
printf '  %s查看配置%s   xzh config\n' "$BOLD" "$RESET"
printf '\n%s  全局配置位于 ~/.xzh/；首次在某个项目下运行时会创建 .xuanzhu/ 保存项目记忆。%s\n\n' \
  "$DIM" "$RESET"
