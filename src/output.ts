import { inspect } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ContentBlock = CallToolResult["content"][number];

const MAX_COMPACT_CATALOG_ITEMS = 30;
const MAX_DETAILED_CATALOG_ITEMS = 5;

export interface OutputCollector {
  content: ContentBlock[];
  text(value: unknown): void;
  image(value: unknown, detail?: "auto" | "low" | "high" | "original" | null): void;
  emit(value: unknown): void;
}

export function createOutputCollector(): OutputCollector {
  const content: ContentBlock[] = [];
  return {
    content,
    text(value) {
      content.push({ type: "text", text: stringifyValue(value) });
    },
    image(value, detail) {
      content.push(parseImage(value, detail));
    },
    emit(value) {
      if (!isContentBlock(value)) throw new Error("emit expects one MCP content block");
      content.push(value);
    },
  };
}

export function buildToolResult(
  returned: unknown,
  emitted: ContentBlock[],
  logs: string[],
  maxOutputChars: number,
  maxConsoleChars: number,
): CallToolResult {
  const logText = truncate(logs.join("\n"), maxConsoleChars);
  if (isCallToolResult(returned)) {
    const content = [...emitted];
    if (logText) content.push({ type: "text", text: `Console:\n${logText}` });
    content.push(...returned.content);
    return {
      ...returned,
      content: guardTextBlocks(content, maxOutputChars),
    };
  }

  const content = [...emitted];
  if (logText) content.push({ type: "text", text: `Console:\n${logText}` });
  const prepared = returned === undefined ? undefined : elideCatalogCollections(returned);
  const returnedBudget = Math.max(0, maxOutputChars - textCharacterCount(content));
  if (prepared !== undefined && returnedBudget > 0) {
    content.push({ type: "text", text: stringifyValueWithinLimit(prepared, returnedBudget) });
  }
  if (content.length === 0) content.push({ type: "text", text: "undefined" });

  const guarded = guardTextBlocks(content, maxOutputChars);
  const structured = toStructuredContent(prepared, maxOutputChars);
  return {
    content: guarded,
    ...(structured ? { structuredContent: structured } : {}),
  };
}

export function buildErrorResult(error: unknown): CallToolResult {
  const normalized = normalizeError(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: normalized }, null, 2) }],
    structuredContent: { error: normalized },
  };
}

function textCharacterCount(content: ContentBlock[]): number {
  return content.reduce((total, block) => total + (block.type === "text" ? block.text.length : 0), 0);
}

function guardTextBlocks(content: ContentBlock[], maxChars: number): ContentBlock[] {
  let remaining = maxChars;
  return content.map(block => {
    if (block.type !== "text") return block;
    if (remaining <= 0) return { ...block, text: "[text output omitted: execution output limit reached]" };
    if (block.text.length <= remaining) {
      remaining -= block.text.length;
      return block;
    }
    const text = truncate(block.text, remaining);
    remaining = 0;
    return { ...block, text };
  });
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = `\n[truncated ${value.length - maxChars} characters]`;
  if (marker.length >= maxChars) return marker.slice(0, maxChars);
  return `${value.slice(0, maxChars - marker.length)}${marker}`;
}

function stringifyValueWithinLimit(value: unknown, maxChars: number): string {
  const serialized = stringifyValue(value);
  if (serialized.length <= maxChars) return serialized;

  const envelope = (preview: string) => JSON.stringify({
    truncated: true,
    originalCharacters: serialized.length,
    preview,
    hint: "Filter or aggregate in code and return a smaller value.",
  }, null, 2);
  if (envelope("").length > maxChars) {
    return "[output omitted: configured execution limit]".slice(0, maxChars);
  }

  let low = 0;
  let high = serialized.length;
  let best = envelope("");
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = envelope(serialized.slice(0, middle));
    if (candidate.length <= maxChars) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function elideCatalogCollections(value: unknown, preparedByObject = new WeakMap<object, unknown>()): unknown {
  if (!value || typeof value !== "object") return value;
  if (preparedByObject.has(value)) return preparedByObject.get(value);

  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isCatalogEntry)) {
      const detailed = value.some(item => "inputSchema" in item);
      const limit = detailed ? MAX_DETAILED_CATALOG_ITEMS : MAX_COMPACT_CATALOG_ITEMS;
      if (value.length > limit) {
        const elided = {
          items: value.slice(0, limit),
          total: value.length,
          omitted: value.length - limit,
          truncated: true,
          hint: detailed
            ? "Describe fewer tools at once, then return only the relevant schemas."
            : "Filter with search(), a server name, or Array.prototype.filter(), then return a smaller selection.",
        };
        preparedByObject.set(value, elided);
        return elided;
      }
    }
    const prepared: unknown[] = [];
    preparedByObject.set(value, prepared);
    prepared.push(...value.map(item => elideCatalogCollections(item, preparedByObject)));
    if (prepared.every((item, index) => item === value[index])) {
      preparedByObject.set(value, value);
      return value;
    }
    return prepared;
  }

  if (Object.prototype.toString.call(value) !== "[object Object]") {
    preparedByObject.set(value, value);
    return value;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const prepared: Record<string, unknown> = {};
  preparedByObject.set(value, prepared);
  for (const [key, item] of entries) prepared[key] = elideCatalogCollections(item, preparedByObject);
  if (entries.every(([key, item]) => prepared[key] === item)) {
    preparedByObject.set(value, value);
    return value;
  }
  return prepared;
}

function isCatalogEntry(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.name === "string"
    && typeof entry.server === "string"
    && typeof entry.tool === "string"
    && typeof entry.description === "string";
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return `${item.toString()}n`;
      if (typeof item === "function") return `[Function ${item.name || "anonymous"}]`;
      if (typeof item === "symbol") return item.toString();
      if (item instanceof Error) return normalizeError(item);
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
      }
      return item;
    }, 2);
    return serialized ?? String(value);
  } catch {
    return inspect(value, { depth: 5, breakLength: 100, maxArrayLength: 100 });
  }
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return Boolean(
    value
      && typeof value === "object"
      && Array.isArray((value as { content?: unknown }).content)
      && (value as { content: unknown[] }).content.every(isContentBlock),
  );
}

function isContentBlock(value: unknown): value is ContentBlock {
  if (!value || typeof value !== "object") return false;
  const block = value as Record<string, unknown>;
  if (block.type === "text") return typeof block.text === "string";
  if (block.type === "image" || block.type === "audio") return typeof block.data === "string" && typeof block.mimeType === "string";
  if (block.type === "resource") return Boolean(block.resource && typeof block.resource === "object");
  if (block.type === "resource_link") return typeof block.uri === "string" && typeof block.name === "string";
  return false;
}

function parseImage(
  value: unknown,
  detail?: "auto" | "low" | "high" | "original" | null,
): Extract<ContentBlock, { type: "image" }> {
  if (typeof value === "string") {
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
    if (!match) throw new Error("image string must be a base64 data: URL");
    return {
      type: "image",
      mimeType: match[1]!,
      data: match[2]!,
      ...(detail ? { _meta: { "codex/imageDetail": detail } } : {}),
    };
  }
  if (!isContentBlock(value) || value.type !== "image") throw new Error("image expects a data URL or MCP image content block");
  if (!detail) return value;
  return { ...value, _meta: { ...(value._meta ?? {}), "codex/imageDetail": detail } };
}

function toStructuredContent(value: unknown, maxChars: number): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || isCallToolResult(value)) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > maxChars) return undefined;
    return JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function normalizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      retryable: error.name === "AbortError" || /timeout|closed|connect/i.test(error.message),
      hint: error.name === "AbortError"
        ? "Retry if the cancellation was not intentional."
        : "Inspect the message, find the tool with search(), inspect its schema with describe(), then retry with corrected code or arguments.",
    };
  }
  return {
    name: "Error",
    message: String(error),
    retryable: false,
    hint: "Inspect the value returned by the failed operation.",
  };
}
