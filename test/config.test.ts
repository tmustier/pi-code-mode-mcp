import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfigCandidates, defaultStateDirectory, loadConfig, validateConfig } from "../src/config.ts";

test("validates and resolves a standard MCP JSON config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-mode-config-"));
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

test("prefers agent-agnostic config names and retains Pi-named fallbacks", () => {
  const originalNew = process.env.CODE_MODE_MCP_CONFIG;
  const originalLegacy = process.env.PI_CODE_MODE_MCP_CONFIG;
  try {
    delete process.env.CODE_MODE_MCP_CONFIG;
    delete process.env.PI_CODE_MODE_MCP_CONFIG;
    const defaults = defaultConfigCandidates("/tmp/code-mode-cwd");
    assert.deepEqual(defaults, [
      "/tmp/code-mode-cwd/.code-mode-mcp.json",
      join(homedir(), ".config", "code-mode-mcp", "mcp.json"),
      join(homedir(), ".config", "pi-code-mode-mcp", "mcp.json"),
    ]);

    const testHome = "/home/code-mode-test";
    const genericRoot = join(testHome, ".config", "code-mode-mcp");
    const legacyRoot = join(testHome, ".config", "pi-code-mode-mcp");

    process.env.PI_CODE_MODE_MCP_CONFIG = "/legacy/config.json";
    assert.equal(defaultConfigCandidates()[0], "/legacy/config.json");
    assert.equal(
      defaultStateDirectory("/legacy/config.json", testHome, path => path === legacyRoot),
      legacyRoot,
    );

    process.env.CODE_MODE_MCP_CONFIG = "/generic/config.json";
    assert.equal(defaultConfigCandidates()[0], "/generic/config.json");
    assert.equal(defaultStateDirectory("/generic/config.json", testHome, () => false), genericRoot);
    assert.equal(defaultStateDirectory(join(legacyRoot, "mcp.json"), testHome, () => false), legacyRoot);

    delete process.env.CODE_MODE_MCP_CONFIG;
    delete process.env.PI_CODE_MODE_MCP_CONFIG;
    const onlyLegacyOAuth = (path: string) => path === join(legacyRoot, "oauth");
    assert.equal(defaultStateDirectory("/project/.code-mode-mcp.json", testHome, onlyLegacyOAuth), legacyRoot);
    const bothOAuthRoots = (path: string) => path === join(genericRoot, "oauth") || path === join(legacyRoot, "oauth");
    assert.equal(defaultStateDirectory("/project/.code-mode-mcp.json", testHome, bothOAuthRoots), genericRoot);
  } finally {
    if (originalNew === undefined) delete process.env.CODE_MODE_MCP_CONFIG;
    else process.env.CODE_MODE_MCP_CONFIG = originalNew;
    if (originalLegacy === undefined) delete process.env.PI_CODE_MODE_MCP_CONFIG;
    else process.env.PI_CODE_MODE_MCP_CONFIG = originalLegacy;
  }
});

test("rejects ambiguous transports, unknown fields, and invalid bearer config", () => {
  assert.throws(() => validateConfig({ mcpServers: { bad: { command: "x", url: "https://x" } } }), /exactly one/);
  assert.throws(() => validateConfig({ mcpServers: {}, surprise: true }), /unknown field surprise/);
  assert.throws(() => validateConfig({ mcpServers: { bad: { url: "https://x", auth: "bearer" } } }), /requires bearerToken/);
});
