---
name: v2ray
description: 在本机已有 v2ray / xray / Clash / mihomo / sing-box 客户端时，发现本地 SOCKS/HTTP 入站端口，验证后只对当前命令临时使用代理，并把可用端点记入跨项目全局记忆。用于访问外网失败（DNS 解析失败、连接超时、GitHub/npm/pip 拉取失败）的场景。
metadata:
  displayName: 本地代理（v2ray / Clash）
  icon: network
  category: network
  version: 1.0.0
---

# 本地代理（v2ray / Clash / sing-box）

目标：**只在需要外网时临时使用本机已有的代理**，不修改系统代理、不写全局配置；
成功后把「本机哪个本地端口可用」记进全局记忆，下次优先复用。

> 这里找的是**本机客户端的入站端口**（SOCKS / HTTP），不是服务器节点、订阅地址或 UUID。
> 不要去读订阅文件，也不要把 UUID、密码、节点链接写进记忆或回复。

## 什么时候用

出现以下情况时，先按本指南探测本机代理，再重试原命令：

- `curl` / `git` / `npm` / `pip` / `go get` 报 `Could not resolve host`、
  `Connection timed out`、`Failed to connect`、`SSL connect error`；
- 访问 GitHub、npm registry、PyPI、Google 等外网服务失败；
- 用户明确说「走代理 / 用本机 v2ray / 开 clash」。

不要因为**本地**端点（`127.0.0.1`、局域网模型服务）失败就套代理。

## 第 1 步：先看全局记忆里有没有上次验证过的端点

系统提示词里的「全局记忆」可能已经有类似条目：

```markdown
## 网络代理
- 2026-10-31：本机 SOCKS5 127.0.0.1:1080 / HTTP 127.0.0.1:10809 可用；下次优先尝试。
```

有就先验证它（见第 3 步），通过就直接用，不要重新扫全部端口。

## 第 2 步：发现本机候选端口

先看环境变量：

```bash
env | grep -iE '^(http|https|all|no)_proxy=' || true
```

再看监听端口（不同系统选一条）：

```bash
# Linux
ss -lntp 2>/dev/null | grep -E ':(1080|10808|10809|7890|7891|2080|8889)\b' || true

# macOS
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E ':(1080|10808|10809|7890|7891|2080|8889)\b' || true

# Windows（在 bash 中通常也可用 netstat）
netstat -ano | grep -i listening | grep -E ':(1080|10808|10809|7890|7891|2080|8889)\b' || true
```

确认监听进程（能看到进程名更好）：

```bash
ps -ef | grep -Ei 'v2ray|xray|clash|mihomo|sing-box' | grep -v grep || true
```

常见客户端的典型本地端口（仅作线索，以实际监听为准）：

| 客户端 | 常见端口 |
| --- | --- |
| v2rayN | SOCKS 10808 / HTTP 10809 |
| v2rayA | 20170 / 20171 等，需看设置 |
| Clash / mihomo | mixed 7890（或 7891） |
| sing-box | 常见 2080，需看 inbound |
| v2ray-core 默认 | SOCKS 1080 |

如果用户配置过非默认端口，可以只看配置里的 **inbound**（不要打印全文）：

```bash
# v2ray / xray JSON：只取监听地址、端口、协议
for f in ~/.config/v2ray/config.json ~/.config/xray/config.json \
         /usr/local/etc/v2ray/config.json /etc/v2ray/config.json; do
  [ -f "$f" ] && jq -c '.inbounds[]? | {listen,port,protocol}' "$f" 2>/dev/null
done

# Clash / mihomo YAML：只取端口字段
for f in ~/.config/clash/config.yaml ~/.config/mihomo/config.yaml; do
  [ -f "$f" ] && grep -E '^(mixed-port|socks-port|port):' "$f"
done
```

**只读监听信息**。不要 `cat` 整个配置，不要读取 `clients`、`uuid`、`password`、
订阅 URL；这些内容既不需要，也不该进入上下文。

## 第 3 步：验证代理真的能出网

TCP 端口开着不代表代理可用。用短超时测试，避免卡住：

```bash
# SOCKS5（推荐 socks5h，让 DNS 也走代理；localhost 必须绕过）
NO_PROXY=127.0.0.1,localhost,::1 \
  curl --proxy socks5h://127.0.0.1:1080 \
       --connect-timeout 5 --max-time 12 -sS -o /dev/null \
       -w 'socks5 %{http_code}\n' https://github.com

# HTTP 代理
NO_PROXY=127.0.0.1,localhost,::1 \
  curl --proxy http://127.0.0.1:10809 \
       --connect-timeout 5 --max-time 12 -sS -o /dev/null \
       -w 'http %{http_code}\n' https://github.com
```

- 返回 `200` / `301` / `302` 都算连通；`000` 或非零退出表示不可用。
- 至少测两个目标（如 `https://github.com` 和 `https://www.google.com`），
  避免「目标站点本身挂了」被误判成代理可用。
- 不要用 `ping` 判断：很多代理只转发 TCP，ICMP 本来就不通。

## 第 4 步：只对当前命令临时使用

**不要** `export` 后一直留在会话里，也不要修改 `~/.gitconfig`、npm/pip 全局配置、
系统代理或 v2ray 客户端配置。每条需要外网的命令前面临时加环境变量，命令结束即还原：

```bash
env HTTP_PROXY=http://127.0.0.1:10809 \
    HTTPS_PROXY=http://127.0.0.1:10809 \
    ALL_PROXY=socks5h://127.0.0.1:1080 \
    NO_PROXY=127.0.0.1,localhost,::1 \
    <原命令>
```

按工具选择更精确的写法：

```bash
# curl：直接用代理
curl --proxy socks5h://127.0.0.1:1080 https://github.com

# git：只对这一次 clone/fetch 生效
git -c http.proxy=socks5h://127.0.0.1:1080 \
    -c https.proxy=socks5h://127.0.0.1:1080 clone <url>

# npm
npm --proxy http://127.0.0.1:10809 --https-proxy http://127.0.0.1:10809 install

# pip
pip install --proxy http://127.0.0.1:10809 <包名>
```

注意：

- 只有 SOCKS 端口时，优先看客户端是否也开了 HTTP / mixed 端口；没有就用
  `ALL_PROXY=socks5h://...`（curl/git 等支持），不要自己搭端口转发。
- `NO_PROXY` 必须包含 `127.0.0.1,localhost,::1`，否则本地模型端点、xzh 自己的
  本地服务也会被绕进代理。
- 代理使用完不需要「关闭」——环境变量只存在于这一条命令的进程里。

## 第 5 步：成功后写入全局记忆

验证成功后，把**本地端点**记到全局记忆（不是项目记忆），方便下次直接尝试：

```text
memory_write target=global
content:
## 网络代理
- 2026-10-31：本机 SOCKS5 127.0.0.1:1080 / HTTP 127.0.0.1:10809 可用（v2rayN）；
  优先尝试，失效再重新扫描。
```

只记录：日期、客户端类型（可选）、本地协议/地址/端口、是否可用。
不要记录：节点名、服务器地址、UUID、订阅 URL、密码、访问过的具体 URL。

如果全局记忆里已有 `## 网络代理` 小节，**优先用 `memory_compact target=global` 更新那一节**，
不要每次都追加一条带日期的流水；只保留最近一次验证结果即可。

## 找不到或全部失败时

1. 报告「未找到可用的本地代理」以及尝试过的端口；
2. 请用户先打开 v2rayN / Clash / v2rayA / sing-box 客户端，确认其「允许局域网连接」
   或系统代理已开启（但**不要**替用户启动 GUI / 修改客户端配置）；
3. 如果用户只有远程代理或多级代理，告诉用户当前只支持本机 SOCKS/HTTP 入站，
   不要猜测节点参数。

## 安全边界

- 默认只使用 `127.0.0.1` / `::1` 上的监听端口；局域网或远程代理必须由用户明确给出。
- 不读取、不输出、不记忆任何节点凭据；只处理本地端口。
- 不修改系统级代理与全局工具配置；每条命令临时生效。
- 不自动启动代理客户端；不自动重跑失败的命令（可能有副作用），由模型拿到代理后重试。
