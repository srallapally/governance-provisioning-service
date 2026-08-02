// src/index.js
'use strict';

const { createHttpClient } = require('./httpClient');
const { createTokenProvider } = require('./tokenProvider');
const { createObjectsApi } = require('./objects');
const { createWaitForOutcome } = require('./waitForOutcome');
const { buildMutationKey, buildCreateKey } = require('./idempotencyKey');
const errors = require('./errors');

/**
 * Build a client bound to one provisioning-service deployment.
 *
 * Auth: provide either
 *   - `auth: { tokenUrl, clientId, clientSecret, audience, scope?, resource? }`
 *     for a built-in, cached OAuth client-credentials token, or
 *   - `getAccessToken: async () => token` if IGA already owns its own
 *     token lifecycle and this client shouldn't manage one.
 * Exactly one is required.
 *
 * `fetchImpl` defaults to the global `fetch` (Node >=18); override it in
 * tests, or if a corporate proxy needs a custom agent wired through a
 * fetch-compatible wrapper.
 */
function createProvisioningClient(config = {}) {
  const { baseUrl, auth, getAccessToken: customGetAccessToken, fetchImpl } = config;

  if (!baseUrl) {
    throw new Error('createProvisioningClient: baseUrl is required');
  }
  if (!auth && !customGetAccessToken) {
    throw new Error('createProvisioningClient: provide either config.auth or config.getAccessToken');
  }
  if (auth && customGetAccessToken) {
    throw new Error('createProvisioningClient: provide config.auth OR config.getAccessToken, not both');
  }

  const tokenProvider = customGetAccessToken
      ? { getAccessToken: customGetAccessToken, invalidate: () => {} }
      : createTokenProvider({ ...auth, fetchImpl });

  const httpClient = createHttpClient({ baseUrl, getAccessToken: tokenProvider.getAccessToken, fetchImpl });
  const objectsApi = createObjectsApi(httpClient);
  const { waitForOutcome } = createWaitForOutcome(httpClient);

  return {
    ...objectsApi,
    waitForOutcome,
    buildMutationKey,
    buildCreateKey,
    invalidateToken: tokenProvider.invalidate,
  };
}

module.exports = {
  createProvisioningClient,
  ...errors,
};
