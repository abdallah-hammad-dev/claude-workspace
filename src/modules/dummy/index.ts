import { Notice } from "obsidian";
import { z } from "zod";
import type { WorkspaceModule } from "../../core/module-api";

/**
 * Smallest possible module: exercises every Module API hook so the registry
 * (and later the MCP server, installer and settings UI) have something to show.
 * Off by default; enable it in settings to try the plumbing.
 */
export const helloModule: WorkspaceModule = {
  id: "hello",
  name: "Hello (example module)",
  description: "Example module that registers one tool, one command, one context provider and one skill.",
  enabledByDefault: false,

  onload(ctx) {
    const settings = ctx.loadData({ greeting: "Hello" });

    ctx.registerTool({
      name: "hello_echo",
      description: "Echo a message back with the configured greeting. Only useful to test the plumbing.",
      inputSchema: { message: z.string().describe("Text to echo") },
      annotations: { readOnlyHint: true },
      handler: async ({ message }) => `${settings.greeting}, ${message}`,
    });

    ctx.registerContextProvider({
      id: "greeting",
      viewTypes: ["*"],
      priority: 1000,
      collect: () => ({ greeting: settings.greeting }),
      render: (data) => [`(hello module is enabled; greeting: ${String(data.greeting)})`],
    });

    ctx.registerCommand({
      id: "say",
      name: "Hello: say hello",
      callback: () => new Notice(`${settings.greeting} from claude-workspace`),
    });

    ctx.registerSettings({
      title: "Hello",
      items: [{ name: "Greeting", control: { type: "text", key: "greeting" } }],
      values: {
        greeting: {
          get: () => settings.greeting,
          set: async (v) => {
            settings.greeting = String(v);
            await ctx.saveData(settings);
          },
        },
      },
    });

    ctx.registerSkill({
      name: "hello",
      markdown: [
        "---",
        "name: hello",
        "description: Test skill from the claude-workspace hello module. Use only when the user asks to test the hello module.",
        "---",
        "",
        "Call the `hello_echo` tool with the user's message and show the result.",
        "",
      ].join("\n"),
    });
  },
};
