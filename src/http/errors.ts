/**
 * Maps every error shape a route can throw to an HTTP status and an
 * `openapi.yaml` `Problem`/`AdmissionRejectedProblem` body.
 *
 * One thing here is a known wart, not a bug: `ConnectorManager.acquire()`
 * throws a plain `Error` with only a message string for "instance not
 * registered" and "not supported" (no typed error, no code -- confirmed by
 * reading the registry/manager source). The substring checks below are the
 * documented workaround, per the P4 plan's finding 4 -- narrow, isolated to
 * this one function, and noted in the plan's Backlog as a candidate for an
 * upstream typed error rather than filed as a framework bug now.
 */
import {
  isAdmissionRejected,
  type AdmissionRejectedError,
} from "../ops/index.js";
import { ApplicationRegistrationError } from "../config/registerApplication.js";
import {
  isConnectorError,
  isDeadlineExpired,
  type ConnectorErrorCode,
} from "@governance-connector-framework/core";
import { FilterSyntaxError } from "./filter.js";

export interface Problem {
  error: string;
  message: string;
}

/** Thrown by request-body/param validation. Always maps to 400. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export interface AdmissionRejectedProblem extends Problem {
  backlogDepth: number;
  priority: string;
}

export interface MappedError {
  status: number;
  body: Problem | AdmissionRejectedProblem;
}

const CONNECTOR_ERROR_STATUS: Record<ConnectorErrorCode, number> = {
  UNKNOWN_UID: 404,
  INVALID_ATTRIBUTE: 400,
  ALREADY_EXISTS: 409,
  PERMISSION_DENIED: 403,
  CONNECTION_FAILED: 502,
  RATE_LIMIT_TARGET: 429,
  UNKNOWN: 500,
};

function admissionProblem(err: AdmissionRejectedError): AdmissionRejectedProblem {
  return {
    error: "admission_rejected",
    message: err.message,
    backlogDepth: err.backlogDepth,
    priority: err.priority,
  };
}

/** True for the untyped `Error`s `acquire()` throws for an id nothing registered. */
function isUnregisteredInstance(err: Error): boolean {
  return err.message.includes("is not registered");
}

/** True for the untyped `Error` a facade throws when the connector doesn't implement the op. */
function isUnsupportedOp(err: Error): boolean {
  return err.message.endsWith("not supported");
}

export function mapError(err: unknown): MappedError {
  if (isAdmissionRejected(err)) {
    return { status: 429, body: admissionProblem(err) };
  }
  if (err instanceof ApplicationRegistrationError) {
    return { status: 400, body: { error: "invalid_application", message: err.message } };
  }
  if (err instanceof FilterSyntaxError) {
    return { status: 400, body: { error: "invalid_filter", message: err.message } };
  }
  if (err instanceof ValidationError) {
    return { status: 400, body: { error: "validation_failed", message: err.message } };
  }
  if (isConnectorError(err)) {
    return {
      status: CONNECTOR_ERROR_STATUS[err.code],
      body: { error: err.code.toLowerCase(), message: err.message },
    };
  }
  if (isDeadlineExpired(err)) {
    return { status: 504, body: { error: "deadline_expired", message: err.message } };
  }
  if (err instanceof Error) {
    if (isUnregisteredInstance(err) || isUnsupportedOp(err)) {
      return { status: 404, body: { error: "not_found", message: err.message } };
    }
    if (err.message.includes("is shutting down")) {
      return { status: 503, body: { error: "unavailable", message: err.message } };
    }
  }
  return { status: 500, body: { error: "internal_error", message: "An internal error occurred" } };
}
