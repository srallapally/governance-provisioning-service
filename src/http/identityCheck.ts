/**
 * P7's second boot-time cross-validation: the inbound audience (the
 * caller's client id, per finding 6 -- AM sets `aud` to the client id for
 * client_credentials) must differ from `IGA_CLIENT_ID`, this service's own
 * outbound identity. If they collapse, this service's own outbound token
 * would pass its own inbound check -- invisible at request time, since
 * nothing about a valid-looking request reveals whose token it actually is.
 *
 * A pure function, not folded into `auth.ts` or `wiring.ts`: neither module
 * knows about the other's config, and this needs both. Kept out of
 * `src/index.ts` too -- that file stays a thin, untested wrapper (the same
 * reason `wiring.ts` never calls `process.on(...)` itself).
 *
 * Warns rather than refusing to boot, unlike the issuer/JWKS-host check in
 * `auth.ts`: that mismatch is essentially always a copy-paste error, while a
 * collapsed audience/client-id is plausibly an intentional, if unusual,
 * deployment (e.g. local testing against a single client).
 */
import type { JwtConfig } from "./auth.js";

export function checkAudienceIdentityCollapse(
    iga: { clientId: string } | undefined,
    jwt: Pick<JwtConfig, "expectedAudience">,
): string | null {
  if (!iga) return null;
  if (iga.clientId !== jwt.expectedAudience) return null;

  return (
      `JWT_EXPECTED_AUD and IGA_CLIENT_ID are both "${jwt.expectedAudience}" -- ` +
      "this service's own outbound token would pass its own inbound bearer check. " +
      "If unintentional, use a distinct IGA_CLIENT_ID.");
}
