/** Excalidraw scene types (the subset we read/write) and the compact summaries Claude sees. Pure. */

export interface ExElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  isDeleted?: boolean;
  version?: number;
  versionNonce?: number;
  updated?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  opacity?: number;
  groupIds?: string[];
  frameId?: string | null;
  link?: string | null;
  // text
  text?: string;
  originalText?: string;
  rawText?: string;
  fontSize?: number;
  fontFamily?: number;
  containerId?: string | null;
  // containers / arrows
  boundElements?: { id: string; type: string }[] | null;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  points?: [number, number][];
  [key: string]: unknown;
}

export interface ElementSummary {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  stroke?: string;
  bg?: string;
  from?: string;
  to?: string;
  groups?: string[];
  frame?: string;
  link?: string;
}

const DEFAULT_STROKES = new Set(["#1e1e1e", "#000000", "#000"]);

/**
 * One entry per visible thing: bound text is merged into its container (or arrow)
 * as `text`, so Claude reasons about "a box labelled X", not two elements.
 */
export function summarize(elements: ExElement[]): ElementSummary[] {
  const live = elements.filter((e) => !e.isDeleted);
  const labelOf = new Map<string, string>();
  for (const e of live) if (e.type === "text" && e.containerId) labelOf.set(e.containerId, e.text ?? "");
  const r = Math.round;
  return live
    .filter((e) => !(e.type === "text" && e.containerId && live.some((c) => c.id === e.containerId)))
    .map((e) => {
      const o: ElementSummary = { id: e.id, type: e.type, x: r(e.x), y: r(e.y), w: r(e.width), h: r(e.height) };
      const label = e.type === "text" ? e.text : labelOf.get(e.id);
      if (label) o.text = label;
      if (e.strokeColor && !DEFAULT_STROKES.has(e.strokeColor)) o.stroke = e.strokeColor;
      if (e.backgroundColor && e.backgroundColor !== "transparent") o.bg = e.backgroundColor;
      if (e.startBinding?.elementId) o.from = e.startBinding.elementId;
      if (e.endBinding?.elementId) o.to = e.endBinding.elementId;
      if (e.groupIds?.length) o.groups = e.groupIds;
      if (e.frameId) o.frame = e.frameId;
      if (e.link) o.link = e.link;
      return o;
    });
}

/** Map a selected bound-text id to its container so selection reads like the summary. */
export function normalizeSelection(selectedIds: string[], elements: ExElement[]): string[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const out = new Set<string>();
  for (const id of selectedIds) {
    const e = byId.get(id);
    out.add(e?.type === "text" && e.containerId && byId.has(e.containerId) ? e.containerId : id);
  }
  return [...out];
}

/** Ids to remove when deleting `ids`: their bound text, and (optionally) attached arrows with their labels. */
export function expandDelete(ids: string[], elements: ExElement[], withArrows: boolean): Set<string> {
  const live = elements.filter((e) => !e.isDeleted);
  const out = new Set<string>();
  const addWithLabel = (id: string) => {
    out.add(id);
    for (const e of live) if (e.containerId === id) out.add(e.id);
  };
  for (const id of ids) {
    addWithLabel(id);
    if (!withArrows) continue;
    for (const e of live) {
      if (e.startBinding?.elementId === id || e.endBinding?.elementId === id) addWithLabel(e.id);
    }
  }
  return out;
}
