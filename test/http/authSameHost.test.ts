// test/http/authSameHost.test.ts
//
// P7's issuer/JWKS same-host boot check, isolated in its own file: it fires
// at module import time (inside validateJwtConfig(), which runs once at the
// top of auth.ts), so testing both a mismatch and a match in one file would
// need a second, differently-configured module instance -- Node's ESM cache
// makes that awkward. A separate file gets a fresh import for free.
import { it, expect } from "vitest";

it("refuses to boot when JWT_EXPECTED_ISS and JWT_JWKS_URI are on different hosts", async () => {
  process.env.JWT_JWKS_URI = "https://issuer-a.example.com/jwks.json";
  process.env.JWT_EXPECTED_ISS = "https://issuer-b.example.com:443";
  process.env.JWT_EXPECTED_AUD = "provisioning-service";

  await expect(import("../../src/http/auth.js")).rejects.toThrow(
      /issuer-a\.example\.com.*issuer-b\.example\.com|issuer-b\.example\.com.*issuer-a\.example\.com/);
});
