import { build } from "esbuild";
import { pathToFileURL } from "node:url";

const outfile = "/tmp/xzh-bench-run.cjs";
await build({
  entryPoints: ["bench/run.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile,
  logLevel: "error",
});

await import(pathToFileURL(outfile).href);
