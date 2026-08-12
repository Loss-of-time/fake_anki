// 用 esbuild 把 TS 测试打包成 CJS，交给 node --test 运行（零新增依赖）
import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, ".tmp-tests", "consolidate.test.cjs");

await esbuild.build({
  entryPoints: [path.join(root, "tests", "consolidate.test.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile,
  alias: { obsidian: path.join(root, "tests", "mocks", "obsidian.ts") },
  logLevel: "warning",
});

const r = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
process.exit(r.status ?? 1);
