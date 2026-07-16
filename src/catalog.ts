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
const BM25_K1 = 1.5;
const BM25_B = 0.75;
const SEARCH_STOP_WORDS = new Set(["a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with"]);
const SEARCH_FIELD_WEIGHTS = {
  tool: 12,
  title: 6,
  server: 4,
  description: 2,
  inputProperties: 1,
} as const;

interface SearchField {
  tokens: string[];
  weight: number;
}

interface SearchDocument {
  tool: CatalogTool;
  fields: SearchField[];
}

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

export function createCatalogSearch(
  catalog: CatalogTool[],
): (query: string, options?: CatalogSearchOptions) => CatalogSearchResult[] {
  const documents = catalog.map(tool => createSearchDocument(tool));
  const serverNames = [...new Set(catalog.map(tool => tool.server))].sort();

  return (query: string, options: CatalogSearchOptions = {}): CatalogSearchResult[] => {
    const { queryTokens, limit, server } = validateSearchRequest(query, options, serverNames);
    const candidates = server === undefined
      ? documents
      : documents.filter(document => document.tool.server === server);
    return rankDocuments(candidates, queryTokens)
      .slice(0, limit)
      .map(({ tool, score }) => ({
        name: tool.name,
        server: tool.server,
        tool: tool.tool,
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        score,
      }));
  };
}

export function searchCatalog(
  catalog: CatalogTool[],
  query: string,
  options: CatalogSearchOptions = {},
): CatalogSearchResult[] {
  return createCatalogSearch(catalog)(query, options);
}

function validateSearchRequest(
  query: string,
  options: CatalogSearchOptions,
  serverNames: string[],
): { queryTokens: string[]; limit: number; server?: string } {
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
  const server = options.server === undefined ? undefined : resolveServerName(options.server, serverNames);
  return { queryTokens, limit, ...(server === undefined ? {} : { server }) };
}

function resolveServerName(requested: string, serverNames: string[]): string {
  if (serverNames.includes(requested)) return requested;
  const normalizedRequested = normalizeIdentifier(requested).toLowerCase();
  const matches = serverNames.filter(server => normalizeIdentifier(server).toLowerCase() === normalizedRequested);
  if (matches.length === 1) return matches[0]!;
  const valid = serverNames.length === 0 ? "none" : serverNames.join(", ");
  if (matches.length > 1) {
    throw new Error(`Ambiguous normalized server ${JSON.stringify(requested)}. Use an exact server name: ${matches.join(", ")}.`);
  }
  throw new Error(`Unknown or unavailable server ${JSON.stringify(requested)}. Valid searchable servers: ${valid}.`);
}

function createSearchDocument(tool: CatalogTool): SearchDocument {
  const inputProperties = getTopLevelInputPropertyNames(tool.inputSchema);
  return {
    tool,
    fields: [
      prepareSearchField(tool.tool, SEARCH_FIELD_WEIGHTS.tool),
      prepareSearchField(tool.title ?? "", SEARCH_FIELD_WEIGHTS.title),
      prepareSearchField(tool.server, SEARCH_FIELD_WEIGHTS.server),
      prepareSearchField(tool.description, SEARCH_FIELD_WEIGHTS.description),
      prepareSearchField(inputProperties.join(" "), SEARCH_FIELD_WEIGHTS.inputProperties),
    ],
  };
}

function getTopLevelInputPropertyNames(schema: Tool["inputSchema"]): string[] {
  const properties = (schema as { properties?: unknown }).properties;
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? Object.keys(properties as Record<string, unknown>).sort()
    : [];
}

function rankDocuments(
  documents: SearchDocument[],
  queryTokens: string[],
): Array<{ tool: CatalogTool; score: number }> {
  if (documents.length === 0) return [];
  const averageFieldLengths = documents[0]!.fields.map((_, fieldIndex) => {
    const total = documents.reduce((sum, document) => sum + document.fields[fieldIndex]!.tokens.length, 0);
    return Math.max(1, total / documents.length);
  });
  const scores = documents.map(() => 0);
  const matchedTokenCounts = documents.map(() => 0);

  for (const queryToken of queryTokens) {
    const termScores = documents.map(document => scoreTerm(document, queryToken, averageFieldLengths));
    const documentFrequency = termScores.filter(score => score > 0).length;
    if (documentFrequency === 0) continue;
    const inverseDocumentFrequency = Math.log(
      1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5),
    );
    for (const [index, termScore] of termScores.entries()) {
      if (termScore === 0) continue;
      scores[index]! += inverseDocumentFrequency * termScore;
      matchedTokenCounts[index]! += 1;
    }
  }

  return documents
    .map((document, index) => {
      const matchedTokens = matchedTokenCounts[index]!;
      if (matchedTokens === 0) return undefined;
      const coverage = matchedTokens / queryTokens.length;
      const coverageMultiplier = 0.5 + coverage * 0.5;
      return {
        tool: document.tool,
        score: Number((scores[index]! * coverageMultiplier).toFixed(6)),
      };
    })
    .filter((entry): entry is { tool: CatalogTool; score: number } => entry !== undefined)
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name));
}

function scoreTerm(document: SearchDocument, queryToken: string, averageFieldLengths: number[]): number {
  return document.fields.reduce((score, field, fieldIndex) => {
    const termFrequency = field.tokens.reduce(
      (sum, token) => sum + tokenMatchStrength(queryToken, token),
      0,
    );
    if (termFrequency === 0) return score;
    const lengthNormalization = 1 - BM25_B
      + BM25_B * (field.tokens.length / averageFieldLengths[fieldIndex]!);
    const normalizedFrequency = termFrequency * (BM25_K1 + 1)
      / (termFrequency + BM25_K1 * lengthNormalization);
    return score + field.weight * normalizedFrequency;
  }, 0);
}

function tokenMatchStrength(queryToken: string, fieldToken: string): number {
  if (fieldToken === queryToken) return 1;
  if (queryToken.length >= 4 && fieldToken.startsWith(queryToken)) return 0.6;
  if (fieldToken.length >= 4 && queryToken.startsWith(fieldToken)) return 0.4;
  return 0;
}

function prepareSearchField(value: string, weight: number): SearchField {
  return { tokens: tokenizeSearchText(value), weight };
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
