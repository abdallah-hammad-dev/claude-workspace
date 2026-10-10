import esbuild from "esbuild";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
  banner: { js: "/* claude-workspace — bundled by esbuild. See the repo for sources. */" },
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Node builtins stay external: they are require()d lazily and only on desktop (see CLAUDE.md).
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins, ...builtins.map((m) => `node:${m}`)],
  format: "cjs",
  target: "es2022",
  platform: "browser",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  outfile: "main.js",
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
