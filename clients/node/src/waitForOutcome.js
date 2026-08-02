// src/waitForOutcome.js
'use strict';

const { TimeoutError } = require('./errors');

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * There is no webhook/callback path in the provisioning service -- the
 * caller is responsible for polling GET /operations/:operationId. A
 * non-terminal status (PENDING / RUNNING / AWAITING_READBACK) carries no
 * `outcome` field; a terminal one always does. This resolves once
 * `outcome` appears, or throws TimeoutError if it doesn't within
 * `timeoutMs` -- which says nothing about the operation itself (it is
 * still non-terminal server-side); poll again later rather than treating
 * a timeout as a failure.
 */
function createWaitForOutcome(httpClient) {
  async function waitForOutcome(operationId, opts = {}) {
    const { pollMs = 500, timeoutMs = 30_000, sleepImpl = defaultSleep } = opts;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const state = await httpClient.call('GET', `/operations/${operationId}`);
      if (state.outcome) return state;
      await sleepImpl(pollMs);
    }

    throw new TimeoutError(operationId, timeoutMs);
  }

  return { waitForOutcome };
}

module.exports = { createWaitForOutcome };
