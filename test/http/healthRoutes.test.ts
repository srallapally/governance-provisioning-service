// test/http/healthRoutes.test.ts
//
// Health routes need no real Postgres and no real auth: they're mounted
// ahead of both. An auth middleware that always rejects proves the mount
// order (health routes must never reach it); MemoryOperationStore proves
// /readyz's DB round trip without needing a real database for a test this
// narrow.
import { describe, it, expect } from "vitest";
import request from "supertest";
import { ConnectorManager, ConnectorRegistry } from "@governance-connector-framework/core";
import { createApp } from "../../src/http/app.js";
import { MemoryOperationStore } from "../harness/MemoryOperationStore.js";

function buildApp(store: MemoryOperationStore) {
  const registry = new ConnectorRegistry();
  const manager = new ConnectorManager(registry, { logger: { error: () => { /* quiet */ } } });
  return createApp({
    store,
    manager,
    ensureApplication: async () => { /* unused by these tests */ },
    authMiddleware: (_req, res) => { res.status(401).json({ error: "unauthorized" }); },
  });
}

describe("health routes", () => {
  it("GET /healthz 200s without an Authorization header", async () => {
    const app = buildApp(new MemoryOperationStore());
    const res = await request(app).get("/healthz").expect(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /readyz 200s when the store answers", async () => {
    const app = buildApp(new MemoryOperationStore());
    const res = await request(app).get("/readyz").expect(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /readyz 503s when the store cannot be reached", async () => {
    class BrokenStore extends MemoryOperationStore {
      override async ping(): Promise<void> {
        throw new Error("connection refused");
      }
    }
    const app = buildApp(new BrokenStore());
    const res = await request(app).get("/readyz").expect(503);
    expect(res.body).toMatchObject({ status: "unavailable", message: "connection refused" });
  });

  it("never reaches authMiddleware, unlike every other route", async () => {
    const app = buildApp(new MemoryOperationStore());
    await request(app).get("/healthz").expect(200);
    await request(app).get("/readyz").expect(200);
    // The always-401 authMiddleware above proves these two are the only
    // routes that bypass it.
    await request(app).get("/operations/00000000-0000-0000-0000-000000000000").expect(401);
  });
});
