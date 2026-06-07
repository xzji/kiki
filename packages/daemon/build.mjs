import { build } from "esbuild";
import { fileURLToPath } from "url";
import path from "path";

const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pkgDir, "..", "..");

await build({
  entryPoints: [path.join(pkgDir, "src", "cli.ts")],
  outfile: path.join(pkgDir, "dist", "cli.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  // better-sqlite3 是原生模块，保持外置由 npm 安装预编译二进制
  external: ["better-sqlite3"],
  // 用仓库根 tsconfig 解析 `@/*` 路径别名
  tsconfig: path.join(repoRoot, "tsconfig.json"),
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});

console.log("✅ 已构建 packages/daemon/dist/cli.cjs");
