import { build, context } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const isWatch = process.argv.includes("--watch");

const ctx = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  sourcemap: isWatch ? "inline" : false,
  outfile: "dist-obsidian/main.js",
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view", "@lezer/common"]
};

mkdirSync("dist-obsidian", { recursive: true });
copyFileSync("manifest.json", "dist-obsidian/manifest.json");

if (isWatch) {
  const buildContext = await context(ctx);
  await buildContext.watch();
  console.log("obsidian build watching");
} else {
  await build(ctx);
  console.log("obsidian build complete");
}
