# ADR 0001: Use a standalone MCP process for Code Mode

- **Status:** Accepted
- **Date:** 2026-07-15

## Context

Pi's progressive tool disclosure reduces schema context but does not let generated code invoke arbitrary Pi tools. Adding an executor to Computer Use would break its exact ten-tool contract.

We explored `pi-mcp-adapter`, `dmmulroy/pi-mcp`, `Hor1zonZzz/pi-codeMode`, `pi-code-tool`, Cloudflare Code Mode, `tool-sandbox`, `tool-sandbox-mcp`, and `cmcp`. None combined a local JavaScript executor with the required MCP OAuth, elicitation, sampling, roots, cancellation, notification, and rich-result fidelity.

## Decision

Implement Code Mode as a separate stdio MCP server loaded through the existing client MCP integration.

- Do not modify Pi or Computer Use.
- Expose one `exec` tool with in-code discovery and normalized upstream functions.
- Give generated code the same host authority as the surrounding runtime; do not add a stricter Code Mode-only security sandbox.
- Use the stdio process as the fault-containment boundary. Do not add a child or isolate per execution without evidence that this is insufficient.
- Preserve nested MCP behavior and return `cancel` when elicitation interaction is unavailable.

## Consequences

Normal Pi tools remain direct. Code Mode composes only its configured upstream MCP servers. The implementation owns upstream lifecycle and protocol forwarding; the outer MCP adapter owns the Code Mode process and user interface. Process timeout, termination, restart, cleanup, OAuth, elicitation, cancellation, and rich-content tests are release requirements.
