// oauth.ts — OAuth 2.1 (authorization code + PKCE) support for HTTP servers.
//
// The MCP SDK does discovery (RFC 9728 / 8414), dynamic client registration
// (RFC 7591), PKCE, resource indicators and token refresh. What it leaves to
// the host, and what this file provides, is:
//   - FileOAuthProvider: an `OAuthClientProvider` that persists the registered
//     client, tokens and discovery state per server under
//     ~/.slask-mcp-client/oauth/<name>.json (mode 0600), so the browser login
//     happens once and later runs refresh silently.
//   - a loopback HTTP listener that receives the authorization-code redirect.
//   - `state` validation (the SDK does not check it).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";

/** Fixed default so the redirect URI registered via DCR stays valid across runs. */
export const DEFAULT_CALLBACK_PORT = 8976;
/** How long to wait for the user to finish the browser login. */
export const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

const OAUTH_DIR = join(homedir(), ".slask-mcp-client", "oauth");

interface Stored {
  clientInformation?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

export class FileOAuthProvider implements OAuthClientProvider {
  readonly callbackPort: number;
  private readonly file: string;
  private readonly scope?: string;
  private expectedState: string | null = null;
  /** Set by `redirectToAuthorization`; the connect loop awaits the callback. */
  authorizationUrl: URL | null = null;

  constructor(opts: { serverName: string; callbackPort?: number; scope?: string; dir?: string }) {
    this.callbackPort = opts.callbackPort ?? DEFAULT_CALLBACK_PORT;
    this.scope = opts.scope;
    this.file = join(opts.dir ?? OAUTH_DIR, `${encodeURIComponent(opts.serverName)}.json`);
  }

  get redirectUrl(): string {
    return `http://localhost:${this.callbackPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "slask-mcp-client",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }

  state(): string {
    this.expectedState = randomBytes(16).toString("hex");
    return this.expectedState;
  }

  /** True when `state` from the callback matches the one we sent. */
  checkState(received: string | null): boolean {
    return this.expectedState !== null && received === this.expectedState;
  }

  clientInformation() {
    return this.read().then((s) => s.clientInformation);
  }
  saveClientInformation(info: StoredOAuthClientInformation) {
    return this.update({ clientInformation: info });
  }
  tokens() {
    return this.read().then((s) => s.tokens);
  }
  saveTokens(tokens: StoredOAuthTokens) {
    return this.update({ tokens });
  }
  saveCodeVerifier(codeVerifier: string) {
    return this.update({ codeVerifier });
  }
  async codeVerifier(): Promise<string> {
    const v = (await this.read()).codeVerifier;
    if (!v) throw new Error("no PKCE code verifier saved");
    return v;
  }
  discoveryState() {
    return this.read().then((s) => s.discoveryState);
  }
  saveDiscoveryState(discoveryState: OAuthDiscoveryState) {
    return this.update({ discoveryState });
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const s = await this.read();
    if (scope === "all") return this.write({});
    if (scope === "client") delete s.clientInformation;
    if (scope === "tokens") delete s.tokens;
    if (scope === "verifier") delete s.codeVerifier;
    if (scope === "discovery") delete s.discoveryState;
    return this.write(s);
  }

  private async read(): Promise<Stored> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as Stored;
    } catch {
      return {};
    }
  }

  private async write(s: Stored): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.file, JSON.stringify(s, null, 2), { mode: 0o600 });
  }

  private async update(patch: Partial<Stored>): Promise<void> {
    await this.write({ ...(await this.read()), ...patch });
  }
}

/**
 * Listen on the loopback callback port and resolve with the redirect's query
 * params once the browser lands on `/callback`. Rejects on timeout, on a port
 * that is already in use, or on an `error` response from the auth server.
 * The listener is closed before settling.
 */
export function waitForCallback(
  provider: FileOAuthProvider,
  timeoutMs = CALLBACK_TIMEOUT_MS,
): { ready: Promise<void>; params: Promise<URLSearchParams>; cancel: () => void } {
  let server: Server | undefined;
  let timer: NodeJS.Timeout | undefined;
  let rejectParams!: (e: Error) => void;
  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  const params = new Promise<URLSearchParams>((resolve, reject) => {
    rejectParams = reject;
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      server?.close();
      server?.closeAllConnections();
      fn();
    };
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", provider.redirectUrl);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const q = url.searchParams;
      const error = q.get("error");
      const bad = error
        ? `Authorization failed: ${error}`
        : !provider.checkState(q.get("state"))
          ? "Authorization failed: state mismatch"
          : null;
      res.writeHead(bad ? 400 : 200, { "content-type": "text/plain; charset=utf-8" });
      res.end(bad ?? "Signed in. You can close this tab and return to the terminal.");
      finish(() => (bad ? reject(new Error(bad)) : resolve(q)));
    });
    server.once("error", (e) => {
      const err = new Error(`OAuth callback listener failed on port ${provider.callbackPort}: ${e.message}`);
      rejectReady(err);
      finish(() => reject(err));
    });
    server.listen(provider.callbackPort, "127.0.0.1", resolveReady);
    timer = setTimeout(
      () => finish(() => reject(new Error("timed out waiting for the browser sign-in"))),
      timeoutMs,
    );
  });
  // Avoid an unhandled rejection if the caller only awaits `ready` and bails.
  params.catch(() => {});
  return {
    ready,
    params,
    cancel: () => {
      clearTimeout(timer);
      server?.close();
      server?.closeAllConnections();
      rejectParams(new Error("cancelled"));
    },
  };
}

/** Best-effort: open `url` in the user's default browser. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is printed too; the user can open it by hand.
  }
}
