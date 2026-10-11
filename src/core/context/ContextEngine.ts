import { EditorView } from "@codemirror/view";
import { debounce, MarkdownView, TFile, type App, type Plugin, type View, type WorkspaceLeaf } from "obsidian";
import type { ActiveContext, Disposer, Logger, OpenTab } from "../module-api";
import type { ModuleRegistry } from "../ModuleRegistry";
import { renderContext } from "./render";

const PROVIDER_TIMEOUT_MS = 1500;

/**
 * Knows what the user is looking at. Tracks the last leaf that holds a file,
 * so focusing the chat view or a side panel doesn't reset it, and asks the
 * registered context providers for details.
 */
export class ContextEngine {
  private lastLeaf: WorkspaceLeaf | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly notifySoon = debounce(() => this.notify(), 150, true);

  constructor(
    private readonly app: App,
    private readonly registry: ModuleRegistry,
    private readonly log: Logger,
  ) {}

  attach(plugin: Plugin): void {
    const ws = this.app.workspace;
    plugin.registerEvent(ws.on("active-leaf-change", (leaf) => this.track(leaf)));
    plugin.registerEvent(ws.on("file-open", (file) => file && this.trackFile(file)));
    plugin.registerEvent(ws.on("layout-change", () => this.notifySoon()));
    // Cursor and selection moves don't fire workspace events; listen in CodeMirror.
    plugin.registerEditorExtension(
      EditorView.updateListener.of((u) => {
        if (u.selectionSet || u.docChanged) this.notifySoon();
      }),
    );
    ws.onLayoutReady(() => this.track(ws.getMostRecentLeaf()));
    plugin.register(this.registry.onChange((c) => c === "providers" && this.notifySoon()));
  }

  /** Called whenever the context may have changed (debounced). */
  onChange(fn: () => void): Disposer {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Let modules with their own selection model (Excalidraw) ask for a refresh. */
  notifyChanged(): void {
    this.notifySoon();
  }

  /** The leaf the user is working in, or null. */
  currentLeaf(): WorkspaceLeaf | null {
    const leaf = this.lastLeaf;
    if (leaf && this.isEditorLeaf(leaf) && leaf.view.containerEl.isConnected) return leaf;
    const active = this.app.workspace.getActiveFile();
    let found: WorkspaceLeaf | null = null;
    this.app.workspace.iterateRootLeaves((l) => {
      if (!found && fileOf(l.view) && (!active || fileOf(l.view) === active)) found = l;
    });
    return found;
  }

  async collect(): Promise<ActiveContext> {
    const openTabs = this.openTabs();
    const leaf = this.currentLeaf();
    const view = leaf?.view;
    const file = view ? fileOf(view) : null;
    if (!view || !file) return { activeFile: null, providers: {}, openTabs };

    const viewType = view.getViewType();
    const ctx: ActiveContext = { activeFile: { path: file.path, viewType }, providers: {}, openTabs };
    if (view instanceof MarkdownView) ctx.mode = view.getMode();

    for (const { key, provider } of this.registry.getProviders(viewType)) {
      try {
        const data = await withTimeout(Promise.resolve(provider.collect(view, file)), PROVIDER_TIMEOUT_MS);
        if (data) ctx.providers[key] = data;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.log.warn(`context provider ${key} failed: ${msg}`);
        ctx.providers[key] = { error: msg };
      }
    }
    return ctx;
  }

  render(ctx: ActiveContext): string {
    return renderContext(ctx, (key) => {
      const p = this.registry.getProvider(key)?.provider;
      return p?.render ? (data) => p.render!(data) : undefined;
    });
  }

  async renderCurrent(): Promise<{ ctx: ActiveContext; text: string }> {
    const ctx = await this.collect();
    return { ctx, text: this.render(ctx) };
  }

  /**
   * A tab in the main area (or a popout window) showing a file. Side panels such as
   * Outline or Backlinks also carry a `file`, but they describe the note, they aren't it.
   */
  private isEditorLeaf(leaf: WorkspaceLeaf): boolean {
    if (!fileOf(leaf.view)) return false;
    const root = leaf.getRoot();
    return root !== this.app.workspace.leftSplit && root !== this.app.workspace.rightSplit;
  }

  private openTabs(): OpenTab[] {
    const tabs: OpenTab[] = [];
    this.app.workspace.iterateRootLeaves((l) => {
      const f = fileOf(l.view);
      if (f) tabs.push({ path: f.path, viewType: l.view.getViewType() });
    });
    return tabs;
  }

  private track(leaf: WorkspaceLeaf | null): void {
    if (leaf && this.isEditorLeaf(leaf)) this.lastLeaf = leaf;
    this.notifySoon();
  }

  /** `file-open` also fires for files opened by tools while focus stays in the chat. */
  private trackFile(file: TFile): void {
    const active = this.app.workspace.getMostRecentLeaf();
    if (active && fileOf(active.view) === file && this.isEditorLeaf(active)) {
      this.lastLeaf = active;
    } else {
      this.app.workspace.iterateRootLeaves((l) => {
        if (fileOf(l.view) === file) this.lastLeaf = l;
      });
    }
    this.notifySoon();
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (e) {
        this.log.error("context listener failed", e);
      }
    }
  }
}

export function fileOf(view: View | null | undefined): TFile | null {
  const file = (view as { file?: unknown } | null | undefined)?.file;
  return file instanceof TFile ? file : null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        window.clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
