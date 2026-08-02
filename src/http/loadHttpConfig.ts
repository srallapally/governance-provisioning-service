/**
 * The HTTP surface's own tiny config slice: just `PORT`. Deliberately not
 * folded into `wiring.ts`'s `WiringConfig` -- that module's own docstring
 * says "No HTTP surface" and P2 scoped it to the data path on purpose.
 * `JWT_*` config lives entirely in `auth.ts`, validated at import time.
 */
export interface HttpConfig {
  port: number;
}

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const raw = env["PORT"];
  if (raw === undefined) return { port: 3000 };
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`http: PORT must be a valid port number, got ${JSON.stringify(raw)}`);
  }
  return { port };
}
