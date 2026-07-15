import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
  CodeModeConfigFile,
  CodeModeSettings,
  LoadedCodeModeConfig,
  OAuthConfig,
  UpstreamServerDefinition,
} from "./types.ts";

const DEFAULT_SETTINGS: Omit<Required<CodeModeSettings>, "stateDir"> = {
  executionTimeoutMs: 120_000,
  requestTimeoutMs: 120_000,
  maxOutputChars: 50 * 1024,
  maxConsoleChars: 10 * 1024,
  oauthCallbackTimeoutMs: 5 * 60_000,
};

const TOP_LEVEL_KEYS = new Set(["settings", "mcpServers"]);
const SETTINGS_KEYS = new Set([
  "executionTimeoutMs",
  "requestTimeoutMs",
  "maxOutputChars",
  "maxConsoleChars",
  "oauthCallbackTimeoutMs",
  "stateDir",
]);
const SERVER_KEYS = new Set([
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "transport",
  "headers",
  "auth",
  "bearerToken",
  "bearerTokenEnv",
  "oauth",
  "requestTimeoutMs",
  "enabled",
  "debug",
]);
const OAUTH_KEYS = new Set([
  "grantType",
  "clientId",
  "clientSecret",
  "scope",
  "redirectUri",
  "clientName",
  "clientUri",
]);

export function defaultConfigCandidates(cwd = process.cwd()): string[] {
  const explicit = process.env.CODE_MODE_MCP_CONFIG ?? process.env.PI_CODE_MODE_MCP_CONFIG;
  return [
    ...(explicit ? [expandPath(explicit, cwd)] : []),
    resolve(cwd, ".code-mode-mcp.json"),
    resolve(homedir(), ".config", "code-mode-mcp", "mcp.json"),
    resolve(homedir(), ".config", "pi-code-mode-mcp", "mcp.json"),
  ];
}

export function findDefaultConfigPath(cwd = process.cwd()): string | undefined {
  return defaultConfigCandidates(cwd).find(candidate => existsSync(candidate));
}

export function defaultStateDirectory(
  selectedConfigPath?: string,
  home = homedir(),
  pathExists: (path: string) => boolean = existsSync,
): string {
  const genericRoot = resolve(home, ".config", "code-mode-mcp");
  const legacyRoot = resolve(home, ".config", "pi-code-mode-mcp");
  const legacyConfig = resolve(legacyRoot, "mcp.json");
  if (selectedConfigPath === legacyConfig) return legacyRoot;
  if (pathExists(resolve(genericRoot, "oauth"))) return genericRoot;
  if (pathExists(resolve(legacyRoot, "oauth"))) return legacyRoot;
  if (pathExists(genericRoot)) return genericRoot;
  if (pathExists(legacyRoot)) return legacyRoot;
  return genericRoot;
}

export function loadConfig(configPath?: string, cwd = process.cwd()): LoadedCodeModeConfig {
  const selectedPath = configPath ? expandPath(configPath, cwd) : findDefaultConfigPath(cwd);
  const baseDir = selectedPath ? dirname(selectedPath) : cwd;
  const raw: unknown = selectedPath
    ? JSON.parse(readFileSync(selectedPath, "utf8"))
    : { mcpServers: {} };
  const file = validateConfig(raw);
  const stateDir = expandPath(
    interpolate(
      file.settings?.stateDir
        ?? process.env.CODE_MODE_MCP_HOME
        ?? process.env.PI_CODE_MODE_MCP_HOME
        ?? defaultStateDirectory(selectedPath),
    ),
    baseDir,
  );

  const settings: Required<CodeModeSettings> = {
    executionTimeoutMs: file.settings?.executionTimeoutMs ?? DEFAULT_SETTINGS.executionTimeoutMs,
    requestTimeoutMs: file.settings?.requestTimeoutMs ?? DEFAULT_SETTINGS.requestTimeoutMs,
    maxOutputChars: file.settings?.maxOutputChars ?? DEFAULT_SETTINGS.maxOutputChars,
    maxConsoleChars: file.settings?.maxConsoleChars ?? DEFAULT_SETTINGS.maxConsoleChars,
    oauthCallbackTimeoutMs:
      file.settings?.oauthCallbackTimeoutMs ?? DEFAULT_SETTINGS.oauthCallbackTimeoutMs,
    stateDir,
  };

  const mcpServers: Record<string, UpstreamServerDefinition> = {};
  for (const [name, definition] of Object.entries(file.mcpServers)) {
    const resolved: UpstreamServerDefinition = {
      ...definition,
      ...(definition.args ? { args: definition.args.map(value => interpolate(value)) } : {}),
      ...(definition.env ? { env: interpolateRecord(definition.env) } : {}),
      ...(definition.headers ? { headers: interpolateRecord(definition.headers) } : {}),
      ...(definition.cwd ? { cwd: expandPath(interpolate(definition.cwd), baseDir) } : {}),
      ...(definition.url ? { url: interpolate(definition.url) } : {}),
      ...(definition.command ? { command: interpolate(definition.command) } : {}),
      ...(definition.bearerToken ? { bearerToken: interpolate(definition.bearerToken) } : {}),
      ...(definition.oauth ? { oauth: interpolateOAuth(definition.oauth) } : {}),
    };
    mcpServers[name] = resolved;
  }

  return {
    ...(selectedPath ? { configPath: selectedPath } : {}),
    baseDir,
    settings,
    mcpServers,
  };
}

export function validateConfig(value: unknown): CodeModeConfigFile {
  const object = expectObject(value, "config");
  rejectUnknownKeys(object, TOP_LEVEL_KEYS, "config");
  const serversObject = expectObject(object.mcpServers, "config.mcpServers");

  let settings: CodeModeSettings | undefined;
  if (object.settings !== undefined) {
    const rawSettings = expectObject(object.settings, "config.settings");
    rejectUnknownKeys(rawSettings, SETTINGS_KEYS, "config.settings");
    settings = {};
    for (const key of [
      "executionTimeoutMs",
      "requestTimeoutMs",
      "maxOutputChars",
      "maxConsoleChars",
      "oauthCallbackTimeoutMs",
    ] as const) {
      if (rawSettings[key] !== undefined) settings[key] = expectPositiveInteger(rawSettings[key], `config.settings.${key}`);
    }
    if (rawSettings.stateDir !== undefined) settings.stateDir = expectString(rawSettings.stateDir, "config.settings.stateDir");
  }

  const mcpServers: Record<string, UpstreamServerDefinition> = {};
  for (const [name, rawDefinition] of Object.entries(serversObject)) {
    if (!name.trim()) throw new Error("MCP server names must not be empty");
    const definitionObject = expectObject(rawDefinition, `config.mcpServers.${name}`);
    rejectUnknownKeys(definitionObject, SERVER_KEYS, `config.mcpServers.${name}`);
    const command = optionalString(definitionObject.command, `config.mcpServers.${name}.command`);
    const url = optionalString(definitionObject.url, `config.mcpServers.${name}.url`);
    if (Boolean(command) === Boolean(url)) {
      throw new Error(`config.mcpServers.${name} must define exactly one of command or url`);
    }
    if (command && definitionObject.transport !== undefined) {
      throw new Error(`config.mcpServers.${name}.transport is only valid with url`);
    }

    const definition: UpstreamServerDefinition = {
      ...(command ? { command } : {}),
      ...(url ? { url } : {}),
    };
    if (definitionObject.args !== undefined) {
      if (!Array.isArray(definitionObject.args) || !definitionObject.args.every(item => typeof item === "string")) {
        throw new Error(`config.mcpServers.${name}.args must be an array of strings`);
      }
      definition.args = [...definitionObject.args];
    }
    if (definitionObject.env !== undefined) definition.env = expectStringRecord(definitionObject.env, `config.mcpServers.${name}.env`);
    if (definitionObject.cwd !== undefined) definition.cwd = expectString(definitionObject.cwd, `config.mcpServers.${name}.cwd`);
    if (definitionObject.headers !== undefined) definition.headers = expectStringRecord(definitionObject.headers, `config.mcpServers.${name}.headers`);
    if (definitionObject.transport !== undefined) {
      const transport = expectString(definitionObject.transport, `config.mcpServers.${name}.transport`);
      if (transport !== "streamable-http" && transport !== "sse") throw new Error(`config.mcpServers.${name}.transport must be streamable-http or sse`);
      definition.transport = transport;
    }
    if (definitionObject.auth !== undefined) {
      const auth = expectString(definitionObject.auth, `config.mcpServers.${name}.auth`);
      if (auth !== "bearer" && auth !== "oauth") throw new Error(`config.mcpServers.${name}.auth must be bearer or oauth`);
      definition.auth = auth;
    }
    if (definitionObject.bearerToken !== undefined) definition.bearerToken = expectString(definitionObject.bearerToken, `config.mcpServers.${name}.bearerToken`);
    if (definitionObject.bearerTokenEnv !== undefined) definition.bearerTokenEnv = expectString(definitionObject.bearerTokenEnv, `config.mcpServers.${name}.bearerTokenEnv`);
    if (definitionObject.requestTimeoutMs !== undefined) definition.requestTimeoutMs = expectPositiveInteger(definitionObject.requestTimeoutMs, `config.mcpServers.${name}.requestTimeoutMs`);
    if (definitionObject.enabled !== undefined) definition.enabled = expectBoolean(definitionObject.enabled, `config.mcpServers.${name}.enabled`);
    if (definitionObject.debug !== undefined) definition.debug = expectBoolean(definitionObject.debug, `config.mcpServers.${name}.debug`);
    if (definitionObject.oauth !== undefined) definition.oauth = validateOAuth(definitionObject.oauth, `config.mcpServers.${name}.oauth`);
    if (definition.auth === "oauth" && !definition.url) throw new Error(`config.mcpServers.${name}: OAuth requires a URL transport`);
    if (definition.auth === "bearer" && !definition.bearerToken && !definition.bearerTokenEnv) {
      throw new Error(`config.mcpServers.${name}: bearer auth requires bearerToken or bearerTokenEnv`);
    }
    mcpServers[name] = definition;
  }

  return {
    ...(settings ? { settings } : {}),
    mcpServers,
  };
}

function validateOAuth(value: unknown, path: string): OAuthConfig {
  const object = expectObject(value, path);
  rejectUnknownKeys(object, OAUTH_KEYS, path);
  const result: OAuthConfig = {};
  for (const key of ["clientId", "clientSecret", "scope", "redirectUri", "clientName", "clientUri"] as const) {
    if (object[key] !== undefined) result[key] = expectString(object[key], `${path}.${key}`);
  }
  if (object.grantType !== undefined) {
    const grantType = expectString(object.grantType, `${path}.grantType`);
    if (grantType !== "authorization_code" && grantType !== "client_credentials") {
      throw new Error(`${path}.grantType must be authorization_code or client_credentials`);
    }
    result.grantType = grantType;
  }
  return result;
}

function interpolateOAuth(value: OAuthConfig): OAuthConfig {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, typeof item === "string" ? interpolate(item) : item]),
  ) as OAuthConfig;
}

function interpolateRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, interpolate(value)]));
}

export function interpolate(value: string): string {
  const exact = /^\$env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  if (exact) return requireEnv(exact[1]!);
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => requireEnv(name));
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`Environment variable ${name} is not set`);
  return value;
}

export function expandPath(value: string, baseDir: string): string {
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : expectString(value, path);
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function expectPositiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${path} must be a positive safe integer`);
  return value as number;
}

function expectStringRecord(value: unknown, path: string): Record<string, string> {
  const object = expectObject(value, path);
  for (const [key, item] of Object.entries(object)) {
    if (typeof item !== "string") throw new Error(`${path}.${key} must be a string`);
  }
  return object as Record<string, string>;
}

function rejectUnknownKeys(object: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new Error(`${path} contains unknown field ${key}`);
  }
}
