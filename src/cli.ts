#!/usr/bin/env node
import { loadConfig } from "./config.ts";
import { startStdioServer } from "./mcp-server.ts";
import { PACKAGE_NAME, VERSION } from "./version.ts";

interface CliOptions {
  configPath?: string;
  checkConfig: boolean;
  help: boolean;
  version: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const config = loadConfig(options.configPath);
  if (options.checkConfig) {
    process.stdout.write(`${JSON.stringify({
      status: "succeeded",
      data: {
        configPath: config.configPath ?? null,
        servers: Object.entries(config.mcpServers).map(([name, definition]) => ({
          name,
          transport: definition.command ? "stdio" : definition.transport ?? "streamable-http-with-sse-fallback",
          enabled: definition.enabled !== false,
          auth: definition.auth ?? "none",
        })),
      },
      errors: [],
      warnings: config.configPath ? [] : ["No config file found; the server has no upstream MCP servers."],
    }, null, 2)}\n`);
    return;
  }

  const handle = await startStdioServer(config);
  let closing = false;
  const close = async (exitCode?: number) => {
    if (closing) return;
    closing = true;
    await handle.close();
    if (exitCode !== undefined) process.exit(exitCode);
  };
  process.once("SIGINT", () => void close(130));
  process.once("SIGTERM", () => void close(143));
}

function parseArgs(args: string[]): CliOptions {
  const result: CliOptions = { checkConfig: false, help: false, version: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--config") {
      const path = args[index + 1];
      if (!path) throw new Error("--config requires a path");
      result.configPath = path;
      index += 1;
    } else if (argument === "--check-config") {
      result.checkConfig = true;
    } else if (argument === "--help" || argument === "-h") {
      result.help = true;
    } else if (argument === "--version" || argument === "-v") {
      result.version = true;
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
  }
  return result;
}

function helpText(): string {
  return `${PACKAGE_NAME} ${VERSION}\n\nUsage:\n  ${PACKAGE_NAME} [--config PATH]\n  ${PACKAGE_NAME} --check-config [--config PATH]\n\nOptions:\n  --config PATH   Read upstream MCP servers from this JSON file.\n  --check-config  Validate configuration and print a secret-free JSON summary.\n  --help, -h      Show this help.\n  --version, -v   Show the version.\n\nConfig lookup when --config is omitted:\n  $CODE_MODE_MCP_CONFIG\n  ./.code-mode-mcp.json\n  ~/.config/code-mode-mcp/mcp.json\n\nLegacy PI_CODE_MODE_MCP_CONFIG and ~/.config/pi-code-mode-mcp/mcp.json are fallback locations.\nStandard output is reserved for MCP in server mode.\n`;
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${PACKAGE_NAME}: ${message}\n`);
  process.exitCode = 1;
});
