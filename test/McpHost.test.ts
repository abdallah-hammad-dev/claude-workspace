import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolError, type RegisteredTool, type ToolDef } from "../src/core/module-api";
import { McpHost, type ServedContext } from "../src/desktop/McpHost";
import { checkRequest, defaultPortFor } from "../src/desktop/http-guard";

const TOKEN = "t0k3n";
const silent = { debug() {}, info() {}, warn() {}, error() {} };

function tool<S extends z.ZodRawShape>(def: ToolDef<S>): RegisteredTool {
  return { moduleId: def.name.split("_")[0]!, def: def };
}

const tools: RegisteredTool[] = [
  tool({
    name: "demo_add",
    description: "add",
    inputSchema: { a: z.number(), b: z.number() },
    annotations: { readOnlyHint: true },
    handler: async ({ a, b }) => ({ sum: a + b }),
  }),
  tool({
    name: "demo_fail",
    description: "fails",
    inputSchema: {},
    handler: async () => {
      throw new ToolError("Open a drawing first.");
    },
  }),
  tool({
    name: "demo_crash",
    description: "crashes",
    inputSchema: {},
    handler: async () => {
      throw new TypeError("x is undefined");
    },
  }),
  tool({
    name: "demo_image",
    description: "image",
    inputSchema: {},
    handler: async () => ({ content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] }),
  }),
];

let host: McpHost;
let port: number;
let served: ServedContext[];

beforeEach(async () => {
  served = [];
  port = 30000 + Math.floor(Math.random() * 20000);
  host = new McpHost({
    port,
    token: TOKEN,
    version: "test",
    getTools: () => tools,
    renderContext: async () => ({
      ctx: { activeFile: { path: "A.md", viewType: "markdown" }, providers: {}, openTabs: [] },
      text: "<obsidian_context>\nA.md\n</obsidian_context>",
    }),
    onContextServed: (s) => served.push(s),
    log: silent,
  });
  expect(await host.start()).toEqual({ status: "listening", port });
});

afterEach(async () => {
  await host.stop();
});

async function connect(): Promise<Client> {
  const client = new Client({ name: "test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);
  return client;
}

function raw(
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe("McpHost — MCP over Streamable HTTP", () => {
  it("lists registry tools with schema and annotations", async () => {
    const client = await connect();
    const { tools: listed } = await client.listTools();
    expect(listed.map((t) => t.name)).toEqual(["demo_add", "demo_fail", "demo_crash", "demo_image"]);
    const add = listed[0]!;
    expect(add.inputSchema.properties).toHaveProperty("a");
    expect(add.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it("calls a tool and serializes its JSON result", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "demo_add", arguments: { a: 2, b: 3 } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse((res.content as { text: string }[])[0]!.text)).toEqual({ sum: 5 });
    await client.close();
  });

  it("returns ToolError messages verbatim as isError", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "demo_fail", arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toBe("Open a drawing first.");
    await client.close();
  });

  it("wraps unexpected errors with recovery advice", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "demo_crash", arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toMatch(/demo_crash failed unexpectedly: x is undefined.*bug/);
    await client.close();
  });

  it("rejects invalid arguments", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "demo_add", arguments: { a: "two" } });
    expect(res.isError).toBe(true);
    await client.close();
  });

  it("passes image content through", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "demo_image", arguments: {} });
    expect(res.content).toEqual([{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
    await client.close();
  });
});

describe("McpHost — /context hook endpoint", () => {
  const auth = { Authorization: `Bearer ${TOKEN}` };

  it("GET returns the context block as text", async () => {
    const res = await raw("/context", { headers: auth });
    expect(res).toEqual({ status: 200, body: "<obsidian_context>\nA.md\n</obsidian_context>" });
  });

  it("POST (HTTP hook) returns additionalContext and records the session", async () => {
    const res = await raw("/context", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s-1", prompt: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "<obsidian_context>\nA.md\n</obsidian_context>" },
    });
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({ sessionId: "s-1", prompt: "hi" });
  });

  it("POST with a malformed body still answers (never blocks a prompt)", async () => {
    const res = await raw("/context", { method: "POST", headers: auth, body: "{nope" });
    expect(res.status).toBe(200);
    expect(served[0]?.sessionId).toBeNull();
  });
});

describe("McpHost — security", () => {
  it("rejects missing token, browser Origin and foreign Host", async () => {
    expect((await raw("/context")).status).toBe(401);
    expect((await raw("/context", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect(
      (await raw("/context", { headers: { Authorization: `Bearer ${TOKEN}`, Origin: "https://evil.example" } })).status,
    ).toBe(403);
    expect((await raw("/context", { headers: { Authorization: `Bearer ${TOKEN}`, Host: "evil.example" } })).status).toBe(403);
  });

  it("reports a port conflict instead of throwing", async () => {
    const other = new McpHost({ port, token: TOKEN, version: "x", getTools: () => [], renderContext: async () => ({ ctx: { activeFile: null, providers: {}, openTabs: [] }, text: "" }), log: silent });
    expect(await other.start()).toEqual({ status: "error", message: `Port ${port} is already in use` });
  });
});

describe("http-guard", () => {
  it("accepts localhost and 127.0.0.1 with the right token", () => {
    const ok = { origin: undefined, authorization: "Bearer abc" };
    expect(checkRequest({ ...ok, host: "127.0.0.1:1234" }, 1234, "abc").ok).toBe(true);
    expect(checkRequest({ ...ok, host: "localhost:1234" }, 1234, "abc").ok).toBe(true);
    expect(checkRequest({ ...ok, host: "127.0.0.1:9999" }, 1234, "abc").ok).toBe(false);
    expect(checkRequest({ ...ok, host: "127.0.0.1:1234" }, 1234, "").ok).toBe(false);
  });

  it("derives a stable per-vault port", () => {
    expect(defaultPortFor("vault-a")).toBe(defaultPortFor("vault-a"));
    expect(defaultPortFor("vault-a")).toBeGreaterThanOrEqual(27200);
    expect(defaultPortFor("vault-a")).toBeLessThan(28000);
  });
});
