// test/http/objectsRoutes.test.ts
//
// Route logic through the real loader + fixture connector bundle + a real
// Postgres-backed wiring, driven with supertest. Auth is a pass-through
// here (see testApp.ts) -- auth.test.ts owns proving requireJwt itself.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { stop, isRunning, getStore } from "../../src/provisioning/wiring.js";
import type { OperationStoreApi } from "../../src/ops/index.js";
import { applySchema, openPool, probePostgres, resetOperations, type PgPool } from "../harness/pg.js";
import { describeWithPg } from "../harness/describeWithPg.js";
import { makeAppConfigDir, writeAppConfig, baseConfig, startTestApp } from "./testApp.js";
import { makeNdjsonHandler } from "../../src/http/objectsRoutes.js";

const probe = await probePostgres();

async function waitForTerminal(store: OperationStoreApi, id: string) {
  const deadline = Date.now() + 5_000;
  let status = await store.getStatus(id);
  while (status?.status === "PENDING" || status?.status === "RUNNING" || status?.status === "AWAITING_READBACK") {
    if (Date.now() > deadline) throw new Error(`operation ${id} did not settle: ${status?.status}`);
    await new Promise((r) => setTimeout(r, 25));
    status = await store.getStatus(id);
  }
  return status;
}

describeWithPg(probe, "objects routes", () => {
  let verifyPool: PgPool;
  let cleanupFns: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    verifyPool = openPool(probe.url!);
    await applySchema(verifyPool);
  });

  afterAll(async () => {
    await verifyPool?.end();
  });

  beforeEach(async () => {
    await resetOperations(verifyPool);
  });

  afterEach(async () => {
    if (isRunning()) await stop();
    await Promise.all(cleanupFns.map((fn) => fn()));
    cleanupFns = [];
  });

  async function setup(applicationId = "app-1", connectorConfig: Record<string, unknown> = {}) {
    const { dir, cleanup } = await makeAppConfigDir();
    cleanupFns.push(cleanup);
    await writeAppConfig(dir, applicationId, connectorConfig);
    const app: Express = await startTestApp(baseConfig(probe, { appConfigDir: dir }));
    // The same OperationStore instance the routes themselves use (not a
    // second one wrapping verifyPool) -- needed so the admission-cap test
    // below can patch the exact instance admitAndEnqueue reads through.
    const store = getStore();
    return { app, store };
  }

  it("202s a create, and it settles SUCCEEDED with a Uid", async () => {
    const { app, store } = await setup();

    const res = await request(app)
        .post("/instances/app-1/objects/__ACCOUNT__")
        .send({ attributes: { __NAME__: "alice" } })
        .expect(202);

    expect(res.body.status).toBe("PENDING");
    expect(res.body.operationId).toMatch(/^[0-9a-f-]{36}$/);

    const final = await waitForTerminal(store, res.body.operationId);
    expect(final?.status).toBe("SUCCEEDED");
  });

  it("400s a create missing the naming attribute", async () => {
    const { app } = await setup();

    const res = await request(app)
        .post("/instances/app-1/objects/__ACCOUNT__")
        .send({ attributes: { email: "a@b.com" } })
        .expect(400);

    expect(res.body.error).toBe("validation_failed");
    expect(res.body.message).toMatch(/__NAME__/);
  });

  it("400s a body with no attributes at all", async () => {
    const { app } = await setup();
    await request(app).post("/instances/app-1/objects/__ACCOUNT__").send({}).expect(400);
  });

  it("429s with the backlog depth once the batch cap is saturated", async () => {
    // admitAndEnqueue's default batch cap is 10,000 -- saturating it for real
    // would make this test absurd. Route through a store double instead is
    // not an option here (routes are wired to the real OperationStore via
    // wiring), so this exercises the same admission path with a store whose
    // pendingCounts always reports the cap already exceeded, proving the
    // route surfaces AdmissionRejectedError as 429 with backlogDepth rather
    // than that the cap arithmetic itself is right -- OperationStore.test.ts
    // and Dispatcher.test.ts already cover the arithmetic.
    const { app, store } = await setup();
    const realPendingCounts = store.pendingCounts.bind(store);
    store.pendingCounts = async (instanceId: string) => {
      if (instanceId === "app-1") return { interactive: 0, batch: 10_000 };
      return realPendingCounts(instanceId);
    };

    const res = await request(app)
        .post("/instances/app-1/objects/__ACCOUNT__")
        .send({ attributes: { __NAME__: "overflow" } })
        .expect(429);

    expect(res.body.error).toBe("admission_rejected");
    expect(res.body.backlogDepth).toBe(10_000);
    expect(res.body.priority).toBe("batch");
  });

  it("enqueues add-values and remove-values", async () => {
    const { app, store } = await setup();

    const created = await request(app)
        .post("/instances/app-1/objects/__ACCOUNT__")
        .send({ attributes: { __NAME__: "bob" } })
        .expect(202);
    const afterCreate = await waitForTerminal(store, created.body.operationId);
    const uid = (afterCreate?.result as { uid?: string } | null)?.uid;
    expect(uid).toBeTruthy();

    const added = await request(app)
        .post(`/instances/app-1/objects/__ACCOUNT__/${uid}/add-values`)
        .send({ attributes: { groups: ["admins"] } })
        .expect(202);
    expect(await waitForTerminal(store, added.body.operationId)).toMatchObject({ status: "SUCCEEDED" });

    const removed = await request(app)
        .post(`/instances/app-1/objects/__ACCOUNT__/${uid}/remove-values`)
        .send({ attributes: { groups: ["admins"] } })
        .expect(202);
    expect(await waitForTerminal(store, removed.body.operationId)).toMatchObject({ status: "SUCCEEDED" });
  });

  it("gets an object by uid, and 404s a uid that doesn't exist", async () => {
    const { app, store } = await setup();

    const created = await request(app)
        .post("/instances/app-1/objects/__ACCOUNT__")
        .send({ attributes: { __NAME__: "carol" } })
        .expect(202);
    const afterCreate = await waitForTerminal(store, created.body.operationId);
    const uid = (afterCreate?.result as { uid?: string } | null)?.uid;
    if (!uid) throw new Error("create did not produce a uid");

    const got = await request(app).get(`/instances/app-1/objects/__ACCOUNT__/${uid}`).expect(200);
    expect(got.body.uid).toBe(uid);
    expect(got.body.attributes.__NAME__).toBe("carol");

    // FakeConnector.get() returns null for a missing uid -- the "not found by
    // absence" half of the facade's ambiguous get() contract.
    await request(app).get("/instances/app-1/objects/__ACCOUNT__/nonexistent-uid").expect(404);
  });

  it("also 404s when the connector throws UNKNOWN_UID instead of returning null", async () => {
    // The other half of get()'s ambiguous contract -- both are legitimate
    // per the SPI, and the route must map both to 404.
    const { app } = await setup("app-thrown-uid", { behavior: "unknownUidOnGet" });
    await request(app).get("/instances/app-thrown-uid/objects/__ACCOUNT__/whatever").expect(404);
  });

  it("streams NDJSON search results, one object per line", async () => {
    const { app, store } = await setup();

    const names = ["dave", "erin", "frank"];
    for (const name of names) {
      const res = await request(app)
          .post("/instances/app-1/objects/__ACCOUNT__")
          .send({ attributes: { __NAME__: name } })
          .expect(202);
      await waitForTerminal(store, res.body.operationId);
    }

    const res = await request(app).get("/instances/app-1/objects/__ACCOUNT__").expect(200);
    expect(res.headers["content-type"]).toMatch(/application\/x-ndjson/);

    const lines = res.text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((o) => o.attributes.__NAME__).sort()).toEqual(names.sort());
  });

  it("400s an invalid filter string rather than 500ing", async () => {
    const { app } = await setup();
    await request(app).get("/instances/app-1/objects/__ACCOUNT__?filter=not+a+filter").expect(400);
  });
});

describe("makeNdjsonHandler", () => {
  // Not typed as `NdjsonSink` directly: that interface's `writableEnded` is
  // `readonly`, matching `http.ServerResponse` (external code shouldn't set
  // it), but this mock needs to flip it to simulate "the response already
  // ended". A mutable object still satisfies `NdjsonSink` structurally
  // wherever it's passed as one.
  function mockSink() {
    const written: string[] = [];
    const drainListeners: Array<() => void> = [];
    return {
      written,
      drainListeners,
      writableEnded: false,
      write(chunk: string): boolean {
        written.push(chunk);
        return true;
      },
      once(_event: "drain", listener: () => void) {
        drainListeners.push(listener);
      },
      fireDrain() {
        drainListeners.splice(0).forEach((l) => l());
      },
    };
  }

  it("writes one JSON line per result and returns true to keep going", async () => {
    const sink = mockSink();
    const handler = makeNdjsonHandler(sink, () => false);
    await expect(handler({ uid: "1", objectClass: "__ACCOUNT__", attributes: {} })).resolves.toBe(true);
    expect(sink.written).toEqual(['{"uid":"1","objectClass":"__ACCOUNT__","attributes":{}}\n']);
  });

  it("awaits drain before resolving when write() reports a full buffer", async () => {
    const sink = mockSink();
    sink.write = (chunk: string) => { sink.written.push(chunk); return false; };

    const handler = makeNdjsonHandler(sink, () => false);
    let resolved = false;
    const p = Promise.resolve(handler({ uid: "1", objectClass: "__ACCOUNT__", attributes: {} })).then((v) => {
      resolved = true;
      return v;
    });

    // Give the microtask queue a turn: it must NOT have resolved yet, since
    // write() reported backpressure and no 'drain' has fired.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    sink.fireDrain();
    expect(await p).toBe(true);
    expect(resolved).toBe(true);
  });

  it("returns false without writing once the client is gone", async () => {
    const sink = mockSink();
    const handler = makeNdjsonHandler(sink, () => true);
    await expect(handler({ uid: "1", objectClass: "__ACCOUNT__", attributes: {} })).resolves.toBe(false);
    expect(sink.written).toEqual([]);
  });

  it("returns false once the response has already ended", async () => {
    const sink = mockSink();
    sink.writableEnded = true;
    const handler = makeNdjsonHandler(sink, () => false);
    await expect(handler({ uid: "1", objectClass: "__ACCOUNT__", attributes: {} })).resolves.toBe(false);
    expect(sink.written).toEqual([]);
  });
});
