import assert from "node:assert/strict";
import test from "node:test";
import { buildToolResult, createOutputCollector } from "../src/output.ts";

test("guards returned text without spilling to disk or retaining oversized structured output", () => {
  const result = buildToolResult({ value: "x".repeat(1000) }, [], [], 100, 100);
  const text = result.content[0];
  assert.equal(text?.type, "text");
  if (text?.type === "text") assert.ok(text.text.length <= 100);
  assert.equal(result.structuredContent, undefined);
});

test("keeps oversized returned JSON valid with an explicit truncation envelope", () => {
  const result = buildToolResult({ value: "x".repeat(5000) }, [], [], 500, 100);
  const block = result.content[0];
  assert.equal(block?.type, "text");
  if (block?.type !== "text") return;
  assert.ok(block.text.length <= 500);
  const parsed = JSON.parse(block.text) as { truncated: boolean; originalCharacters: number; preview: string };
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.originalCharacters > 500);
  assert.ok(parsed.preview.length > 0);
  assert.equal(result.structuredContent, undefined);
});

test("structurally elides compact and detailed catalog arrays before they reach context", () => {
  const compact = Array.from({ length: 40 }, (_, index) => ({
    name: `mcp__teams__tool_${index}`,
    server: "teams",
    tool: `tool_${index}`,
    description: `Tool ${index}`,
  }));
  const compactResult = buildToolResult({ catalog: compact }, [], [], 50 * 1024, 100);
  const compactStructured = compactResult.structuredContent as {
    catalog: { items: unknown[]; total: number; omitted: number; truncated: boolean };
  };
  assert.equal(compactStructured.catalog.items.length, 30);
  assert.equal(compactStructured.catalog.total, 40);
  assert.equal(compactStructured.catalog.omitted, 10);
  assert.equal(compactStructured.catalog.truncated, true);

  const detailed = compact.slice(0, 8).map(item => ({
    ...item,
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
  }));
  const detailedResult = buildToolResult(detailed, [], [], 50 * 1024, 100);
  const detailedBlock = detailedResult.content[0];
  assert.equal(detailedBlock?.type, "text");
  if (detailedBlock?.type !== "text") return;
  const detailedParsed = JSON.parse(detailedBlock.text) as { items: unknown[]; total: number; omitted: number };
  assert.equal(detailedParsed.items.length, 5);
  assert.equal(detailedParsed.total, 8);
  assert.equal(detailedParsed.omitted, 3);
});

test("image helper accepts data URLs and preserves requested detail", () => {
  const collector = createOutputCollector();
  collector.image("data:image/png;base64,AAAA", "original");
  assert.deepEqual(collector.content, [{
    type: "image",
    mimeType: "image/png",
    data: "AAAA",
    _meta: { "codex/imageDetail": "original" },
  }]);
});
