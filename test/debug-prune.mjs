import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { snapshotForUndo, undoLastChange } from "../src/utils/backups.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-debug-"));
process.env.XZH_HOME = home;
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
const target = path.join(cwd, "sample.txt");
fs.writeFileSync(target, "v0");

for (let i = 0; i < 60; i++) {
  fs.writeFileSync(target, `内容 v${i}`);
  snapshotForUndo(target, cwd);
}

const manifestDir = fs
  .readdirSync(path.join(home, "backups"))
  .map((d) => path.join(home, "backups", d))[0];
const manifest = fs.readFileSync(path.join(manifestDir, "manifest.jsonl"), "utf8");
const lines = manifest.split("\n").filter((l) => l.trim());
console.log("快照后清单行数 =", lines.length);

let undone = 0;
while (true) {
  const message = undoLastChange(cwd);
  if (message.includes("没有可撤销的修改")) break;
  undone++;
  if (undone > 200) break;
}
console.log("成功撤销 =", undone);
const after = fs.readFileSync(path.join(manifestDir, "manifest.jsonl"), "utf8");
console.log("撤销后清单行数 =", after.split("\n").filter((l) => l.trim()).length);
console.log("撤销后备份文件数 =", fs.readdirSync(manifestDir).filter((f) => f.endsWith(".bak")).length);
