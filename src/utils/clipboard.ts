import { spawn } from "child_process";

/**
 * 读取**系统剪贴板**里的图片 / 文本。
 *
 * 为什么不依赖终端粘贴：终端与程序之间只有字节流，粘贴只能传文本 ——
 * 剪贴板里只有图片时，绝大多数终端在粘贴时不发送任何内容，程序无从感知。
 * 因此改为由玄猪主动向操作系统索取。
 *
 * 各平台通路（按顺序尝试，第一个成功的即采用）：
 *   - Windows：内置 PowerShell（`System.Windows.Forms.Clipboard`），无需额外安装；
 *   - macOS：`pngpaste`（若安装）；否则退回内置 `osascript`；
 *   - Linux：Wayland 的 `wl-paste`（wl-clipboard 包）；X11 的 `xclip`。
 *
 * 之所以**按顺序试而不是先探测环境变量**：Wayland 会话里常常同时装着 xclip
 * （XWayland），X11 会话里也可能有 wl-paste，直接试更省事且不会误判。
 */

export interface ClipboardImage {
  /** 嗅探出的 MIME 类型（image/png、image/jpeg 等） */
  mimeType: string;
  /** base64 编码（不含 `data:` 前缀） */
  base64: string;
  /** 原始字节数（用于体积提示与上限判断） */
  bytes: number;
}

export type ClipboardImageResult =
  | { kind: "image"; image: ClipboardImage }
  | { kind: "empty" }
  /** 候选命令都不存在或全部失败 */
  | { kind: "unavailable"; detail: string };

/** 单张剪贴板图片的体积上限：超过则不接收，避免上下文与请求体被撑爆 */
export const MAX_CLIPBOARD_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * 单次读取的超时时间。
 *
 * 取得比较宽松是因为 **Windows PowerShell 冷启动就要几百毫秒到 1 秒**，
 * 超时太短会把「能用」误判成「不可用」。
 */
const CAPTURE_TIMEOUT_MS = 10_000;

/** stdout 的解码方式 */
type OutputMode =
  /** 原始二进制 */
  | "binary"
  /** base64 文本 */
  | "base64"
  /** macOS osascript 的 `«data PNGf<HEX>»` 形式 */
  | "applescript-hex";

interface Candidate {
  command: string;
  args: string[];
  output: OutputMode;
  /** 人类可读的来源说明，用于错误提示 */
  label: string;
}

/** PowerShell：把剪贴板图片以 PNG 存到内存流并输出 base64；无图片时以退出码 3 退出 */
const PS_IMAGE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$img=[System.Windows.Forms.Clipboard]::GetImage()",
  "if($null -eq $img){exit 3}",
  "$ms=New-Object System.IO.MemoryStream",
  "$img.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png)",
  "[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))",
].join("; ");

const PS_TEXT_SCRIPT = "[Console]::Out.Write((Get-Clipboard -Raw))";

/** 无图片时 PowerShell 使用的退出码（与 `exit 3` 对应） */
const PS_NO_IMAGE_EXIT = 3;

function imageCandidates(): Candidate[] {
  if (process.platform === "win32") {
    const psArgs = (
      exe: string,
    ): string[] => [
      "-NoProfile",
      "-NonInteractive",
      // `-STA` 只有 Windows PowerShell 需要（剪贴板访问要求单线程单元）；
      // pwsh 7 不支持该开关，因此单独处理。
      ...(exe === "powershell.exe" ? ["-STA"] : []),
      "-Command",
      PS_IMAGE_SCRIPT,
    ];
    return [
      {
        command: "powershell.exe",
        args: psArgs("powershell.exe"),
        output: "base64",
        label: "PowerShell",
      },
      {
        command: "pwsh",
        args: psArgs("pwsh"),
        output: "base64",
        label: "PowerShell 7",
      },
    ];
  }

  if (process.platform === "darwin") {
    return [
      {
        command: "pngpaste",
        args: ["-"],
        output: "binary",
        label: "pngpaste",
      },
      {
        // 无 pngpaste 时的内置退路：osascript 把剪贴板里的 PNG 输出成
        // `«data PNGf<十六进制>»`，解析十六进制即可拿到原始字节。
        command: "osascript",
        args: ["-e", "the clipboard as «class PNGf»"],
        output: "applescript-hex",
        label: "osascript",
      },
    ];
  }

  return [
    {
      command: "wl-paste",
      args: ["--no-newline", "--type", "image/png"],
      output: "binary",
      label: "wl-paste（wl-clipboard）",
    },
    {
      command: "xclip",
      args: ["-selection", "clipboard", "-t", "image/png", "-o"],
      output: "binary",
      label: "xclip",
    },
  ];
}

function textCandidates(): Candidate[] {
  if (process.platform === "win32") {
    return [
      {
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", PS_TEXT_SCRIPT],
        output: "binary",
        label: "PowerShell",
      },
      {
        command: "pwsh",
        args: ["-NoProfile", "-NonInteractive", "-Command", PS_TEXT_SCRIPT],
        output: "binary",
        label: "PowerShell 7",
      },
    ];
  }
  if (process.platform === "darwin") {
    return [
      { command: "pbpaste", args: [], output: "binary", label: "pbpaste" },
    ];
  }
  return [
    {
      command: "wl-paste",
      args: ["--no-newline"],
      output: "binary",
      label: "wl-paste（wl-clipboard）",
    },
    {
      command: "xclip",
      args: ["-selection", "clipboard", "-o"],
      output: "binary",
      label: "xclip",
    },
  ];
}

/**
 * 拼接 stdout 分片。
 *
 * 单独收口 `Buffer.concat` 的类型断言：较新的 `@types/node` 里 `Buffer[]` 与
 * `Buffer.concat` 的参数类型不再直接兼容（buffer 底层的 ArrayBufferLike / ArrayBuffer
 * 差异），而运行时行为没有任何问题。
 */
function concatBuffers(chunks: Buffer[]): Buffer {
  if (chunks.length === 0) return Buffer.alloc(0);
  return Buffer.concat(chunks as unknown as Uint8Array[]);
}

interface CaptureOutcome {
  /** 命令不存在（ENOENT）—— 换下一个候选 */
  missing: boolean;
  /** 退出码（命令不存在时为 null） */
  code: number | null;
  stdout: Buffer;
  /** 失败原因，用于最终提示 */
  error?: string;
}

/** 执行一个候选命令并收集 stdout（不经过 shell，参数不会被转义污染） */
function capture(candidate: Candidate): Promise<CaptureOutcome> {
  return new Promise<CaptureOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: CaptureOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    let child;
    try {
      child = spawn(candidate.command, candidate.args, {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch (err) {
      finish({
        missing: true,
        code: null,
        stdout: Buffer.alloc(0),
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 忽略
      }
      finish({
        missing: false,
        code: null,
        stdout: concatBuffers(chunks),
        error: `超时（${CAPTURE_TIMEOUT_MS} ms）`,
      });
    }, CAPTURE_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish({
        missing: err.code === "ENOENT",
        code: null,
        stdout: Buffer.alloc(0),
        error: err.message,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ missing: false, code, stdout: concatBuffers(chunks) });
    });
  });
}

/** 按魔数嗅探图片类型；非图片返回 null */
export function sniffImageMime(data: Buffer): string | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.length >= 6 && data.subarray(0, 4).toString("latin1") === "GIF8") {
    return "image/gif";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("latin1") === "RIFF" &&
    data.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** 解析 osascript 的 `«data PNGf<HEX>»` 输出 */
function decodeAppleScriptHex(text: string): Buffer | null {
  const match = /«data\s+\w{4}([0-9A-Fa-f]+)»/.exec(text);
  if (!match) return null;
  const hex = match[1];
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  return Buffer.from(hex, "hex");
}

/** 把候选命令的输出解码成图片；无法得到有效图片时返回 null */
function decodeImage(
  candidate: Candidate,
  outcome: CaptureOutcome,
): { image: ClipboardImage } | { empty: true } | { error: string } {
  if (outcome.code !== 0) {
    // PowerShell 用退出码 3 明确表示「剪贴板里没有图片」
    if (outcome.code === PS_NO_IMAGE_EXIT) return { empty: true };
    return {
      error: `${candidate.label} 退出码 ${outcome.code ?? "未知"}${
        outcome.error ? `（${outcome.error}）` : ""
      }`,
    };
  }

  let data: Buffer | null = null;
  if (candidate.output === "binary") {
    data = outcome.stdout;
  } else if (candidate.output === "base64") {
    const text = outcome.stdout.toString("utf8").replace(/\s+/g, "");
    data = text.length > 0 ? Buffer.from(text, "base64") : null;
  } else {
    data = decodeAppleScriptHex(outcome.stdout.toString("utf8"));
  }

  if (!data || data.length === 0) return { empty: true };

  const mimeType = sniffImageMime(data);
  if (!mimeType) {
    // 剪贴板里是文本/其它格式，而不是图片
    return { empty: true };
  }
  return {
    image: { mimeType, base64: data.toString("base64"), bytes: data.length },
  };
}

/**
 * 读取剪贴板图片。
 *
 * 依次尝试各平台的候选命令，返回第一个成功解出图片的结果；
 * 全部命令都不存在时返回 `unavailable`（附带可执行的安装提示由调用方组织）。
 */
export async function readClipboardImage(): Promise<ClipboardImageResult> {
  const tried: string[] = [];
  let lastError = "";

  for (const candidate of imageCandidates()) {
    tried.push(candidate.label);
    const outcome = await capture(candidate);

    if (outcome.missing) continue;

    const decoded = decodeImage(candidate, outcome);
    if ("image" in decoded) return { kind: "image", image: decoded.image };
    if ("empty" in decoded) return { kind: "empty" };
    lastError = decoded.error;
  }

  return {
    kind: "unavailable",
    detail:
      lastError ||
      `未找到可用的剪贴板工具（已尝试：${tried.join("、")}）。` +
        (process.platform === "linux"
          ? " 请安装 wl-clipboard（Wayland）或 xclip（X11）。"
          : ""),
  };
}

/**
 * 读取剪贴板**文本**。
 *
 * 作为 Ctrl+V 的退路：某些终端会把 Ctrl+V 上送成 `\x16` 而不自己处理粘贴，
 * 此时读取剪贴板文本可以还原出常规的「粘贴」行为。
 */
export async function readClipboardText(): Promise<string | null> {
  for (const candidate of textCandidates()) {
    const outcome = await capture(candidate);
    if (outcome.missing || outcome.code !== 0) continue;
    const text = outcome.stdout.toString("utf8");
    if (text.length > 0) return text;
  }
  return null;
}
