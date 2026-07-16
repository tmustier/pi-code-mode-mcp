import { createHash } from "node:crypto";

export const CANONICAL_TOOL_NAME_LIMIT = 64;
const HASH_HEX_LENGTH = 16;
const HASH_SEPARATOR = "__";
const SAFE_COMPONENT = /^[A-Za-z0-9_]+$/;

/**
 * Return one provider-safe callable name for an MCP capability.
 *
 * The readable form is reserved for tuples whose components are already safe
 * and unambiguous. Every lossy normalization, ambiguous separator, or length
 * overflow takes the hash path, making the result a pure function of the raw
 * (server, tool) tuple rather than of the surrounding catalog.
 */
export function canonicalToolName(
  server: string,
  tool: string,
  limit = CANONICAL_TOOL_NAME_LIMIT,
): string {
  if (!Number.isSafeInteger(limit) || limit < 24) {
    throw new Error("canonical tool-name limit must be an integer of at least 24");
  }

  const safeServer = sanitizeToolNameComponent(server);
  const safeTool = sanitizeToolNameComponent(tool);
  const readable = `mcp__${safeServer}__${safeTool}`;
  const isUnambiguous = isSafeUnambiguousComponent(server)
    && isSafeUnambiguousComponent(tool);

  if (isUnambiguous && readable.length <= limit) return readable;

  const hash = createHash("sha256")
    .update(server)
    .update("\0")
    .update(tool)
    .digest("hex")
    .slice(0, HASH_HEX_LENGTH);
  const prefixLimit = limit - HASH_SEPARATOR.length - hash.length;
  const prefix = readable.slice(0, prefixLimit);
  return `${prefix}${HASH_SEPARATOR}${hash}`;
}

export function sanitizeToolNameComponent(value: string): string {
  const sanitized = [...value]
    .map(character => /[A-Za-z0-9_]/.test(character) ? character : "_")
    .join("");
  return sanitized || "_";
}

function isSafeUnambiguousComponent(value: string): boolean {
  return SAFE_COMPONENT.test(value) && !value.includes("__");
}
