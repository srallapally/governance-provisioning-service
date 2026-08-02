// test/harness/describeWithPg.ts
//
// The vitest-facing half of the Postgres harness, kept separate from pg.ts so
// that non-test consumers (the soak script runs under plain tsx) can use the
// connection helpers without importing vitest, which throws outside a worker.

import { describe } from "vitest";
import type { PgProbe } from "./pg.js";

/**
 * Register a suite that needs Postgres, skipping it when none is available.
 *
 * The skip reason goes into the suite name so a skipped run says why, rather
 * than looking like a suite someone disabled and forgot.
 *
 * `timeoutMs` sets the default per-test timeout for the suite (overridable
 * per `it()` as usual). Vitest's own default (5000ms) is tuned for a
 * same-host Postgres; verified against a real Cloud SQL instance over the
 * public internet (P3), several tests here do tens of sequential/concurrent
 * round trips and blew past it on latency alone with no logic at fault.
 */
export function describeWithPg(
    probe: PgProbe,
    name: string,
    fn: () => void,
    timeoutMs = 20_000,
): void {
  if (!probe.available) {
    describe.skip(`${name} [skipped: ${probe.reason}]`, fn);
    return;
  }
  describe(name, fn, timeoutMs);
}
