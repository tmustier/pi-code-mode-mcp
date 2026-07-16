import type { CallToolResult, Progress, Tool } from "@modelcontextprotocol/sdk/types.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface OAuthConfig {
  grantType?: "authorization_code" | "client_credentials";
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
  clientName?: string;
  clientUri?: string;
}

export interface UpstreamServerDefinition {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  transport?: "streamable-http" | "sse";
  headers?: Record<string, string>;
  auth?: "bearer" | "oauth";
  bearerToken?: string;
  bearerTokenEnv?: string;
  oauth?: OAuthConfig;
  requestTimeoutMs?: number;
  enabled?: boolean;
  debug?: boolean;
}

export interface CodeModeSettings {
  executionTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxOutputChars?: number;
  maxConsoleChars?: number;
  oauthCallbackTimeoutMs?: number;
  stateDir?: string;
}

export interface CodeModeConfigFile {
  settings?: CodeModeSettings;
  mcpServers: Record<string, UpstreamServerDefinition>;
}

export interface LoadedCodeModeConfig {
  configPath?: string;
  baseDir: string;
  settings: Required<CodeModeSettings>;
  mcpServers: Record<string, UpstreamServerDefinition>;
}

export interface CatalogTool {
  /** Normalized JavaScript identifier exposed on the global `tools` object. */
  name: string;
  server: string;
  tool: string;
  title?: string;
  description: string;
  inputSchema: Tool["inputSchema"];
  outputSchema?: Tool["outputSchema"];
  annotations?: Tool["annotations"];
  _meta?: Tool["_meta"];
}

export interface PublicCatalogTool {
  name: string;
  server: string;
  tool: string;
  title?: string;
  description: string;
}

export interface CatalogSearchOptions {
  server?: string;
  limit?: number;
}

export interface CatalogSearchResult extends PublicCatalogTool {
  score: number;
}

export interface CatalogSearchPage {
  items: CatalogSearchResult[];
  total: number;
}

export interface UpstreamServerStatus {
  server: string;
  status: "connected" | "error" | "disabled";
  toolCount: number;
  error?: string;
}

export interface NestedCallContext {
  signal: AbortSignal;
  onProgress?: (progress: Progress) => void;
}

export type NestedToolResult = CallToolResult;
