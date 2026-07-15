import { randomBytes } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthConfig } from "./types.ts";
import { OAuthStore } from "./oauth-store.ts";

export interface OAuthInteraction {
  authorize(serverName: string, authorizationUrl: URL, signal?: AbortSignal): Promise<"accept" | "decline" | "cancel">;
}

interface CallbackWaiter {
  redirectUrl: string;
  wait(signal?: AbortSignal): Promise<string>;
  close(): Promise<void>;
}

export class NestedOAuthProvider implements OAuthClientProvider {
  private readonly store: OAuthStore;
  private readonly serverName: string;
  private readonly serverUrl: string;
  private readonly config: OAuthConfig;
  private readonly callbackTimeoutMs: number;
  private readonly interaction: OAuthInteraction;
  private readonly signal: AbortSignal | undefined;
  private readonly redirectUrlValue: string | undefined;
  private readonly flowState = randomBytes(32).toString("hex");
  private callbackWaiter: CallbackWaiter | undefined;
  private authorizationCode: string | undefined;

  constructor(
    serverName: string,
    serverUrl: string,
    config: OAuthConfig,
    stateDir: string,
    callbackTimeoutMs: number,
    interaction: OAuthInteraction,
    signal?: AbortSignal,
  ) {
    this.serverName = serverName;
    this.serverUrl = serverUrl;
    this.config = config;
    this.callbackTimeoutMs = callbackTimeoutMs;
    this.interaction = interaction;
    this.signal = signal;
    this.store = new OAuthStore(stateDir);
    this.redirectUrlValue = config.grantType === "client_credentials"
      ? undefined
      : config.redirectUri;
  }

  get redirectUrl(): string | undefined {
    return this.callbackWaiter?.redirectUrl ?? this.redirectUrlValue ?? "http://127.0.0.1:19877/callback";
  }

  get clientMetadata(): OAuthClientMetadata {
    if (this.config.grantType === "client_credentials") {
      return {
        client_name: this.config.clientName ?? "Pi Code Mode MCP",
        client_uri: this.config.clientUri ?? "https://github.com/tmustier/pi-code-mode-mcp",
        redirect_uris: [],
        grant_types: ["client_credentials"],
        token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
        ...(this.config.scope ? { scope: this.config.scope } : {}),
      };
    }
    return {
      client_name: this.config.clientName ?? "Pi Code Mode MCP",
      client_uri: this.config.clientUri ?? "https://github.com/tmustier/pi-code-mode-mcp",
      redirect_uris: [this.redirectUrl!],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    };
  }

  async prepare(): Promise<void> {
    if (this.config.grantType === "client_credentials" || this.callbackWaiter) return;
    this.callbackWaiter = await createCallbackWaiter(
      this.redirectUrlValue,
      this.flowState,
      this.callbackTimeoutMs,
    );
  }

  async finishAuthorization(): Promise<string | undefined> {
    if (!this.callbackWaiter) return this.authorizationCode;
    try {
      this.authorizationCode = await this.callbackWaiter.wait(this.signal);
      return this.authorizationCode;
    } finally {
      await this.callbackWaiter.close();
      this.callbackWaiter = undefined;
    }
  }

  async close(): Promise<void> {
    await this.callbackWaiter?.close();
    this.callbackWaiter = undefined;
  }

  state(): string {
    return this.flowState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}),
      };
    }
    return (await this.store.read(this.serverName, this.serverUrl)).clientInformation;
  }

  async saveClientInformation(value: OAuthClientInformationFull): Promise<void> {
    await this.store.update(this.serverName, this.serverUrl, current => ({
      ...current,
      clientInformation: value,
    }));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.store.read(this.serverName, this.serverUrl)).tokens;
  }

  async saveTokens(value: OAuthTokens): Promise<void> {
    await this.store.update(this.serverName, this.serverUrl, current => ({ ...current, tokens: value }));
  }

  async saveCodeVerifier(value: string): Promise<void> {
    await this.store.update(this.serverName, this.serverUrl, current => ({ ...current, codeVerifier: value }));
  }

  async codeVerifier(): Promise<string> {
    const value = (await this.store.read(this.serverName, this.serverUrl)).codeVerifier;
    if (!value) throw new Error(`No OAuth code verifier is stored for ${this.serverName}`);
    return value;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.prepare();
    const action = await this.interaction.authorize(this.serverName, authorizationUrl, this.signal);
    if (action !== "accept") {
      await this.close();
      throw new UnauthorizedError(`OAuth authorization ${action} for ${this.serverName}`);
    }
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all") {
      await this.store.clear(this.serverName);
      return;
    }
    await this.store.update(this.serverName, this.serverUrl, current => {
      const next = { ...current };
      if (scope === "client") delete next.clientInformation;
      if (scope === "tokens") delete next.tokens;
      if (scope === "verifier") delete next.codeVerifier;
      if (scope === "discovery") delete next.discoveryState;
      return next;
    });
  }

  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    await this.store.update(this.serverName, this.serverUrl, current => ({ ...current, discoveryState: value }));
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.store.read(this.serverName, this.serverUrl)).discoveryState;
  }

  prepareTokenRequest(scope?: string): URLSearchParams | undefined {
    if (this.config.grantType !== "client_credentials") return undefined;
    const params = new URLSearchParams({ grant_type: "client_credentials" });
    if (scope ?? this.config.scope) params.set("scope", scope ?? this.config.scope!);
    if (this.config.clientId) params.set("client_id", this.config.clientId);
    if (this.config.clientSecret) params.set("client_secret", this.config.clientSecret);
    return params;
  }
}

async function createCallbackWaiter(
  configuredRedirectUrl: string | undefined,
  expectedState: string,
  timeoutMs: number,
): Promise<CallbackWaiter> {
  const configured = configuredRedirectUrl ? new URL(configuredRedirectUrl) : undefined;
  if (configured && configured.protocol !== "http:") throw new Error("OAuth redirectUri must use http:// loopback");
  const host = configured?.hostname ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    throw new Error("OAuth redirectUri must use a loopback host");
  }
  const path = configured?.pathname ?? "/callback";
  const requestedPort = configured?.port ? Number(configured.port) : 0;
  let settled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Closing an unused callback listener must not create an unhandled rejection.
  void codePromise.catch(() => {});
  const server: HttpServer = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
      if (url.pathname !== path) {
        response.writeHead(404).end("Not found");
        return;
      }
      const error = url.searchParams.get("error");
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (state !== expectedState) throw new Error("OAuth state mismatch");
      if (error) throw new Error(url.searchParams.get("error_description") ?? error);
      if (!code) throw new Error("OAuth callback did not include a code");
      settled = true;
      resolveCode(code);
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Authorization complete. You can close this window.");
    } catch (error) {
      settled = true;
      rejectCode(error instanceof Error ? error : new Error(String(error)));
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Authorization failed.");
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(requestedPort, host === "localhost" ? "127.0.0.1" : host, () => resolveListen());
  });
  const address = server.address() as AddressInfo;
  const redirectUrl = configured
    ? configured.toString()
    : `http://127.0.0.1:${address.port}${path}`;
  let timer: NodeJS.Timeout | undefined;

  return {
    redirectUrl,
    wait(signal) {
      return new Promise<string>((resolveWait, rejectWait) => {
        const abort = () => rejectWait(signal?.reason instanceof Error ? signal.reason : new Error("OAuth authorization cancelled"));
        if (signal?.aborted) return abort();
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => rejectWait(new Error("OAuth callback timed out")), timeoutMs);
        timer.unref?.();
        codePromise.then(resolveWait, rejectWait).finally(() => signal?.removeEventListener("abort", abort));
      });
    },
    async close() {
      if (timer) clearTimeout(timer);
      if (!settled) rejectCode(new Error("OAuth callback closed"));
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    },
  };
}
