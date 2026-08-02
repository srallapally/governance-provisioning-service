/**
 * Process entrypoint.
 *
 * Everything that constructs the data path lives in `provisioning/wiring.js`
 * and is safely importable without side effects -- this file is the only
 * place that touches `process.on(...)`, so a test that imports `start`/
 * `stop` to drive them directly never picks up a signal handler it didn't
 * ask for.
 *
 * Deployment is a single Docker container with nothing external restarting
 * it (settled at P0): a failed `start()` must exit nonzero rather than leave
 * a half-wired process running, and a signal must drain rather than exit
 * immediately, because nothing else will give an in-flight operation the
 * chance to finish or be left resumably `RUNNING` for the reaper.
 *
 * P4 adds the HTTP server on top. Shutdown order matters: `server.close()`
 * first, so nothing new can enqueue while `stop()` drains the dispatcher,
 * then `stop()` itself.
 */
import type { Server } from "node:http";
import { ensureApplication, getManager, getStore, loadWiringConfig, start, stop } from "./provisioning/wiring.js";
import { createApp } from "./http/app.js";
import { requireJwt, getJwtConfig } from "./http/auth.js";
import { loadHttpConfig } from "./http/loadHttpConfig.js";
import { checkAudienceIdentityCollapse } from "./http/identityCheck.js";

let shuttingDown = false;
let server: Server | undefined;

function onSignal(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[index] ${signal} received, draining...`);

    const closeServer = server
        ? new Promise<void>((resolve) => server!.close(() => resolve()))
        : Promise.resolve();

    closeServer
        .then(() => stop())
        .then(() => {
            console.log("[index] stopped cleanly, exiting");
            process.exit(0);
        })
        .catch((err: unknown) => {
            console.error(`[index] stop() failed: ${(err as Error).message}`);
            process.exit(1);
        });
}

async function main(): Promise<void> {
    const wiringConfig = loadWiringConfig();

    const collapseWarning = checkAudienceIdentityCollapse(wiringConfig.iga, getJwtConfig());
    if (collapseWarning) console.warn(`[index] ${collapseWarning}`);

    await start(wiringConfig);

    const app = createApp({
        store: getStore(),
        manager: getManager(),
        ensureApplication,
        authMiddleware: requireJwt(),
    });
    const { port } = loadHttpConfig();
    server = app.listen(port, () => {
        console.log(`[index] listening on ${port}`);
    });

    process.on("SIGTERM", () => onSignal("SIGTERM"));
    process.on("SIGINT", () => onSignal("SIGINT"));
    console.log("[index] started");
}

main().catch((err: unknown) => {
    console.error(`[index] start() failed: ${(err as Error).message}`);
    process.exit(1);
});
