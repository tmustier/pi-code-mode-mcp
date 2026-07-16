import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { createCodeModeServer } from "../src/mcp-server.ts";
import type { LoadedCodeModeConfig } from "../src/types.ts";

const fixturePath = new URL("./fixtures/upstream-server.mjs", import.meta.url).pathname;

interface Harness {
  client: Client;
  close(): Promise<void>;
  exec(code: string, options?: { sessionId?: string; timeoutMs?: number; signal?: AbortSignal; onprogress?: (progress: unknown) => void }): Promise<CallToolResult>;
}

test("exec composes nested MCP calls and preserves protocol behavior", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "code-mode-state-"));
  const harness = await createHarness(stateDir);
  t.after(async () => {
    await harness.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  await t.test("exposes one compact tool and ranked in-code discovery", async () => {
    const listed = await harness.client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name), ["exec"]);
    assert.match(listed.tools[0]!.description ?? "", /search\(query, options\?\)/);
    const result = await harness.exec(`
      const matches = search("calculate", { server: "fixture", limit: 3 });
      return {
        names: matches.map(t => t.name),
        completeInventoryHasImage: ALL_TOOLS.some(t => t.name === "mcp__fixture__image"),
        frozen: Object.isFrozen(matches) && Object.isFrozen(matches[0]),
      };
    `);
    assert.deepEqual(result.structuredContent, {
      names: ["mcp__fixture__calculate"],
      completeInventoryHasImage: true,
      frozen: true,
    });
  });

  await t.test("structurally elides accidental catalog dumps returned from the VM", async () => {
    const result = await harness.exec(`
      return {
        catalog: Array.from({ length: 40 }, (_, index) => ({
          name: \`mcp__teams__tool_\${index}\`,
          server: "teams",
          tool: \`tool_\${index}\`,
          description: \`Tool \${index}\`,
        })),
      };
    `);
    const catalog = (result.structuredContent as {
      catalog: { items: unknown[]; total: number; omitted: number; truncated: boolean };
    }).catalog;
    assert.equal(catalog.items.length, 30);
    assert.equal(catalog.total, 40);
    assert.equal(catalog.omitted, 10);
    assert.equal(catalog.truncated, true);
  });

  await t.test("supports loops, branching, Promise.all, schema discovery, and result transformation", async () => {
    const result = await harness.exec(`
      const [match] = search("calculate", { server: "fixture" });
      const metadata = describe(match.name);
      if (!metadata.inputSchema.properties.values) throw new Error("schema missing");
      const calls = [];
      for (let i = 1; i <= 3; i++) {
        calls.push(call(match.name, { values: [i, i * 2] }));
      }
      const results = await Promise.all(calls);
      const sums = results.map(result => result.structuredContent.sum);
      return { sums, total: sums.reduce((a, b) => a + b, 0), branch: sums[0] === 3 ? "yes" : "no" };
    `);
    assert.deepEqual(result.structuredContent, { sums: [3, 6, 9], total: 18, branch: "yes" });
  });

  await t.test("forwards progress from nested calls", async () => {
    const progress: unknown[] = [];
    const result = await harness.exec(
      `return await tools.mcp__fixture__calculate({ values: [4, 5], delay_ms: 20 });`,
      { onprogress: value => progress.push(value) },
    );
    assert.equal(text(result), "9");
    assert.ok(progress.length >= 1);
  });

  await t.test("preserves images and selected rich blocks", async () => {
    const raw = await harness.exec(`return await tools.mcp__fixture__image({});`);
    assert.equal(raw.content[0]!.type, "image");
    const selected = await harness.exec(`
      const result = await tools.mcp__fixture__image({});
      text("selected");
      image(result.content[0], "original");
    `);
    assert.equal(selected.content[0]!.type, "text");
    assert.equal(selected.content[1]!.type, "image");
    assert.deepEqual(selected.content[1]!._meta, { "codex/imageDetail": "original" });
  });

  await t.test("forwards elicitation, sampling, and roots", async () => {
    const elicited = await harness.exec(`return await tools.mcp__fixture__elicit({ prompt: "Value?" });`);
    assert.deepEqual(elicited.structuredContent, { action: "accept", content: { value: "from-client" } });

    const sampled = await harness.exec(`return await tools.mcp__fixture__sample({});`);
    assert.equal((sampled.structuredContent as { model: string }).model, "fixture-model");

    const roots = await harness.exec(`return await tools.mcp__fixture__roots({});`);
    assert.deepEqual((roots.structuredContent as { roots: unknown[] }).roots, [{ uri: "file:///fixture", name: "fixture" }]);
  });

  await t.test("returns cancel instead of fabricating an elicitation decision when interaction is unavailable", async () => {
    const headlessState = await mkdtemp(join(tmpdir(), "code-mode-headless-"));
    const headless = await createHarness(headlessState, false);
    try {
      const result = await headless.exec(`return await tools.mcp__fixture__elicit({ prompt: "Value?" });`);
      assert.deepEqual(result.structuredContent, { action: "cancel" });
    } finally {
      await headless.close();
      await rm(headlessState, { recursive: true, force: true });
    }
  });

  await t.test("refreshes discovery after tools/list_changed", async () => {
    await harness.exec(`return await tools.mcp__fixture__enable_dynamic({});`);
    await new Promise(resolve => setTimeout(resolve, 50));
    const result = await harness.exec(`return await tools.mcp__fixture__dynamic({});`);
    assert.equal(text(result), "dynamic result");
  });

  await t.test("reconnects on the next execution after an upstream process closes", async () => {
    const closed = await harness.exec(`return await tools.mcp__fixture__exit_after_response({});`);
    assert.equal(text(closed), "closing");
    await new Promise(resolve => setTimeout(resolve, 50));
    const reconnected = await harness.exec(`return await tools.mcp__fixture__calculate({ values: [21, 21] });`);
    assert.equal(text(reconnected), "42");
  });

  await t.test("keeps explicit session state in memory only", async () => {
    await harness.exec(`store("count", 41); return "stored";`, { sessionId: "alpha" });
    const same = await harness.exec(`return load("count") + 1;`, { sessionId: "alpha" });
    const other = await harness.exec(`return load("count");`, { sessionId: "beta" });
    assert.equal(text(same), "42");
    assert.equal(text(other), "undefined");
    assert.deepEqual(await (await import("node:fs/promises")).readdir(stateDir), []);
  });

  await t.test("has equivalent host filesystem authority", async () => {
    const path = join(stateDir, "authority-proof.txt");
    const result = await harness.exec(`
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(path)}, "host authority");
      return fs.readFileSync(${JSON.stringify(path)}, "utf8");
    `);
    assert.equal(text(result), "host authority");
    assert.equal(await readFile(path, "utf8"), "host authority");
  });

  await t.test("interrupts synchronous infinite loops and remains usable", async () => {
    const timedOut = await harness.exec(`while (true) {}`, { timeoutMs: 30 });
    assert.equal(timedOut.isError, true);
    assert.match(text(timedOut), /timed out|exceeded/i);
    const recovery = await harness.exec(`return 6 * 7;`);
    assert.equal(text(recovery), "42");
  });

  await t.test("propagates cancellation to a nested call and recovers", async () => {
    const controller = new AbortController();
    const pending = harness.exec(`return await tools.mcp__fixture__hang({});`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 40);
    await assert.rejects(pending, /abort/i);
    const recovery = await harness.exec(`return await tools.mcp__fixture__calculate({ values: [20, 22] });`);
    assert.equal(text(recovery), "42");
  });
});

async function createHarness(stateDir: string, interactive = true): Promise<Harness> {
  const config: LoadedCodeModeConfig = {
    baseDir: process.cwd(),
    settings: {
      executionTimeoutMs: 2000,
      requestTimeoutMs: 2000,
      maxOutputChars: 50 * 1024,
      maxConsoleChars: 10 * 1024,
      oauthCallbackTimeoutMs: 2000,
      stateDir,
    },
    mcpServers: {
      fixture: {
        command: process.execPath,
        args: [fixturePath],
        requestTimeoutMs: 2000,
      },
    },
  };
  const handle = createCodeModeServer(config);
  const client = new Client(
    { name: "code-mode-test-client", version: "1.0.0" },
    interactive
      ? {
          capabilities: {
            elicitation: { form: {} },
            sampling: {},
            roots: { listChanged: false },
          },
        }
      : undefined,
  );
  if (interactive) {
    client.setRequestHandler(ElicitRequestSchema, async request => {
      assert.equal(request.params.mode ?? "form", "form");
      return { action: "accept", content: { value: "from-client" } };
    });
    client.setRequestHandler(CreateMessageRequestSchema, async () => ({
      model: "fixture-model",
      role: "assistant",
      content: { type: "text", text: "fixture" },
    }));
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: "file:///fixture", name: "fixture" }],
    }));
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    handle.server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    async exec(code, options = {}) {
      return await client.callTool({
        name: "exec",
        arguments: {
          code,
          ...(options.sessionId ? { session_id: options.sessionId } : {}),
          ...(options.timeoutMs ? { timeout_ms: options.timeoutMs } : {}),
        },
      }, undefined, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onprogress ? { onprogress: options.onprogress } : {}),
        timeout: 3000,
        maxTotalTimeout: 3000,
      }) as CallToolResult;
    },
    async close() {
      await client.close().catch(() => {});
      await handle.close();
    },
  };
}

function text(result: CallToolResult): string {
  return result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
}
