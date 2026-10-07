/**
 * 当前版本号。
 *
 * 由 esbuild 在构建时从 `package.json` 注入（见 `esbuild.js` 的 `define`）。
 * 存在的意义是**只保留一处来源** —— 早先 `cli/index.ts` 与 `tui/app.ts`
 * 各硬编码了一份，发版时改了 `package.json` 却漏改其中之一，
 * 就会出现 `xzh --version` 与界面标题显示不同版本的情况。
 */
declare const __XZH_VERSION__: string | undefined;

export const VERSION =
  typeof __XZH_VERSION__ === "string" ? __XZH_VERSION__ : "0.0.0-dev";
