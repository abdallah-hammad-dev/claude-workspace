/* Claude Bridge — VS Code–style live context for Claude Code inside Obsidian.
 *
 * - Tracks the last file view you worked in (ignores side panels such as Claudian).
 * - GET  /context  → short text block injected on every prompt by a UserPromptSubmit hook.
 * - POST /mcp      → minimal MCP (streamable HTTP, JSON responses) with tools to read the
 *                    active context and read/edit/screenshot the live Excalidraw canvas.
 * Listens on 127.0.0.1 only, requires a bearer token, rejects foreign Host headers.
 */
const { Plugin, PluginSettingTab, Setting, Notice, MarkdownView, TFile } = require("obsidian");
const http = require("http");
const crypto = require("crypto");

const DEFAULTS = { port: 27200, token: "" };
const SERVER_NAME = "obsidian-bridge";
const MAX_SELECTION = 6000;
const EXCALIDRAW_VIEW = "excalidraw";

module.exports = class ClaudeBridge extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    if (!this.settings.token) {
      this.settings.token = crypto.randomBytes(24).toString("hex");
      await this.saveData(this.settings);
    }
    this.lastLeaf = null;

    const track = (leaf) => { if (leaf && leaf.view && leaf.view.file) this.lastLeaf = leaf; };
    this.app.workspace.onLayoutReady(() => track(this.app.workspace.getMostRecentLeaf()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", track));

    this.startServer();
    this.addSettingTab(new BridgeSettings(this.app, this));
    this.addCommand({
      id: "install-claude-config",
      name: "Install Claude Code config in this vault (.mcp.json + hook)",
      callback: () => this.installConfig(),
    });
  }

  onunload() { if (this.server) this.server.close(); }

  // ───────────────────────── context ─────────────────────────

  currentLeaf() {
    const leaf = this.lastLeaf;
    if (leaf && leaf.view && leaf.view.file && leaf.view.containerEl.isConnected) return leaf;
    const f = this.app.workspace.getActiveFile();
    if (!f) return null;
    let found = null;
    this.app.workspace.iterateAllLeaves((l) => { if (!found && l.view && l.view.file === f) found = l; });
    return found;
  }

  openTabs() {
    const out = [];
    this.app.workspace.iterateRootLeaves((l) => {
      if (l.view && l.view.file) out.push({ path: l.view.file.path, view: l.view.getViewType() });
    });
    return out;
  }

  getContext() {
    const leaf = this.currentLeaf();
    const ctx = { activeFile: null, openTabs: this.openTabs() };
    if (!leaf) return ctx;
    const view = leaf.view;
    const type = view.getViewType();
    ctx.activeFile = { path: view.file.path, view: type };

    if (view instanceof MarkdownView && view.editor) {
      const ed = view.editor;
      ctx.mode = view.getMode ? view.getMode() : undefined; // "source" | "preview"
      const cur = ed.getCursor("head");
      ctx.cursor = { line: cur.line + 1, ch: cur.ch };
      const sel = ed.getSelection();
      if (sel) {
        const from = ed.getCursor("from"), to = ed.getCursor("to");
        ctx.selection = {
          fromLine: from.line + 1, toLine: to.line + 1,
          text: sel.length > MAX_SELECTION ? sel.slice(0, MAX_SELECTION) + "\n…[truncated]" : sel,
        };
      }
    } else if (type === EXCALIDRAW_VIEW) {
      try {
        const ea = this.ea(view);
        const els = ea.getViewElements().filter((e) => !e.isDeleted);
        const selected = ea.getViewSelectedElements().map((e) => e.id);
        ctx.excalidraw = { elementCount: els.length, selectedIds: selected };
        if (selected.length) ctx.excalidraw.selected = this.summarize(els).filter((e) => selected.includes(e.id));
      } catch (e) { ctx.excalidraw = { error: String(e.message || e) }; }
    } else {
      const sel = activeWindow.getSelection && activeWindow.getSelection().toString();
      if (sel && view.containerEl.contains(activeWindow.getSelection().anchorNode)) {
        ctx.selection = { text: sel.slice(0, MAX_SELECTION) };
      }
    }
    return ctx;
  }

  contextText() {
    const c = this.getContext();
    if (!c.activeFile) return "";
    const L = ["<obsidian_context>",
      `The user is currently looking at: ${c.activeFile.path} (view: ${c.activeFile.view}${c.mode ? ", mode: " + c.mode : ""}).`,
      `"This file", "this note", "this drawing", "here" refer to it.`];
    if (c.cursor) L.push(`Cursor at line ${c.cursor.line}.`);
    if (c.selection) {
      L.push(c.selection.fromLine
        ? `Selected text (lines ${c.selection.fromLine}-${c.selection.toLine}):`
        : "Selected text:");
      L.push(c.selection.text);
    }
    if (c.excalidraw) {
      if (c.excalidraw.error) L.push(`Excalidraw view (could not read: ${c.excalidraw.error}).`);
      else {
        L.push(`It is a live Excalidraw canvas with ${c.excalidraw.elementCount} elements` +
          (c.excalidraw.selectedIds.length ? `; selected: ${JSON.stringify(c.excalidraw.selected)}` : "") + ".");
        L.push(`To read or change it use the ${SERVER_NAME} MCP tools (excalidraw_get_scene, excalidraw_apply, excalidraw_screenshot). Do NOT edit the .excalidraw.md file directly while it is open.`);
      }
    }
    const others = c.openTabs.filter((t) => t.path !== c.activeFile.path).map((t) => t.path);
    if (others.length) L.push(`Other open tabs: ${[...new Set(others)].join(", ")}`);
    L.push("</obsidian_context>");
    return L.join("\n");
  }

  // ───────────────────────── excalidraw ─────────────────────────

  ea(view) {
    const base = window.ExcalidrawAutomate;
    if (!base) throw new Error("Excalidraw plugin not loaded");
    const ea = typeof base.getAPI === "function" ? base.getAPI(view) : base;
    ea.setView(view);
    return ea;
  }

  excalidrawLeaf(path) {
    const cur = this.currentLeaf();
    if (!path && cur && cur.view.getViewType() === EXCALIDRAW_VIEW) return cur;
    let found = null;
    this.app.workspace.iterateAllLeaves((l) => {
      if (!found && l.view && l.view.getViewType() === EXCALIDRAW_VIEW && l.view.file
        && (!path || l.view.file.path === path)) found = l;
    });
    if (!found) throw new Error(path
      ? `No open Excalidraw view for ${path}. Open it first (open_file).`
      : "No Excalidraw drawing is open.");
    return found;
  }

  summarize(els) {
    const r = (n) => Math.round(n);
    const textOf = new Map();
    for (const e of els) if (e.type === "text" && e.containerId) textOf.set(e.containerId, e.text);
    return els.filter((e) => !(e.type === "text" && e.containerId)).map((e) => {
      const o = { id: e.id, type: e.type, x: r(e.x), y: r(e.y), w: r(e.width), h: r(e.height) };
      const label = e.type === "text" ? e.text : textOf.get(e.id);
      if (label) o.text = label;
      if (e.strokeColor && e.strokeColor !== "#1e1e1e" && e.strokeColor !== "#000000") o.stroke = e.strokeColor;
      if (e.backgroundColor && e.backgroundColor !== "transparent") o.bg = e.backgroundColor;
      if (e.startBinding) o.from = e.startBinding.elementId;
      if (e.endBinding) o.to = e.endBinding.elementId;
      if (e.groupIds && e.groupIds.length) o.groups = e.groupIds;
      if (e.frameId) o.frame = e.frameId;
      if (e.link) o.link = e.link;
      return o;
    });
  }

  bindLabel(ea, containerId, text, fontSize) {
    const c = ea.getElement(containerId);
    if (fontSize) ea.style.fontSize = fontSize;
    const tid = ea.addText(c.x, c.y, text);
    const t = ea.getElement(tid);
    t.containerId = containerId;
    t.textAlign = "center";
    t.verticalAlign = "middle";
    if (c.type === "arrow" || c.type === "line") {
      const pts = c.points, mid = pts[Math.floor(pts.length / 2)] || [0, 0];
      t.x = c.x + mid[0] - t.width / 2; t.y = c.y + mid[1] - t.height / 2;
    } else {
      t.x = c.x + (c.width - t.width) / 2; t.y = c.y + (c.height - t.height) / 2;
    }
    c.boundElements = (c.boundElements || []).filter((b) => b.type !== "text").concat([{ type: "text", id: tid }]);
    return tid;
  }

  setText(ea, el, text) {
    const m = ea.measureText ? ea.measureText(text) : null;
    el.text = text; el.originalText = text; el.rawText = text;
    if (m) {
      const cx = el.x + el.width / 2, cy = el.y + el.height / 2;
      el.width = m.width; el.height = m.height;
      if (el.containerId) { el.x = cx - m.width / 2; el.y = cy - m.height / 2; }
    }
  }

  async excalidrawApply(path, ops) {
    if (!Array.isArray(ops) || !ops.length) throw new Error("ops must be a non-empty array");
    const view = this.excalidrawLeaf(path).view;
    const ea = this.ea(view);
    const viewEls = ea.getViewElements().filter((e) => !e.isDeleted);
    const byId = new Map(viewEls.map((e) => [e.id, e]));
    const refs = {};
    const resolve = (k) => refs[k] || k;

    // copy every existing element an op touches (plus its bound text) into the workbench
    const need = new Set();
    const want = (id) => {
      if (!byId.has(id)) return;
      need.add(id);
      for (const e of viewEls) if (e.containerId === id) need.add(e.id);
    };
    for (const op of ops) {
      if (op.op === "connect") { want(op.from); want(op.to); }
      if (op.op === "update") want(op.id);
    }
    if (need.size) ea.copyViewElementsToEAforEditing(viewEls.filter((e) => need.has(e.id)));

    const toDelete = new Set();
    const STYLE = ["strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity", "fontSize"];

    for (const op of ops) {
      ea.style.strokeColor = op.strokeColor || "#1e1e1e";
      ea.style.backgroundColor = op.backgroundColor || "transparent";
      ea.style.fillStyle = op.fillStyle || "solid";
      if (op.strokeWidth) ea.style.strokeWidth = op.strokeWidth;
      if (op.fontSize) ea.style.fontSize = op.fontSize;

      switch (op.op) {
        case "add_shape": {
          const { x = 0, y = 0, width = 160, height = 70 } = op;
          const shape = op.shape || "rectangle";
          if (shape === "rectangle") ea.style.roundness = op.rounded === false ? null : { type: 3 };
          const id = shape === "ellipse" ? ea.addEllipse(x, y, width, height)
            : shape === "diamond" ? ea.addDiamond(x, y, width, height)
            : ea.addRect(x, y, width, height);
          if (op.text) this.bindLabel(ea, id, op.text, op.fontSize);
          if (op.link) ea.getElement(id).link = op.link;
          if (op.ref) refs[op.ref] = id;
          break;
        }
        case "add_text": {
          const id = ea.addText(op.x || 0, op.y || 0, op.text || "");
          if (op.ref) refs[op.ref] = id;
          break;
        }
        case "connect": {
          const a = resolve(op.from), b = resolve(op.to);
          if (!ea.getElement(a) || !ea.getElement(b)) throw new Error(`connect: unknown element ${!ea.getElement(a) ? op.from : op.to}`);
          const id = ea.connectObjects(a, null, b, null, {
            endArrowHead: op.endArrowHead === undefined ? "arrow" : op.endArrowHead,
            startArrowHead: op.startArrowHead || null,
          });
          if (op.text) this.bindLabel(ea, id, op.text, op.fontSize);
          if (op.ref) refs[op.ref] = id;
          break;
        }
        case "update": {
          const el = ea.getElement(resolve(op.id));
          if (!el) throw new Error(`update: unknown element ${op.id}`);
          const p = op.props || {};
          for (const k of ["x", "y", "width", "height", "angle", "link", ...STYLE]) if (k in p) el[k] = p[k];
          if ("text" in p) {
            if (el.type === "text") this.setText(ea, el, p.text);
            else {
              const b = (el.boundElements || []).find((x) => x.type === "text");
              const t = b && ea.getElement(b.id);
              if (t) this.setText(ea, t, p.text); else this.bindLabel(ea, el.id, p.text, p.fontSize);
            }
          }
          if (("width" in p || "height" in p || "x" in p || "y" in p) && el.type !== "text") {
            const b = (el.boundElements || []).find((x) => x.type === "text");
            const t = b && ea.getElement(b.id);
            if (t) { t.x = el.x + (el.width - t.width) / 2; t.y = el.y + (el.height - t.height) / 2; }
          }
          break;
        }
        case "delete": {
          for (const id of op.ids || []) {
            toDelete.add(id);
            for (const e of viewEls) {
              if (e.containerId === id) toDelete.add(e.id);
              if (op.withArrows !== false && (e.startBinding?.elementId === id || e.endBinding?.elementId === id)) {
                toDelete.add(e.id);
                for (const t of viewEls) if (t.containerId === e.id) toDelete.add(t.id);
              }
            }
          }
          break;
        }
        default: throw new Error(`unknown op "${op.op}"`);
      }
    }

    if (Object.keys(ea.elementsDict || {}).length) await ea.addElementsToView(false, true, true);

    if (toDelete.size) {
      const api = ea.getExcalidrawAPI();
      api.updateScene({
        elements: api.getSceneElements().map((e) => toDelete.has(e.id)
          ? Object.assign({}, e, { isDeleted: true, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() })
          : e),
      });
    }
    return { ok: true, created: refs, deleted: [...toDelete] };
  }

  async excalidrawScreenshot(path, scale) {
    const view = this.excalidrawLeaf(path).view;
    const ea = this.ea(view);
    ea.copyViewElementsToEAforEditing(ea.getViewElements().filter((e) => !e.isDeleted));
    const blob = await ea.createPNG(undefined, scale || 1);
    return Buffer.from(await blob.arrayBuffer()).toString("base64");
  }

  // ───────────────────────── MCP ─────────────────────────

  tools() {
    const pathProp = { path: { type: "string", description: "Vault path of an open drawing. Omit to use the one the user is looking at." } };
    return [
      { name: "get_active_context", description: "What the user is looking at in Obsidian right now: active file, view type, cursor, selected text, selected Excalidraw elements, open tabs.", inputSchema: { type: "object", properties: {} } },
      { name: "open_file", description: "Open a vault file in Obsidian (new tab optional).", inputSchema: { type: "object", properties: { path: { type: "string" }, newTab: { type: "boolean" } }, required: ["path"] } },
      { name: "excalidraw_get_scene", description: "Read the LIVE Excalidraw canvas (including unsaved changes): every element with id, type, position, size, label text, colors and arrow bindings (from/to), plus the selection.", inputSchema: { type: "object", properties: { ...pathProp, selectedOnly: { type: "boolean" } } } },
      {
        name: "excalidraw_apply",
        description: "Edit the LIVE Excalidraw canvas. Ops run in order. Ops: " +
          "{op:'add_shape', shape:'rectangle'|'ellipse'|'diamond', x, y, width, height, text?, strokeColor?, backgroundColor?, fontSize?, link?, ref?} · " +
          "{op:'add_text', x, y, text, fontSize?, strokeColor?, ref?} · " +
          "{op:'connect', from, to, text?, endArrowHead?, startArrowHead?, ref?} (from/to = existing id or a ref from this call) · " +
          "{op:'update', id, props:{x,y,width,height,text,strokeColor,backgroundColor,fillStyle,strokeWidth,strokeStyle,opacity,fontSize,link}} · " +
          "{op:'delete', ids:[...], withArrows?:true}. Returns ref→id map. Call excalidraw_get_scene first to get ids and coordinates; take a screenshot after to check layout.",
        inputSchema: { type: "object", properties: { ...pathProp, ops: { type: "array", items: { type: "object" } } }, required: ["ops"] },
      },
      { name: "excalidraw_screenshot", description: "PNG render of the live Excalidraw canvas, to visually check your edits.", inputSchema: { type: "object", properties: { ...pathProp, scale: { type: "number" } } } },
    ];
  }

  async callTool(name, a) {
    a = a || {};
    const json = (v) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 1) }] });
    switch (name) {
      case "get_active_context": return json(this.getContext());
      case "open_file": {
        const f = this.app.vault.getAbstractFileByPath(a.path);
        if (!(f instanceof TFile)) throw new Error(`No file at ${a.path}`);
        const leaf = this.app.workspace.getLeaf(!!a.newTab);
        await leaf.openFile(f);
        this.lastLeaf = leaf;
        return json({ ok: true, view: leaf.view.getViewType() });
      }
      case "excalidraw_get_scene": {
        const leaf = this.excalidrawLeaf(a.path);
        const ea = this.ea(leaf.view);
        const els = ea.getViewElements().filter((e) => !e.isDeleted);
        const sel = ea.getViewSelectedElements().map((e) => e.id);
        let list = this.summarize(els);
        if (a.selectedOnly) list = list.filter((e) => sel.includes(e.id));
        return json({ path: leaf.view.file.path, selectedIds: sel, elements: list });
      }
      case "excalidraw_apply": return json(await this.excalidrawApply(a.path, a.ops));
      case "excalidraw_screenshot":
        return { content: [{ type: "image", mimeType: "image/png", data: await this.excalidrawScreenshot(a.path, a.scale) }] };
      default: throw new Error(`Unknown tool ${name}`);
    }
  }

  async handleRpc(msg) {
    const { id, method, params } = msg;
    if (id === undefined || id === null) return null; // notification
    const ok = (result) => ({ jsonrpc: "2.0", id, result });
    try {
      switch (method) {
        case "initialize":
          return ok({
            protocolVersion: (params && params.protocolVersion) || "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: this.manifest.version },
            instructions: "Live bridge to the user's Obsidian window. Use get_active_context to see what they are looking at; use excalidraw_* tools to read and edit open Excalidraw drawings instead of editing their files.",
          });
        case "ping": return ok({});
        case "tools/list": return ok({ tools: this.tools() });
        case "tools/call":
          try { return ok(await this.callTool(params.name, params.arguments)); }
          catch (e) { return ok({ isError: true, content: [{ type: "text", text: String(e.message || e) }] }); }
        default: return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
    } catch (e) {
      return { jsonrpc: "2.0", id, error: { code: -32603, message: String(e.message || e) } };
    }
  }

  // ───────────────────────── HTTP ─────────────────────────

  startServer() {
    const port = this.settings.port;
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    this.server = http.createServer((req, res) => {
      const send = (code, body, type = "application/json") => {
        res.writeHead(code, { "Content-Type": type });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      };
      if (!allowedHosts.has(req.headers.host) || req.headers.origin) return send(403, { error: "forbidden" });
      if (req.headers.authorization !== `Bearer ${this.settings.token}`) return send(401, { error: "unauthorized" });

      const url = req.url.split("?")[0];
      if (req.method === "GET" && url === "/context") return send(200, this.contextText(), "text/plain; charset=utf-8");
      if (url !== "/mcp") return send(404, { error: "not found" });
      if (req.method === "DELETE") return send(200, {});
      if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); return res.end(); }

      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 5e6) req.destroy(); });
      req.on("end", async () => {
        let msg;
        try { msg = JSON.parse(body); } catch { return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
        const batch = Array.isArray(msg);
        const out = (await Promise.all((batch ? msg : [msg]).map((m) => this.handleRpc(m)))).filter(Boolean);
        if (!out.length) { res.writeHead(202); return res.end(); }
        send(200, batch ? out : out[0]);
      });
    });
    this.server.on("error", (e) => new Notice(`Claude Bridge: cannot listen on port ${port} (${e.code}). Change it in settings.`));
    this.server.listen(port, "127.0.0.1");
  }

  // ───────────────────────── setup ─────────────────────────

  hookCommand() {
    return `curl -s -m 2 -H "Authorization: Bearer ${this.settings.token}" http://127.0.0.1:${this.settings.port}/context`;
  }

  mcpAddCommand() {
    return `claude mcp add --scope user --transport http ${SERVER_NAME} http://127.0.0.1:${this.settings.port}/mcp --header "Authorization: Bearer ${this.settings.token}"`;
  }

  async readJson(path) {
    const ad = this.app.vault.adapter;
    if (!(await ad.exists(path))) return {};
    try { return JSON.parse(await ad.read(path)); }
    catch { throw new Error(`${path} is not valid JSON — fix it first`); }
  }

  async installConfig() {
    try {
      const ad = this.app.vault.adapter;
      const mcp = await this.readJson(".mcp.json");
      mcp.mcpServers = mcp.mcpServers || {};
      mcp.mcpServers[SERVER_NAME] = {
        type: "http",
        url: `http://127.0.0.1:${this.settings.port}/mcp`,
        headers: { Authorization: `Bearer ${this.settings.token}` },
      };
      await ad.write(".mcp.json", JSON.stringify(mcp, null, 2) + "\n");

      if (!(await ad.exists(".claude"))) await ad.mkdir(".claude");
      const s = await this.readJson(".claude/settings.json");
      s.enabledMcpjsonServers = [...new Set([...(s.enabledMcpjsonServers || []), SERVER_NAME])];
      s.hooks = s.hooks || {};
      const groups = (s.hooks.UserPromptSubmit || []).map((g) => Object.assign({}, g, {
        hooks: (g.hooks || []).filter((h) => !(h.command || "").includes("/context")),
      })).filter((g) => g.hooks.length);
      groups.push({ hooks: [{ type: "command", command: this.hookCommand(), timeout: 5 }] });
      s.hooks.UserPromptSubmit = groups;
      await ad.write(".claude/settings.json", JSON.stringify(s, null, 2) + "\n");

      new Notice("Claude Bridge: wrote .mcp.json and .claude/settings.json. Start a new Claudian session.");
    } catch (e) {
      new Notice(`Claude Bridge: ${e.message}`);
    }
  }
};

class BridgeSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this; const p = this.plugin;
    containerEl.empty();
    new Setting(containerEl).setName("Port").setDesc("Restart Obsidian after changing, then re-run the install command.")
      .addText((t) => t.setValue(String(p.settings.port)).onChange(async (v) => {
        const n = parseInt(v, 10); if (n > 1024 && n < 65536) { p.settings.port = n; await p.saveData(p.settings); }
      }));
    new Setting(containerEl).setName("Install into this vault")
      .setDesc("Writes .mcp.json (MCP server) and .claude/settings.json (prompt hook). Merges with what is already there.")
      .addButton((b) => b.setButtonText("Install").setCta().onClick(() => p.installConfig()));
    new Setting(containerEl).setName("Or register for all projects")
      .setDesc("Copies a `claude mcp add` command (user scope) — use this if Claudian ignores the vault's .mcp.json.")
      .addButton((b) => b.setButtonText("Copy command").onClick(async () => {
        await navigator.clipboard.writeText(p.mcpAddCommand()); new Notice("Copied");
      }));
    new Setting(containerEl).setName("Regenerate token")
      .setDesc("Invalidates the old token. Re-run Install afterwards.")
      .addButton((b) => b.setButtonText("Regenerate").setWarning().onClick(async () => {
        p.settings.token = crypto.randomBytes(24).toString("hex"); await p.saveData(p.settings);
        new Notice("New token saved — run Install again.");
      }));
  }
}
