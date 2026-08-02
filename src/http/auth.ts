/**
 * Bearer-JWT verification, ported from the framework's
 * `packages/websocket/src/security/auth.ts` rather than written a second
 * time (P4's own instruction) -- same JWKS fetch/cache, algorithm allowlist,
 * iss/aud/expiry, and clock-skew handling, byte-for-byte where the logic
 * doesn't need to change for this transport.
 *
 * Deliberately does NOT include a replay cache: the framework's current
 * `auth.ts` doesn't have one either (removed at some point in favor of
 * stateless "bearer semantics" -- see that package's
 * `test/bearer-semantics.test.ts`, which exists specifically to lock in that
 * a JTI/replay setting is now ignored). An older description of that file
 * elsewhere in the framework repo still mentions a `TokenReplayCache`; the
 * code, not that description, is what this was ported from.
 */
import { NextFunction, Request, RequestHandler, Response } from "express";
import { createRemoteJWKSet, jwtVerify, JWTPayload, errors as JoseErrors } from "jose";
import { URL } from "url";

export interface JwtConfig {
  jwksUri: string;
  expectedIssuer: string;
  expectedAudience: string;
  allowedAlgorithms: string[];
  clockSkewSeconds: number;
  maxTokenAgeSeconds: number;
  requiredScope?: string;
}

const SUPPORTED_ALGORITHMS = [
  "RS256", "RS384", "RS512",
  "PS256", "PS384", "PS512",
  "ES256", "ES384", "ES512",
  "EdDSA",
] as const;

/**
 * Validates JWT environment variables and returns typed configuration.
 *
 * Fail-fast: throws with every problem found, not just the first, so a
 * container that starts with a broken auth config says why in one shot.
 */
export function validateJwtConfig(): JwtConfig {
  const errors: string[] = [];

  const jwksUri = process.env.JWT_JWKS_URI?.trim();
  if (!jwksUri) {
    errors.push("JWT_JWKS_URI is required but not set");
  } else {
    try {
      const url = new URL(jwksUri);
      if (!url.protocol.startsWith("http")) {
        errors.push(`JWT_JWKS_URI must be a valid HTTP(S) URL, got: ${jwksUri}`);
      }
    } catch {
      errors.push(`JWT_JWKS_URI is not a valid URL: ${jwksUri}`);
    }
  }

  const expectedIssuer = process.env.JWT_EXPECTED_ISS?.trim();
  if (!expectedIssuer) {
    errors.push("JWT_EXPECTED_ISS (issuer) is required but not set");
  } else if (expectedIssuer.length > 512) {
    errors.push(`JWT_EXPECTED_ISS is too long (max 512 chars): ${expectedIssuer.length} chars`);
  }

  const expectedAudience = process.env.JWT_EXPECTED_AUD?.trim();
  if (!expectedAudience) {
    errors.push("JWT_EXPECTED_AUD (audience) is required but not set");
  } else if (expectedAudience.length > 512) {
    errors.push(`JWT_EXPECTED_AUD is too long (max 512 chars): ${expectedAudience.length} chars`);
  }

  const algsEnv = process.env.JWT_ALLOWED_ALGS;
  const algsString = algsEnv !== undefined ? algsEnv.trim() : "RS256,PS256,ES256";
  const allowedAlgorithms = algsString.split(",").map(s => s.trim()).filter(Boolean);

  if (allowedAlgorithms.length === 0) {
    errors.push("JWT_ALLOWED_ALGS must contain at least one algorithm");
  } else {
    const unsupported = allowedAlgorithms.filter(
        alg => !(SUPPORTED_ALGORITHMS as readonly string[]).includes(alg));
    if (unsupported.length > 0) {
      errors.push(
          `JWT_ALLOWED_ALGS contains unsupported algorithms: ${unsupported.join(", ")}. ` +
          `Supported: ${SUPPORTED_ALGORITHMS.join(", ")}`);
    }
  }

  const skewString = process.env.JWT_ACCEPTED_CLOCK_SKEW_SEC?.trim() || "60";
  const clockSkewSeconds = Number(skewString);

  if (Number.isNaN(clockSkewSeconds)) {
    errors.push(`JWT_ACCEPTED_CLOCK_SKEW_SEC must be a number, got: ${skewString}`);
  } else if (clockSkewSeconds < 0) {
    errors.push(`JWT_ACCEPTED_CLOCK_SKEW_SEC must be non-negative, got: ${clockSkewSeconds}`);
  } else if (clockSkewSeconds > 300) {
    errors.push(
        `JWT_ACCEPTED_CLOCK_SKEW_SEC is too large (max 300 seconds), got: ${clockSkewSeconds}. ` +
        `Large clock skew values weaken security.`);
  }

  const maxAgeString = process.env.JWT_MAX_TOKEN_AGE_SEC?.trim() || "86400";
  const maxTokenAgeSeconds = Number(maxAgeString);
  const MAX_TOKEN_AGE_CEILING = 7 * 24 * 60 * 60;

  if (!Number.isInteger(maxTokenAgeSeconds)) {
    errors.push(`JWT_MAX_TOKEN_AGE_SEC must be an integer, got: ${maxAgeString}`);
  } else if (maxTokenAgeSeconds <= 0) {
    errors.push(`JWT_MAX_TOKEN_AGE_SEC must be positive, got: ${maxTokenAgeSeconds}`);
  } else if (maxTokenAgeSeconds > MAX_TOKEN_AGE_CEILING) {
    errors.push(
        `JWT_MAX_TOKEN_AGE_SEC is too large (max ${MAX_TOKEN_AGE_CEILING} seconds / 7 days), ` +
        `got: ${maxTokenAgeSeconds}. Long-lived tokens weaken security.`);
  }

  const requiredScope = process.env.JWT_REQUIRED_SCOPE?.trim();
  if (requiredScope && requiredScope.length > 256) {
    errors.push(`JWT_REQUIRED_SCOPE is too long (max 256 chars): ${requiredScope.length} chars`);
  }

  if (errors.length > 0) {
    throw new Error(`JWT configuration validation failed:\n${errors.map(e => `  - ${e}`).join("\n")}`);
  }

  const result: JwtConfig = {
    jwksUri: jwksUri!,
    expectedIssuer: expectedIssuer!,
    expectedAudience: expectedAudience!,
    allowedAlgorithms,
    clockSkewSeconds,
    maxTokenAgeSeconds,
  };

  if (requiredScope) {
    result.requiredScope = requiredScope;
  }

  return result;
}

// Validate configuration on module load (fail-fast) and build the JWKS
// client once. This means importing this module without valid JWT_* env
// vars throws immediately -- deliberate, matching the port source, and why
// callers (including tests) that need to control env per-run import this
// module dynamically, after setting env, rather than at top-level.
const config = validateJwtConfig();

const jwks = createRemoteJWKSet(new URL(config.jwksUri), {
  timeoutDuration: 5_000,
  cooldownDuration: 10 * 60_000,
});

export interface AuthContext {
  sub: string;
  scopes: string[];
  token: string;
  payload: JWTPayload;
}

declare global {
  // Module augmentation of Express's own ambient namespace is the only way
  // to add a property to `Request` -- not the namespace-as-scoping pattern
  // the rule exists to discourage.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { auth?: AuthContext; } }
}

/**
 * Parse and validate the Bearer token from the Authorization header.
 *
 * Strict on purpose: exact "Bearer " prefix, bounded length, no whitespace
 * inside the token -- rejects malformed/manipulated headers outright rather
 * than attempting a lenient parse.
 */
function parseAuthHeader(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  if (!h.startsWith("Bearer ")) return null;

  const token = h.slice(7);
  if (!token || token.length < 20 || token.length > 2048) return null;
  if (/\s/.test(token)) return null;

  return token;
}

function scopeAllowed(scopes: string[], required?: string | string[]): boolean {
  if (!required) return true;
  const list = Array.isArray(required) ? required : [required];
  return list.every(r => scopes.includes(r));
}

/**
 * Build the JWT-verifying middleware.
 *
 * Not `async`: this is a factory, so `app.use(requireJwt())` must receive
 * the handler itself, not a Promise of one -- an async factory would make
 * Express reject with "app.use() requires a middleware function".
 */
export function requireJwt(requiredScopes?: string | string[]): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = parseAuthHeader(req);
      if (!token) { res.status(401).json({ error: "Missing bearer token" }); return; }

      const { payload, protectedHeader } = await jwtVerify(token, jwks, {
        algorithms: config.allowedAlgorithms,
        issuer: config.expectedIssuer,
        audience: config.expectedAudience,
        maxTokenAge: config.maxTokenAgeSeconds,
        clockTolerance: config.clockSkewSeconds,
      });

      if (!protectedHeader.kid) { res.status(401).json({ error: "Missing kid" }); return; }
      if (!config.allowedAlgorithms.includes(protectedHeader.alg)) {
        res.status(401).json({ error: "Unsupported alg" });
        return;
      }

      const sub = payload.sub;
      const exp = payload.exp;
      if (!sub || !exp) { res.status(401).json({ error: "Missing sub/exp" }); return; }

      const rawScope = (payload as Record<string, unknown>).scope;
      const scopes = Array.isArray(rawScope)
          ? rawScope as string[]
          : String(rawScope ?? "").split(" ").filter(Boolean);

      if (config.requiredScope && !scopeAllowed(scopes, config.requiredScope)) {
        res.status(403).json({ error: "Insufficient scope" });
        return;
      }
      if (requiredScopes && !scopeAllowed(scopes, requiredScopes)) {
        res.status(403).json({ error: "Insufficient scope" });
        return;
      }

      req.auth = { sub, scopes, token, payload };
      next();
    } catch (e: unknown) {
      if (e instanceof JoseErrors.JWTExpired) { res.status(401).json({ error: "Token expired" }); return; }
      if (e instanceof JoseErrors.JWTInvalid) { res.status(401).json({ error: "Invalid token" }); return; }
      if (e instanceof JoseErrors.JWSSignatureVerificationFailed) {
        res.status(401).json({ error: "Bad signature" });
        return;
      }
      res.status(401).json({ error: "Unauthorized" });
    }
  };
}
