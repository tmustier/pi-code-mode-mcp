import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createCodeModeServer } from "../src/mcp-server.ts";
import type { LoadedCodeModeConfig } from "../src/types.ts";

const oauthServerPath = fileURLToPath(new URL(
  "../node_modules/@modelcontextprotocol/sdk/dist/esm/examples/server/simpleStreamableHttp.js",
  import.meta.url,
));

test("authorization-code OAuth crosses the outer elicitation boundary and persists only credentials", async () => {
  const [mcpPort, authPort] = await Promise.all([freePort(), freePort()]);
  const stateDir = await mkdtemp(join(tmpdir(), "pi-code-mode-oauth-"));
  const child = spawn(process.execPath, [oauthServerPath, "--oauth"], {
    env: { ...process.env, MCP_PORT: String(mcpPort), MCP_AUTH_PORT: String(authPort) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", chunk => { stderr += String(chunk); });

  try {
    await waitForHttp(`http://127.0.0.1:${mcpPort}/.well-known/oauth-protected-resource/mcp`, child, () => stderr);
    const config: LoadedCodeModeConfig = {
      baseDir: process.cwd(),
      settings: {
        executionTimeoutMs: 10_000,
        requestTimeoutMs: 10_000,
        maxOutputChars: 50 * 1024,
        maxConsoleChars: 10 * 1024,
        oauthCallbackTimeoutMs: 10_000,
        stateDir,
      },
      mcpServers: {
        oauth: {
          url: `http://localhost:${mcpPort}/mcp`,
          transport: "streamable-http",
          auth: "oauth",
          oauth: { scope: "mcp:tools" },
          requestTimeoutMs: 10_000,
        },
      },
    };
    const handle = createCodeModeServer(config);
    const client = new Client(
      { name: "oauth-outer-client", version: "1.0.0" },
      { capabilities: { elicitation: { url: {} } } },
    );
    let authorizationRequests = 0;
    client.setRequestHandler(ElicitRequestSchema, async request => {
      assert.equal(request.params.mode, "url");
      authorizationRequests += 1;
      const response = await fetch(request.params.url, { redirect: "follow" });
      assert.equal(response.ok, true);
      return { action: "accept" };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.callTool({
        name: "exec",
        arguments: { code: `return await tools.mcp__oauth__greet({ name: "Coral" });` },
      }, undefined, { timeout: 15_000, maxTotalTimeout: 15_000 }) as CallToolResult;
      assert.equal(text(result), "Hello, Coral!");
      assert.equal(authorizationRequests, 1);

      const oauthFiles = await readdir(join(stateDir, "oauth"));
      assert.equal(oauthFiles.length, 1);
      assert.equal((await stat(join(stateDir, "oauth", oauthFiles[0]!))).mode & 0o777, 0o600);
      assert.deepEqual((await readdir(stateDir)).sort(), ["oauth"]);

      const second = await client.callTool({
        name: "exec",
        arguments: { code: `return await tools.mcp__oauth__greet({ name: "Again" });` },
      }) as CallToolResult;
      assert.equal(text(second), "Hello, Again!");
      assert.equal(authorizationRequests, 1);
    } finally {
      await client.close().catch(() => {});
      await handle.close();
    }
  } finally {
    await terminate(child);
    await rm(stateDir, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to reserve a port");
  const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function waitForHttp(url: string, child: ChildProcess, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`OAuth fixture exited ${child.exitCode}: ${stderr()}`);
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`OAuth fixture did not become ready: ${stderr()}`);
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>(resolve => child.once("exit", () => resolve())),
    new Promise<void>(resolve => setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000)),
  ]);
}

function text(result: CallToolResult): string {
  return result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
}
