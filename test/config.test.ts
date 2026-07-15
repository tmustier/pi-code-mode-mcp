import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, validateConfig } from "../src/config.ts";

test("validates and resolves a standard MCP JSON config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-code-mode-config-"));
  const path = join(directory, "mcp.json");
  process.env.CODE_MODE_TEST_TOKEN = "secret-value";
  await writeFile(path, JSON.stringify({
    settings: { executionTimeoutMs: 3210, stateDir: "./state" },
    mcpServers: {
      local: { command: "node", args: ["server.js"], cwd: "./fixture" },
      remote: { url: "https://example.test/mcp", auth: "bearer", bearerToken: "${CODE_MODE_TEST_TOKEN}" },
    },
  }));
  try {
    const config = loadConfig(path);
    assert.equal(config.settings.executionTimeoutMs, 3210);
    assert.equal(config.settings.stateDir, join(directory, "state"));
    assert.equal(config.mcpServers.local!.cwd, join(directory, "fixture"));
    assert.equal(config.mcpServers.remote!.bearerToken, "secret-value");
  } finally {
    delete process.env.CODE_MODE_TEST_TOKEN;
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects ambiguous transports, unknown fields, and invalid bearer config", () => {
  assert.throws(() => validateConfig({ mcpServers: { bad: { command: "x", url: "https://x" } } }), /exactly one/);
  assert.throws(() => validateConfig({ mcpServers: {}, surprise: true }), /unknown field surprise/);
  assert.throws(() => validateConfig({ mcpServers: { bad: { url: "https://x", auth: "bearer" } } }), /requires bearerToken/);
});
