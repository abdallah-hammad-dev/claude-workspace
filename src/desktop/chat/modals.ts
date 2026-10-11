import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { SuggestModal, type App } from "obsidian";

/** Past Claude Code sessions for this vault (the same ones `claude --resume` shows). */
export class SessionPickerModal extends SuggestModal<SDKSessionInfo> {
  constructor(
    app: App,
    private readonly sessions: SDKSessionInfo[],
    private readonly onPick: (s: SDKSessionInfo) => void,
  ) {
    super(app);
    this.setPlaceholder("Resume a conversation…");
  }
  getSuggestions(q: string): SDKSessionInfo[] {
    const needle = q.toLowerCase();
    return this.sessions.filter((s) => sessionTitle(s).toLowerCase().includes(needle));
  }
  renderSuggestion(s: SDKSessionInfo, el: HTMLElement): void {
    el.addClass("cw-session-suggestion");
    el.createDiv({ cls: "cw-session-title", text: sessionTitle(s) });
    el.createDiv({ cls: "cw-session-date", text: relativeTime(s.lastModified) });
  }
  onChooseSuggestion(s: SDKSessionInfo): void {
    this.onPick(s);
  }
}

export function sessionTitle(s: SDKSessionInfo): string {
  return (s.customTitle || s.summary || s.firstPrompt || s.sessionId).replace(/\s+/g, " ").slice(0, 120);
}

export function relativeTime(ms: number, now = Date.now()): string {
  const min = Math.round((now - ms) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} day${d > 1 ? "s" : ""} ago`;
  return new Date(ms).toLocaleDateString();
}
