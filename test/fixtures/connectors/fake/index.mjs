// Fixture connector for wiring.test.ts and the soak scripts.
//
// Deliberately committed rather than generated per-test into an os.tmpdir():
// this factory imports @governance-connector-framework/core/testing, and
// Node's ESM resolution for a bare specifier walks up node_modules from the
// importing file's own location -- a tmpdir has no ancestor node_modules to
// find. Living inside this repo's tree is what makes the import resolve.
//
// No `instances` in manifest.json and no instances.json beside this file:
// either would make loadExternalConnectors call registry.registerInstance
// eagerly at load time, which is exactly the boot-time registration this
// service's lazy-registration design (P1, CP-3) exists to avoid. Tests
// register applications explicitly via wiring's ensureApplication().
import { makeFakeConnector } from "@governance-connector-framework/core/testing";

// ---------------------------------------------------------------------------
// P8 soak instrumentation
// ---------------------------------------------------------------------------
//
// test/load/soakHttp.ts drives load through the real loader, so it never
// touches the connector instances the loader builds -- unlike the older
// test/load/soak.ts, which hand-wired its own connectors and could wrap
// create() itself. This module-level state is the only place left to record
// per-attempt timing and lane concurrency; it's shared across every
// factory() call in the process because ESM caches this module by URL, which
// is exactly what lets soakHttp.ts import the same instance and read it back.
//
// `attemptLog` entries are `{ priority, instanceId, start, end }` in
// epoch ms. `priority` comes from `attrs.__priority` -- not a real ICF
// attribute, just a convention this fixture and soakHttp.ts agree on to
// correlate an attempt back to the priority class that enqueued it, since
// the connector SPI itself has no concept of priority.
export const attemptLog = [];
export let laneViolations = 0;
const inLane = new Map();

export function resetSoakInstrumentation() {
    attemptLog.length = 0;
    laneViolations = 0;
    inLane.clear();
}

// The registry calls the factory with a context object, not the raw config
// directly: { logger, config, instanceId, connectorId, connectorVersion, type }.
// The connector's own settings -- what ApplicationConfig.connectorConfig
// carries -- live at ctx.config.
export default async function factory(ctx) {
    const connector = makeFakeConnector({});
    const config = ctx?.config ?? {};
    if (config.behavior === "hang") connector.controls.hangUntilAborted();
    if (typeof config.latencyMs === "number") connector.controls.latency(config.latencyMs);
    if (config.behavior === "unknownUidOnGet") {
        // Unconditional override, not controls.failNext(): failNext is
        // one-shot and would apply to whatever call happens to be first
        // against a freshly built instance (which may not be the get() a
        // test is trying to exercise, e.g. a health check at construction).
        // This exists to prove the route maps get()'s OTHER legitimate
        // "not found" contract -- a thrown ConnectorError, not a null
        // return -- to 404 too.
        connector.get = async () => {
            const { ConnectorError } = await import("@governance-connector-framework/core");
            throw new ConnectorError("UNKNOWN_UID", "no such uid (fixture)");
        };
    }

    if (config.soakInstrumented === true) {
        const instanceId = ctx?.instanceId ?? "unknown";
        const realCreate = connector.create.bind(connector);
        connector.create = async (objectClass, attrs, options) => {
            const laneKey = `${instanceId}:${attrs?.__NAME__}`;
            const depth = (inLane.get(laneKey) ?? 0) + 1;
            inLane.set(laneKey, depth);
            if (depth > 1) laneViolations += 1;

            const entry = { priority: attrs?.__priority ?? "unknown", instanceId, start: Date.now() };
            attemptLog.push(entry);
            try {
                return await realCreate(objectClass, attrs, options);
            } finally {
                entry.end = Date.now();
                inLane.set(laneKey, (inLane.get(laneKey) ?? 1) - 1);
            }
        };
    }

    return connector;
}
