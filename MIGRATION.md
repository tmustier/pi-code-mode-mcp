# Migration from `pi-code-mode-mcp`

Version 0.2.0 renamed the agent-agnostic package and repository from `pi-code-mode-mcp` to `code-mode-mcp`. Runtime behavior and the single public `exec` tool are unchanged.

## Upgrade

1. Install `code-mode-mcp@0.2.0`.
2. Change the outer MCP command from `pi-code-mode-mcp` to `code-mode-mcp`, or change the pinned `npx` package name.
3. Optionally move `~/.config/pi-code-mode-mcp/mcp.json` to `~/.config/code-mode-mcp/mcp.json`.
4. Replace `PI_CODE_MODE_MCP_CONFIG` with `CODE_MODE_MCP_CONFIG` and `PI_CODE_MODE_MCP_HOME` with `CODE_MODE_MCP_HOME` when those variables are set.
5. Restart or reload the outer MCP client.

The old environment variables and config path remain lookup fallbacks. When a project-local config is unchanged, an existing legacy OAuth directory remains the default until a new OAuth directory exists. OAuth credential files can instead be moved with the config directory while the server is stopped; do not copy them into tickets, logs, or chat.

The old npm package is deprecated and points to `code-mode-mcp`. GitHub redirects the previous repository URL.
