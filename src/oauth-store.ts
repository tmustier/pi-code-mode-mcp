import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";

interface StoredOAuthState {
  serverUrl: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

export class OAuthStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async read(serverName: string, serverUrl: string): Promise<StoredOAuthState> {
    const path = this.path(serverName);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as StoredOAuthState;
      return parsed.serverUrl === serverUrl ? parsed : { serverUrl };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { serverUrl };
      throw error;
    }
  }

  async update(
    serverName: string,
    serverUrl: string,
    mutate: (current: StoredOAuthState) => StoredOAuthState,
  ): Promise<void> {
    const path = this.path(serverName);
    const current = await this.read(serverName, serverUrl);
    const next = mutate(current);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  }

  async clear(serverName: string): Promise<void> {
    await rm(this.path(serverName), { force: true });
  }

  private path(serverName: string): string {
    const key = createHash("sha256").update(serverName).digest("hex");
    return join(this.root, "oauth", `${key}.json`);
  }
}

export type { StoredOAuthState };
