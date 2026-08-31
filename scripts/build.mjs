// Build script: lint + typecheck (skipped in --watch), bundle src/main.ts to
// build/main.js, then copy the static plugin assets next to it so the whole
// build/ folder can be dropped straight into <vault>/.obsidian/plugins/.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "build");
const watch = process.argv.includes("--watch");

mkdirSync(outDir, { recursive: true });

if (!watch) {
  const eslint = join(root, "node_modules", "eslint", "bin", "eslint.js");
  console.log("[build] linting…");
  const lint = spawnSync(process.execPath, [eslint, "src", "tests"], {
    cwd: root,
    stdio: "inherit",
  });
  if (lint.status !== 0) process.exit(lint.status ?? 1);
  console.log("[build] lint ok");

  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  console.log("[build] typechecking…");
  const check = spawnSync(process.execPath, [tsc, "-noEmit", "-skipLibCheck"], {
    cwd: root,
    stdio: "inherit",
  });
  if (check.status !== 0) process.exit(check.status ?? 1);
  console.log("[build] typecheck ok");
}

const bundleOptions = {
  entryPoints: [join(root, "src", "main.ts")],
  bundle: true,
  external: ["obsidian", "electron"],
  format: "cjs",
  target: "es2020",
  platform: "node",
  outfile: join(outDir, "main.js"),
  logLevel: "info",
  // dsh-profile assets are imported as raw text (src uses `?raw` suffixes)
  // so the plugin can provision the bridge profile at runtime; never bundle
  // the bridge as runnable code.
  loader: { ".mjs": "text", ".yml": "text", ".json": "text" },
};

if (watch) {
  const ctx = await esbuild.context(bundleOptions);
  await ctx.watch();
  console.log("[build] watching for changes…");
} else {
  await esbuild.build(bundleOptions);
  copyFileSync(join(root, "manifest.json"), join(outDir, "manifest.json"));
  copyFileSync(join(root, "styles.css"), join(outDir, "styles.css"));
  console.log("[build] done -> build/");
}
