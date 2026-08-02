// test/provisioning/wiring.test.ts
//
// Exercises src/provisioning/wiring.ts end to end against a real Postgres.
// No HTTP: per the task that authorized this phase, proving the wiring works
// means driving OperationStore/Dispatcher directly, not standing up routes
// that do not exist until P4.
//
// Two pools are in play, deliberately mirroring the split P4 will need
// later: wiring.start() builds and owns the dispatcher's own pool
// internally, and this file opens a second one -- exactly the shape a
// future API pool will have -- both for direct DB assertions and as the
// OperationStore a route handler will eventually enqueue through.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import pgDefault from "pg";
const { Pool } = pgDefault;

import {
    start, stop, isRunning, ensureApplication, loadWiringConfig, type WiringConfig,
} from "../../src/provisioning/wiring.js";
import { OperationStore } from "../../src/ops/OperationStore.js";
import { laneKeyFor } from "../../src/ops/admission.js";
import { applySchema, openPool, probePostgres, resetOperations, type PgPool } from "../harness/pg.js";
import { describeWithPg } from "../harness/describeWithPg.js";

const probe = await probePostgres();

const FIXTURE_CONNECTORS = path.join(import.meta.dirname, "..", "fixtures", "connectors");

async function makeAppConfigDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    const dir = await mkdtemp(path.join(tmpdir(), "wiring-appcfg-"));
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function writeAppConfig(
    dir: string,
    applicationId: string,
    connectorConfig: Record<string, unknown> = {},
    runtime?: Record<string, unknown>,
): Promise<void> {
    await writeFile(
        path.join(dir, `${applicationId}.json`),
        JSON.stringify({
            applicationId,
            connectorType: "fake",
            connectorVersion: "1.0.0",
            connectorConfig,
            ...(runtime ? { runtime } : {}),
        }, null, 2),
    );
}

function baseConfig(overrides: Partial<WiringConfig> = {}): WiringConfig {
    return {
        databaseUrl: probe.url!,
        connectorBundleDir: FIXTURE_CONNECTORS,
        appConfigStore: "file",
        drainBudgetMs: 300,
        shutdownGraceMs: 100,
        statementTimeoutMs: 5_000,
        partitionRetentionDays: 1,
        partitionMaintenanceIntervalMs: 3_600_000,
        logger: { warn: () => { /* quiet in tests */ }, error: () => { /* quiet in tests */ } },
        ...overrides,
    };
}

async function startServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
    const server: Server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
    return {
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

describeWithPg(probe, "wiring", () => {
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
        // Defensive: a failing assertion mid-test must not leave `running`
        // set and a pool open for the next test to inherit.
        if (isRunning()) await stop();
        await Promise.all(cleanupFns.map((fn) => fn()));
        cleanupFns = [];
        vi.restoreAllMocks();
    });

    it("starts and stops cleanly with nothing in flight", async () => {
        const { dir, cleanup } = await makeAppConfigDir();
        cleanupFns.push(cleanup);

        expect(isRunning()).toBe(false);
        await start(baseConfig({ appConfigDir: dir }));
        expect(isRunning()).toBe(true);

        await stop();
        expect(isRunning()).toBe(false);

        // Idempotent: a second stop() (a second SIGTERM, or a race) is a no-op.
        await expect(stop()).resolves.toBeUndefined();
    });

    it("wires up partition maintenance: start() ensures tomorrow's partition even if it's missing", async () => {
        const { dir, cleanup } = await makeAppConfigDir();
        cleanupFns.push(cleanup);

        const { rows: [{ suffix }] } = await verifyPool.query(
            "SELECT to_char(current_date + 1, 'YYYYMMDD') AS suffix");
        await verifyPool.query(`DROP TABLE IF EXISTS operations_${suffix}`);

        await start(baseConfig({ appConfigDir: dir, partitionMaintenanceIntervalMs: 3_600_000 }));

        // start() kicks off an immediate pass rather than waiting a full
        // interval (PartitionMaintainer's own reasoning) -- poll briefly
        // since that pass runs in the background, not awaited by start().
        const deadline = Date.now() + 2_000;
        let present = false;
        while (!present) {
            if (Date.now() > deadline) throw new Error("partition maintenance never ran");
            const { rows } = await verifyPool.query(
                "SELECT to_regclass($1) IS NOT NULL AS present", [`operations_${suffix}`]);
            present = rows[0].present;
            if (!present) await new Promise((r) => setTimeout(r, 20));
        }

        expect(present).toBe(true);
    });

    it("enqueues, claims, finishes, and stops promptly", async () => {
        const { dir, cleanup } = await makeAppConfigDir();
        cleanupFns.push(cleanup);
        await writeAppConfig(dir, "app-1");

        await start(baseConfig({ appConfigDir: dir }));
        await ensureApplication("app-1");

        const store = new OperationStore(verifyPool);
        const { id } = await store.enqueue({
            instanceId: "app-1",
            objectClass: "__ACCOUNT__",
            opType: "CREATE",
            laneKey: laneKeyFor("CREATE", "__ACCOUNT__", { nameAttrValue: "alice" }),
            idempotencyKey: "wiring-e2e-1",
            nameAttrValue: "alice",
            attrs: { __NAME__: "alice" },
        });

        const deadline = Date.now() + 5_000;
        let status = await store.getStatus(id);
        while (status?.status === "PENDING" || status?.status === "RUNNING") {
            if (Date.now() > deadline) throw new Error(`operation ${id} did not settle: ${status?.status}`);
            await new Promise((r) => setTimeout(r, 25));
            status = await store.getStatus(id);
        }

        expect(status?.status).toBe("SUCCEEDED");

        const startedAt = Date.now();
        await stop();
        // Nothing was in flight, so stop() has no drain budget to spend.
        expect(Date.now() - startedAt).toBeLessThan(300);
    });

    it("stop() bounds the wait and leaves an in-flight op resumable rather than orphaned", async () => {
        const { dir, cleanup } = await makeAppConfigDir();
        cleanupFns.push(cleanup);
        // A short attemptDeadlineMs so the facade's own deadline aborts the
        // hung attempt quickly once the test is done with it, rather than
        // leaving a background timer running for the 3000ms default.
        await writeAppConfig(dir, "app-hang", { behavior: "hang" }, { attemptDeadlineMs: 500 });

        await start(baseConfig({
            appConfigDir: dir,
            drainBudgetMs: 100,
            shutdownGraceMs: 50,
        }));
        await ensureApplication("app-hang");

        const store = new OperationStore(verifyPool);
        const { id } = await store.enqueue({
            instanceId: "app-hang",
            objectClass: "__ACCOUNT__",
            opType: "CREATE",
            laneKey: laneKeyFor("CREATE", "__ACCOUNT__", { nameAttrValue: "stuck" }),
            idempotencyKey: "wiring-e2e-2",
            nameAttrValue: "stuck",
            attrs: { __NAME__: "stuck" },
        });

        // Give the claim loop a moment to pick it up before stopping.
        const claimDeadline = Date.now() + 2_000;
        let status = await store.getStatus(id);
        while (status?.status !== "RUNNING") {
            if (Date.now() > claimDeadline) throw new Error(`operation ${id} was never claimed: ${status?.status}`);
            await new Promise((r) => setTimeout(r, 10));
            status = await store.getStatus(id);
        }

        const startedAt = Date.now();
        await stop();
        const elapsedMs = Date.now() - startedAt;

        // Bounded by drainBudgetMs + shutdownGraceMs (100 + 50), not by
        // whatever it would take the hung attempt to finish on its own --
        // it never will, since controls.hangUntilAborted() only settles via
        // the facade's deadline abort, and that connector has none armed
        // beyond the default. Generous margin for scheduling jitter.
        expect(elapsedMs).toBeLessThan(1_000);

        // Left RUNNING, not partially written -- exactly what reapStale()
        // exists to recover, and the point of a bounded rather than
        // cancelling stop(): the row is resumable, not ambiguous.
        const stranded = await store.getStatus(id);
        expect(stranded?.status).toBe("RUNNING");

        const reaped = await store.reapStale(0, 0);
        expect(reaped.requeued + reaped.deferredForReadback).toBe(1);

        const afterReap = await store.getStatus(id);
        expect(afterReap?.status).not.toBe("RUNNING");
    });

    it("fails start() with the token endpoint's status in the message on a bad IGA secret", async () => {
        const tokenServer = await startServer((_req, res) => {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_client" }));
        });
        cleanupFns.push(tokenServer.close);

        const poolEndSpy = vi.spyOn(Pool.prototype, "end");

        await expect(start(baseConfig({
            appConfigStore: "iga",
            iga: { tokenUrl: tokenServer.url, clientId: "svc", clientSecret: "wrong" },
        }))).rejects.toThrow(/401/);

        expect(isRunning()).toBe(false);
        expect(poolEndSpy).toHaveBeenCalled();
    });

    it("refuses to boot on APP_CONFIG_STORE=iga even with a good secret, since that store is not built until P7", async () => {
        const tokenServer = await startServer((_req, res) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
        });
        cleanupFns.push(tokenServer.close);

        await expect(start(baseConfig({
            appConfigStore: "iga",
            iga: { tokenUrl: tokenServer.url, clientId: "svc", clientSecret: "right" },
        }))).rejects.toThrow(/Phase P7/);

        expect(isRunning()).toBe(false);
    });

    it("fails start() loudly on a nonexistent connector bundle directory", async () => {
        const { dir, cleanup } = await makeAppConfigDir();
        cleanupFns.push(cleanup);

        const poolEndSpy = vi.spyOn(Pool.prototype, "end");
        const badDir = path.join(tmpdir(), "wiring-does-not-exist-" + Date.now());

        await expect(start(baseConfig({ appConfigDir: dir, connectorBundleDir: badDir })))
            .rejects.toThrow(/ENOENT|no such file/i);

        expect(isRunning()).toBe(false);
        expect(poolEndSpy).toHaveBeenCalled();
    });

    it("refuses a second start() while already running, without disturbing the first", async () => {
        const { dir, cleanup } = await makeAppConfigDir();
        cleanupFns.push(cleanup);

        await start(baseConfig({ appConfigDir: dir }));
        await expect(start(baseConfig({ appConfigDir: dir }))).rejects.toThrow(/already running/);
        expect(isRunning()).toBe(true);
    });
});

describe("loadWiringConfig", () => {
    function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
        return { ...overrides };
    }

    it("throws when DATABASE_URL is missing", () => {
        expect(() => loadWiringConfig(env({ CONNECTOR_BUNDLE_DIR: "/x" })))
            .toThrow(/DATABASE_URL/);
    });

    it("throws when CONNECTOR_BUNDLE_DIR is missing", () => {
        expect(() => loadWiringConfig(env({ DATABASE_URL: "postgres://x" })))
            .toThrow(/CONNECTOR_BUNDLE_DIR/);
    });

    it("defaults APP_CONFIG_STORE to file and requires APP_CONFIG_DIR", () => {
        expect(() => loadWiringConfig(env({ DATABASE_URL: "postgres://x", CONNECTOR_BUNDLE_DIR: "/x" })))
            .toThrow(/APP_CONFIG_DIR/);
    });

    it("rejects an unrecognized APP_CONFIG_STORE", () => {
        expect(() => loadWiringConfig(env({
            DATABASE_URL: "postgres://x", CONNECTOR_BUNDLE_DIR: "/x", APP_CONFIG_STORE: "bogus",
        }))).toThrow(/"file" or "iga"/);
    });

    it("requires the IGA block only when APP_CONFIG_STORE=iga", () => {
        expect(() => loadWiringConfig(env({
            DATABASE_URL: "postgres://x", CONNECTOR_BUNDLE_DIR: "/x", APP_CONFIG_STORE: "iga",
        }))).toThrow(/IGA_TOKEN_URL/);
    });

    it("applies documented defaults for the tuning knobs", () => {
        const cfg = loadWiringConfig(env({
            DATABASE_URL: "postgres://x", CONNECTOR_BUNDLE_DIR: "/x", APP_CONFIG_DIR: "/y",
        }));
        expect(cfg.drainBudgetMs).toBe(8_000);
        expect(cfg.shutdownGraceMs).toBe(2_000);
        expect(cfg.statementTimeoutMs).toBe(5_000);
    });
});
