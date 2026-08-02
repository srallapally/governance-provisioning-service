/**
 * Assembles the Express app: JSON body parsing, auth in front of every
 * route (including status -- an operationId is a capability, P0's finding),
 * the two routers, and a catch-all error handler.
 *
 * `authMiddleware` is injected rather than imported here and wired
 * internally: `auth.ts` validates `JWT_*` env and builds a JWKS client at
 * module load, which is exactly the fail-fast behaviour the real process
 * wants but is awkward for a test that wants to control that env per run
 * (the framework's own auth tests dynamically import `auth.ts` after
 * setting env for the same reason). Injecting it here means route tests
 * that don't care about auth can pass a trivial pass-through middleware
 * instead of standing up a real JWKS server.
 */
import express, { type Express, type NextFunction, type Request, type Response, type RequestHandler } from "express";
import type { ConnectorManager } from "@governance-connector-framework/core";
import type { OperationStoreApi } from "../ops/index.js";
import { createObjectsRouter } from "./objectsRoutes.js";
import { createOperationsRouter } from "./operationsRoutes.js";
import { mapError } from "./errors.js";

export interface CreateAppDeps {
  store: OperationStoreApi;
  manager: ConnectorManager;
  ensureApplication: (applicationId: string) => Promise<void>;
  authMiddleware: RequestHandler;
}

export function createApp(deps: CreateAppDeps): Express {
  const app = express();
  app.use(express.json());
  app.use(deps.authMiddleware);
  app.use(createObjectsRouter(deps));
  app.use(createOperationsRouter(deps));

  // Express identifies an error handler by arity (4 params); a 3-arg
  // signature here would be mistaken for a normal route.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const { status, body } = mapError(err);
    if (status >= 500) console.error("[http] unhandled error:", err);
    if (res.headersSent) { res.end(); return; }
    res.status(status).json(body);
  });

  return app;
}
