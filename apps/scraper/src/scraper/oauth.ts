// Google OAuth for an installed (desktop) app: PKCE flow, token refresh, token file.

import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chmod, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import path from "node:path";
import process from "node:process";
import { GOOGLE_DRIVE_SCOPE } from "../config/index.js";
import { parseJsonResponse } from "./drive.js";
import { formatErrorWithCause, logInfo, logWarn } from "./log.js";
import { type GoogleOAuthClient, type GoogleOAuthToken, type OAuthCallbackResult } from "./types.js";

export const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export class GoogleOAuthRefreshRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleOAuthRefreshRejectedError";
  }
}

export async function getGoogleAccessSession(clientFile: string, tokenFile: string): Promise<GoogleOAuthToken> {
  const client = await readGoogleOAuthClient(clientFile);
  const existingToken = await readGoogleOAuthToken(tokenFile);
  if (existingToken && isAccessTokenValid(existingToken)) {
    return existingToken;
  }

  if (existingToken?.refreshToken) {
    try {
      const refreshedToken = await refreshGoogleAccessToken(client, existingToken, tokenFile);
      return refreshedToken;
    } catch (error) {
      if (!(error instanceof GoogleOAuthRefreshRejectedError)) {
        throw error;
      }

      logWarn(`${error.message} Starting a new Google OAuth authorization flow.`);
      await unlink(tokenFile).catch(() => undefined);
      return authorizeGoogleAccess(client, tokenFile);
    }
  }

  return authorizeGoogleAccess(client, tokenFile);
}

export async function readGoogleOAuthClient(clientFile: string): Promise<GoogleOAuthClient> {
  let raw: string;

  try {
    raw = await readFile(clientFile, "utf8");
  } catch {
    throw new Error(`Google OAuth client file not found: ${clientFile}`);
  }

  const parsed = JSON.parse(raw) as {
    installed?: {
      auth_uri?: string;
      client_id?: string;
      client_secret?: string;
      redirect_uris?: string[];
      token_uri?: string;
    };
    web?: {
      auth_uri?: string;
      client_id?: string;
      client_secret?: string;
      redirect_uris?: string[];
      token_uri?: string;
    };
  };

  const source = parsed.installed ?? parsed.web;
  if (!source?.client_id || !source.auth_uri || !source.token_uri) {
    throw new Error(`Invalid Google OAuth client file: ${clientFile}`);
  }

  return {
    authUri: source.auth_uri,
    clientId: source.client_id,
    clientSecret: source.client_secret,
    tokenUri: source.token_uri
  };
}

export async function readGoogleOAuthToken(tokenFile: string): Promise<GoogleOAuthToken | null> {
  try {
    const raw = await readFile(tokenFile, "utf8");
    const parsed = JSON.parse(raw) as {
      access_token?: string;
      expiry_date_ms?: number;
      refresh_token?: string;
      scope?: string;
      token_type?: string;
    };

    if (!parsed.access_token) {
      return null;
    }

    return {
      accessToken: parsed.access_token,
      expiryDateMs: parsed.expiry_date_ms,
      refreshToken: parsed.refresh_token,
      scope: parsed.scope,
      tokenType: parsed.token_type
    };
  } catch {
    return null;
  }
}

export function isAccessTokenValid(token: GoogleOAuthToken): boolean {
  return Boolean(token.accessToken && token.expiryDateMs && token.expiryDateMs > Date.now() + 60_000);
}

export async function refreshGoogleAccessToken(
  client: GoogleOAuthClient,
  existingToken: GoogleOAuthToken,
  tokenFile: string
): Promise<GoogleOAuthToken> {
  if (!existingToken.refreshToken) {
    throw new Error("Google OAuth token file does not contain a refresh token.");
  }

  logInfo("Refreshing Google OAuth access token.");
  const params = new URLSearchParams({
    client_id: client.clientId,
    grant_type: "refresh_token",
    refresh_token: existingToken.refreshToken
  });

  if (client.clientSecret) {
    params.set("client_secret", client.clientSecret);
  }

  const response = await postGoogleOAuthTokenRequest(client.tokenUri, params, "refresh");

  const payload = await parseJsonResponse<{
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  }>(response);

  if (!response.ok || !payload.access_token || !payload.expires_in) {
    const message = payload.error_description ?? payload.error ?? response.statusText;
    if (payload.error === "invalid_grant" || /expired|revoked/iu.test(message)) {
      throw new GoogleOAuthRefreshRejectedError(`Failed to refresh Google OAuth token: ${message}`);
    }

    throw new Error(`Failed to refresh Google OAuth token: ${message}`);
  }

  const refreshedToken: GoogleOAuthToken = {
    accessToken: payload.access_token,
    expiryDateMs: Date.now() + payload.expires_in * 1000,
    refreshToken: payload.refresh_token ?? existingToken.refreshToken,
    scope: payload.scope ?? existingToken.scope,
    tokenType: payload.token_type ?? existingToken.tokenType ?? "Bearer"
  };

  await writeGoogleOAuthToken(tokenFile, refreshedToken);
  return refreshedToken;
}

export async function authorizeGoogleAccess(client: GoogleOAuthClient, tokenFile: string): Promise<GoogleOAuthToken> {
  const callback = await waitForGoogleAuthorizationCode(client);
  const params = new URLSearchParams({
    client_id: client.clientId,
    code: callback.code,
    code_verifier: callback.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: callback.redirectUri
  });

  if (client.clientSecret) {
    params.set("client_secret", client.clientSecret);
  }

  const response = await postGoogleOAuthTokenRequest(client.tokenUri, params, "authorization_code");

  const payload = await parseJsonResponse<{
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  }>(response);

  if (!response.ok || !payload.access_token || !payload.expires_in) {
    throw new Error(`Failed to exchange Google OAuth authorization code: ${payload.error_description ?? payload.error ?? response.statusText}`);
  }

  const token: GoogleOAuthToken = {
    accessToken: payload.access_token,
    expiryDateMs: Date.now() + payload.expires_in * 1000,
    refreshToken: payload.refresh_token,
    scope: payload.scope,
    tokenType: payload.token_type ?? "Bearer"
  };

  if (!token.refreshToken) {
    logWarn("Google OAuth did not return a refresh token. Future runs may require re-authorization.");
  }

  await writeGoogleOAuthToken(tokenFile, token);
  return token;
}

export async function postGoogleOAuthTokenRequest(
  tokenUri: string,
  params: URLSearchParams,
  grantType: "authorization_code" | "refresh"
): Promise<Response> {
  try {
    return await fetch(tokenUri, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    });
  } catch (error) {
    const details = formatErrorWithCause(error);
    throw new Error(`Google OAuth token request failed during ${grantType} exchange to ${tokenUri}: ${details}`);
  }
}

export async function waitForGoogleAuthorizationCode(
  client: GoogleOAuthClient
): Promise<OAuthCallbackResult & { codeVerifier: string; }> {
  const state = base64UrlEncode(randomBytes(32));
  const codeVerifier = base64UrlEncode(randomBytes(64));
  const codeChallenge = base64UrlEncode(createHash("sha256").update(codeVerifier).digest());

  const server = createServer();
  const redirectHost = "127.0.0.1";
  const redirectPath = "/oauth2/callback";
  let resolveCallback: ((value: OAuthCallbackResult) => void) | null = null;
  let rejectCallback: ((reason?: unknown) => void) | null = null;

  const callbackPromise = new Promise<OAuthCallbackResult>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  server.on("request", (request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${redirectHost}`);
    if (requestUrl.pathname !== redirectPath) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    if (requestUrl.searchParams.get("state") !== state) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Invalid OAuth state.");
      rejectCallback?.(new Error("Google OAuth state mismatch."));
      return;
    }

    const error = requestUrl.searchParams.get("error");
    if (error) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`Google OAuth failed: ${error}`);
      rejectCallback?.(new Error(`Google OAuth authorization failed: ${error}`));
      return;
    }

    const code = requestUrl.searchParams.get("code");
    if (!code) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Missing authorization code.");
      rejectCallback?.(new Error("Google OAuth callback did not include an authorization code."));
      return;
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<html><body><h1>Authorization received</h1><p>You can close this browser tab and return to the scraper.</p></body></html>");
    resolveCallback?.({
      code,
      redirectUri: `http://${redirectHost}:${(server.address() as AddressInfo).port}${redirectPath}`
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, redirectHost, resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start local Google OAuth callback listener.");
  }

  const redirectUri = `http://${redirectHost}:${address.port}${redirectPath}`;
  const authUrl = new URL(client.authUri);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("client_id", client.clientId);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_DRIVE_SCOPE);
  authUrl.searchParams.set("state", state);

  logInfo("Google OAuth authorization required.");
  logInfo(`Open this URL in your browser, sign in, and approve access:\n${authUrl.toString()}`);
  openExternalUrl(authUrl.toString());
  logInfo(`Waiting up to ${Math.round(OAUTH_CALLBACK_TIMEOUT_MS / 60_000)} minutes for Google OAuth callback on ${redirectUri}`);

  const callbackResult = await Promise.race([
    callbackPromise,
    delay(OAUTH_CALLBACK_TIMEOUT_MS).then(() => {
      throw new Error("Timed out waiting for Google OAuth authorization callback.");
    })
  ]).finally(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    }).catch(() => undefined);
  });

  return {
    ...callbackResult,
    codeVerifier
  };
}

export function openExternalUrl(url: string): void {
  const opener = getUrlOpenerCommand();
  if (!opener) {
    return;
  }

  try {
    const child = spawn(opener.command, [...opener.args, url], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    logInfo("Opened Google OAuth authorization URL in your default browser.");
  } catch (error) {
    logWarn(`Could not open Google OAuth URL automatically: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function getUrlOpenerCommand(): { args: string[]; command: string; } | null {
  if (process.platform === "darwin") {
    return { args: [], command: "open" };
  }

  if (process.platform === "win32") {
    return { args: ["/c", "start", ""], command: "cmd" };
  }

  return { args: [], command: "xdg-open" };
}

export async function writeGoogleOAuthToken(tokenFile: string, token: GoogleOAuthToken): Promise<void> {
  mkdirSync(path.dirname(tokenFile), { recursive: true });
  await writeFile(tokenFile, JSON.stringify({
    access_token: token.accessToken,
    expiry_date_ms: token.expiryDateMs,
    refresh_token: token.refreshToken,
    scope: token.scope,
    token_type: token.tokenType
  }, null, 2), { encoding: "utf8", mode: 0o600 });
  // writeFile's mode only applies on creation; tighten token files written by
  // older versions too, since they hold a long-lived Drive refresh token.
  await chmod(tokenFile, 0o600);
}

export function base64UrlEncode(value: Uint8Array): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
