// test/http/operationsRoutes.test.ts
import { it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { stop, isRunning } from "../../src/provisioning/wiring.js";
import { applySchema, openPool, probePostgres, resetOperations, type PgPool } from "../harness/pg.js";
import { describeWithPg } from "../harness/describeWithPg.js";
import { makeAppConfigDir, writeAppConfig, baseConfig, startTestApp } from "./testApp.js";

const probe = await probePostgres();

async function waitForTerminal(store: { getStatus(id: string): Promise<{ status: string } | null> }, id: string) {
  const deadline = Date.now() + 5_000;
  let status = await store.getStatus(id);
  while (status?.status === "PENDING" || status?.status === "RUNNING" || status?.status === "AWAITING_READBACK") {
    if (Date.now() > deadline) throw new Error(`operation ${id} did not settle: ${status?.status}`);
    await new Promise((r) => setTimeout(r, 25));
    status = await store.getStatus(id);
  }
  return status;
}

describeWithPg(probe, "operations route", () => {
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

  it("200s with the full OperationState shape for a hot terminal row", async () => {
    const { dir, cleanup } = await makeAppConfigDir();
    cleanupFns.push(cleanup);
    await writeAppConfig(dir, "app-1");
    const app = await startTestApp(baseConfig(probe, { appConfigDir: dir }));
    const { OperationStore } = await import("../../src/ops/OperationStore.js");
    const store = new OperationStore(verifyPool);

    const created = await request(app)
        .post("/instances/app-1/objects/__ACCOUNT__")
        .send({ attributes: { __NAME__: "grace" }, priority: "interactive" })
        .expect(202);
    await waitForTerminal(store, created.body.operationId);

    const res = await request(app).get(`/operations/${created.body.operationId}`).expect(200);
    expect(res.body).toMatchObject({
      operationId: created.body.operationId,
      instanceId: "app-1",
      objectClass: "__ACCOUNT__",
      type: "CREATE",
      priority: "interactive",
      status: "SUCCEEDED",
      outcome: "SUCCEEDED",
      attemptCount: expect.any(Number),
    });
    expect(res.body.result.uid).toBeTruthy();
    expect(res.body.result.object.attributes.__NAME__).toBe("grace");
    expect(res.body.createdAt).toBeTruthy();
    expect(res.body.completedAt).toBeTruthy();
  });

  it("carries no outcome while non-terminal", async () => {
    const { dir, cleanup } = await makeAppConfigDir();
    cleanupFns.push(cleanup);
    // Hang so the operation stays RUNNING long enough to observe.
    await writeAppConfig(dir, "app-hang", { behavior: "hang" }, { attemptDeadlineMs: 60_000 });
    const app = await startTestApp(baseConfig(probe, { appConfigDir: dir }));
    const { OperationStore } = await import("../../src/ops/OperationStore.js");
    const store = new OperationStore(verifyPool);

    const created = await request(app)
        .post("/instances/app-hang/objects/__ACCOUNT__")
        .send({ attributes: { __NAME__: "stuck" } })
        .expect(202);

    const deadline = Date.now() + 2_000;
    let status = await store.getStatus(created.body.operationId);
    while (status?.status !== "RUNNING") {
      if (Date.now() > deadline) throw new Error("never claimed");
      await new Promise((r) => setTimeout(r, 10));
      status = await store.getStatus(created.body.operationId);
    }

    const res = await request(app).get(`/operations/${created.body.operationId}`).expect(200);
    expect(res.body.status).toBe("RUNNING");
    expect(res.body.outcome).toBeUndefined();
  });

  it("404s an unknown operation id", async () => {
    const { dir, cleanup } = await makeAppConfigDir();
    cleanupFns.push(cleanup);
    await writeAppConfig(dir, "app-1");
    const app = await startTestApp(baseConfig(probe, { appConfigDir: dir }));

    await request(app).get("/operations/00000000-0000-0000-0000-000000000000").expect(404);
  });

  it("404s a syntactically invalid operation id rather than 500ing", async () => {
    const { dir, cleanup } = await makeAppConfigDir();
    cleanupFns.push(cleanup);
    await writeAppConfig(dir, "app-1");
    const app = await startTestApp(baseConfig(probe, { appConfigDir: dir }));

    await request(app).get("/operations/not-a-uuid").expect(404);
  });
});
