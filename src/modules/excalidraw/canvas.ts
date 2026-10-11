import { ToolError } from "../../core/module-api";
import { opSchema, validateOps, type Op } from "./ops";
import { expandDelete, type ExElement } from "./scene";

/**
 * The subset of ExcalidrawAutomate (Excalidraw plugin's public scripting API) we use.
 * Everything Excalidraw-specific goes through this interface so it can be faked in tests.
 * Docs: https://excalidraw-obsidian.online/WIKI/7.+Developer+Docs/Excalidraw+Automate
 */
export interface EA {
  style: Record<string, unknown>;
  elementsDict: Record<string, ExElement>;
  getViewElements(): ExElement[];
  getViewSelectedElements(): ExElement[];
  copyViewElementsToEAforEditing(elements: ExElement[]): void;
  getElement(id: string): ExElement | undefined;
  addRect(x: number, y: number, w: number, h: number): string;
  addEllipse(x: number, y: number, w: number, h: number): string;
  addDiamond(x: number, y: number, w: number, h: number): string;
  addText(
    x: number,
    y: number,
    text: string,
    formatting?: { box?: boolean | "box" | "ellipse" | "diamond"; textAlign?: string; textVerticalAlign?: string; boxPadding?: number },
  ): string;
  connectObjects(
    a: string,
    ca: null,
    b: string,
    cb: null,
    formatting?: { startArrowHead?: string | null; endArrowHead?: string | null },
  ): string;
  addLabelToLine(lineId: string, label: string): string;
  measureText(text: string): { width: number; height: number };
  addElementsToView(repositionToCursor?: boolean, save?: boolean, newElementsOnTop?: boolean): Promise<boolean>;
  getExcalidrawAPI(): { getSceneElements(): ExElement[]; updateScene(scene: { elements: ExElement[] }): void };
  selectElementsInView(ids: string[]): void;
  viewZoomToElements(select: boolean, elements: ExElement[]): void;
  createPNG(templatePath?: string, scale?: number): Promise<Blob>;
}

export interface ApplyResult {
  /** ref → new element id */
  created: Record<string, string>;
  /** ids of every element added (including unnamed ones) */
  added: string[];
  updated: string[];
  deleted: string[];
}

const DEFAULT_W = 160;
const DEFAULT_H = 70;
const BOX: Record<string, "box" | "ellipse" | "diamond"> = { rectangle: "box", ellipse: "ellipse", diamond: "diamond" };

export function liveElements(ea: EA): ExElement[] {
  return ea.getViewElements().filter((e) => !e.isDeleted);
}

/** Parse + validate + apply an op list as one batch (one addElementsToView call). */
export async function applyOps(ea: EA, rawOps: unknown[]): Promise<ApplyResult> {
  const parsed = rawOps.map((o, i) => {
    const r = opSchema.safeParse(o);
    if (!r.success) {
      throw new ToolError(`Nothing was changed. op #${i + 1} is invalid: ${r.error.issues.map((x) => `${x.path.join(".") || "op"}: ${x.message}`).join("; ")}`);
    }
    return r.data;
  });
  const live = liveElements(ea);
  validateOps(parsed, new Set(live.map((e) => e.id)));

  const byId = new Map(live.map((e) => [e.id, e]));
  const toDelete = new Set<string>();
  for (const op of parsed) if (op.op === "delete") for (const id of expandDelete(op.ids, live, op.withArrows)) toDelete.add(id);

  // Copy every existing element an op touches (plus bound text) into EA's workbench.
  const touched = new Set<string>(toDelete);
  const want = (id: string) => {
    if (!byId.has(id)) return;
    touched.add(id);
    for (const e of live) if (e.containerId === id) touched.add(e.id);
    const c = byId.get(id)?.containerId;
    if (c && byId.has(c)) touched.add(c);
  };
  for (const op of parsed) {
    if (op.op === "connect") {
      want(op.from);
      want(op.to);
    } else if (op.op === "update") want(op.id);
  }
  if (touched.size) ea.copyViewElementsToEAforEditing(live.filter((e) => touched.has(e.id)));

  const refs: Record<string, string> = {};
  const added: string[] = [];
  const updated = new Set<string>();
  const resolve = (k: string) => refs[k] ?? k;

  for (const op of parsed) {
    if (op.op === "delete") continue;
    setStyle(ea, op);
    switch (op.op) {
      case "add_shape": {
        const id = addShape(ea, op);
        added.push(id);
        if (op.ref) refs[op.ref] = id;
        break;
      }
      case "add_text": {
        const id = ea.addText(op.x, op.y, op.text);
        added.push(id);
        if (op.ref) refs[op.ref] = id;
        break;
      }
      case "connect": {
        const id = ea.connectObjects(resolve(op.from), null, resolve(op.to), null, {
          startArrowHead: op.startArrowHead ?? null,
          endArrowHead: op.endArrowHead === undefined ? "arrow" : op.endArrowHead,
        });
        if (op.text) ea.addLabelToLine(id, op.text);
        added.push(id);
        if (op.ref) refs[op.ref] = id;
        break;
      }
      case "update": {
        const id = resolve(op.id);
        updateElement(ea, id, op);
        updated.add(id);
        break;
      }
    }
  }

  for (const id of toDelete) {
    const el = ea.getElement(id);
    if (el) el.isDeleted = true;
  }
  // Elements edited in place need a new version or Excalidraw ignores the change.
  for (const id of touched) bumpVersion(ea.getElement(id));

  if (Object.keys(ea.elementsDict).length) await ea.addElementsToView(false, true, true);

  // Fallback in case addElementsToView didn't apply the deletions.
  const lingering = liveElements(ea).filter((e) => toDelete.has(e.id));
  if (lingering.length) {
    const api = ea.getExcalidrawAPI();
    api.updateScene({
      elements: api.getSceneElements().map((e) => (toDelete.has(e.id) ? bumpVersion({ ...e, isDeleted: true }) : e)),
    });
  }

  return { created: refs, added, updated: [...updated], deleted: [...toDelete] };
}

function setStyle(ea: EA, op: Exclude<Op, { op: "delete" }>): void {
  const s = ea.style;
  s.strokeColor = ("strokeColor" in op && op.strokeColor) || "#1e1e1e";
  s.backgroundColor = ("backgroundColor" in op && op.backgroundColor) || "transparent";
  s.fillStyle = ("fillStyle" in op && op.fillStyle) || "solid";
  s.strokeStyle = ("strokeStyle" in op && op.strokeStyle) || "solid";
  if ("fontSize" in op && op.fontSize) s.fontSize = op.fontSize;
  if (op.op === "add_shape") s.roundness = op.shape === "rectangle" ? { type: 3 } : null;
}

function addShape(ea: EA, op: Extract<Op, { op: "add_shape" }>): string {
  const w = op.width ?? DEFAULT_W;
  const h = op.height ?? DEFAULT_H;
  let id: string;
  if (op.text) {
    // addText with `box` creates the container and binds the text properly.
    const first = ea.addText(op.x, op.y, op.text, { box: BOX[op.shape], textAlign: "center", textVerticalAlign: "middle", boxPadding: 10 });
    const el = ea.getElement(first);
    id = el?.type === "text" && el.containerId ? el.containerId : first;
    const container = ea.getElement(id);
    if (container) {
      container.x = op.x;
      container.y = op.y;
      container.width = Math.max(w, container.width);
      container.height = Math.max(h, container.height);
      centerLabel(ea, container);
    }
  } else {
    id = op.shape === "ellipse" ? ea.addEllipse(op.x, op.y, w, h) : op.shape === "diamond" ? ea.addDiamond(op.x, op.y, w, h) : ea.addRect(op.x, op.y, w, h);
  }
  if (op.link) {
    const c = ea.getElement(id);
    if (c) c.link = op.link;
  }
  return id;
}

function updateElement(ea: EA, id: string, op: Extract<Op, { op: "update" }>): void {
  const el = ea.getElement(id);
  if (!el) throw new ToolError(`update: element "${id}" not found in the drawing anymore. Call excalidraw_get_scene and retry.`);
  const label = boundText(ea, el);
  const dx = op.x !== undefined ? op.x - el.x : 0;
  const dy = op.y !== undefined ? op.y - el.y : 0;

  for (const k of ["x", "y", "width", "height", "strokeColor", "backgroundColor", "fillStyle", "strokeStyle", "strokeWidth", "opacity"] as const) {
    if (op[k] !== undefined) (el as Record<string, unknown>)[k] = op[k];
  }
  if (op.link !== undefined) el.link = op.link;
  if (op.fontSize !== undefined) {
    const t = el.type === "text" ? el : label;
    if (t) t.fontSize = op.fontSize;
  }

  if (op.text !== undefined) {
    if (el.type === "text") setText(ea, el, op.text);
    else if (label) setText(ea, label, op.text);
    else if (el.type === "arrow" || el.type === "line") ea.addLabelToLine(el.id, op.text);
    else bindNewLabel(ea, el, op.text);
  } else if (op.fontSize !== undefined && (el.type === "text" || label)) {
    const t = el.type === "text" ? el : label!;
    setText(ea, t, t.text ?? "");
  }

  if (label && el.type !== "text" && el.type !== "arrow" && el.type !== "line") {
    if (op.width !== undefined || op.height !== undefined) centerLabel(ea, el);
    else if (dx || dy) {
      label.x += dx;
      label.y += dy;
    }
  }
}

function boundText(ea: EA, el: ExElement): ExElement | undefined {
  const ref = el.boundElements?.find((b) => b.type === "text");
  return (ref && ea.getElement(ref.id)) || Object.values(ea.elementsDict).find((e) => e.type === "text" && e.containerId === el.id);
}

function centerLabel(ea: EA, container: ExElement): void {
  const t = boundText(ea, container);
  if (!t) return;
  t.x = container.x + (container.width - t.width) / 2;
  t.y = container.y + (container.height - t.height) / 2;
}

function setText(ea: EA, t: ExElement, text: string): void {
  if (t.fontSize) ea.style.fontSize = t.fontSize;
  if (t.fontFamily) ea.style.fontFamily = t.fontFamily;
  const m = ea.measureText(text);
  t.text = t.originalText = t.rawText = text;
  t.width = m.width;
  t.height = m.height;
  if (t.containerId) {
    const c = ea.getElement(t.containerId);
    if (c) centerLabel(ea, c);
  }
}

function bindNewLabel(ea: EA, container: ExElement, text: string): void {
  const id = ea.addText(container.x, container.y, text);
  const t = ea.getElement(id);
  if (!t) return;
  t.containerId = container.id;
  t.textAlign = "center";
  t.verticalAlign = "middle";
  container.boundElements = [...(container.boundElements ?? []).filter((b) => b.type !== "text"), { type: "text", id }];
  centerLabel(ea, container);
}

function bumpVersion<T extends ExElement | undefined>(el: T): T {
  if (el) {
    el.version = (el.version ?? 1) + 1;
    el.versionNonce = Math.floor(Math.random() * 2 ** 31);
    el.updated = Date.now();
  }
  return el;
}
