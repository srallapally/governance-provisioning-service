// scripts/dev-auth.ts
//
// Local-dev-only JWT issuer for the Docker Compose stack (docker-compose.yml's
// `jwks` service). NOT for production or any real deployment -- it mints a
// throwaway RSA signing key every time it starts and serves the matching
// JWKS over plain HTTP, exactly mirroring the pattern test/http/auth.test.ts
// and test/load/soakHttp.ts already use to exercise a real (not mocked)
// requireJwt() middleware.
//
// Serves the JWKS forever on PORT (default 4180) and logs one ready-to-use
// bearer token to stdout at startup (`docker compose logs jwks`).
// docker-compose.yml points the app's JWT_JWKS_URI at this service;
// JWT_EXPECTED_ISS/AUD must match what this script signs with.
import http from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const PORT = Number(process.env["PORT"] ?? 4180);
const ISS = process.env["DEV_JWT_ISS"] ?? `http://jwks:${PORT}`;
const AUD = process.env["DEV_JWT_AUD"] ?? "provisioning-service-dev";

async function main(): Promise<void> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: "dev-key", alg: "RS256", use: "sig" });

  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(PORT, resolve));

  const token = await new SignJWT({ scope: "" })
      .setProtectedHeader({ alg: "RS256", kid: "dev-key" })
      .setSubject("dev")
      .setIssuer(ISS)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime("12h")
      .sign(privateKey);

  console.log(`[dev-auth] serving JWKS on :${PORT} (iss=${ISS} aud=${AUD})`);
  console.log(`[dev-auth] bearer token, valid 12h:\n${token}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
