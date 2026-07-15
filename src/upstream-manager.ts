import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ElicitationCompleteNotificationSchema,
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  ToolListChangedNotificationSchema,
  type ClientCapabilities,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { NestedOAuthProvider, type OAuthInteraction } from "./oauth.ts";
import { PACKAGE_NAME, VERSION } from "./version.ts";
import type {
  LoadedCodeModeConfig,
  NestedCallContext,
  NestedToolResult,
  UpstreamServerDefinition,
  UpstreamServerStatus,
} from "./types.ts";

type UpstreamTransport = StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;

interface Connection {
  client: Client;
  transport: UpstreamTransport;
  definition: UpstreamServerDefinition;
  tools: Tool[];
}

export class UpstreamManager implements OAuthInteraction {
  private readonly connections = new Map<string, Connection>();
  private readonly connecting = new Map<string, Promise<Connection>>();
  private readonly errors = new Map<string, string>();
  private readonly config: LoadedCodeModeConfig;
  private readonly outerServer: Server;
  private catalogChanged?: () => void;

  constructor(config: LoadedCodeModeConfig, outerServer: Server) {
    this.config = config;
    this.outerServer = outerServer;
  }

  onCatalogChanged(callback: () => void): void {
    this.catalogChanged = callback;
  }

  async authorize(serverName: string, authorizationUrl: URL, signal?: AbortSignal): Promise<"accept" | "decline" | "cancel"> {
    const capability = this.outerServer.getClientCapabilities()?.elicitation;
    if (!capability?.url) return "cancel";
    try {
      const result = await this.outerServer.elicitInput({
        mode: "url",
        message: `Authorize upstream MCP server ${serverName}`,
        url: authorizationUrl.toString(),
        elicitationId: `oauth-${serverName}-${Date.now().toString(36)}`,
      }, signal ? { signal } : undefined);
      return result.action;
    } catch {
      return "cancel";
    }
  }

  async loadAll(signal?: AbortSignal): Promise<void> {
    const operations = Object.entries(this.config.mcpServers)
      .filter(([, definition]) => definition.enabled !== false)
      .map(async ([name, definition]) => {
        try {
          await this.connect(name, definition, signal);
          this.errors.delete(name);
        } catch (error) {
          this.errors.set(name, errorMessage(error));
        }
      });
    await Promise.all(operations);
  }

  getCatalogEntries(): Array<{ server: string; tools: Tool[] }> {
    return [...this.connections.entries()].map(([server, connection]) => ({
      server,
      tools: connection.tools,
    }));
  }

  getStatuses(): UpstreamServerStatus[] {
    return Object.entries(this.config.mcpServers).map(([server, definition]) => {
      if (definition.enabled === false) return { server, status: "disabled", toolCount: 0 };
      const connection = this.connections.get(server);
      if (connection) return { server, status: "connected", toolCount: connection.tools.length };
      return {
        server,
        status: "error",
        toolCount: 0,
        error: this.errors.get(server) ?? "Not connected",
      };
    });
  }

  async call(
    serverName: string,
    toolName: string,
    args: unknown,
    context: NestedCallContext,
  ): Promise<NestedToolResult> {
    const definition = this.config.mcpServers[serverName];
    if (!definition || definition.enabled === false) throw new Error(`MCP server ${serverName} is not configured or enabled`);
    const connection = await this.connect(serverName, definition, context.signal);
    const options: RequestOptions = {
      signal: context.signal,
      timeout: definition.requestTimeoutMs ?? this.config.settings.requestTimeoutMs,
      maxTotalTimeout: definition.requestTimeoutMs ?? this.config.settings.requestTimeoutMs,
      ...(context.onProgress ? { onprogress: context.onProgress } : {}),
    };
    try {
      return await connection.client.callTool({
        name: toolName,
        arguments: expectArguments(args),
      }, undefined, options) as NestedToolResult;
    } catch (error) {
      await this.evictConnection(serverName, connection, error);
      throw error;
    }
  }

  async close(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(connections.map(async connection => {
      await connection.client.close().catch(() => {});
      await connection.transport.close().catch(() => {});
    }));
  }

  private async connect(
    name: string,
    definition: UpstreamServerDefinition,
    signal?: AbortSignal,
  ): Promise<Connection> {
    const existing = this.connections.get(name);
    if (existing) return existing;
    const pending = this.connecting.get(name);
    if (pending) return pending;
    const operation = this.createConnection(name, definition, signal);
    this.connecting.set(name, operation);
    try {
      const connection = await operation;
      this.connections.set(name, connection);
      this.errors.delete(name);
      return connection;
    } catch (error) {
      this.errors.set(name, errorMessage(error));
      throw error;
    } finally {
      this.connecting.delete(name);
    }
  }

  private async createConnection(
    name: string,
    definition: UpstreamServerDefinition,
    signal?: AbortSignal,
  ): Promise<Connection> {
    const candidates = await this.createTransportCandidates(name, definition, signal);
    let lastError: unknown;
    for (const candidate of candidates) {
      const client = this.createClient(name);
      try {
        const transport = candidate.transport;
        await client.connect(transport, requestOptions(definition, this.config, signal));
        const tools = await listAllTools(client, requestOptions(definition, this.config, signal));
        await candidate.oauthProvider?.close();
        const connection: Connection = { client, transport, definition, tools };
        this.registerNotifications(name, connection);
        return connection;
      } catch (error) {
        lastError = error;
        let retryAfterAuth = false;
        try {
          if (error instanceof UnauthorizedError && candidate.oauthProvider) {
            const code = await candidate.oauthProvider.finishAuthorization();
            if (code && "finishAuth" in candidate.transport) {
              await (candidate.transport as StreamableHTTPClientTransport | SSEClientTransport).finishAuth(code);
              retryAfterAuth = true;
            }
          }
        } catch (authError) {
          lastError = authError;
        }
        await client.close().catch(() => {});
        await candidate.oauthProvider?.close();
        await candidate.transport.close().catch(() => {});
        if (retryAfterAuth) return await this.createConnection(name, definition, signal);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Failed to connect to ${name}`);
  }

  private createClient(name: string): Client {
    const capabilities = this.buildInnerCapabilities();
    const client = new Client(
      { name: `${PACKAGE_NAME}-${name}`, version: VERSION },
      Object.keys(capabilities).length > 0 ? { capabilities } : undefined,
    );
    this.registerForwardingHandlers(client, capabilities);
    return client;
  }

  private buildInnerCapabilities(): ClientCapabilities {
    const outer = this.outerServer.getClientCapabilities();
    return {
      ...(outer?.sampling ? { sampling: {} } : {}),
      ...(outer?.roots ? { roots: { listChanged: outer.roots.listChanged ?? false } } : {}),
      elicitation: { form: {}, url: {} },
    };
  }

  private registerForwardingHandlers(client: Client, capabilities: ClientCapabilities): void {
    client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      const mode = request.params.mode ?? "form";
      const capability = this.outerServer.getClientCapabilities()?.elicitation;
      if ((mode === "url" && !capability?.url) || (mode === "form" && !capability?.form)) {
        return { action: "cancel" as const };
      }
      try {
        return await this.outerServer.elicitInput(request.params, { signal: extra.signal });
      } catch {
        return { action: "cancel" as const };
      }
    });
    client.setNotificationHandler(ElicitationCompleteNotificationSchema, async notification => {
      if (!this.outerServer.getClientCapabilities()?.elicitation?.url) return;
      await this.outerServer.createElicitationCompletionNotifier(notification.params.elicitationId)();
    });

    if (capabilities.sampling) {
      client.setRequestHandler(CreateMessageRequestSchema, async (request, extra) => {
        return await this.outerServer.createMessage(request.params, { signal: extra.signal });
      });
    }

    if (capabilities.roots) {
      client.setRequestHandler(ListRootsRequestSchema, async (request, extra) => {
        return await this.outerServer.listRoots(request.params, { signal: extra.signal });
      });
    }

    client.setNotificationHandler(LoggingMessageNotificationSchema, async notification => {
      await this.outerServer.sendLoggingMessage(notification.params).catch(() => {});
    });
  }

  private registerNotifications(name: string, connection: Connection): void {
    connection.client.onclose = () => {
      if (this.connections.get(name) !== connection) return;
      this.connections.delete(name);
      this.errors.set(name, "Connection closed");
      this.catalogChanged?.();
    };
    connection.client.onerror = error => {
      this.errors.set(name, errorMessage(error));
    };
    connection.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        connection.tools = await listAllTools(
          connection.client,
          requestOptions(connection.definition, this.config),
        );
        this.catalogChanged?.();
      } catch (error) {
        this.errors.set(name, errorMessage(error));
      }
    });
  }

  private async evictConnection(name: string, connection: Connection, error: unknown): Promise<void> {
    if (this.connections.get(name) === connection) this.connections.delete(name);
    this.errors.set(name, errorMessage(error));
    await connection.client.close().catch(() => {});
    await connection.transport.close().catch(() => {});
    this.catalogChanged?.();
  }

  private async createTransportCandidates(
    name: string,
    definition: UpstreamServerDefinition,
    signal?: AbortSignal,
  ): Promise<Array<{
    transport: UpstreamTransport;
    oauthProvider?: NestedOAuthProvider;
  }>> {
    if (definition.command) {
      const environment: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) if (value !== undefined) environment[key] = value;
      Object.assign(environment, definition.env ?? {});
      return [{
        transport: new StdioClientTransport({
          command: definition.command,
          args: definition.args ?? [],
          env: environment,
          ...(definition.cwd ? { cwd: definition.cwd } : {}),
          stderr: definition.debug ? "inherit" : "ignore",
        }),
      }];
    }

    const url = new URL(definition.url!);
    const headers = new Headers(definition.headers);
    if (definition.auth === "bearer") {
      const token = definition.bearerToken
        ?? (definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined);
      if (!token) throw new Error(`Bearer token for ${name} is unavailable`);
      headers.set("authorization", `Bearer ${token}`);
    }
    const requestInit = [...headers].length > 0 ? { headers } : undefined;
    const buildOAuth = async (): Promise<NestedOAuthProvider | undefined> => {
      if (definition.auth !== "oauth") return undefined;
      const provider = new NestedOAuthProvider(
        name,
        definition.url!,
        definition.oauth ?? {},
        this.config.settings.stateDir,
        this.config.settings.oauthCallbackTimeoutMs,
        this,
        signal,
      );
      await provider.prepare();
      return provider;
    };

    if (definition.transport === "sse") {
      const oauthProvider = await buildOAuth();
      return [{
        transport: new SSEClientTransport(url, {
          ...(requestInit ? { requestInit } : {}),
          ...(oauthProvider ? { authProvider: oauthProvider } : {}),
        }),
        ...(oauthProvider ? { oauthProvider } : {}),
      }];
    }

    const streamableOAuth = await buildOAuth();
    const candidates: Array<{ transport: UpstreamTransport; oauthProvider?: NestedOAuthProvider }> = [{
      transport: new StreamableHTTPClientTransport(url, {
        ...(requestInit ? { requestInit } : {}),
        ...(streamableOAuth ? { authProvider: streamableOAuth } : {}),
      }),
      ...(streamableOAuth ? { oauthProvider: streamableOAuth } : {}),
    }];
    if (!definition.transport && definition.auth !== "oauth") {
      candidates.push({
        transport: new SSEClientTransport(url, requestInit ? { requestInit } : undefined),
      });
    }
    return candidates;
  }
}

function requestOptions(
  definition: UpstreamServerDefinition,
  config: LoadedCodeModeConfig,
  signal?: AbortSignal,
): RequestOptions {
  const timeout = definition.requestTimeoutMs ?? config.settings.requestTimeoutMs;
  return {
    ...(signal ? { signal } : {}),
    timeout,
    maxTotalTimeout: timeout,
  };
}

async function listAllTools(client: Client, options: RequestOptions): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, options);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

function expectArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
