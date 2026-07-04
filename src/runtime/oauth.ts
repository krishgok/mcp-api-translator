/**
 * OAuth2 token acquisition + cache for the runtime proxy (client-credentials and refresh-token
 * grants).
 *
 * When a scheme carries a token endpoint, the proxy exchanges either a client id/secret
 * (grant_type=client_credentials) or a pre-obtained refresh token (grant_type=refresh_token) for a
 * short-lived bearer token and caches it until shortly before it expires, so repeated tool calls
 * don't re-hit the token endpoint. Mirrors what the generated `auth` module does.
 */
import type { FetchLike } from "./client.js";

interface CacheEntry {
  token: string;
  /** Epoch ms after which the token must be refreshed. */
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Rotated refresh tokens, keyed by the cache key of the env-supplied token. Some providers
 * invalidate the old refresh token on each exchange; the replacement lives only in memory, so
 * rotation does not survive a process restart (re-supply a fresh token via env if the provider
 * rotates aggressively).
 */
const refreshOverrides = new Map<string, string>();

/** Refresh this many ms before the stated expiry, to avoid using a just-expired token. */
const EARLY_REFRESH_MS = 30_000;
const DEFAULT_TTL_SECONDS = 3600;

/** Fetch (or return a cached) client-credentials access token for the given endpoint + client. */
export async function getClientCredentialsToken(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: FetchLike,
  now: () => number = () => Date.now(),
): Promise<string> {
  const key = `${tokenUrl}|${clientId}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now()) return hit.token;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();
  const response = await fetchImpl(new URL(tokenUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OAuth token request failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("OAuth token response had no access_token");
  const ttl = typeof json.expires_in === "number" ? json.expires_in : DEFAULT_TTL_SECONDS;
  cache.set(key, { token: json.access_token, expiresAt: now() + ttl * 1000 - EARLY_REFRESH_MS });
  return json.access_token;
}

/**
 * Fetch (or return a cached) access token by exchanging a pre-obtained refresh token
 * (grant_type=refresh_token). `clientSecret` is optional — public clients omit it.
 */
export async function getRefreshGrantToken(
  tokenUrl: string,
  clientId: string,
  clientSecret: string | undefined,
  refreshToken: string,
  fetchImpl: FetchLike,
  now: () => number = () => Date.now(),
): Promise<string> {
  const key = `${tokenUrl}|${clientId}|${refreshToken}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now()) return hit.token;

  const fields: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshOverrides.get(key) ?? refreshToken,
    client_id: clientId,
  };
  if (clientSecret) fields.client_secret = clientSecret;
  const body = new URLSearchParams(fields).toString();
  const response = await fetchImpl(new URL(tokenUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OAuth token request failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  const json = JSON.parse(text) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  };
  if (!json.access_token) throw new Error("OAuth token response had no access_token");
  if (json.refresh_token) refreshOverrides.set(key, json.refresh_token);
  const ttl = typeof json.expires_in === "number" ? json.expires_in : DEFAULT_TTL_SECONDS;
  cache.set(key, { token: json.access_token, expiresAt: now() + ttl * 1000 - EARLY_REFRESH_MS });
  return json.access_token;
}

/** Clear the token cache (tests only). */
export function clearTokenCache(): void {
  cache.clear();
  refreshOverrides.clear();
}
