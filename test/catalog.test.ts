import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalog, describeTool, normalizeIdentifier, searchCatalog } from "../src/catalog.ts";

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

test("searchCatalog ranks compact tool metadata with bounded filters", () => {
  const catalog = buildCatalog([
    {
      server: "computer-use",
      tools: [
        { name: "get_app_state", description: "Inspect an application window and return its screenshot and accessibility tree", inputSchema: schema },
        { name: "list_apps", description: "List available applications", inputSchema: schema },
        { name: "scroll", description: "Scroll an application window", inputSchema: schema },
        { name: "click", description: "Click an element in an application", inputSchema: schema },
        { name: "target_window", description: "Choose a target window", inputSchema: schema },
        { name: "set_timer", description: "Set a timer", inputSchema: schema },
        { name: "delete_user", description: "Delete a user", inputSchema: schema },
      ],
    },
    {
      server: "browser",
      tools: [{ name: "takeScreenshot", description: "Capture the current web page", inputSchema: schema }],
    },
  ]);

  const matches = searchCatalog(catalog, "inspect app screenshot");
  assert.equal(matches[0]!.name, "mcp__computer_use__get_app_state");
  assert.ok(matches[0]!.score > 0);
  assert.equal("inputSchema" in matches[0]!, false);

  assert.deepEqual(
    searchCatalog(catalog, "capture screenshot", { server: "browser", limit: 1 }).map(tool => tool.tool),
    ["takeScreenshot"],
  );
  assert.equal(searchCatalog(catalog, "scroll app window")[0]!.tool, "scroll");
  assert.equal(searchCatalog(catalog, "list available applications")[0]!.tool, "list_apps");
  assert.equal(searchCatalog(catalog, "get").some(tool => tool.tool === "target_window"), false);
  assert.deepEqual(searchCatalog(catalog, "settings"), []);
  assert.deepEqual(searchCatalog(catalog, "delete production user"), []);
  assert.equal(searchCatalog(catalog, "click on an element")[0]!.tool, "click");
  assert.throws(() => searchCatalog(catalog, "screenshot", { limit: 51 }), /integer from 1 to 50/);
  assert.throws(() => searchCatalog(catalog, "---"), /letters or numbers/);
  assert.throws(() => searchCatalog(catalog, "screenshot", { unexpected: true } as never), /unknown option unexpected/);
});
