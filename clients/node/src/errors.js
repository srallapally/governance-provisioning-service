// src/errors.js
'use strict';

/**
 * A non-2xx response from the provisioning service that isn't better
 * represented by a more specific error class below.
 *
 * Carries the parsed Problem body (`{ error, message }` from openapi.yaml)
 * alongside the HTTP status, so a caller can branch on `err.code`
 * (the service's own error string, e.g. "validation_failed",
 * "unknown_uid") without parsing `err.message`.
 */
class HttpError extends Error {
  constructor(message, status, code, body) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * 429 — the backlog for this instance/priority is at its admission cap.
 *
 * Distinguished from HttpError because this is the one error a caller is
 * expected to handle specifically: back off and retry later, using
 * backlogDepth to decide how long. See the security review, SEC-5, for
 * why this is a shared, not per-caller, budget — one noisy caller can
 * produce this for every other caller of the same instance.
 */
class AdmissionRejectedError extends HttpError {
  constructor(backlogDepth, priority, message, status) {
    super(message, status, 'admission_rejected', { backlogDepth, priority });
    this.name = 'AdmissionRejectedError';
    this.backlogDepth = backlogDepth;
    this.priority = priority;
  }
}

/** The requested operation, instance, or object was not found (404). */
class NotFoundError extends HttpError {
  constructor(message, status, body) {
    super(message, status, 'not_found', body);
    this.name = 'NotFoundError';
  }
}

/** Thrown by waitForOutcome() when timeoutMs elapses with no terminal outcome. */
class TimeoutError extends Error {
  constructor(operationId, timeoutMs) {
    super(`operation ${operationId} did not reach a terminal outcome within ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.operationId = operationId;
    this.timeoutMs = timeoutMs;
  }
}

function isAdmissionRejected(err) {
  return err instanceof AdmissionRejectedError;
}

function isHttpError(err) {
  return err instanceof HttpError;
}

module.exports = {
  HttpError,
  AdmissionRejectedError,
  NotFoundError,
  TimeoutError,
  isAdmissionRejected,
  isHttpError,
};
