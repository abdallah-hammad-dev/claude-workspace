// Load main.js the way Obsidian mobile would: only `obsidian` (and CodeMirror) resolve,
// Node builtins don't exist. Fails if desktop-only code runs at load time.
//   npm run check:mobile
const vm = require("vm");
const fs = require("fs");
const code = fs.readFileSync(process.argv[2] ?? "main.js", "utf8");
const Dummy = class {};
const obsidian = new Proxy({}, { get: (_, k) => (k === "Platform" ? { isDesktopApp: false } : Dummy) });
const required = new Set();
const fakeRequire = (m) => {
  required.add(m);
  if (m === "obsidian") return obsidian;
  if (m.startsWith("@codemirror")) return new Proxy({}, { get: () => ({ of: () => ({}) }) });
  throw new Error(`Cannot find module ${m}`);
};
const mod = { exports: {} };
const ctx = vm.createContext({ setTimeout, clearTimeout, setInterval, clearInterval, console, window: {}, Symbol });
ctx.globalThis = ctx;
vm.runInContext(`(function(require, module, exports){${code}\n})`, ctx)(fakeRequire, mod, mod.exports);
if (typeof mod.exports.default !== "function") throw new Error("main.js has no default export");
console.log(`mobile load OK (required at load: ${[...required].join(", ")})`);
