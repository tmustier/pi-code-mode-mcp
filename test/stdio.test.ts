import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const fixturePath = new URL("./fixtures/upstream-server.mjs", import.meta.url).pathname;
const cliPath = new URL("../dist/cli.js", import.meta.url).pathname;

test("built stdio server survives a timed-out cell and restarts cleanly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-code-mode-stdio-"));
  const configPath = join(directory, "mcp.json");
  await writeFile(configPath, JSON.stringify({
    settings: { executionTimeoutMs: 500, stateDir: join(directory, "state") },
    mcpServers: {
      fixture: { command: process.execPath, args: [fixturePath], requestTimeoutMs: 2000 },
    },
  }));

  try {
    const first = await connect(configPath);
    const timedOut = await first.client.callTool({
      name: "exec",
      arguments: { code: "while (true) {}", timeout_ms: 25 },
    }) as CallToolResult;
    assert.equal(timedOut.isError, true);
    const recovered = await first.client.callTool({
      name: "exec",
      arguments: { code: "return await tools.mcp__fixture__calculate({ values: [19, 23] });" },
    }) as CallToolResult;
    assert.equal(text(recovered), "42");
    await first.client.close();

    const wedged = await connect(configPath);
    await assert.rejects(
      wedged.client.callTool({
        name: "exec",
        arguments: { code: "await Promise.resolve(); while (true) {}", timeout_ms: 5000 },
      }, undefined, { timeout: 75, maxTotalTimeout: 75 }),
      /timed out/i,
    );
    const wedgedPid = wedged.transport.pid;
    assert.ok(wedgedPid);
    process.kill(wedgedPid, "SIGKILL");
    await new Promise(resolve => setTimeout(resolve, 50));
    await wedged.client.close().catch(() => {});

    const second = await connect(configPath);
    const restarted = await second.client.callTool({
      name: "exec",
      arguments: { code: "return 40 + 2;" },
    }) as CallToolResult;
    assert.equal(text(restarted), "42");
    await second.client.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function connect(configPath: string): Promise<{ client: Client; transport: StdioClientTransport }> {
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "--config", configPath],
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, transport };
}

function text(result: CallToolResult): string {
  return result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
}
