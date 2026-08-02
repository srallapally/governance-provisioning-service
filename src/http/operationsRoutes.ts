/** `GET /operations/:operationId` -- poll-only status, from `openapi.yaml`. */
import { Router } from "express";
import { TERMINAL_STATUSES, type OperationStoreApi } from "../ops/index.js";
import type { OperationOutcome } from "../ops/types.js";

export interface OperationsRouterDeps {
  store: OperationStoreApi;
}

export function createOperationsRouter(deps: OperationsRouterDeps): Router {
  const { store } = deps;
  const router = Router();

  router.get("/operations/:operationId", async (req, res, next) => {
    try {
      const row = await store.getStatus(req.params.operationId!);
      if (!row) {
        res.status(404).json({ error: "not_found", message: "no operation with that id" });
        return;
      }

      const outcome = (TERMINAL_STATUSES as readonly string[]).includes(row.status)
          ? row.status as OperationOutcome
          : undefined;
      const result = row.result as { uid?: string; object?: unknown } | null;

      res.status(200).json({
        operationId: row.id,
        instanceId: row.instanceId,
        objectClass: row.objectClass,
        type: row.opType,
        ...(row.priority !== undefined ? { priority: row.priority } : {}),
        status: row.status,
        ...(outcome !== undefined ? { outcome } : {}),
        ...(row.errorCode !== null ? { errorCode: row.errorCode } : {}),
        attemptCount: row.attemptCount,
        ...(result ? { result: { uid: result.uid, object: result.object } } : {}),
        createdAt: row.createdAt.toISOString(),
        ...(row.finalizedAt ? { completedAt: row.finalizedAt.toISOString() } : {}),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
