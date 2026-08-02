// test/http/auth.test.ts
//
// Adapted from the framework's packages/websocket/test/bearer-semantics.test.ts:
// real signing keys and a throwaway local JWKS HTTP server, so verification
// runs for real rather than against a mocked `jose`. `auth.ts` validates its
// env and builds the JWKS client at module load, so it's imported
// dynamically here, after env is set -- a static top-level import would run
// before this file gets a chance to set JWT_JWKS_URI etc.
import { describe, it, afterAll } from "vitest";
import http from "node:http";
import express from "express";
import request from "supertest";
import { generateKeyPair, exportJWK, SignJWT, type KeyLike } from "jose";

// Hostname must match the local JWKS server's (127.0.0.1) -- P7's
// issuer/JWKS same-host boot check would otherwise refuse this fixture at
// import time. The :443 suffix is kept (on an otherwise-unreachable port,
// which is fine: JWT_EXPECTED_ISS is only ever string-compared against a
// token's `iss` claim, never dialed) since that's what the ":443 omitted"
// test below actually needs to be meaningful.
const ISS = "https://127.0.0.1:443";
const AUD = "provisioning-service";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = await exportJWK(publicKey);
Object.assign(jwk, { kid: "test-key", alg: "RS256", use: "sig" });

const other = await generateKeyPair("RS256");

const jwksServer = http.createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
const { port } = jwksServer.address() as { port: number };

process.env.JWT_JWKS_URI = `http://127.0.0.1:${port}/jwks.json`;
process.env.JWT_EXPECTED_ISS = ISS;
process.env.JWT_EXPECTED_AUD = AUD;

const { requireJwt } = await import("../../src/http/auth.js");

interface SignOpts {
  sub?: string;
  scope?: string;
  iss?: string;
  aud?: string;
  expiresIn?: string;
  key?: KeyLike;
}

async function sign(opts: SignOpts = {}): Promise<string> {
  return new SignJWT({ scope: opts.scope ?? "read write" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setSubject(opts.sub ?? "user-1")
      .setIssuer(opts.iss ?? ISS)
      .setAudience(opts.aud ?? AUD)
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? "5m")
      .sign(opts.key ?? privateKey);
}

function appWith(scopes?: string | string[]) {
  const app = express();
  app.use(requireJwt(scopes));
  app.get("/protected", (_req, res) => { res.json({ ok: true }); });
  return app;
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

afterAll(() => {
  jwksServer.close();
});

describe("requireJwt", () => {
  it("401s with no Authorization header", async () => {
    await request(appWith()).get("/protected").expect(401);
  });

  it("401s a malformed header", async () => {
    await request(appWith()).get("/protected").set("Authorization", "Basic abc").expect(401);
  });

  it("accepts a validly signed token", async () => {
    const token = await sign();
    await request(appWith()).get("/protected").set(bearer(token)).expect(200, { ok: true });
  });

  it("401s a token signed by an unknown key", async () => {
    const token = await sign({ key: other.privateKey });
    await request(appWith()).get("/protected").set(bearer(token)).expect(401);
  });

  it("401s an expired token", async () => {
    // Beyond JWT_ACCEPTED_CLOCK_SKEW_SEC's default (60s) tolerance -- a
    // token 10s past `exp` is deliberately still accepted, that's what the
    // tolerance is for.
    const token = await sign({ expiresIn: "-120s" });
    await request(appWith()).get("/protected").set(bearer(token)).expect(401);
  });

  it("401s a token whose iss omits :443 rather than passing", async () => {
    const token = await sign({ iss: "https://127.0.0.1" });
    await request(appWith()).get("/protected").set(bearer(token)).expect(401);
  });

  it("401s a token with the wrong audience", async () => {
    const token = await sign({ aud: "someone-else" });
    await request(appWith()).get("/protected").set(bearer(token)).expect(401);
  });

  it("403s a valid token missing a required scope -- aud can't separate callers, scope must", async () => {
    const token = await sign({ scope: "read" });
    await request(appWith("write")).get("/protected").set(bearer(token)).expect(403);
  });

  it("200s a valid token carrying the required scope", async () => {
    const token = await sign({ scope: "read write" });
    await request(appWith("write")).get("/protected").set(bearer(token)).expect(200);
  });

  it("accepts scope delivered as a JSON array, not just a space-delimited string", async () => {
    const token = await new SignJWT({ scope: ["read", "write"] })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setSubject("user-1")
        .setIssuer(ISS)
        .setAudience(AUD)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    await request(appWith("write")).get("/protected").set(bearer(token)).expect(200);
  });
});
