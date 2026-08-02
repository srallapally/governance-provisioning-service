/**
 * Assembles the operation table, the dispatcher, and everything they depend
 * on into one running process. No HTTP surface -- that is P4's job. This
 * module answers one question: given an environment, can a claim loop run.
 *
 * `start()`/`stop()` are the whole public surface, plus `isRunning()` for a
 * caller that wants to check without racing a concurrent call. State lives in
 * a module-level variable rather than a class instance because this process
 * only ever runs one of these -- a second `start()` while one is already
 * running is refused rather than silently supported.
 *
 * Deployment is a single Docker container with nothing external restarting
 * it (settled at P0). Two consequences shape everything below:
 *
 * - `start()` must reject outright on any misconfiguration, in full, rather
 *   than boot partially wired. A container that starts half-broken and stays
 *   up looks healthy to nothing that would restart it.
 * - `stop()` must not wait forever. Whatever stop-grace-period the deployment
 *   grants arrives eventually as SIGKILL regardless of what this module does,
 *   so an unbounded wait only spends that budget worse than a bounded one.
 *
 * This module never calls `process.on(...)`. That belongs to `src/index.ts`,
 * the actual entrypoint -- a module that wired a signal handler at import
 * time would fire it for every test that imports `start`/`stop` to drive
 * them directly, which is exactly what this file's own tests do.
 */
import {
    ConnectorManager,
    ConnectorRegistry,
    loadExternalConnectors,
    type MetricsSink,
} from "@governance-connector-framework/core";
// pg ships CommonJS; the named export is not reachable through ESM interop
// (see test/harness/pg.ts, which established this pattern first).
import pgDefault from "pg";
const { Pool } = pgDefault;
type Pool = InstanceType<typeof Pool>;

import { Dispatcher } from "../ops/Dispatcher.js";
import { OperationStore } from "../ops/OperationStore.js";
import type { ApplicationConfigStore } from "../config/application.js";
import { FileApplicationConfigStore } from "../config/FileApplicationConfigStore.js";
import { ApplicationRegistrar } from "../config/registerApplication.js";
import { IgaTokenProvider } from "../config/IgaTokenProvider.js";
import { consoleMetricsSink } from "./consoleMetricsSink.js";

export interface WiringConfig {
    databaseUrl: string;
    connectorBundleDir: string;
    appConfigStore: "file" | "iga";
    /** Required when `appConfigStore` is `"file"`. */
    appConfigDir?: string | undefined;
    iga?: {
        tokenUrl: string;
        clientId: string;
        clientSecret: string;
        scope?: string | undefined;
        audience?: string | undefined;
        resource?: string | undefined;
    } | undefined;
    /** Wait for in-flight attempts up to this long before giving up. Default 8000ms. */
    drainBudgetMs: number;
    /**
     * Second-stage wait after the drain budget, before disposing connector
     * instances. See the note on `ConnectorManager.shutdown()` in `stop()`
     * below for why this exists. Default 2000ms.
     */
    shutdownGraceMs: number;
    /** `statement_timeout` for the dispatcher's own pool, in ms. Default 5000ms. */
    statementTimeoutMs: number;
    logger: { error(msg: string): void };
}

const CONFIG_DEFAULTS = {
    appConfigStore: "file" as const,
    drainBudgetMs: 8_000,
    shutdownGraceMs: 2_000,
    statementTimeoutMs: 5_000,
    poolMax: 5,
};

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
    const v = env[key];
    if (v === undefined || v === "") {
        throw new Error(`wiring: ${key} is required and was not set`);
    }
    return v;
}

function optionalPositiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
    const raw = env[key];
    if (raw === undefined) return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`wiring: ${key} must be a positive integer, got ${JSON.stringify(raw)}`);
    }
    return n;
}

/**
 * Read and validate the environment into a {@link WiringConfig}.
 *
 * Pure given its input (defaults to `process.env` but takes any
 * `ProcessEnv`-shaped object, so tests never have to mutate real env vars).
 * Throws synchronously on the first problem found -- the cheapest possible
 * failure, before anything is constructed.
 *
 * This is a minimal surface for this phase only, not the full P7 config
 * block (dispatcher pool size, retention window, reaper threshold, claim
 * interval are not here -- they stay at their `Dispatcher`/`OperationStore`
 * defaults until P7 exposes them).
 */
export function loadWiringConfig(env: NodeJS.ProcessEnv = process.env): WiringConfig {
    const databaseUrl = requireEnv(env, "DATABASE_URL");
    const connectorBundleDir = requireEnv(env, "CONNECTOR_BUNDLE_DIR");

    const rawStore = env["APP_CONFIG_STORE"];
    const appConfigStore = rawStore === undefined ? CONFIG_DEFAULTS.appConfigStore : rawStore;
    if (appConfigStore !== "file" && appConfigStore !== "iga") {
        throw new Error(
            `wiring: APP_CONFIG_STORE must be "file" or "iga", got ${JSON.stringify(rawStore)}`);
    }

    const config: WiringConfig = {
        databaseUrl,
        connectorBundleDir,
        appConfigStore,
        drainBudgetMs: optionalPositiveInt(env, "DISPATCHER_DRAIN_BUDGET_MS", CONFIG_DEFAULTS.drainBudgetMs),
        shutdownGraceMs: optionalPositiveInt(
            env, "DISPATCHER_SHUTDOWN_GRACE_MS", CONFIG_DEFAULTS.shutdownGraceMs),
        statementTimeoutMs: optionalPositiveInt(
            env, "DISPATCHER_POOL_STATEMENT_TIMEOUT_MS", CONFIG_DEFAULTS.statementTimeoutMs),
        logger: { error: (m) => console.error(m) },
    };

    if (appConfigStore === "file") {
        config.appConfigDir = requireEnv(env, "APP_CONFIG_DIR");
    } else {
        config.iga = {
            tokenUrl: requireEnv(env, "IGA_TOKEN_URL"),
            clientId: requireEnv(env, "IGA_CLIENT_ID"),
            clientSecret: requireEnv(env, "IGA_CLIENT_SECRET"),
            scope: env["IGA_SCOPE"],
            audience: env["IGA_AUDIENCE"],
            resource: env["IGA_RESOURCE"],
        };
    }

    return config;
}

interface RunningWiring {
    pool: Pool;
    store: OperationStore;
    manager: ConnectorManager;
    dispatcher: Dispatcher;
    registrar: ApplicationRegistrar;
    drainBudgetMs: number;
    shutdownGraceMs: number;
    logger: { error(msg: string): void };
}

let running: RunningWiring | undefined;

/** Whether `start()` has completed and `stop()` has not yet been called. */
export function isRunning(): boolean {
    return running !== undefined;
}

/**
 * Register an application if it is not already known, so operations enqueued
 * for it can be claimed.
 *
 * Nothing in this phase calls this on its own -- there are no routes yet.
 * P4's admission layer is where it belongs: a route handler calls this
 * (synchronous, while the caller waits) before `store.enqueue(...)`, which is
 * what "an application becomes known the first time an operation names it"
 * actually means end to end. Exposed now because the claim loop has nothing
 * to claim without it: `Dispatcher` reads an instance's config straight from
 * the registry, and an application nothing ever registered is invisible to
 * `computeAvailability` -- not rejected, just silently never claimed.
 */
export async function ensureApplication(applicationId: string): Promise<void> {
    if (!running) throw new Error("wiring: ensureApplication() called while not running");
    await running.registrar.ensure(applicationId);
}

/**
 * The running `OperationStore`, for the HTTP layer (P4) to enqueue against
 * and read status from. Guarded the same way as `ensureApplication()`.
 */
export function getStore(): OperationStore {
    if (!running) throw new Error("wiring: getStore() called while not running");
    return running.store;
}

/**
 * The running `ConnectorManager`, for the HTTP layer's synchronous read
 * routes (get/search) to acquire a lease against directly -- those never go
 * through the operation table.
 */
export function getManager(): ConnectorManager {
    if (!running) throw new Error("wiring: getManager() called while not running");
    return running.manager;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Construct the config store this phase is prepared to run with.
 *
 * `"file"` is fully wired: `FileApplicationConfigStore` over the configured
 * directory. `"iga"` validates outbound credentials -- constructing an
 * `IgaTokenProvider` and fetching one token, so a bad client secret fails
 * here with the token endpoint's status in the message, exactly as if a real
 * IGA-backed store were about to use it -- and then refuses to boot, because
 * that store does not exist until P7. Building it now, ahead of need, is
 * exactly what P0 said not to do; this still proves the credential-failure
 * path through a real `start()` rather than only through a unit test of
 * `IgaTokenProvider` in isolation.
 */
async function buildConfigStore(
    config: WiringConfig,
): Promise<{ store: ApplicationConfigStore; tokenProvider: IgaTokenProvider | undefined }> {
    if (config.appConfigStore === "file") {
        if (config.appConfigDir === undefined) {
            throw new Error("wiring: appConfigDir is required when appConfigStore is \"file\"");
        }
        return { store: new FileApplicationConfigStore(config.appConfigDir), tokenProvider: undefined };
    }

    if (config.iga === undefined) {
        throw new Error("wiring: iga config is required when appConfigStore is \"iga\"");
    }
    const tokenProvider = new IgaTokenProvider(config.iga);
    await tokenProvider.getToken();
    throw new Error(
        "wiring: APP_CONFIG_STORE=iga validated its credentials, but the IGA-backed " +
        "ApplicationConfigStore is not built until Phase P7. Use APP_CONFIG_STORE=file for now.");
}

/**
 * Build and start every piece of the data path, in order: dispatcher pool,
 * `OperationStore`, the application config store (and, if selected, the IGA
 * token it authenticates with), the connector registry and loader, the
 * connector manager, a metrics sink, the application registrar, and the
 * dispatcher itself.
 *
 * Any failure at any step tears down whatever was already constructed, in
 * reverse order, and rejects with the original error -- `running` is
 * published only once every step has succeeded, so a failed `start()` never
 * leaves partial state for a caller to mistake as live, and a second
 * `start()` after a failure is not blocked by one.
 *
 * Registration stays lazy: nothing here loops over known application ids and
 * calls `registerInstance`. `loadExternalConnectors` registers connector
 * **factories** (code) only; an application becomes known to the registry
 * the first time an operation names it, through `ApplicationRegistrar`. That
 * split -- code loaded eagerly at boot, config pulled lazily per
 * application -- is what P1 settled and this phase must not undo.
 */
export async function start(config: WiringConfig = loadWiringConfig()): Promise<void> {
    if (running) {
        throw new Error("wiring: start() called while already running; call stop() first");
    }

    let pool: Pool | undefined;
    let registry: ConnectorRegistry | undefined;
    let manager: ConnectorManager | undefined;

    try {
        pool = new Pool({
            connectionString: config.databaseUrl,
            max: CONFIG_DEFAULTS.poolMax,
            statement_timeout: config.statementTimeoutMs,
        });
        // An explicit reachability check: a bad DATABASE_URL must fail here,
        // not surface opaquely on the first claim cycle.
        await pool.query("SELECT 1");

        const store = new OperationStore(pool);
        const { store: configStore } = await buildConfigStore(config);

        registry = new ConnectorRegistry();

        const metrics: MetricsSink = consoleMetricsSink;

        // Factories only. A bundle directory whose manifest.json declares
        // `instances`/ships `instances.json` makes loadExternalConnectors
        // eagerly call registerInstance per entry -- that bootstrap path
        // predates this service's lazy-registration design and must not be
        // used by bundles configured for this service.
        await loadExternalConnectors(config.connectorBundleDir, registry);

        manager = new ConnectorManager(registry, { logger: config.logger, metrics });
        manager.start();

        const registrar = new ApplicationRegistrar(configStore, registry, {
            manager,
            drainTimeoutMs: 30_000,
        });

        const dispatcher = new Dispatcher({
            store,
            manager,
            registry,
            config: { metrics, logger: config.logger },
            scheduling: registrar.schedulingOf.bind(registrar),
        });
        dispatcher.start();

        running = {
            pool,
            store,
            manager,
            dispatcher,
            registrar,
            drainBudgetMs: config.drainBudgetMs,
            shutdownGraceMs: config.shutdownGraceMs,
            logger: config.logger,
        };
    } catch (err) {
        if (manager) await manager.shutdown().catch(() => { /* teardown is best effort */ });
        if (registry) await registry.disposeAll().catch(() => { /* nothing eager was registered */ });
        if (pool) await pool.end().catch(() => { /* pool may already be broken */ });
        throw err;
    }
}

/**
 * Stop claiming, drain in-flight work up to a budget, and release everything.
 *
 * A no-op if `start()` has not succeeded or `stop()` has already run --
 * `running` is cleared synchronously before any `await`, so a second SIGTERM
 * (or a `stop()` called twice) returns immediately rather than re-entering
 * teardown.
 *
 * The second-stage grace wait exists because `ConnectorManager.shutdown()`
 * (framework code) disposes every live connector instance unconditionally --
 * unlike its own `evict()`, it has no guard against a nonzero lease
 * refcount. That may well be intentional: the same "caller drains before
 * disposing" contract `ApplicationRegistrar.drainLeases()` already assumes
 * for re-registration. Either way, calling `manager.shutdown()` the instant
 * `dispatcher.stop()` gives up waiting risks tearing a connector down under
 * an attempt that is still genuinely in flight, which is a worse outcome
 * than the stranded-RUNNING-row recoverable-by-the-reaper case the drain
 * budget alone accepts. Polling `inFlightCount` a little longer here costs
 * nothing when there is nothing left running, and only spends time that was
 * going to be spent anyway when there is.
 */
export async function stop(): Promise<void> {
    if (!running) return;
    const w = running;
    running = undefined;

    await w.dispatcher.stop({ drainBudgetMs: w.drainBudgetMs });

    const graceDeadline = Date.now() + w.shutdownGraceMs;
    while (w.dispatcher.inFlightCount > 0 && Date.now() < graceDeadline) {
        await sleep(50);
    }
    if (w.dispatcher.inFlightCount > 0) {
        w.logger.error(
            `[wiring] stop(): ${w.dispatcher.inFlightCount} operation(s) still in flight after ` +
            "the drain budget and grace window; proceeding to shut down. The reaper recovers them.");
    }

    await w.manager.shutdown().catch((e: unknown) => {
        w.logger.error(`[wiring] manager.shutdown() failed: ${(e as Error).message}`);
    });
    await w.pool.end().catch((e: unknown) => {
        w.logger.error(`[wiring] pool.end() failed: ${(e as Error).message}`);
    });
}
