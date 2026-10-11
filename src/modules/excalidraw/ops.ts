import { z } from "zod";
import { ToolError } from "../../core/module-api";

const color = z.string().describe('CSS color, e.g. "#1971c2", or "transparent"');
const fill = z.enum(["solid", "hachure", "cross-hatch"]);
const strokeStyle = z.enum(["solid", "dashed", "dotted"]);
const arrowHead = z.enum(["arrow", "triangle", "dot", "bar"]).nullable();
const ref = z.string().describe("Your name for the new element, usable as from/to/id later in the same call");
const elementRef = z.string().describe("Existing element id (from excalidraw_get_scene) or a ref defined earlier in this call");

export const addShapeOp = z.object({
  op: z.literal("add_shape"),
  shape: z.enum(["rectangle", "ellipse", "diamond"]).default("rectangle"),
  x: z.number(),
  y: z.number(),
  width: z.number().positive().optional().describe("Default 160 (grown to fit the label)"),
  height: z.number().positive().optional().describe("Default 70 (grown to fit the label)"),
  text: z.string().optional().describe("Label, centered inside the shape"),
  strokeColor: color.optional(),
  backgroundColor: color.optional(),
  fillStyle: fill.optional(),
  strokeStyle: strokeStyle.optional(),
  fontSize: z.number().positive().optional(),
  link: z.string().optional().describe("e.g. [[Note]] or https://…"),
  ref: ref.optional(),
});

export const addTextOp = z.object({
  op: z.literal("add_text"),
  x: z.number(),
  y: z.number(),
  text: z.string(),
  fontSize: z.number().positive().optional(),
  strokeColor: color.optional(),
  ref: ref.optional(),
});

export const connectOp = z.object({
  op: z.literal("connect"),
  from: elementRef,
  to: elementRef,
  text: z.string().optional().describe("Label on the arrow"),
  startArrowHead: arrowHead.optional().describe("Default none"),
  endArrowHead: arrowHead.optional().describe('Default "arrow"; null for a plain line'),
  strokeColor: color.optional(),
  strokeStyle: strokeStyle.optional(),
  ref: ref.optional(),
});

export const updateOp = z.object({
  op: z.literal("update"),
  id: elementRef,
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  text: z.string().optional().describe("New text (for a shape or arrow: its label, created if missing)"),
  strokeColor: color.optional(),
  backgroundColor: color.optional(),
  fillStyle: fill.optional(),
  strokeStyle: strokeStyle.optional(),
  strokeWidth: z.number().positive().optional(),
  opacity: z.number().min(0).max(100).optional(),
  fontSize: z.number().positive().optional(),
  link: z.string().nullable().optional().describe("null removes the link"),
});

export const deleteOp = z.object({
  op: z.literal("delete"),
  ids: z.array(elementRef).min(1),
  withArrows: z.boolean().default(true).describe("Also delete arrows attached to these elements"),
});

export const opSchema = z.discriminatedUnion("op", [addShapeOp, addTextOp, connectOp, updateOp, deleteOp]);
export type Op = z.infer<typeof opSchema>;

/**
 * Check the whole op list against the scene before anything is applied
 * (no partial writes). Collects every problem so Claude can fix them in one go.
 */
export function validateOps(ops: Op[], existingIds: Set<string>): void {
  const refs = new Set<string>();
  const deleted = new Set<string>();
  const problems: string[] = [];

  const resolvable = (id: string, i: number, what: string) => {
    if (deleted.has(id)) problems.push(`op #${i + 1} (${what}): "${id}" is deleted earlier in this call`);
    else if (!existingIds.has(id) && !refs.has(id)) {
      problems.push(`op #${i + 1} (${what}): unknown element "${id}"`);
    }
  };

  ops.forEach((op, i) => {
    switch (op.op) {
      case "add_shape":
      case "add_text":
      case "connect":
        if (op.op === "connect") {
          resolvable(op.from, i, "connect.from");
          resolvable(op.to, i, "connect.to");
          if (op.from === op.to) problems.push(`op #${i + 1} (connect): from and to are the same element`);
        }
        if (op.ref !== undefined) {
          if (refs.has(op.ref)) problems.push(`op #${i + 1}: ref "${op.ref}" is used twice`);
          else if (existingIds.has(op.ref)) problems.push(`op #${i + 1}: ref "${op.ref}" collides with an existing element id`);
          refs.add(op.ref);
        }
        break;
      case "update":
        resolvable(op.id, i, "update.id");
        break;
      case "delete":
        for (const id of op.ids) resolvable(id, i, "delete.ids");
        for (const id of op.ids) deleted.add(id);
        break;
    }
  });

  if (problems.length) {
    throw new ToolError(
      `Nothing was changed. Fix these and call excalidraw_apply again:\n- ${problems.join("\n- ")}\n` +
        "Use ids from excalidraw_get_scene, or refs defined by an earlier op in the same call.",
    );
  }
}
