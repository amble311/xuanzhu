// esbuild.js - 打包玄猪（xzh）终端 Agent 的 CLI 产物
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// 版本号从 package.json 注入，避免源码里再硬编码一份导致发版后 `xzh --version` 漂移
const pkg = require("./package.json");

// 第三方 SDK 保持 external，运行时从 node_modules 解析，避免把 SDK 打进来。
const external = [
  "openai",
  "@anthropic-ai/sdk",
  "@google/generative-ai",
  "readline/promises",
];

// 构建完成后把内置技能（skills/）复制到 dist/skills，供运行时发现
const copySkillsPlugin = {
  name: "copy-skills",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      const src = path.join(__dirname, "skills");
      const dest = path.join(__dirname, "dist", "skills");
      if (!fs.existsSync(src)) return;
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(src, dest, { recursive: true });
      console.log(`📚 已复制 ${fs.readdirSync(dest).length} 个技能到 dist/skills`);

      // 生产构建不产出 sourcemap，但上一次普通（开发）构建可能留下
      // dist/cli.js.map；package.json 的 files 含整个 dist/，不清掉就会被打进发布包。
      if (production) {
        const staleMap = path.join(__dirname, "dist", "cli.js.map");
        try {
          fs.rmSync(staleMap, { force: true });
        } catch {
          // 删除失败不影响构建结果
        }
      }
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/cli/index.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "dist/cli.js",
  minify: production,
  sourcemap: !production,
  logLevel: "info",
  external,
  define: {
    __XZH_VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
  plugins: [copySkillsPlugin],
};

function ensureBinShim() {
  // 保证 bin/xzh.js 存在且可执行
  const binPath = "bin/xzh.js";
  if (!fs.existsSync("bin")) {
    fs.mkdirSync("bin", { recursive: true });
  }
  const shim = `#!/usr/bin/env node
"use strict";
require("../dist/cli.js");
`;
  fs.writeFileSync(binPath, shim, { mode: 0o755 });
  fs.chmodSync(binPath, 0o755);
}

async function main() {
  if (!fs.existsSync("dist")) {
    fs.mkdirSync("dist", { recursive: true });
  }
  ensureBinShim();

  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("👀 玄猪：正在监听文件变化...");
    return;
  }

  const start = Date.now();
  await esbuild.build(options);
  console.log(`✨ 玄猪构建完成 (${Date.now() - start}ms)`);
}

main().catch((err) => {
  console.error("❌ 玄猪构建失败：", err);
  process.exit(1);
});
