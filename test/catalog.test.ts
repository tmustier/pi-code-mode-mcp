import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalog, describeTool, normalizeIdentifier } from "../src/catalog.ts";

const schema = { type: "object" as const, properties: {} };

test("normalizes MCP identities and resolves deterministic collisions", () => {
  assert.equal(normalizeIdentifier("mcp__a-b__3.tool"), "mcp__a_b__3_tool");
  const catalog = buildCatalog([
    { server: "a-b", tools: [{ name: "same", description: "first", inputSchema: schema }] },
    { server: "a_b", tools: [{ name: "same", description: "second", inputSchema: schema }] },
  ]);
  assert.equal(catalog.length, 2);
  assert.notEqual(catalog[0]!.name, catalog[1]!.name);
  assert.match(catalog[1]!.name, /__[0-9a-f]{8}$/);
  assert.equal(describeTool(catalog, "a-b.same").description, "first");
});

test("describeTool provides close normalized matches", () => {
  const catalog = buildCatalog([{ server: "demo", tools: [{ name: "take_screenshot", description: "Capture a screenshot", inputSchema: schema }] }]);
  assert.throws(() => describeTool(catalog, "screenshot"), /Close matches: mcp__demo__take_screenshot/);
});
