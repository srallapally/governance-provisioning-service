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
 */
import { start, stop } from "./provisioning/wiring.js";

let shuttingDown = false;

function onSignal(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[index] ${signal} received, draining...`);
    stop()
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
    await start();
    process.on("SIGTERM", () => onSignal("SIGTERM"));
    process.on("SIGINT", () => onSignal("SIGINT"));
    console.log("[index] started");
}

main().catch((err: unknown) => {
    console.error(`[index] start() failed: ${(err as Error).message}`);
    process.exit(1);
});
