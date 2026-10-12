import esbuild from "esbuild";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

// Runs before the bundle, inside Obsidian's plugin wrapper (module scope).
// 1. Electron renderer timers return numbers; Node libs (Agent SDK) call .unref() on them.
//    Shadow the timer globals in our module scope with Node-like handles.
// 2. The SDK is ESM and uses import.meta.url; in a CJS bundle we point it at Obsidian's page.
//    Both are guarded so the bundle still loads on mobile (no require/__filename there).
const banner = `/* claude-workspace — bundled by esbuild. Sources: https://github.com/abdallah-hammad-dev/claude-workspace */
var __cwImportMetaUrl = (() => { try { return require("url").pathToFileURL(__filename).href; } catch { return "file:///"; } })();
var { setTimeout, clearTimeout, setInterval, clearInterval } = (() => {
  const g = globalThis;
  const wrap = (fn) => (...args) => {
    const id = fn.apply(g, args);
    if (typeof id !== "number") return id;
    return { __cwId: id, unref() { return this; }, ref() { return this; }, hasRef() { return true; }, refresh() { return this; }, [Symbol.toPrimitive]() { return id; } };
  };
  const unwrap = (fn) => (h) => fn.call(g, h && typeof h === "object" && "__cwId" in h ? h.__cwId : h);
  return { setTimeout: wrap(g.setTimeout), setInterval: wrap(g.setInterval), clearTimeout: unwrap(g.clearTimeout), clearInterval: unwrap(g.clearInterval) };
})();`;

const ctx = await esbuild.context({
  banner: { js: banner },
  define: { "import.meta.url": "__cwImportMetaUrl" },
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
