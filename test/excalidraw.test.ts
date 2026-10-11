import { describe, expect, it } from "vitest";
import { ToolError } from "../src/core/module-api";
import { applyOps, type EA } from "../src/modules/excalidraw/canvas";
import { expandDelete, normalizeSelection, summarize, type ExElement } from "../src/modules/excalidraw/scene";

/** Fake ExcalidrawAutomate: a workbench dict + a scene, merged by id like the real addElementsToView. */
class FakeEA implements EA {
  style: Record<string, unknown> = { fontSize: 20 };
  elementsDict: Record<string, ExElement> = {};
  scene: ExElement[];
  selected: string[] = [];
  addCalls = 0;
  zoomed: string[] = [];
  private n = 0;

  constructor(scene: ExElement[]) {
    this.scene = scene.map((e) => ({ version: 1, ...e }));
  }

  private make(type: string, x: number, y: number, w: number, h: number, extra: Partial<ExElement> = {}): string {
    const id = `new${++this.n}`;
    this.elementsDict[id] = {
      id, type, x, y, width: w, height: h, version: 1,
      strokeColor: this.style.strokeColor as string,
      backgroundColor: this.style.backgroundColor as string,
      fontSize: this.style.fontSize as number,
      ...extra,
    };
    return id;
  }
  getViewElements() { return this.scene; }
  getViewSelectedElements() { return this.scene.filter((e) => this.selected.includes(e.id)); }
  copyViewElementsToEAforEditing(els: ExElement[]) { for (const e of els) this.elementsDict[e.id] = structuredClone(e); }
  getElement(id: string) { return this.elementsDict[id]; }
  addRect(x: number, y: number, w: number, h: number) { return this.make("rectangle", x, y, w, h); }
  addEllipse(x: number, y: number, w: number, h: number) { return this.make("ellipse", x, y, w, h); }
  addDiamond(x: number, y: number, w: number, h: number) { return this.make("diamond", x, y, w, h); }
  measureText(text: string) { return { width: text.length * 10, height: 25 }; }
  addText(x: number, y: number, text: string, f?: { box?: boolean | string }) {
    const m = this.measureText(text);
    const tid = this.make("text", x, y, m.width, m.height, { text });
    if (!f?.box) return tid;
    const type = f.box === "ellipse" ? "ellipse" : f.box === "diamond" ? "diamond" : "rectangle";
    const bid = this.make(type, x - 10, y - 10, m.width + 20, m.height + 20, { boundElements: [{ id: tid, type: "text" }] });
    this.elementsDict[tid]!.containerId = bid;
    return bid; // the real EA returns the box id when boxed
  }
  connectObjects(a: string, _ca: null, b: string, _cb: null, f?: { endArrowHead?: string | null }) {
    if (!this.elementsDict[a] || !this.elementsDict[b]) throw new Error("connectObjects: element not in elementsDict");
    return this.make("arrow", 0, 0, 10, 10, { startBinding: { elementId: a }, endBinding: { elementId: b }, endArrowhead: f?.endArrowHead });
  }
  addLabelToLine(lineId: string, label: string) {
    const id = this.make("text", 0, 0, label.length * 10, 25, { text: label, containerId: lineId });
    return id;
  }
  async addElementsToView() {
    this.addCalls++;
    const incoming = Object.values(this.elementsDict);
    const ids = new Set(incoming.map((e) => e.id));
    this.scene = [...this.scene.filter((e) => !ids.has(e.id)), ...incoming];
    this.elementsDict = {};
    return true;
  }
  getExcalidrawAPI() {
    return { getSceneElements: () => this.scene, updateScene: (s: { elements: ExElement[] }) => void (this.scene = s.elements) };
  }
  selectElementsInView(ids: string[]) { this.selected = ids; }
  viewZoomToElements(_s: boolean, els: ExElement[]) { this.zoomed = els.map((e) => e.id); }
  async createPNG() { return new Blob([new Uint8Array([137, 80, 78, 71])]); }

  live(id: string) { return this.scene.find((e) => e.id === id && !e.isDeleted); }
}

const box = (id: string, x: number, label?: string): ExElement[] => {
  const els: ExElement[] = [{ id, type: "rectangle", x, y: 0, width: 160, height: 70, strokeColor: "#1e1e1e", backgroundColor: "transparent" }];
  if (label) {
    els[0]!.boundElements = [{ id: `${id}-t`, type: "text" }];
    els.push({ id: `${id}-t`, type: "text", x: x + 50, y: 20, width: 60, height: 25, text: label, containerId: id, fontSize: 20 });
  }
  return els;
};
const arrow = (id: string, from: string, to: string): ExElement => ({
  id, type: "arrow", x: 0, y: 0, width: 50, height: 0, startBinding: { elementId: from }, endBinding: { elementId: to },
});

describe("scene summaries", () => {
  const scene = [...box("a", 0, "API"), ...box("b", 220, "DB"), arrow("ab", "a", "b"), { ...box("gone", 0)[0]!, isDeleted: true }];

  it("merges bound text into containers and reports bindings", () => {
    expect(summarize(scene)).toEqual([
      { id: "a", type: "rectangle", x: 0, y: 0, w: 160, h: 70, text: "API" },
      { id: "b", type: "rectangle", x: 220, y: 0, w: 160, h: 70, text: "DB" },
      { id: "ab", type: "arrow", x: 0, y: 0, w: 50, h: 0, from: "a", to: "b" },
    ]);
  });

  it("maps a selected label to its container", () => {
    expect(normalizeSelection(["a-t", "ab"], scene)).toEqual(["a", "ab"]);
  });

  it("expands deletes to labels and attached arrows", () => {
    expect([...expandDelete(["a"], scene, true)].sort()).toEqual(["a", "a-t", "ab"]);
    expect([...expandDelete(["a"], scene, false)].sort()).toEqual(["a", "a-t"]);
  });
});

describe("excalidraw_apply ops", () => {
  it("adds labelled shapes and connects them by ref in one batch", async () => {
    const ea = new FakeEA([]);
    const r = await applyOps(ea, [
      { op: "add_shape", ref: "api", x: 0, y: 0, text: "API" },
      { op: "add_shape", ref: "db", x: 220, y: 0, text: "Database", shape: "ellipse", backgroundColor: "#a5d8ff" },
      { op: "connect", from: "api", to: "db", text: "SQL" },
    ]);
    expect(ea.addCalls).toBe(1);
    const api = ea.live(r.created.api!)!;
    const db = ea.live(r.created.db!)!;
    expect(api).toMatchObject({ type: "rectangle", x: 0, y: 0, width: 160, height: 70 });
    expect(db).toMatchObject({ type: "ellipse", x: 220, backgroundColor: "#a5d8ff" });
    // label centered in its container
    const label = ea.scene.find((e) => e.containerId === api.id)!;
    expect(label.x).toBe(api.x + (api.width - label.width) / 2);
    const summary = summarize(ea.scene);
    expect(summary.find((s) => s.type === "arrow")).toMatchObject({ from: api.id, to: db.id, text: "SQL" });
  });

  it("connects existing elements (copied into the workbench)", async () => {
    const ea = new FakeEA([...box("a", 0), ...box("b", 220)]);
    const r = await applyOps(ea, [{ op: "connect", from: "a", to: "b", endArrowHead: null }]);
    expect(r.added).toHaveLength(1);
    expect(ea.scene.find((e) => e.type === "arrow")).toMatchObject({ endArrowhead: null });
  });

  it("updates geometry and moves the label with its shape", async () => {
    const ea = new FakeEA(box("a", 0, "API"));
    await applyOps(ea, [{ op: "update", id: "a", x: 100, y: 50, backgroundColor: "#ffc9c9" }]);
    const a = ea.live("a")!;
    expect(a).toMatchObject({ x: 100, y: 50, backgroundColor: "#ffc9c9", version: 2 });
    expect(ea.live("a-t")).toMatchObject({ x: 150, y: 70 });
  });

  it("changes a label and re-centers it", async () => {
    const ea = new FakeEA(box("a", 0, "API"));
    await applyOps(ea, [{ op: "update", id: "a", text: "Gateway" }]);
    const t = ea.live("a-t")!;
    expect(t.text).toBe("Gateway");
    expect(t.width).toBe(70);
    expect(t.x).toBe((160 - 70) / 2);
  });

  it("adds a label to a shape that had none", async () => {
    const ea = new FakeEA(box("a", 0));
    await applyOps(ea, [{ op: "update", id: "a", text: "New" }]);
    expect(summarize(ea.scene)).toEqual([expect.objectContaining({ id: "a", text: "New" })]);
  });

  it("deletes with labels and attached arrows", async () => {
    const ea = new FakeEA([...box("a", 0, "API"), ...box("b", 220), arrow("ab", "a", "b")]);
    const r = await applyOps(ea, [{ op: "delete", ids: ["a"] }]);
    expect(r.deleted.sort()).toEqual(["a", "a-t", "ab"]);
    expect(summarize(ea.scene).map((e) => e.id)).toEqual(["b"]);
    expect(ea.addCalls).toBe(1); // one batch → one undo step
  });

  it("validates everything before writing anything", async () => {
    const ea = new FakeEA(box("a", 0));
    const before = structuredClone(ea.scene);
    const err = await applyOps(ea, [
      { op: "add_shape", ref: "x", x: 0, y: 0 },
      { op: "connect", from: "x", to: "nope" },
      { op: "update", id: "ghost", x: 1 },
      { op: "delete", ids: ["a"] },
      { op: "update", id: "a", x: 5 },
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    const msg = (err as Error).message;
    expect(msg).toContain('op #2 (connect.to): unknown element "nope"');
    expect(msg).toContain('op #3 (update.id): unknown element "ghost"');
    expect(msg).toContain('op #5 (update.id): "a" is deleted earlier in this call');
    expect(ea.scene).toEqual(before);
    expect(ea.addCalls).toBe(0);
  });

  it("rejects malformed ops and duplicate refs", async () => {
    const ea = new FakeEA([]);
    await expect(applyOps(ea, [{ op: "explode" }])).rejects.toThrow(/op #1 is invalid/);
    await expect(applyOps(ea, [{ op: "add_text", x: 0, y: 0, text: "a", ref: "r" }, { op: "add_text", x: 0, y: 0, text: "b", ref: "r" }])).rejects.toThrow(/used twice/);
  });
});

describe("excalidraw tool schemas over MCP", () => {
  it("exposes the ops union as a usable JSON schema", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { z } = await import("zod");
    const { opSchema } = await import("../src/modules/excalidraw/ops");
    const server = new McpServer({ name: "t", version: "1" });
    server.registerTool("excalidraw_apply", { inputSchema: { path: z.string().optional(), ops: z.array(opSchema).min(1) } }, async () => ({ content: [] }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "c", version: "1" });
    await client.connect(b);
    const { tools } = await client.listTools();
    const ops = (tools[0]!.inputSchema.properties as Record<string, { items?: Record<string, unknown> }>).ops!;
    const variants = (ops.items!.oneOf ?? ops.items!.anyOf) as { properties: { op: { const?: string } } }[];
    expect(variants.map((v) => v.properties.op.const)).toEqual(["add_shape", "add_text", "connect", "update", "delete"]);
  });
});
