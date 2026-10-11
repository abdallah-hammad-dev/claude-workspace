/**
 * Module API — the only surface modules see. Core knows nothing about drawings,
 * calendars or tasks; it only collects what modules register here.
 *
 * Every `register*` call is scoped to the module: when the module is disabled
 * or unloaded, everything it registered is disposed automatically.
 *
 * Keep this file free of MCP SDK / Agent SDK types so modules don't depend on them.
 */
import type { App, Command, Plugin, TFile, View, ViewCreator } from "obsidian";
import type { z } from "zod";

export type Disposer = () => void;
export type ModulePlatform = "desktop" | "mobile";

export interface WorkspaceModule {
  /** Lowercase id, also the tool-name prefix: tools must be named `${id}_…`. */
  id: string;
  name: string;
  description?: string;
  /** Where the module can run. Default: both. Desktop = Node APIs available. */
  platforms?: ModulePlatform[];
  /** E.g. "is the Excalidraw plugin installed". Unavailable modules register nothing. */
  isAvailable?(app: App): boolean;
  /** Initial state of the per-module toggle in settings. Default: true. */
  enabledByDefault?: boolean;
  /** Core modules that can't be turned off. */
  required?: boolean;
  onload(ctx: ModuleContext): void | Promise<void>;
  onunload?(): void | Promise<void>;
}

export interface ModuleContext {
  readonly app: App;
  readonly plugin: Plugin;
  readonly moduleId: string;
  readonly log: Logger;
  registerTool<S extends z.ZodRawShape>(def: ToolDef<S>): void;
  registerContextProvider(provider: ContextProvider): void;
  registerView(type: string, factory: ViewCreator): void;
  /** `id` is prefixed with the module id; Obsidian adds the plugin id on top. */
  registerCommand(cmd: Command): void;
  registerSettings(section: SettingsSection): void;
  /** Installed by the Installer to `.claude/skills/<name>/SKILL.md`. */
  registerSkill(skill: SkillDef): void;
  /** Any extra cleanup to run when the module is disabled. */
  onDispose(fn: Disposer): void;
  getActiveContext(): Promise<ActiveContext>;
  /** Per-module persisted settings, stored under `modules.<id>.data` in plugin data. */
  loadData<T extends object>(defaults: T): T;
  saveData(data: object): Promise<void>;
}

// ───────────────────────────── tools ─────────────────────────────

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolCallExtra {
  signal: AbortSignal;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  /** Must start with `${moduleId}_`, e.g. `excalidraw_get_scene`. */
  name: string;
  title?: string;
  /** Written for Claude: what it does, when to use it, what to call first. */
  description: string;
  inputSchema: S;
  annotations?: ToolAnnotations;
  /**
   * Return a ToolResult, or any JSON-serializable value (sent as text).
   * Throw `ToolError` for an expected failure: the message reaches Claude as
   * `isError: true`, so phrase it as how to recover.
   */
  handler(args: z.infer<z.ZodObject<S>>, extra: ToolCallExtra): Promise<unknown>;
}

/** Expected, recoverable tool failure. Message is shown to Claude verbatim. */
export class ToolError extends Error {
  override name = "ToolError";
}

/** A tool as stored in the registry (after the module prefix check). */
export interface RegisteredTool {
  moduleId: string;
  def: ToolDef;
}

// ───────────────────────────── context ─────────────────────────────

export interface ContextProvider {
  /** Unique within the module; data is keyed `${moduleId}.${id}` in ActiveContext. */
  id: string;
  /** View types this provider applies to: ["markdown"], ["excalidraw"], or ["*"]. */
  viewTypes: string[];
  /** Lower runs (and renders) first. Default 100. */
  priority?: number;
  /** Structured data about the view. Return null when there's nothing to say. */
  collect(view: View, file: TFile | null): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  /** Lines for the `<obsidian_context>` block. Keep it short; never full file contents. */
  render?(data: Record<string, unknown>): string[];
  /** Short label for the chat view's context chips (e.g. "L40–45 selected"). Display only. */
  chip?(data: Record<string, unknown>): string | null;
}

export interface OpenTab {
  path: string;
  viewType: string;
}

export interface ActiveContext {
  activeFile: { path: string; viewType: string } | null;
  /** Markdown "source" | "preview", when known. */
  mode?: string;
  /** Keyed by `${moduleId}.${providerId}`. */
  providers: Record<string, Record<string, unknown>>;
  openTabs: OpenTab[];
}

// ───────────────────────────── misc ─────────────────────────────

export interface SettingsSection {
  /** Heading shown above the module's settings. */
  title: string;
  display(containerEl: HTMLElement): void;
}

export interface SkillDef {
  /** Directory name under `.claude/skills/`. Lowercase, digits, hyphens. */
  name: string;
  /** Full SKILL.md contents, including the YAML frontmatter. */
  markdown: string;
}

export interface Logger {
  debug(msg: string, ...meta: unknown[]): void;
  info(msg: string, ...meta: unknown[]): void;
  warn(msg: string, ...meta: unknown[]): void;
  error(msg: string, ...meta: unknown[]): void;
}

/** What `plugin.api` exposes to other Obsidian plugins. */
export interface ClaudeWorkspaceApi {
  readonly version: 1;
  registerModule(mod: WorkspaceModule): Disposer;
}
