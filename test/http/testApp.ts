// test/http/testApp.ts
//
// Shared setup for objectsRoutes.test.ts/operationsRoutes.test.ts: stands up
// the real wiring (real Postgres, the fixture connector bundle) and wraps it
// in createApp() with a pass-through auth middleware. Auth itself is
// auth.test.ts's job -- these files test route logic, not JWT verification,
// and a pass-through here means they need no JWKS server of their own.
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Express, RequestHandler } from "express";
import { start, ensureApplication, getStore, getManager, type WiringConfig } from "../../src/provisioning/wiring.js";
import { createApp } from "../../src/http/app.js";
import type { PgProbe } from "../harness/pg.js";

export const FIXTURE_CONNECTORS = path.join(import.meta.dirname, "..", "fixtures", "connectors");

const passThroughAuth: RequestHandler = (_req, _res, next) => { next(); };

export async function makeAppConfigDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "http-appcfg-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function writeAppConfig(
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

export function baseConfig(probe: PgProbe, overrides: Partial<WiringConfig> = {}): WiringConfig {
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

/** Starts wiring and returns the Express app built on top of it. Caller owns `stop()`. */
export async function startTestApp(config: WiringConfig): Promise<Express> {
  await start(config);
  return createApp({
    store: getStore(),
    manager: getManager(),
    ensureApplication,
    authMiddleware: passThroughAuth,
  });
}
