import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCodeModeServer } from "../src/mcp-server.ts";
import { PACKAGE_NAME, VERSION } from "../src/version.ts";
import type { LoadedCodeModeConfig } from "../src/types.ts";

test("published identity is agent-agnostic and version-consistent", async () => {
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const manifest = JSON.parse(raw) as {
    name: string;
    version: string;
    bin: Record<string, string>;
    repository: { url: string };
  };
  assert.equal(manifest.name, PACKAGE_NAME);
  assert.equal(manifest.version, VERSION);
  assert.deepEqual(manifest.bin, { "code-mode-mcp": "dist/cli.js" });
  assert.match(manifest.repository.url, /tmustier\/code-mode-mcp/);
  for (const key of ["keywords", "repository", "bugs", "homepage", "publishConfig"]) {
    assert.equal([...raw.matchAll(new RegExp(`"${key}"\\s*:`, "g"))].length, 1, `${key} must occur once`);
  }

  const version = spawnSync(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), VERSION);
});

test("MCP initialize reports the generic package identity", async () => {
  const config: LoadedCodeModeConfig = {
    baseDir: process.cwd(),
    settings: {
      executionTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      maxOutputChars: 1024,
      maxConsoleChars: 1024,
      oauthCallbackTimeoutMs: 1000,
      stateDir: "/tmp/code-mode-mcp-identity-unused",
    },
    mcpServers: {},
  };
  const handle = createCodeModeServer(config);
  const client = new Client({ name: "identity-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    assert.deepEqual(client.getServerVersion(), { name: PACKAGE_NAME, version: VERSION });
  } finally {
    await client.close();
    await handle.close();
  }
});
