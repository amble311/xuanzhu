import { spawnSync } from "child_process";
import { ansi } from "../utils/ansi";
import { gatewayStatus } from "../gateway/service";
import {
  fetchQrCode,
  fetchQrStatus,
  ILINK_BASE_URL,
} from "../gateway/weixin/client";
import {
  clearAccount,
  loadAccount,
  saveAccount,
} from "../gateway/weixin/paths";

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

/** 用系统 `qrencode` 画 ASCII 二维码；没装就只给链接并提示 */
function renderQr(content: string): void {
  const result = spawnSync(
    "qrencode",
    ["-t", "ANSIUTF8", "-m", "1", content],
    { encoding: "utf8" },
  );
  if (result.status === 0 && result.stdout?.trim()) {
    process.stdout.write(result.stdout);
    return;
  }
  line(
    `${ansi.yellow}  未安装 qrencode，无法在终端画二维码${ansi.reset}` +
      `${ansi.gray}（apt install qrencode / brew install qrencode）${ansi.reset}`,
  );
}

function describeStatus(): void {
  const account = loadAccount();
  const gateway = gatewayStatus();
  if (!account) {
    line(`${ansi.gray}微信：${ansi.reset}${ansi.yellow}未登录${ansi.reset}`);
    line(`${ansi.gray}  登录：xzh gateway weixin login${ansi.reset}`);
    return;
  }
  line(
    `${ansi.gray}微信：${ansi.reset}${ansi.green}已登录${ansi.reset}` +
      `${ansi.gray} account=${account.accountId}${ansi.reset}`,
  );
  if (account.userId) line(`${ansi.gray}  绑定用户 ${account.userId}${ansi.reset}`);
  line(`${ansi.gray}  API ${account.baseUrl}${ansi.reset}`);
  line(
    `${ansi.gray}  频道：${ansi.reset}` +
      (gateway.running
        ? `${ansi.green}随 gateway 运行中${ansi.reset}`
        : `${ansi.yellow}gateway 未运行（xzh gateway）${ansi.reset}`),
  );
}

export async function weixinCommand(args: string[]): Promise<void> {
  const action = (args[0] ?? "status").trim().toLowerCase();

  if (action === "logout") {
    clearAccount();
    line(`${ansi.green}✓ 已清除微信登录信息${ansi.reset}（gateway 重启后不再连接）`);
    return;
  }

  if (action !== "login") {
    describeStatus();
    return;
  }

  // ── 扫码登录 ────────────────────────────────────────────
  let qr: { qrcode: string; url: string };
  try {
    qr = await fetchQrCode();
  } catch (err) {
    line(
      `${ansi.red}✗ 获取二维码失败：${err instanceof Error ? err.message : String(err)}${ansi.reset}`,
    );
    return;
  }
  if (!qr.qrcode) {
    line(`${ansi.red}✗ 接口没有返回二维码${ansi.reset}`);
    return;
  }

  line("");
  line("请使用微信扫描以下二维码：");
  if (qr.url) line(`${ansi.gray}${qr.url}${ansi.reset}`);
  renderQr(qr.url || qr.qrcode);

  const deadline = Date.now() + 8 * 60_000;
  let baseUrl = ILINK_BASE_URL;
  let refreshes = 0;
  let lastStatus = "";

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    let status;
    try {
      status = await fetchQrStatus(qr.qrcode, baseUrl);
    } catch {
      // 轮询失败（网络抖动）继续等，不要因为一次超时就中断登录
      continue;
    }

    if (status.status !== lastStatus) {
      lastStatus = status.status;
      if (status.status === "scaned") {
        line(`\n${ansi.green}已扫码，请在微信里确认…${ansi.reset}`);
      }
      if (status.status === "scaned_but_redirect" && status.redirectHost) {
        baseUrl = `https://${status.redirectHost}`;
        line(`${ansi.gray}已切换到 ${baseUrl}${ansi.reset}`);
      }
    }

    if (status.status === "expired") {
      refreshes += 1;
      if (refreshes > 3) {
        line(`${ansi.red}✗ 二维码多次过期，请重新执行登录${ansi.reset}`);
        return;
      }
      line(`\n${ansi.yellow}二维码已过期，刷新中（${refreshes}/3）${ansi.reset}`);
      try {
        qr = await fetchQrCode();
        if (qr.url) line(`${ansi.gray}${qr.url}${ansi.reset}`);
        renderQr(qr.url || qr.qrcode);
      } catch {
        line(`${ansi.red}✗ 刷新二维码失败${ansi.reset}`);
        return;
      }
      continue;
    }

    if (status.status === "confirmed") {
      if (!status.accountId || !status.token) {
        line(`${ansi.red}✗ 已确认，但凭据不完整（缺少 account_id 或 token）${ansi.reset}`);
        return;
      }
      saveAccount({
        accountId: status.accountId,
        token: status.token,
        baseUrl: status.baseUrl || baseUrl,
        userId: status.userId,
        savedAt: new Date().toISOString(),
      });
      line(
        `\n${ansi.green}✓ 微信连接成功${ansi.reset}` +
          `${ansi.gray} account=${status.accountId}${ansi.reset}`,
      );
      line(
        `${ansi.gray}  重启 gateway 后生效：${ansi.reset}xzh gateway restart`,
      );
      return;
    }
  }
  line(`${ansi.red}✗ 登录超时（8 分钟），请重新执行${ansi.reset}`);
}
