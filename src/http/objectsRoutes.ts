/**
 * `/instances/:instanceId/objects/:objectClass[...]` -- the object surface
 * from `openapi.yaml`. Five mutation routes (enqueue + 202) and two
 * synchronous read routes (get one, search/stream) sharing one concern:
 * lazy registration. `ensureApplication(instanceId)` runs once per request,
 * for every route including the reads -- `manager.acquire()` throws "not
 * registered" for an id nothing has named yet, and a read is just as much
 * "the first operation that names it" as a mutation is.
 */
import { randomUUID } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import type { ConnectorManager } from "@governance-connector-framework/core";
import type { OperationPriority } from "@governance-connector-framework/core";
import type { ResultsHandler } from "@governance-connector-framework/core";
import { admitAndEnqueue, type OperationStoreApi, type OperationType } from "../ops/index.js";
import { resolveNameAttribute } from "../ops/nameAttribute.js";
import { parseFilterString } from "./filter.js";
import { ValidationError } from "./errors.js";

export interface ObjectsRouterDeps {
  store: OperationStoreApi;
  manager: ConnectorManager;
  ensureApplication: (applicationId: string) => Promise<void>;
}

function idempotencyKeyOf(req: Request): string {
  const header = req.header("Idempotency-Key");
  return header && header.trim() !== "" ? header.trim() : randomUUID();
}

function priorityOf(body: unknown): OperationPriority | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const raw = (body as Record<string, unknown>).priority;
  if (raw === undefined) return undefined;
  if (raw !== "interactive" && raw !== "batch") {
    throw new ValidationError(`priority must be "interactive" or "batch", got: ${JSON.stringify(raw)}`);
  }
  return raw;
}

/** `attributes` must be present and a plain object, matching `AttributesRequest`/`CreateRequest`. */
function attributesOf(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  const attributes = (body as Record<string, unknown>).attributes;
  if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes)) {
    throw new ValidationError("attributes is required and must be an object");
  }
  return attributes as Record<string, unknown>;
}

function respondAccepted(res: Response, result: { id: string; deduplicated: boolean }, idempotencyKey: string): void {
  res.status(202).json({ operationId: result.id, status: "PENDING", idempotencyKey });
}

/** The slice of `http.ServerResponse` the NDJSON handler needs, so it's testable without a real socket. */
export interface NdjsonSink {
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): void;
  readonly writableEnded: boolean;
}

/**
 * Build the `ResultsHandler` a streaming search writes NDJSON through.
 *
 * Backpressure at the source, no buffering: a full response buffer makes
 * `write()` return `false`, and the handler awaits `drain` before asking the
 * connector for the next result rather than letting more pile up in memory.
 * A gone client (`isClientGone()`) or an already-ended response stop
 * production the same way a full buffer does -- `false` either way.
 *
 * Exported and decoupled from Express/http so it can be tested directly
 * against a mock sink. `@governance-connector-framework/core`'s
 * `FakeConnector` streaming path doesn't await a handler's `Promise<boolean>`
 * (it only checks `=== false`, a plain boolean), so it cannot exercise this
 * function's async backpressure/early-stop behaviour through an end-to-end
 * HTTP test -- documented in the P4 plan notes, not silently worked around.
 */
export function makeNdjsonHandler(sink: NdjsonSink, isClientGone: () => boolean): ResultsHandler {
  return async (obj) => {
    if (isClientGone() || sink.writableEnded) return false;
    const ok = sink.write(`${JSON.stringify(obj)}\n`);
    if (!ok) {
      await new Promise<void>((resolve) => sink.once("drain", resolve));
    }
    return !isClientGone() && !sink.writableEnded;
  };
}

export function createObjectsRouter(deps: ObjectsRouterDeps): Router {
  const { store, manager, ensureApplication } = deps;
  const router = Router();

  router.use("/instances/:instanceId/objects/:objectClass", async (req, _res, next) => {
    try {
      await ensureApplication(req.params.instanceId!);
      next();
    } catch (err) {
      next(err);
    }
  });

  function enqueueRoute(opType: OperationType, requiresAttributes: boolean) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { instanceId, objectClass } = req.params as { instanceId: string; objectClass: string };
        const uid = (req.params as { uid?: string }).uid;
        const priority = priorityOf(req.body);
        const idempotencyKey = idempotencyKeyOf(req);
        const attrs = requiresAttributes ? attributesOf(req.body) : undefined;

        let nameAttrValue: string | undefined;
        if (opType === "CREATE") {
          const lease = await manager.acquire(instanceId);
          let nameAttribute: string;
          try {
            nameAttribute = await resolveNameAttribute(lease, objectClass);
          } finally {
            lease.release();
          }
          const raw = attrs?.[nameAttribute];
          if (typeof raw !== "string" || raw === "") {
            throw new ValidationError(
                `attributes.${nameAttribute} (the naming attribute) is required for CREATE`);
          }
          nameAttrValue = raw;
        }

        const result = await admitAndEnqueue(store, {
          instanceId,
          objectClass,
          opType,
          idempotencyKey,
          priority,
          uid: uid ?? null,
          nameAttrValue: nameAttrValue ?? null,
          attrs: attrs ?? null,
        });
        respondAccepted(res, result, idempotencyKey);
      } catch (err) {
        next(err);
      }
    };
  }

  router.post("/instances/:instanceId/objects/:objectClass", enqueueRoute("CREATE", true));
  router.put("/instances/:instanceId/objects/:objectClass/:uid", enqueueRoute("UPDATE", true));
  router.delete("/instances/:instanceId/objects/:objectClass/:uid", enqueueRoute("DELETE", false));
  router.post("/instances/:instanceId/objects/:objectClass/:uid/add-values", enqueueRoute("ADD_VALUES", true));
  router.post("/instances/:instanceId/objects/:objectClass/:uid/remove-values", enqueueRoute("REMOVE_VALUES", true));

  router.get("/instances/:instanceId/objects/:objectClass/:uid", async (req, res, next) => {
    const { instanceId, objectClass, uid } = req.params as
        { instanceId: string; objectClass: string; uid: string };
    const lease = await manager.acquire(instanceId).catch((err: unknown) => { next(err); return undefined; });
    if (!lease) return;
    try {
      const object = await lease.facade.get(objectClass, uid);
      if (!object) { res.status(404).json({ error: "not_found", message: `no object with uid ${uid}` }); return; }
      res.status(200).json(object);
    } catch (err) {
      next(err);
    } finally {
      lease.release();
    }
  });

  router.get("/instances/:instanceId/objects/:objectClass", async (req, res, next) => {
    const { instanceId, objectClass } = req.params as { instanceId: string; objectClass: string };
    const rawFilter = req.query.filter;

    let filter;
    try {
      filter = typeof rawFilter === "string" ? parseFilterString(rawFilter) : undefined;
    } catch (err) {
      next(err);
      return;
    }

    const lease = await manager.acquire(instanceId).catch((err: unknown) => { next(err); return undefined; });
    if (!lease) return;

    let clientGone = false;
    req.on("close", () => { clientGone = true; });

    const handler = makeNdjsonHandler(res, () => clientGone);

    try {
      res.status(200).setHeader("content-type", "application/x-ndjson");
      await lease.facade.search(objectClass, filter, handler);
      res.end();
    } catch (err) {
      if (res.headersSent) {
        // Mid-stream failure: the status line is already committed to 200,
        // so there's no clean way to report the error in-band. End the
        // response; the client sees a truncated NDJSON stream rather than a
        // hang, and the error is still logged via the outer error handler
        // for anything that hasn't already written to the socket.
        res.end();
      } else {
        next(err);
      }
    } finally {
      lease.release();
    }
  });

  return router;
}
