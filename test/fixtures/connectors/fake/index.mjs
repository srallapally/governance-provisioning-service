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
    return connector;
}
