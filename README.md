# Code Mode MCP

Compose arbitrary MCP tools with JavaScript through one agent-agnostic stdio MCP server.

The server exposes one tool, `exec`. Upstream schemas stay out of the model's initial context: JavaScript finds relevant tools with ranked `search()`, inspects exact schemas with `describe()`, and invokes normalized functions on `tools`.

> **Independent and experimental.** This is not an OpenAI or Pi product. The Code Mode API may change before version 1.0.
>
> Upgrading from `pi-code-mode-mcp`? See [`MIGRATION.md`](MIGRATION.md).

## What it does

```text
MCP client (Pi, Claude, Codex, or another host)
  └─ exec({ code })
      └─ standalone code-mode-mcp process
          ├─ tools.mcp__github__search_issues(...)
          ├─ tools.mcp__computer_use__get_app_state(...)
          └─ Promise.all(...)
```

- one model-facing MCP tool instead of every upstream schema;
- stdio, Streamable HTTP, and legacy SSE upstream transports;
- JavaScript loops, branching, parallel calls, transformation, and filtering;
- in-code discovery and exact JSON Schema inspection;
- text, image, audio, resource, structured-content, error, and metadata forwarding;
- nested cancellation, progress, elicitation, sampling, roots, logging, and `tools/list_changed` handling;
- bearer auth, OAuth client credentials, and interactive authorization-code OAuth;
- explicit, JSON-only, in-memory session state;
- no automatic persistence of tool results, screenshots, logs, or intermediate values.

Normal client tools remain available directly. Code Mode composes the MCP servers configured behind it; it does not replace the host's direct tools or convert host-native tools into nested MCP functions.

## Requirements

- Node.js 22 or newer
- an MCP client that can launch a stdio server

## Install

Install the exact npm release globally:

```bash
npm install --global @tmustier/code-mode-mcp@0.2.0
code-mode-mcp --help
```

Or build a source checkout:

```bash
git clone https://github.com/tmustier/code-mode-mcp.git
cd code-mode-mcp
npm ci
npm run prepublishOnly
```

The source executable is `dist/cli.js` after the build.

## Configure upstream MCP servers

Create `~/.config/code-mode-mcp/mcp.json`:

```json
{
  "settings": {
    "executionTimeoutMs": 120000,
    "requestTimeoutMs": 120000
  },
  "mcpServers": {
    "computer-use": {
      "command": "node",
      "args": [
        "/absolute/path/to/codex-computer-use-mcp/dist/mcp-server.js"
      ],
      "requestTimeoutMs": 180000
    },
    "remote": {
      "url": "https://example.com/mcp",
      "auth": "bearer",
      "bearerTokenEnv": "EXAMPLE_MCP_TOKEN"
    }
  }
}
```

Validate without starting MCP:

```bash
code-mode-mcp --check-config \
  --config ~/.config/code-mode-mcp/mcp.json
```

The JSON summary excludes commands, arguments, headers, tokens, and environment values.

### Configuration lookup

When `--config` is omitted, the first existing file wins:

1. `$CODE_MODE_MCP_CONFIG`
2. `./.code-mode-mcp.json`
3. `~/.config/code-mode-mcp/mcp.json`
4. legacy `~/.config/pi-code-mode-mcp/mcp.json`

`PI_CODE_MODE_MCP_CONFIG` and `PI_CODE_MODE_MCP_HOME` remain compatibility fallbacks.

The file uses the standard `mcpServers` object. Each server defines exactly one of:

- `command`, with optional `args`, `env`, and `cwd`;
- `url`, with optional `transport`, `headers`, and auth.

URL transport defaults to Streamable HTTP with SSE fallback. Set `transport` to `"streamable-http"` or `"sse"` to require one.

Strings support `${VAR}` and exact `$env:VAR` environment expansion. Relative `cwd` and `settings.stateDir` paths resolve from the config file.

### OAuth

```json
{
  "mcpServers": {
    "linear": {
      "url": "https://mcp.example.com/mcp",
      "auth": "oauth",
      "oauth": {
        "grantType": "authorization_code",
        "scope": "read write"
      }
    }
  }
}
```

For authorization-code OAuth, the server opens a loopback callback and forwards the authorization URL through MCP URL elicitation. The outer client decides whether to open it. Unsupported interaction returns `cancel`; the server never invents `accept` or `decline`.

OAuth tokens, dynamic client registration, PKCE verifier, and discovery metadata are stored as mode-0600 files under `settings.stateDir` (default `~/.config/code-mode-mcp`). No tool result is stored there.

## Add to any MCP client

Configure the outer server in any client that can launch stdio MCP processes:

```json
{
  "mcpServers": {
    "code-mode": {
      "command": "npx",
      "args": [
        "-y",
        "@tmustier/code-mode-mcp@0.2.0",
        "--config",
        "/Users/you/.config/code-mode-mcp/mcp.json"
      ]
    }
  }
}
```

Keep the upstream file separate. Do not configure Code Mode as its own upstream server.

### Pi through `pi-mcp-adapter`

Pi can add lifecycle and direct-tool settings in `~/.pi/agent/mcp.json` or `.pi/mcp.json`:

```json
{
  "mcpServers": {
    "code-mode": {
      "command": "npx",
      "args": [
        "-y",
        "@tmustier/code-mode-mcp@0.2.0",
        "--config",
        "/Users/you/.config/code-mode-mcp/mcp.json"
      ],
      "lifecycle": "lazy",
      "requestTimeoutMs": 180000,
      "directTools": ["exec"]
    }
  }
}
```

Restart or reload Pi after changing MCP configuration. The native Computer Use Pi extension and all normal Pi tools remain active alongside Code Mode.

## `exec` API

Input:

```json
{
  "code": "return search('app screenshot accessibility', { limit: 5 });",
  "session_id": "optional-session",
  "timeout_ms": 120000,
  "max_output_chars": 51200
}
```

`code` is a raw JavaScript async function body, not JSON-encoded source or a markdown fence.

### Discover

```js
return search("app screenshot accessibility", { limit: 5 });
```

`search()` uses recall-oriented lexical ranking over tool names, descriptions, titles, server names, and top-level input property names. It returns up to 10 compact `{ name, server, tool, title?, description, score }` matches by default, with no schemas. Query terms may match partially, so let the model choose among several candidates rather than treating the first result as authoritative.

It accepts optional `{ server, limit }` filters; the maximum limit is 50. Server filters accept either the raw configured key (`computer-use`) or its normalized form (`computer_use`) and report valid names instead of silently returning no matches. When vocabulary is uncertain, search several phrasings in one execution:

```js
const queries = ["send Teams message", "post chat message", "reply channel"];
const hits = queries.flatMap(query => search(query, { server: "teams", limit: 5 }));
return [...new Map(hits.map(hit => [hit.name, hit])).values()].slice(0, 10);
```

Inspect one exact schema:

```js
return describe("mcp__computer_use__get_app_state");
```

To inspect a small candidate set and its schemas in one discovery response:

```js
return search("send Teams message", { limit: 3 }).map(hit => describe(hit.name));
```

`ALL_TOOLS` remains a frozen complete inventory for deterministic recovery or custom filtering when ranked search is insufficient. Check its length and return only a bounded projection:

```js
return ALL_TOOLS
  .filter(tool => /message|chat|channel/i.test(`${tool.name} ${tool.description}`))
  .slice(0, 30);
```

Do not infer that a capability is absent from one empty ranked search. Rephrase, narrow by server, or inspect a bounded `ALL_TOOLS` projection.

`ALL_SERVERS` reports `{ server, status, toolCount, error? }` summaries for enabled upstreams. Use `toolCount` to decide whether direct enumeration is reasonable.

### Compose

```js
const apps = await tools.mcp__computer_use__list_apps({});
const selected = ["Calculator", "TextEdit"];
const states = await Promise.all(
  selected.map(app => tools.mcp__computer_use__get_app_state({ app }))
);
return states.map((state, index) => ({
  app: selected[index],
  text: state.content.find(block => block.type === "text")?.text.slice(0, 500)
}));
```

Use `call(name, args)` when a name is selected dynamically.

### Return rich output

Returning a complete MCP `CallToolResult` preserves its blocks and fields:

```js
return await tools.mcp__computer_use__get_app_state({ app: "Calculator" });
```

Select output explicitly when intermediate results are large:

```js
const result = await tools.mcp__computer_use__get_app_state({ app: "Calculator" });
text("Current Calculator state");
image(result.content.find(block => block.type === "image"), "original");
```

Helpers:

- `text(value)` emits a text block;
- `image(dataUrlOrMcpImage, detail?)` emits an image;
- `emit(contentBlock)` emits any valid MCP content block;
- `console.log()` and related methods are captured and returned, not written to MCP stdout.

Returned text is bounded in memory. Oversized JSON is returned as a valid truncation envelope rather than cut mid-structure. Catalog-shaped arrays are structurally elided after 30 compact entries or 5 detailed schema entries, with `total`, `omitted`, and a filtering hint. The server never spills full output to disk. Filter and aggregate inside the code cell for the best context efficiency.

### Session state

```js
store("cursor", { page: 2 });
return load("cursor");
```

`store`, `load`, and `clearStore` use explicit JSON-only, process-memory state. It disappears when the Code Mode server exits. The default `session_id` is `"default"`.

## Host authority and fault containment

Generated code intentionally has the same authority as this Node process. It can use `process`, `require()`, dynamic `import()`, `fetch()`, filesystem, network, environment, and child-process APIs. `node:vm` supplies a fresh context, captured console, tracked standard timers, and synchronous timeout interruption; it is not a security sandbox.

The standalone stdio process is the fault boundary. A synchronous tight loop is interrupted by `node:vm`. A loop that wedges the process after an asynchronous continuation may require the outer MCP client to terminate and restart the stdio server. This is why Code Mode is separate from Pi rather than an in-process extension.

See [`ARCHITECTURE.md`](ARCHITECTURE.md), [`SECURITY.md`](SECURITY.md), and [ADR 0001](docs/adr/0001-standalone-code-mode-mcp.md).

## Development

```bash
npm ci
npm run check
npm test
npm run prepublishOnly
npm pack --dry-run
```
