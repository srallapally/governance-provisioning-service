/**
 * `/healthz` and `/readyz` -- unauthenticated, for a container orchestrator's
 * liveness/readiness probes, not for callers of the API. Mounted in
 * `app.ts` before `authMiddleware`: a kubelet has no bearer token to send,
 * and a probe that required one would just report every pod unready.
 *
 * The two answer different questions. `/healthz` (liveness) asks only "is
 * the process alive enough to answer HTTP at all" -- it never touches the
 * store, because a slow or unreachable database should make a pod stop
 * receiving traffic, not get killed and restarted, which would drop
 * whatever it had in flight for no benefit (the database being unreachable
 * is not fixed by a new pod). `/readyz` (readiness) asks "can this pod
 * currently serve a request that needs the store," by making the cheapest
 * possible round trip to it.
 */
import { Router } from "express";
import type { OperationStoreApi } from "../ops/index.js";

export interface HealthRouterDeps {
  store: OperationStoreApi;
}

export function createHealthRouter(deps: HealthRouterDeps): Router {
  const { store } = deps;
  const router = Router();

  router.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  router.get("/readyz", async (_req, res) => {
    try {
      await store.ping();
      res.status(200).json({ status: "ok" });
    } catch (err) {
      res.status(503).json({ status: "unavailable", message: (err as Error).message });
    }
  });

  return router;
}
