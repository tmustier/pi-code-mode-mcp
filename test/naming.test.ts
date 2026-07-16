import assert from "node:assert/strict";
import test from "node:test";
import { canonicalToolName, sanitizeToolNameComponent } from "../src/naming.ts";

const tuples: Array<[string, string]> = [
  ["linear", "create_issue"],
  ["a-b", "same"],
  ["a.b", "same"],
  ["a__b", "c"],
  ["a", "b__c"],
  ["unicode-ツ", "créer"],
  ["long-server-".repeat(8), "long-tool-".repeat(8)],
];

test("uses one readable provider-safe name for unambiguous tuples", () => {
  assert.equal(canonicalToolName("linear", "create_issue"), "mcp__linear__create_issue");
  assert.equal(canonicalToolName("small_eval", "lookup_metric"), "mcp__small_eval__lookup_metric");
});

test("hashes every lossy, structurally ambiguous, or over-length tuple", () => {
  const names = tuples.map(([server, tool]) => canonicalToolName(server, tool));
  assert.equal(new Set(names).size, names.length);
  for (const name of names.slice(1)) {
    assert.match(name, /__[0-9a-f]{16}$/);
    assert.match(name, /^[A-Za-z0-9_]+$/);
    assert.ok(name.length <= 64);
  }
  assert.notEqual(canonicalToolName("a-b", "same"), canonicalToolName("a.b", "same"));
  assert.notEqual(canonicalToolName("a__b", "c"), canonicalToolName("a", "b__c"));
});

test("is pure and subset-independent", () => {
  for (const [server, tool] of tuples) {
    const expected = canonicalToolName(server, tool);
    assert.equal(canonicalToolName(server, tool), expected);
    assert.equal(canonicalToolName(server, tool), expected);
  }
});

test("uses the raw tuple, not its sanitized projection, for the hash", () => {
  assert.equal(sanitizeToolNameComponent("a-b"), sanitizeToolNameComponent("a.b"));
  assert.notEqual(canonicalToolName("a-b", "tool"), canonicalToolName("a.b", "tool"));
});

test("enforces a usable name budget", () => {
  const name = canonicalToolName("linear", "create_issue", 32);
  assert.equal(name, "mcp__linear__create_issue");
  assert.throws(() => canonicalToolName("linear", "create_issue", 23), /at least 24/);
  const long = canonicalToolName("server", "x".repeat(100), 32);
  assert.equal(long.length, 32);
  assert.match(long, /__[0-9a-f]{16}$/);
});
