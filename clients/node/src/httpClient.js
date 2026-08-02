// src/httpClient.js
'use strict';

const { HttpError, AdmissionRejectedError, NotFoundError } = require('./errors');

/**
 * The single request path every non-streaming call goes through: attach
 * the bearer token, JSON-encode the body, and map a non-2xx response to a
 * typed error instead of a bare status code.
 *
 * `rawGet` exists separately for the streaming search endpoint (see
 * objects.js), which needs the raw Response — an NDJSON body read line by
 * line, not parsed as one JSON document.
 */
function createHttpClient(options = {}) {
  const { baseUrl, getAccessToken, fetchImpl = fetch } = options;

  if (!baseUrl) throw new Error('createHttpClient: baseUrl is required');
  if (typeof getAccessToken !== 'function') {
    throw new Error('createHttpClient: getAccessToken must be a function');
  }

  async function mapErrorResponse(res) {
    const problem = await res.json().catch(() => ({}));
    const message = problem.message || res.statusText || `request failed with status ${res.status}`;

    if (res.status === 429) {
      return new AdmissionRejectedError(problem.backlogDepth, problem.priority, message, res.status);
    }
    if (res.status === 404) {
      return new NotFoundError(message, res.status, problem);
    }
    return new HttpError(message, res.status, problem.error, problem);
  }

  async function call(method, path, { body, idempotencyKey } = {}) {
    const token = await getAccessToken();
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status >= 400) {
      throw await mapErrorResponse(res);
    }
    return res.status === 204 ? null : res.json();
  }

  /** For the streaming search route — returns the raw Response, already authenticated. */
  async function rawGet(path) {
    const token = await getAccessToken();
    return fetchImpl(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  }

  return { call, rawGet, mapErrorResponse };
}

module.exports = { createHttpClient };
