# Agent guide

## Commands

- Install: `npm ci`
- Type-check: `npm run check`
- Test: `npm test`
- Full release check: `npm run prepublishOnly`

## Boundaries

- Keep the public surface compact: Code Mode is one `exec` MCP tool with in-code discovery.
- Do not modify Pi or `codex-computer-use-mcp` from this repository.
- Generated code intentionally has the same host authority as this Node process. `node:vm` is used for execution control, not as a security boundary.
- The standalone stdio process is the fault-containment boundary. Do not add a child or isolate per execution without evidence that this boundary is insufficient.
- Standard output is reserved for MCP. Diagnostics belong on standard error and must not include secrets or tool payloads.
- Preserve nested MCP cancellation, progress, rich content, sampling, roots, and elicitation decisions. Never fabricate elicitation acceptance or rejection.
- Keep tool outputs in memory. Do not persist intermediate tool results or screenshots.
