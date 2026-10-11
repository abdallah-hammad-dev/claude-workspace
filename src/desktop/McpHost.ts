import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ToolError, type ActiveContext, type Logger, type RegisteredTool, type ToolResult } from "../core/module-api";
import { checkRequest } from "./http-guard";

export const SERVER_NAME = "obsidian";
const MAX_BODY = 5 * 1024 * 1024;

export interface ServedContext {
  sessionId: string | null;
  prompt: string | null;
  text: string;
  ctx: ActiveContext;
  at: number;
}

export interface McpHostDeps {
  port: number;
  token: string;
  version: string;
  getTools(): RegisteredTool[];
  renderContext(): Promise<{ ctx: ActiveContext; text: string }>;
  /** Called every time the UserPromptSubmit hook fetched context (chat chips listen to this). */
  onContextServed?(served: ServedContext): void;
  log: Logger;
}

export type HostState = { status: "stopped" } | { status: "listening"; port: number } | { status: "error"; message: string };

const INSTRUCTIONS =
  "Live bridge to the user's Obsidian window. Before each prompt you get an <obsidian_context> block saying " +
  "which file the user is looking at; obsidian_get_active_context refreshes it. Prefer module tools " +
  "(e.g. excalidraw_*) to edit views that are open, instead of editing their files.";

/**
 * Local HTTP server: MCP (Streamable HTTP, stateless) on /mcp, and the
 * UserPromptSubmit hook endpoint on /context. 127.0.0.1 only, bearer token.
 *
 * Stateless MCP: a fresh McpServer per request, built from the registry's
 * current tools. Obsidian restarts never strand a Claude Code session, and
 * module toggles show up on the next tools/list (Claude Code: /mcp → reconnect).
 */
export class McpHost {
  private server: Server | null = null;
  state: HostState = { status: "stopped" };

  constructor(private deps: McpHostDeps) {}

  update(partial: Partial<Pick<McpHostDeps, "port" | "token">>): void {
    this.deps = { ...this.deps, ...partial };
  }

  async start(): Promise<HostState> {
    await this.stop();
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e: unknown) => {
        this.deps.log.error("request failed", e instanceof Error ? e.message : e);
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      });
    });
    this.server = server;
    const { port } = this.deps;
    this.state = await new Promise<HostState>((resolve) => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        resolve({
          status: "error",
          message: e.code === "EADDRINUSE" ? `Port ${port} is already in use` : `Cannot listen on ${port}: ${e.message}`,
        });
      });
      server.listen(port, "127.0.0.1", () => resolve({ status: "listening", port }));
    });
    if (this.state.status === "error") this.server = null;
    return this.state;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.state = { status: "stopped" };
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const guard = checkRequest(
      { host: req.headers.host, origin: req.headers.origin, authorization: req.headers.authorization },
      this.deps.port,
      this.deps.token,
    );
    if (!guard.ok) return sendJson(res, guard.status, { error: guard.reason });

    const path = (req.url ?? "/").split("?")[0];
    if (path === "/context") return this.handleContext(req, res);
    if (path === "/mcp") return this.handleMcp(req, res);
    if (path === "/health" && req.method === "GET") return sendJson(res, 200, { ok: true, version: this.deps.version });
    return sendJson(res, 404, { error: "not found" });
  }

  /**
   * GET  → the context block as plain text (handy with curl).
   * POST → Claude Code HTTP hook (UserPromptSubmit): body is the hook input,
   *        response is hook JSON output with `additionalContext`.
   */
  private async handleContext(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { ctx, text } = await this.deps.renderContext();
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(text);
      return;
    }
    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });

    let input: { session_id?: unknown; prompt?: unknown } = {};
    try {
      const body = await readBody(req);
      if (body) input = JSON.parse(body) as typeof input;
    } catch {
      // A malformed hook body must never block the user's prompt.
    }
    this.deps.onContextServed?.({
      sessionId: typeof input.session_id === "string" ? input.session_id : null,
      prompt: typeof input.prompt === "string" ? input.prompt : null,
      text,
      ctx,
      at: Date.now(),
    });
    sendJson(res, 200, text ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } } : {});
  }

  private async handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      // Stateless server: no standalone SSE stream, no sessions to delete.
      return sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }

    const server = this.buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  private buildServer(): McpServer {
    const server = new McpServer(
      { name: SERVER_NAME, version: this.deps.version },
      { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
    );
    for (const { def } of this.deps.getTools()) {
      server.registerTool(
        def.name,
        { title: def.title, description: def.description, inputSchema: def.inputSchema, annotations: def.annotations },
        async (args: Record<string, unknown>, extra) => runTool(def.name, () => def.handler(args, { signal: extra.signal })),
      );
    }
    return server;
  }
}

/** Run a module tool handler and turn whatever it returns or throws into an MCP result. */
export async function runTool(name: string, call: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return toCallToolResult(await call());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const text =
      e instanceof ToolError
        ? msg
        : `${name} failed unexpectedly: ${msg}. This is likely a bug in the Obsidian plugin; tell the user rather than retrying.`;
    return { isError: true, content: [{ type: "text", text }] };
  }
}

export function toCallToolResult(out: unknown): CallToolResult {
  if (isToolResult(out)) return out as CallToolResult;
  if (out === undefined || out === null) return { content: [{ type: "text", text: "ok" }] };
  if (typeof out === "string") return { content: [{ type: "text", text: out }] };
  return { content: [{ type: "text", text: JSON.stringify(out, null, 1) }] };
}

function isToolResult(v: unknown): v is ToolResult {
  return !!v && typeof v === "object" && Array.isArray((v as { content?: unknown }).content);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
