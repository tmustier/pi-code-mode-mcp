import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { CodeExecutor } from "./executor.ts";
import { buildErrorResult } from "./output.ts";
import type { LoadedCodeModeConfig } from "./types.ts";
import { UpstreamManager } from "./upstream-manager.ts";

export const VERSION = "0.1.0";
export const EXEC_TOOL_NAME = "exec";

export const EXEC_INPUT_SCHEMA = {
  type: "object",
  properties: {
    code: {
      type: "string",
      description: "Raw JavaScript function body. Use top-level await and return the final value. Do not wrap it in JSON or markdown fences.",
    },
    session_id: {
      type: "string",
      description: "Optional in-memory store namespace. Defaults to default.",
      default: "default",
    },
    timeout_ms: {
      type: "integer",
      minimum: 1,
      description: "Optional execution timeout. Defaults to the server setting.",
    },
    max_output_chars: {
      type: "integer",
      minimum: 1,
      description: "Optional returned-text limit. Filter large results in code instead.",
    },
  },
  required: ["code"],
  additionalProperties: false,
} as const;

export const EXEC_DESCRIPTION = `Run JavaScript to discover and compose upstream MCP tools in one call.

The code is an async function body: use top-level await and return a final value. Global APIs:
- ALL_TOOLS: frozen { name, server, tool, title?, description } metadata. Filter it in code for discovery.
- ALL_SERVERS: connection status for configured upstream servers.
- describe(name): full metadata and JSON input/output schemas for one normalized or unambiguous raw tool name.
- tools.<name>(args) or call(name, args): invoke a tool. Names are normalized as mcp__<server>__<tool> and listed in ALL_TOOLS.
- text(value), image(dataUrlOrMcpImage, detail?), emit(contentBlock): select MCP output blocks.
- store(key, value), load(key), clearStore(key?): explicit JSON-only in-memory session state.
- signal: AbortSignal for this execution.

Nested calls can be looped, branched, or run with Promise.all. Return a complete MCP CallToolResult to preserve all its text, image, audio, resource, structured content, error, and metadata fields. Otherwise returned values become text/JSON; use image() or emit() to select rich blocks.

This is ordinary host-authority Node JavaScript, not a security sandbox. process, require(), dynamic import(), fetch(), filesystem, network, environment, and child-process APIs have the same authority as this MCP server. node:vm supplies execution context and synchronous timeout control only. Standard output is reserved for MCP; console output is captured and returned.`;

export interface CodeModeServerHandle {
  server: Server;
  upstream: UpstreamManager;
  executor: CodeExecutor;
  close(): Promise<void>;
}

export function createCodeModeServer(config: LoadedCodeModeConfig): CodeModeServerHandle {
  const server = new Server(
    { name: "pi-code-mode-mcp", version: VERSION },
    {
      capabilities: {
        tools: { listChanged: false },
        logging: {},
      },
      instructions: "Use exec to discover and compose configured MCP tools with JavaScript. Normal client tools remain separate and directly available.",
    },
  );
  const upstream = new UpstreamManager(config, server);
  const executor = new CodeExecutor(config, upstream);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: EXEC_TOOL_NAME,
      title: "Execute JavaScript over MCP tools",
      description: EXEC_DESCRIPTION,
      inputSchema: EXEC_INPUT_SCHEMA,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    }],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    if (request.params.name !== EXEC_TOOL_NAME) {
      return buildErrorResult(new Error(`Unknown tool ${request.params.name}`));
    }
    try {
      const args = validateExecArguments(request.params.arguments);
      const progressToken = extra._meta?.progressToken;
      return await executor.execute({
        code: args.code,
        sessionId: args.sessionId,
        ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
        ...(args.maxOutputChars ? { maxOutputChars: args.maxOutputChars } : {}),
        signal: extra.signal,
        ...(progressToken !== undefined
          ? {
              onProgress: progress => {
                void extra.sendNotification({
                  method: "notifications/progress",
                  params: { progressToken, ...progress },
                }).catch(() => {});
              },
            }
          : {}),
      });
    } catch (error) {
      return buildErrorResult(error);
    }
  });

  server.onclose = () => {
    void upstream.close();
  };

  return {
    server,
    upstream,
    executor,
    async close() {
      await upstream.close();
      await server.close().catch(() => {});
    },
  };
}

export async function startStdioServer(config: LoadedCodeModeConfig): Promise<CodeModeServerHandle> {
  const handle = createCodeModeServer(config);
  await handle.server.connect(new StdioServerTransport());
  return handle;
}

function validateExecArguments(value: unknown): {
  code: string;
  sessionId: string;
  timeoutMs?: number;
  maxOutputChars?: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("exec arguments must be an object");
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (!["code", "session_id", "timeout_ms", "max_output_chars"].includes(key)) throw new Error(`exec received unknown argument ${key}`);
  }
  if (typeof object.code !== "string" || !object.code.trim()) throw new Error("exec.code must be non-empty JavaScript source");
  const sessionId = object.session_id === undefined ? "default" : expectNonEmptyString(object.session_id, "exec.session_id");
  return {
    code: object.code,
    sessionId,
    ...(object.timeout_ms === undefined ? {} : { timeoutMs: expectPositiveInteger(object.timeout_ms, "exec.timeout_ms") }),
    ...(object.max_output_chars === undefined ? {} : { maxOutputChars: expectPositiveInteger(object.max_output_chars, "exec.max_output_chars") }),
  };
}

function expectNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function expectPositiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${path} must be a positive safe integer`);
  return value as number;
}
