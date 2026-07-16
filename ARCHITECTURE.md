# Architecture

## Boundary

```text
outer MCP client
  └─ stdio: code-mode-mcp
      ├─ one public tool: exec
      ├─ fresh node:vm context per execution
      ├─ in-memory session store
      └─ upstream MCP clients
          ├─ stdio child
          ├─ Streamable HTTP
          └─ SSE fallback
```

The stdio server is a process-level reliability boundary, not a capability sandbox. Generated code and the surrounding outer agent runtime intentionally have equivalent host authority.

Code Mode is an independent MCP layer. It does not modify the outer client or any upstream MCP server.

## Execution

On `exec`:

1. connect enabled upstream servers and fetch every paginated tool page;
2. build deterministic normalized names as `mcp__<server>__<tool>`;
3. build one recall-oriented search index for the execution, expose complete compact metadata through `ALL_TOOLS`, and expose exact schemas through `describe()`;
4. create one function per tool on the frozen `tools` object;
5. run the JavaScript async function body in a fresh `node:vm` context;
6. pass outer cancellation and progress through each nested call;
7. return only explicit emitted blocks and the final value;
8. clear tracked standard timers and discard the context.

Normalization replaces non-JavaScript identifier characters with `_`. A stable hash suffix resolves collisions.

`node:vm` interrupts synchronous tight loops. It is not treated as a security boundary: host APIs are injected deliberately, including `process`, `require`, dynamic import, network, filesystem, and child processes. An async continuation can still wedge the process; the outer MCP host can then kill and restart this standalone server.

## MCP protocol forwarding

The nested client advertises and forwards capabilities supported by the outer client:

- form and URL elicitation preserve `accept`, `decline`, `cancel`, response content, and metadata; unavailable interaction returns `cancel`;
- sampling and roots are forwarded only when the outer client advertises them;
- cancellation signals and progress callbacks cross both MCP boundaries;
- logging and URL-elicitation completion notifications are forwarded;
- upstream `tools/list_changed` refreshes the next execution's catalog;
- standard `CallToolResult` blocks, `structuredContent`, `isError`, and `_meta` are preserved when returned.

Connections stay alive for the stdio server lifetime and close on transport shutdown or signal handling. Upstream failures appear in `ALL_SERVERS`; one unavailable server does not hide tools from healthy servers.

## Configuration and credentials

The inner server has its own `mcpServers` config to prevent recursive self-registration and to remain agent-agnostic. The outer MCP client owns only its connection to Code Mode; client-specific lifecycle and UI stay outside this server.

Bearer values are resolved in memory. OAuth authorization URLs cross URL elicitation, and loopback callbacks use PKCE/state validation. OAuth credentials and discovery metadata are stored in mode-0600 files. Tool payloads, screenshots, console output, and intermediate values are never written automatically.

## Discovery

`search()` applies field-weighted BM25-style ranking across tool names, titles, server names, descriptions, and top-level input property names. Any matching significant query term can admit a candidate; coverage affects score rather than acting as an all-terms gate. This favors recall because the model can rerank a bounded set of compact rows. The index is built once per execution and reused by every search in that JavaScript cell.

`ALL_SERVERS` provides the authoritative server boundary and per-server tool counts. `ALL_TOOLS` stays complete, frozen, and schema-free inside the VM as deterministic recovery for query reformulation and negative capability checks. Neither inventory enters model context unless JavaScript returns it.

## Output

Text is bounded in memory. Oversized returned JSON becomes a valid truncation envelope instead of malformed, character-sliced JSON. Catalog-shaped arrays are structurally capped at 30 compact entries or 5 detailed entries and include counts plus a recovery hint. Oversized arbitrary objects do not get duplicated into `structuredContent`. Images and other explicitly returned rich blocks are preserved without disk spill. Explicit session values are JSON-cloned into process memory and vanish on exit.
