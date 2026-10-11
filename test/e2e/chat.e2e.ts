/**
 * End-to-end check against the REAL Claude Code CLI (costs a few cents, uses your login).
 *   npm run test:e2e
 * Verifies: the vault HTTP hook injects context exactly once per prompt, the MCP
 * server's tools work through Claude Code, and sessions can be resumed.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { RegisteredTool } from "../../src/core/module-api";
import { locateClaude } from "../../src/desktop/claude-binary";
import { ChatSession } from "../../src/desktop/chat/ChatSession";
import { mergeClaudeSettings, mergeMcpJson } from "../../src/desktop/installer-merge";
import { McpHost, SERVER_NAME, type ServedContext } from "../../src/desktop/McpHost";
import { existsSync, statSync } from "node:fs";

const claudePath = process.env.CLAUDE_PATH ?? locateClaude({
  platform: process.platform,
  home: homedir(),
  env: process.env,
  isFile: (p) => existsSync(p) && statSync(p).isFile(),
});
const TOKEN = "e2e-token";
const port = 31000 + Math.floor(Math.random() * 1000);
const target = { serverName: SERVER_NAME, port, token: TOKEN };
const silent = { debug() {}, info() {}, warn() {}, error() {} };

let vault: string;
let host: McpHost;
const served: ServedContext[] = [];
let activeFile = "Projects/Beta.md";
const toolCalls: string[] = [];

const tools: RegisteredTool[] = [
  {
    moduleId: "obsidian",
    def: {
      name: "obsidian_secret_word",
      description: "Returns today's secret word. Call it when the user asks for the secret word.",
      inputSchema: { reason: z.string().optional() },
      handler: async () => {
        toolCalls.push("obsidian_secret_word");
        return "pineapple-42";
      },
    },
  },
];

function runTurn(session: ChatSession, messages: SDKMessage[]): Promise<SDKMessage[]> {
  return new Promise((resolve) => {
    const start = messages.length;
    const check = setInterval(() => {
      if (messages.slice(start).some((m) => m.type === "result")) {
        clearInterval(check);
        resolve(messages.slice(start));
      }
    }, 100);
  });
}

function finalText(msgs: SDKMessage[]): string {
  const r = msgs.find((m) => m.type === "result");
  return r && r.type === "result" && r.subtype === "success" ? r.result : "";
}

describe.skipIf(!claudePath)("chat e2e (real Claude Code)", () => {
  beforeAll(async () => {
    vault = mkdtempSync(join(tmpdir(), "cw-e2e-vault-"));
    mkdirSync(join(vault, "Projects"), { recursive: true });
    mkdirSync(join(vault, ".claude"), { recursive: true });
    writeFileSync(join(vault, "Projects/Beta.md"), "# Beta\n");
    writeFileSync(join(vault, ".mcp.json"), JSON.stringify(mergeMcpJson({}, target)));
    writeFileSync(join(vault, ".claude/settings.json"), JSON.stringify(mergeClaudeSettings({}, target)));

    host = new McpHost({
      port,
      token: TOKEN,
      version: "e2e",
      getTools: () => tools,
      renderContext: async () => {
        const text = `<obsidian_context>\nThe user is currently looking at: ${activeFile} (view: markdown).\n</obsidian_context>`;
        return { ctx: { activeFile: { path: activeFile, viewType: "markdown" }, providers: {}, openTabs: [] }, text };
      },
      onContextServed: (s) => served.push(s),
      log: silent,
    });
    expect((await host.start()).status).toBe("listening");
  });

  afterAll(async () => {
    await host?.stop();
  });

  it("injects context once per turn, follows the active file, calls MCP tools, resumes", async () => {
    const messages: SDKMessage[] = [];
    const ended: (Error | undefined)[] = [];
    const make = (resume?: string) =>
      new ChatSession({
        cwd: vault,
        claudePath: claudePath!,
        env: { ...process.env },
        // Same as the ChatView: pass the server explicitly (it is also in .mcp.json).
        mcpServers: { [SERVER_NAME]: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${TOKEN}` } } },
        model: "haiku",
        permissionMode: "default",
        resume,
        appendSystemPrompt: "Answer in as few words as possible.",
        canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
        onMessage: (m) => messages.push(m),
        onEnd: (e) => ended.push(e),
      });

    const session = make();
    // Warm start: slash commands and models are available before the first message.
    session.warmup();
    const init = await session.initialization();
    expect(init?.commands.some((c) => c.name === "compact")).toBe(true);
    expect(init?.models.length).toBeGreaterThan(0);
    expect(served).toHaveLength(0);

    session.send("Which file am I looking at? Reply with the path only.");
    const t1 = await runTurn(session, messages);
    expect(finalText(t1)).toContain("Projects/Beta.md");
    expect(served).toHaveLength(1);
    expect(served[0]!.sessionId).toBe(session.sessionId);

    activeFile = "Projects/Alpha.md";
    session.send("And now? Path only.");
    const t2 = await runTurn(session, messages);
    expect(finalText(t2)).toContain("Projects/Alpha.md");
    expect(served).toHaveLength(2);

    session.send("What is the secret word? Use the tool.");
    const t3 = await runTurn(session, messages);
    expect(toolCalls).toContain("obsidian_secret_word");
    expect(finalText(t3)).toContain("pineapple-42");
    expect(served).toHaveLength(3);

    const id = session.sessionId!;
    session.close();

    const resumed = make(id);
    resumed.send("What was the secret word you told me? Word only.");
    const t4 = await runTurn(resumed, messages);
    expect(finalText(t4)).toContain("pineapple");
    expect(resumed.sessionId).toBe(id);
    expect(served).toHaveLength(4);
    resumed.close();
    expect(ended.filter(Boolean)).toEqual([]);
  }, 240_000);

  it("starts at the chosen effort and changes it mid-conversation", async () => {
    const messages: SDKMessage[] = [];
    const session = new ChatSession({
      cwd: vault,
      claudePath: claudePath!,
      env: { ...process.env },
      mcpServers: {},
      // Haiku has no effort levels; Claude Code exposes the level to Bash as CLAUDE_EFFORT.
      model: "sonnet",
      effort: "low",
      permissionMode: "default",
      appendSystemPrompt: "Answer in as few words as possible.",
      canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
      onMessage: (m) => messages.push(m),
      onEnd: () => undefined,
    });
    const ask = "Run `echo effort=$CLAUDE_EFFORT` with the Bash tool and reply with its output only.";
    session.send(ask);
    expect(finalText(await runTurn(session, messages))).toContain("effort=low");
    await session.setEffort("high");
    session.send(ask);
    expect(finalText(await runTurn(session, messages))).toContain("effort=high");
    session.close();
  }, 240_000);
});
