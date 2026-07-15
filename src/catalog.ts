import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  CatalogSearchOptions,
  CatalogSearchResult,
  CatalogTool,
  PublicCatalogTool,
} from "./types.ts";

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const SEARCH_STOP_WORDS = new Set(["a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with"]);

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

export function searchCatalog(
  catalog: CatalogTool[],
  query: string,
  options: CatalogSearchOptions = {},
): CatalogSearchResult[] {
  if (typeof query !== "string" || !query.trim()) throw new Error("search query must be a non-empty string");
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("search options must be an object");
  for (const key of Object.keys(options)) {
    if (key !== "server" && key !== "limit") throw new Error(`search received unknown option ${key}`);
  }
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new Error(`search options.limit must be an integer from 1 to ${MAX_SEARCH_LIMIT}`);
  }
  if (options.server !== undefined && (typeof options.server !== "string" || !options.server)) {
    throw new Error("search options.server must be a non-empty string");
  }

  const queryTokens = [...new Set(tokenizeSearchText(query).filter(token => !SEARCH_STOP_WORDS.has(token)))];
  if (queryTokens.length === 0) throw new Error("search query must contain searchable letters or numbers");
  return catalog
    .filter(tool => options.server === undefined || tool.server === options.server)
    .map(tool => ({ tool, match: scoreCatalogTool(tool, queryTokens) }))
    .filter((entry): entry is { tool: CatalogTool; match: { score: number; coverage: number } } => entry.match !== undefined)
    .sort((left, right) => right.match.score - left.match.score || left.tool.name.localeCompare(right.tool.name))
    .slice(0, limit)
    .map(({ tool, match }) => ({
      name: tool.name,
      server: tool.server,
      tool: tool.tool,
      ...(tool.title ? { title: tool.title } : {}),
      description: tool.description,
      score: match.score,
    }));
}

function scoreCatalogTool(
  tool: CatalogTool,
  queryTokens: string[],
): { score: number; coverage: number } | undefined {
  const fields = [
    prepareSearchField(`${tool.server}.${tool.tool}`, 12),
    prepareSearchField(tool.tool, 10),
    prepareSearchField(tool.name, 8),
    prepareSearchField(tool.server, 6),
    prepareSearchField(tool.title ?? "", 5),
    prepareSearchField(tool.description, 3),
  ];
  let score = 0;
  let matchedTokens = 0;
  const primaryQueryToken = queryTokens[0]!;
  const toolTokens = tokenizeSearchText(tool.tool);
  if (toolTokens.includes(primaryQueryToken)) score += 60;
  else if (toolTokens.some(token => token.startsWith(primaryQueryToken) ||
    (token.length >= 4 && primaryQueryToken.startsWith(token)))) score += 30;

  const queryPhrase = queryTokens.join(" ");
  for (const field of fields) {
    if (!field.text) continue;
    const fieldPhrase = field.tokens.join(" ");
    if (fieldPhrase === queryPhrase) score += field.weight * 20;
    else if (` ${fieldPhrase} `.includes(` ${queryPhrase} `)) score += field.weight * 8;
  }

  for (const queryToken of queryTokens) {
    let bestTokenScore = 0;
    for (const field of fields) {
      for (const fieldToken of field.tokens) {
        const relevance = fieldToken === queryToken
          ? 5
          : fieldToken.startsWith(queryToken)
            ? 3
            : fieldToken.length >= 4 && queryToken.startsWith(fieldToken)
              ? 2
              : 0;
        bestTokenScore = Math.max(bestTokenScore, relevance * field.weight);
      }
    }
    if (bestTokenScore > 0) {
      matchedTokens += 1;
      score += bestTokenScore;
    }
  }

  if (matchedTokens === 0) return undefined;
  const coverage = matchedTokens / queryTokens.length;
  if (matchedTokens < queryTokens.length) return undefined;
  score += Math.round(coverage * 20);
  return { score, coverage };
}

function prepareSearchField(value: string, weight: number): { text: string; tokens: string[]; weight: number } {
  return { text: normalizeSearchText(value), tokens: tokenizeSearchText(value), weight };
}

function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .toLowerCase()
    .trim();
}

function tokenizeSearchText(value: string): string[] {
  return normalizeSearchText(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(token => token.length > 3 && token.endsWith("s") && !/(ss|us|is)$/.test(token)
      ? token.slice(0, -1)
      : token);
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
