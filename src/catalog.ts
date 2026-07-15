import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CatalogTool, PublicCatalogTool } from "./types.ts";

export function normalizeIdentifier(value: string): string {
  let result = "";
  for (const [index, character] of [...value].entries()) {
    const valid = index === 0
      ? character === "_" || character === "$" || /[A-Za-z]/.test(character)
      : character === "_" || character === "$" || /[A-Za-z0-9]/.test(character);
    result += valid ? character : "_";
  }
  return result || "_";
}

export function buildCatalog(entries: Array<{ server: string; tools: Tool[] }>): CatalogTool[] {
  const sorted = entries
    .flatMap(entry => entry.tools.map(tool => ({ server: entry.server, tool })))
    .sort((left, right) => `${left.server}\0${left.tool.name}`.localeCompare(`${right.server}\0${right.tool.name}`));
  const used = new Map<string, string>();
  const catalog: CatalogTool[] = [];

  for (const entry of sorted) {
    const rawIdentity = `${entry.server}\0${entry.tool.name}`;
    const baseName = normalizeIdentifier(`mcp__${entry.server}__${entry.tool.name}`);
    const previous = used.get(baseName);
    const name = previous === undefined || previous === rawIdentity
      ? baseName
      : `${baseName}__${createHash("sha256").update(rawIdentity).digest("hex").slice(0, 8)}`;
    used.set(name, rawIdentity);
    catalog.push({
      name,
      server: entry.server,
      tool: entry.tool.name,
      ...(entry.tool.title ? { title: entry.tool.title } : {}),
      description: entry.tool.description ?? "",
      inputSchema: entry.tool.inputSchema,
      ...(entry.tool.outputSchema ? { outputSchema: entry.tool.outputSchema } : {}),
      ...(entry.tool.annotations ? { annotations: entry.tool.annotations } : {}),
      ...(entry.tool._meta ? { _meta: entry.tool._meta } : {}),
    });
  }
  return catalog;
}

export function publicCatalog(catalog: CatalogTool[]): PublicCatalogTool[] {
  return catalog.map(tool => ({
    name: tool.name,
    server: tool.server,
    tool: tool.tool,
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description,
  }));
}

export function describeTool(catalog: CatalogTool[], name: string): CatalogTool {
  const exact = catalog.find(tool => tool.name === name);
  if (exact) return exact;

  const rawMatches = catalog.filter(tool => tool.tool === name || `${tool.server}.${tool.tool}` === name);
  if (rawMatches.length === 1) return rawMatches[0]!;

  const query = name.toLowerCase();
  const close = catalog
    .filter(tool => `${tool.name} ${tool.server} ${tool.tool} ${tool.description}`.toLowerCase().includes(query))
    .slice(0, 8)
    .map(tool => tool.name);
  const suffix = close.length > 0 ? ` Close matches: ${close.join(", ")}.` : "";
  throw new Error(`Unknown or ambiguous tool ${JSON.stringify(name)}.${suffix}`);
}
