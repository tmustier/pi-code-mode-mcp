#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

let dynamicToolEnabled = false;
const objectSchema = { type: "object", properties: {}, additionalProperties: false };
const tools = () => [
  {
    name: "calculate",
    description: "Sum numbers after an optional delay and report progress.",
    inputSchema: {
      type: "object",
      properties: {
        values: { type: "array", items: { type: "number" } },
        delay_ms: { type: "integer", minimum: 0 },
      },
      required: ["values"],
      additionalProperties: false,
    },
  },
  { name: "image", description: "Return a tiny PNG.", inputSchema: objectSchema },
  {
    name: "elicit",
    description: "Ask the MCP client for a value.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  { name: "sample", description: "Ask the MCP client to sample.", inputSchema: objectSchema },
  { name: "roots", description: "Ask the MCP client for roots.", inputSchema: objectSchema },
  { name: "hang", description: "Wait until the call is cancelled.", inputSchema: objectSchema },
  { name: "enable_dynamic", description: "Enable another tool and emit tools/list_changed.", inputSchema: objectSchema },
  { name: "exit_after_response", description: "Exit the upstream process after returning.", inputSchema: objectSchema },
  ...(dynamicToolEnabled ? [{ name: "dynamic", description: "A dynamically added tool.", inputSchema: objectSchema }] : []),
];

const server = new Server(
  { name: "code-mode-test-upstream", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true }, logging: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools() }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const args = request.params.arguments ?? {};
  switch (request.params.name) {
    case "calculate": {
      const delay = Number(args.delay_ms ?? 0);
      if (extra._meta?.progressToken !== undefined) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: extra._meta.progressToken, progress: 0, total: 1, message: "calculating" },
        });
      }
      if (delay > 0) await abortableDelay(delay, extra.signal);
      const sum = args.values.reduce((total, value) => total + Number(value), 0);
      return {
        content: [{ type: "text", text: String(sum) }],
        structuredContent: { sum },
      };
    }
    case "image":
      return {
        content: [{
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nH0AAAAASUVORK5CYII=",
        }],
      };
    case "elicit": {
      const result = await server.elicitInput({
        mode: "form",
        message: String(args.prompt),
        requestedSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      }, { signal: extra.signal });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }
    case "sample": {
      const result = await server.createMessage({
        messages: [{ role: "user", content: { type: "text", text: "Say fixture" } }],
        maxTokens: 20,
      }, { signal: extra.signal });
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    }
    case "roots": {
      const result = await server.listRoots(undefined, { signal: extra.signal });
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    }
    case "hang":
      await new Promise((resolve, reject) => {
        const abort = () => reject(extra.signal.reason ?? new DOMException("Aborted", "AbortError"));
        if (extra.signal.aborted) abort();
        else extra.signal.addEventListener("abort", abort, { once: true });
      });
      return { content: [{ type: "text", text: "unexpected" }] };
    case "enable_dynamic":
      dynamicToolEnabled = true;
      await server.sendToolListChanged();
      return { content: [{ type: "text", text: "enabled" }] };
    case "exit_after_response":
      setImmediate(() => process.exit(0));
      return { content: [{ type: "text", text: "closing" }] };
    case "dynamic":
      if (!dynamicToolEnabled) throw new Error("dynamic is disabled");
      return { content: [{ type: "text", text: "dynamic result" }] };
    default:
      throw new Error(`Unknown fixture tool ${request.params.name}`);
  }
});

server.onclose = () => process.exit(0);
await server.connect(new StdioServerTransport());

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
