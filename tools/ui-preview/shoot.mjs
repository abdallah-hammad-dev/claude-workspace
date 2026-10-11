// Screenshot the chat view and settings with Obsidian's real stylesheet.
//
//   npm run ui:preview                       # all scenarios, light + dark
//   npm run ui:preview -- chat-plan settings # only these
//
// Needs Obsidian installed (its stylesheet is read from obsidian.asar) and a Chromium:
//   OBSIDIAN_ASAR=/path/to/obsidian.asar   (auto-detected on Windows/WSL, macOS, Linux)
//   CHROMIUM_PATH=/path/to/chrome          (default: Playwright's cache)
// Output: tools/ui-preview/out/<scenario>-<theme>.png
import { extractFile } from "@electron/asar";
import esbuild from "esbuild";
import { existsSync, globSync, mkdirSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const here = import.meta.dirname;
const repo = resolve(here, "../..");
const cache = join(here, ".cache");
const out = join(here, "out");
mkdirSync(cache, { recursive: true });
mkdirSync(out, { recursive: true });

const SCENARIOS = [
  ["chat-empty", 420, 860],
  ["chat-banner", 420, 860],
  ["chat-conversation", 420, 1100],
  ["chat-permission-edit", 420, 860],
  ["chat-permission-bash", 420, 860],
  ["chat-permission-mcp", 420, 860],
  ["chat-plan", 420, 860],
  ["chat-question", 420, 960],
  ["chat-slash", 420, 860],
  ["chat-mention", 420, 860],
  ["chat-mode-menu", 420, 860],
  ["chat-context-preview", 420, 860],
  ["settings", 760, 1900],
];
const wanted = process.argv.slice(2);
const run = SCENARIOS.filter(([name]) => !wanted.length || wanted.includes(name));

function findAsar() {
  if (process.env.OBSIDIAN_ASAR) return process.env.OBSIDIAN_ASAR;
  const candidates = [
    ...globSync("/mnt/c/Users/*/AppData/Local/Programs/Obsidian/resources/obsidian.asar"),
    join(homedir(), "AppData/Local/Programs/Obsidian/resources/obsidian.asar"),
    "/Applications/Obsidian.app/Contents/Resources/obsidian.asar",
    "/opt/Obsidian/resources/obsidian.asar",
  ];
  return candidates.find((p) => existsSync(p));
}

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = join(homedir(), ".cache/ms-playwright");
  for (const dir of existsSync(base) ? readdirSync(base).filter((d) => d.startsWith("chromium-")).sort().reverse() : []) {
    for (const rel of ["chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-win/chrome.exe"]) {
      if (existsSync(join(base, dir, rel))) return join(base, dir, rel);
    }
  }
  throw new Error("No Chromium found. Set CHROMIUM_PATH or run `npx playwright install chromium`.");
}

const asar = findAsar();
if (!asar) throw new Error("Obsidian's obsidian.asar not found. Set OBSIDIAN_ASAR.");
writeFileSync(join(cache, "app.css"), extractFile(asar, "app.css"));
copyFileSync(join(repo, "styles.css"), join(cache, "styles.css"));

const stub = (name) => join(here, name);
await esbuild.build({
  entryPoints: [join(here, "harness.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: join(cache, "harness.js"),
  logLevel: "warning",
  alias: {
    obsidian: stub("obsidian-browser.ts"),
    "@anthropic-ai/claude-agent-sdk": stub("sdk-stub.ts"),
  },
  plugins: [
    {
      name: "node-builtins",
      setup(b) {
        b.onResolve({ filter: /^node:/ }, () => ({ path: "node-stub", namespace: "stub" }));
        b.onResolve({ filter: /^@codemirror\// }, () => ({ path: "cm-stub", namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const spawn = () => { throw new Error('no processes in preview'); }; export const EditorView = { updateListener: { of: () => ({}) } }; export default {};" }));
      },
    },
  ],
});

writeFileSync(
  join(cache, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="app.css"><link rel="stylesheet" href="styles.css">
<style>
  html, body { height: 100%; margin: 0; }
  .workspace { height: 100vh; }
  .workspace-split.mod-right-split { width: 100%; height: 100%; }
  .workspace-tabs, .workspace-tab-container, .workspace-leaf { height: 100%; }
  .cw-preview-settings { position: static; width: 100%; max-width: none; height: auto; max-height: none; border-radius: 0; overflow: visible; }
  .cw-preview-settings .vertical-tab-content-container, .cw-preview-settings .vertical-tab-content { height: auto; max-height: none; overflow: visible; padding: 24px 32px; }
</style></head><body><script src="harness.js"></script></body></html>`,
);

const browser = await chromium.launch({ executablePath: findChromium() });
for (const [name, width, height] of run) {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // Obsidian's bundled fonts aren't extracted; ignore those 404s.
    page.on("console", (m) => m.type() === "error" && !m.text().includes("ERR_FILE_NOT_FOUND") && errors.push(m.text()));
    await page.goto(`file://${join(cache, "index.html")}?scenario=${name}&theme=${theme}`);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 10000 }).catch(() => errors.push("timed out"));
    await page.waitForTimeout(150);
    const file = join(out, `${name}-${theme}.png`);
    if (name === "settings") await page.locator(".cw-preview-settings").screenshot({ path: file });
    else await page.screenshot({ path: file });
    console.log(`${errors.length ? "✗" : "✓"} ${name}-${theme}${errors.length ? `  ${errors.join(" | ")}` : ""}`);
    await page.close();
  }
}
await browser.close();
console.log(`Screenshots in ${out}`);
