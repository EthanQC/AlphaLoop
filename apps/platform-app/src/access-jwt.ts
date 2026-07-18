import {
  createPublicKey,
  verify as cryptoVerify,
  type JsonWebKey as NodeJsonWebKey,
  type KeyObject
} from "node:crypto";

/**
 * Cloudflare Access self-hosted-app JWT verification, hand-rolled on Node's
 * built-in crypto (no external JWT/JWKS library). Cloudflare puts a signed
 * assertion on the `Cf-Access-Jwt-Assertion` header (also the `CF_Authorization`
 * cookie) for every request that transits an Access tunnel; verifying it is the
 * only cryptographic proof the request really came from Access rather than from
 * anything else that can reach the origin and forge the plaintext
 * `Cf-Access-Authenticated-User-Email` header.
 *
 * Everything here is SYNCHRONOUS on the request path on purpose: `resolveIdentity`
 * (identity.ts) is called synchronously from every route, so signature checks use
 * the one-shot `crypto.verify` (sync) and read keys from an in-memory JWKS cache
 * that is refreshed in the background. A cold/rotated key never blocks or throws
 * into a request - it fails closed (returns null) and schedules a background
 * refetch so the next request can succeed.
 */

/** A single JSON Web Key as it appears in Cloudflare's `keys` array. */
export interface Jwk {
  kid?: unknown;
  kty?: unknown;
  alg?: unknown;
  use?: unknown;
  n?: unknown;
  e?: unknown;
  crv?: unknown;
  x?: unknown;
  y?: unknown;
}

/** Fetches the raw `keys` array from a team's `/cdn-cgi/access/certs` endpoint. */
export type JwksFetcher = (certsUrl: string) => Promise<Jwk[]>;

const JWKS_FETCH_TIMEOUT_MS = 5000;

/**
 * Default network JWKS fetcher. Fails (throws) on any non-2xx / malformed body;
 * JwksCache.refresh() turns that throw into a logged, fail-closed no-op so it
 * never reaches the request path.
 */
export const defaultJwksFetcher: JwksFetcher = async (certsUrl) => {
  const res = await fetch(certsUrl, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`JWKS fetch ${certsUrl} -> HTTP ${res.status}`);
  }
  const body = (await res.json()) as { keys?: unknown };
  if (!body || !Array.isArray(body.keys)) {
    throw new Error(`JWKS ${certsUrl} missing 'keys' array`);
  }
  return body.keys as Jwk[];
};

export interface JwksCacheOptions {
  certsUrl: string;
  fetcher: JwksFetcher;
  /** How long a fetched key set is considered fresh before a background refetch. */
  ttlMs: number;
  /** Injectable clock (epoch ms); defaults to Date.now via the caller. */
  now: () => number;
  /** Called (not thrown) when a background refresh fails. */
  onError?: (error: unknown) => void;
}

/**
 * In-memory JWKS cache with synchronous reads and background refresh.
 *
 * `getKey` never awaits: it returns whatever it currently holds and schedules a
 * background refetch when the cache is stale (TTL elapsed) OR when an unknown
 * `kid` is requested (key rotation). Concurrent refreshes are de-duplicated.
 */
export class JwksCache {
  private keys = new Map<string, KeyObject>();
  private fetchedAtMs = 0;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly opts: JwksCacheOptions) {}

  /**
   * Synchronous key lookup for the request path. Returns null (fail closed)
   * when the kid is unknown even after scheduling a refetch. A stale-but-present
   * key is still served (Cloudflare keys stay valid for weeks across rotations)
   * while the background refresh runs.
   */
  getKey(kid: string): KeyObject | null {
    const key = this.keys.get(kid);
    const stale = this.opts.now() - this.fetchedAtMs >= this.opts.ttlMs;
    if (key && !stale) {
      return key;
    }
    // Stale cache, or an unknown kid (possible rotation): refetch for next time.
    void this.scheduleRefresh();
    return key ?? null;
  }

  /** Kicks a refresh, coalescing concurrent callers onto one in-flight fetch. */
  scheduleRefresh(): Promise<void> {
    if (this.refreshing) {
      return this.refreshing;
    }
    this.refreshing = this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(): Promise<void> {
    try {
      const jwks = await this.opts.fetcher(this.opts.certsUrl);
      const next = new Map<string, KeyObject>();
      for (const jwk of jwks) {
        if (!jwk || typeof jwk.kid !== "string" || jwk.kid.length === 0) {
          continue;
        }
        try {
          // node:crypto's own JsonWebKey type, NOT the global (web) one - the
          // two disagree under exactOptionalPropertyTypes.
          next.set(jwk.kid, createPublicKey({ key: jwk as NodeJsonWebKey, format: "jwk" }));
        } catch {
          // Skip a single malformed key rather than discarding the whole set.
        }
      }
      this.keys = next;
      this.fetchedAtMs = this.opts.now();
    } catch (error) {
      // Fail closed: keep the previous (possibly empty) key set, never throw.
      this.opts.onError?.(error);
    }
  }
}

/** Normalized team identifiers derived from the configured team domain. */
export interface NormalizedTeam {
  host: string;
  issuer: string;
  certsUrl: string;
}

/**
 * Accepts a bare team name (`myteam`), a full host
 * (`myteam.cloudflareaccess.com`), or a URL (`https://myteam.cloudflareaccess.com/`)
 * and normalizes all three to the same issuer + certs URL Cloudflare signs with.
 */
export function normalizeTeamDomain(raw: string): NormalizedTeam | null {
  const trimmed = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, "")
    .replace(/\/+$/u, "");
  if (!trimmed) {
    return null;
  }
  const host = trimmed.includes(".") ? trimmed : `${trimmed}.cloudflareaccess.com`;
  const issuer = `https://${host}`;
  return { host, issuer, certsUrl: `${issuer}/cdn-cgi/access/certs` };
}

interface ParsedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

/** Parses a compact JWS (`header.payload.signature`); returns null on any malformation. */
function parseCompactJwt(token: string): ParsedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [h, p, s] = parts;
  if (!h || !p || !s) {
    return null;
  }
  try {
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as unknown;
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as unknown;
    const signature = Buffer.from(s, "base64url");
    if (typeof header !== "object" || header === null) {
      return null;
    }
    if (typeof payload !== "object" || payload === null) {
      return null;
    }
    if (signature.length === 0) {
      return null;
    }
    return {
      header: header as Record<string, unknown>,
      payload: payload as Record<string, unknown>,
      signingInput: `${h}.${p}`,
      signature
    };
  } catch {
    return null;
  }
}

type SupportedAlg = "RS256" | "ES256";

function verifySignature(
  alg: SupportedAlg,
  signingInput: string,
  key: KeyObject,
  signature: Buffer
): boolean {
  try {
    if (alg === "RS256") {
      return cryptoVerify("RSA-SHA256", Buffer.from(signingInput), key, signature);
    }
    // ES256: JWT carries the raw R||S (IEEE P1363) form, not DER.
    return cryptoVerify(
      "sha256",
      Buffer.from(signingInput),
      { key, dsaEncoding: "ieee-p1363" },
      signature
    );
  } catch {
    return false;
  }
}

export interface VerifiedAccessIdentity {
  email: string;
}

export interface VerifyAccessOptions {
  jwksCache: JwksCache;
  /** Expected `iss`, e.g. `https://myteam.cloudflareaccess.com`. */
  issuer: string;
  /** The Access application's AUD tag; `aud` (string or array) must contain it. */
  audience: string;
  /** Injectable clock (epoch ms). */
  now: () => number;
  /** Allowed clock skew in seconds for exp/iat/nbf (default 60). */
  clockSkewSec?: number;
}

/**
 * Verifies a Cloudflare Access JWT and returns the proven identity, or null if
 * ANY check fails. Checks, in order: parseable compact JWT; supported alg
 * (RS256/ES256, never `none`); a kid resolvable in the JWKS cache; signature;
 * `iss`; `aud` contains the app tag; `exp`/`nbf`/`iat` within skew; a non-empty
 * `email` claim. Never throws.
 */
export function verifyAccessToken(
  token: string,
  opts: VerifyAccessOptions
): VerifiedAccessIdentity | null {
  const parsed = parseCompactJwt(token);
  if (!parsed) {
    return null;
  }

  const alg = parsed.header["alg"];
  if (alg !== "RS256" && alg !== "ES256") {
    return null;
  }
  const kid = parsed.header["kid"];
  if (typeof kid !== "string" || kid.length === 0) {
    return null;
  }

  const key = opts.jwksCache.getKey(kid);
  if (!key) {
    return null;
  }

  if (!verifySignature(alg, parsed.signingInput, key, parsed.signature)) {
    return null;
  }

  const { payload } = parsed;

  if (payload["iss"] !== opts.issuer) {
    return null;
  }

  const aud = payload["aud"];
  const audOk = Array.isArray(aud) ? aud.includes(opts.audience) : aud === opts.audience;
  if (!audOk) {
    return null;
  }

  const skew = opts.clockSkewSec ?? 60;
  const nowSec = Math.floor(opts.now() / 1000);

  const exp = payload["exp"];
  if (typeof exp !== "number" || nowSec > exp + skew) {
    return null;
  }
  const nbf = payload["nbf"];
  if (typeof nbf === "number" && nowSec + skew < nbf) {
    return null;
  }
  const iat = payload["iat"];
  if (typeof iat === "number" && nowSec + skew < iat) {
    return null;
  }

  const email = payload["email"];
  if (typeof email !== "string" || email.length === 0) {
    return null;
  }

  return { email };
}
