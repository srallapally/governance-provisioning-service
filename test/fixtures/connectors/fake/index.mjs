// Fixture connector for wiring.test.ts.
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
    return connector;
}
