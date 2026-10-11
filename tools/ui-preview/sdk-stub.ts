/** Stand-in for @anthropic-ai/claude-agent-sdk in UI previews: a session that never answers. */
export const FAKE_COMMANDS = [
  { name: "compact", description: "Free up context by summarizing the conversation so far", argumentHint: "<optional custom summarization instructions>", builtin: true },
  { name: "context", description: "Show current context usage", argumentHint: "", builtin: true },
  { name: "cost", description: "Show session cost, plan usage, and what's contributing to your usage", argumentHint: "", aliases: ["usage"], builtin: true },
  { name: "clear", description: "Start a new session with empty context", argumentHint: "[name]", builtin: true },
  { name: "excalidraw", description: "Read and edit Excalidraw drawings that are open in Obsidian, live", argumentHint: "" },
  { name: "obsidian-commands", description: "Run Obsidian commands (core features and any installed plugin)", argumentHint: "" },
  { name: "init", description: "Initialize a new CLAUDE.md file with codebase documentation", argumentHint: "", builtin: true },
  { name: "model", description: "Set the AI model for Claude Code", argumentHint: "<model>", builtin: true },
];

export const FAKE_MODELS = [
  { value: "default", displayName: "Default (recommended)", description: "Opus 5.5 · Most capable for complex work" },
  { value: "sonnet", displayName: "Sonnet", description: "Sonnet 5.5 · Best for everyday tasks" },
  { value: "haiku", displayName: "Haiku", description: "Haiku 5.5 · Fastest for quick answers" },
  { value: "claude-opus-4-8", displayName: "claude-opus-4-8", description: "" },
];

export function query(): unknown {
  return {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
    initializationResult: () => Promise.resolve({ commands: FAKE_COMMANDS, models: FAKE_MODELS }),
    interrupt: () => Promise.resolve(),
    setModel: () => Promise.resolve(),
    setPermissionMode: () => Promise.resolve(),
    close: () => undefined,
  };
}
export const listSessions = () => Promise.resolve([]);
export const getSessionMessages = () => Promise.resolve([]);
