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
