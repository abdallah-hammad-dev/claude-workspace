/**
 * Long pastes, the Claude Code way: the composer shows `[Pasted text #1 +42 lines]` instead of the text,
 * and the placeholder is replaced by the pasted text when the message is sent. Deleting the placeholder
 * drops the paste.
 */
const COLLAPSE_CHARS = 800;
const COLLAPSE_LINES = 12;
const PLACEHOLDER = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g;

export function lineCount(text: string): number {
  return text.replace(/\n$/, "").split("\n").length;
}

export function shouldCollapse(text: string): boolean {
  return text.length > COLLAPSE_CHARS || lineCount(text) > COLLAPSE_LINES;
}

export function pastePlaceholder(id: number, text: string): string {
  const lines = lineCount(text);
  return lines > 1 ? `[Pasted text #${id} +${lines} lines]` : `[Pasted text #${id}]`;
}

export type Segment = { text: string } | { paste: number; content: string };

/** Splits a message into plain text and known pastes (unknown placeholders stay text). */
export function splitPastes(input: string, pastes: ReadonlyMap<number, string>): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of input.matchAll(PLACEHOLDER)) {
    const content = pastes.get(Number(m[1]));
    if (content === undefined) continue;
    if (m.index > last) out.push({ text: input.slice(last, m.index) });
    out.push({ paste: Number(m[1]), content });
    last = m.index + m[0].length;
  }
  if (last < input.length) out.push({ text: input.slice(last) });
  return out;
}

export function expandPastes(input: string, pastes: ReadonlyMap<number, string>): string {
  return splitPastes(input, pastes)
    .map((s) => ("text" in s ? s.text : s.content))
    .join("");
}
