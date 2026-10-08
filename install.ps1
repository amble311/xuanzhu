<#
    玄猪（XuanZhu）一键全局安装脚本 —— Windows

    用法（在 PowerShell 中执行）：

        iex (irm https://raw.githubusercontent.com/amble311/xuanzhu/main/install.ps1)

    可用环境变量（在执行上面命令之前设置）：

        $env:XZH_PACKAGE   安装源，默认 xuanzhu（npm 包名）。也可填：
                             xuanzhu@0.1.0                     指定版本
                             git+https://github.com/u/r.git    从 git 仓库安装
                             C:\path\to\xzh-0.1.0.tgz          本地 tarball
        $env:XZH_VERSION   指定版本，等价于把安装源写成 xuanzhu@<版本>
        $env:XZH_NPM_ARGS  追加给 npm 的额外参数，例如国内镜像：
                             $env:XZH_NPM_ARGS = '--registry=https://registry.npmmirror.com'
        $env:XZH_DRY_RUN   设为 1 时只打印将要执行的命令，不真正安装

    说明：本脚本刻意不使用 param() 块与 exit ——前者在 iex 管道执行下容易被误解析，
    后者会关掉你的整个 PowerShell 会话；因此失败一律用 throw 抛出。

    若下载后直接执行出现中文乱码（Windows PowerShell 5.1 按本地代码页读取脚本），
    用 PowerShell 7（pwsh）执行即可，或改走上面的 iex 方式。
#>

$ErrorActionPreference = 'Stop'

# ─────────────────────────────── 输出 ───────────────────────────────

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host '==> ' -ForegroundColor Cyan -NoNewline
    Write-Host $Text
}

function Write-Ok([string]$Text) {
    Write-Host '  √ ' -ForegroundColor Green -NoNewline
    Write-Host $Text
}

function Write-Warn([string]$Text) {
    Write-Host '  ! ' -ForegroundColor Yellow -NoNewline
    Write-Host $Text
}

function Fail([string]$Text) {
    Write-Host '  x ' -ForegroundColor Red -NoNewline
    Write-Host $Text
    throw $Text
}

# ─────────────────────────────── 配置 ───────────────────────────────

$minNodeMajor = 18
$recommendedNodeMajor = 20

Write-Host ''
Write-Host '玄猪 XuanZhu ' -NoNewline -ForegroundColor White
Write-Host '— 终端 AI 编码 Agent' -ForegroundColor DarkGray

# ──────────────────────── 0. 决定安装源 ────────────────────────
# 优先级：XZH_PACKAGE 显式指定 > 脚本旁边的本地源码目录 > npm registry。
# 注意：通过 `iex (irm ...)` 执行时 $PSScriptRoot 为空，此时只能走 npm registry。

$sourceKind = ''
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)

if ($env:XZH_PACKAGE) {
    $installSource = $env:XZH_PACKAGE
    $sourceKind = '手动指定'
} elseif ($PSScriptRoot -and
          (Test-Path (Join-Path $PSScriptRoot 'package.json')) -and
          (Test-Path (Join-Path $PSScriptRoot 'bin\xzh.js'))) {
    $installSource = $PSScriptRoot
    $sourceKind = '本地源码'
} else {
    $installSource = 'xuanzhu'
    $sourceKind = 'npm registry'
}

# XZH_VERSION 只在源是普通包名时参与拼接，
# 免得把 git+https://...@main 这类本来就带 @ 的源改坏。
if ($env:XZH_VERSION -and $sourceKind -ne '本地源码' -and $installSource -notlike '*@*') {
    $installSource = "$installSource@$($env:XZH_VERSION)"
}

if ($isAdmin) {
    Write-Warn '检测到以管理员身份运行。若全局目录本来就属于当前用户，无需提权即可安装。'
}

# ────────────────────────── 1. 检查运行环境 ──────────────────────────

Write-Step '检查运行环境'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "未找到 Node.js。请先安装 Node.js $recommendedNodeMajor 或更高版本：https://nodejs.org/"
}

$nodeVersion = (& node -v) -replace '^v', ''
$nodeMajor = 0
try {
    $nodeMajor = [int](($nodeVersion -split '\.')[0])
} catch {
    Fail "无法识别 Node.js 版本（node -v 输出：$nodeVersion）。"
}

if ($nodeMajor -lt $minNodeMajor) {
    Fail "Node.js 版本过低（当前 v$nodeVersion，需要 v$minNodeMajor 或更高）。请升级：https://nodejs.org/"
}
Write-Ok "Node.js v$nodeVersion"

if ($nodeMajor -lt $recommendedNodeMajor) {
    Write-Warn "建议升级到 Node.js v$recommendedNodeMajor 或更高，以获得更好的兼容性。"
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail '未找到 npm。它通常随 Node.js 一起安装，请检查 PATH。'
}
Write-Ok "npm $(& npm -v)"

# ────────────────────────── 2. 检查现有安装 ──────────────────────────

Write-Step '检查现有安装'

$existing = Get-Command xzh -ErrorAction SilentlyContinue
if ($existing) {
    Write-Ok "检测到已安装：$($existing.Source)（将升级覆盖）"
} else {
    Write-Ok '尚未安装，将全新安装'
}

# ──────────────────────────── 3. 安装 ────────────────────────────

# npm registry 源先探测包是否存在，避免装到一半才报 404 并给出误导性的排查方向
if ($sourceKind -eq 'npm registry' -and $env:XZH_DRY_RUN -ne '1') {
    & npm view $installSource version *> $null
    if ($LASTEXITCODE -ne 0) {
        Fail ("npm registry 上找不到 $installSource。`n" +
              '    可能的原因：' + "`n" +
              '      · 包尚未发布到 npm —— 请改从源码安装：' + "`n" +
              '          cd <仓库目录>; .\install.ps1' + "`n" +
              '      · 包名写错或使用私有 registry：' + "`n" +
              "          `$env:XZH_PACKAGE = '<包名>'; `$env:XZH_NPM_ARGS = '--registry=<镜像地址>'")
    }
    Write-Ok "$installSource  (npm registry)"
} elseif ($sourceKind -eq '本地源码') {
    Write-Ok "$installSource  (本地源码目录)"
} else {
    Write-Ok "$installSource  (来自 XZH_PACKAGE)"
}

Write-Step "安装 $installSource"

if ($env:XZH_DRY_RUN -eq '1') {
    Write-Host "  [dry-run] npm install -g $installSource $($env:XZH_NPM_ARGS)" -ForegroundColor DarkGray
} else {
    $npmArgs = @('install', '-g', $installSource)
    if ($env:XZH_NPM_ARGS) {
        $npmArgs += ($env:XZH_NPM_ARGS -split '\s+' | Where-Object { $_ })
    }

    & npm @npmArgs

    if ($LASTEXITCODE -ne 0) {
        Fail ("安装失败（npm 退出码 $LASTEXITCODE）。`n" +
              '    常见原因：' + "`n" +
              "      · 包不存在 —— 确认包名，或改从源码安装（cd <仓库目录>; .\install.ps1）" + "`n" +
              "      · 网络不通 —— 国内可先设置镜像：" + "`n" +
              "          `$env:XZH_NPM_ARGS = '--registry=https://registry.npmmirror.com'")
    }
    Write-Ok '安装完成'
}

# ──────────────────────────── 4. 验证 ────────────────────────────

Write-Step '验证'

# 先定位**本次安装**的可执行文件（npm 全局目录下的 xzh.cmd），而不是直接
# Get-Command —— 下面会刷新 PATH，Path 上若遗留旧安装就总能命中，
# 于是「装到别的 prefix」也会报告成功，用户重开窗口后才发现命令不对。
$globalPrefix = (& npm prefix -g 2>$null | Select-Object -First 1)
$installedExe = if ($globalPrefix) { Join-Path $globalPrefix 'xzh.cmd' } else { $null }
if ($installedExe -and -not (Test-Path $installedExe)) { $installedExe = $null }

# 刷新本会话 PATH，让刚装好的命令立刻可见（无需重开窗口即可确认）
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = "$machinePath;$userPath"

if (-not $installedExe) {
    Write-Warn '未找到 xzh 可执行文件，安装可能未成功。'
} elseif (Get-Command xzh -ErrorAction SilentlyContinue) {
    Write-Ok "命令可用：$((Get-Command xzh).Source)"
    $ver = (& xzh --version 2>$null | Select-Object -Last 1)
    if ($ver) { Write-Host "    版本：$ver" -ForegroundColor DarkGray }
} else {
    Write-Ok "已安装到：$installedExe"
    Write-Warn "它不在当前 PATH 中，请把 $globalPrefix 加入 PATH 后重开窗口。"
}

# ──────────────────────────── 完成 ────────────────────────────

Write-Host ''
Write-Host '安装完成' -ForegroundColor Green
Write-Host ''
Write-Host '  启动       ' -NoNewline; Write-Host 'xzh' -ForegroundColor Cyan
Write-Host '  设置模型   ' -NoNewline; Write-Host 'xzh model' -ForegroundColor Cyan
Write-Host '  查看配置   ' -NoNewline; Write-Host 'xzh config' -ForegroundColor Cyan
Write-Host ''
Write-Host "  全局配置位于 $env:USERPROFILE\.xzh\；首次在某个项目下运行时会创建 .xuanzhu\ 保存项目记忆。" -ForegroundColor DarkGray
Write-Host ''
