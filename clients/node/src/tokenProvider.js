// src/tokenProvider.js
'use strict';

const DEFAULT_EARLY_EXPIRY_MS = 30_000;
const DEFAULT_EXPIRES_IN_SEC = 300;

/**
 * OAuth 2.0 client-credentials token provider, cached until just before
 * expiry. The provisioning service checks the token's `aud` claim against
 * its own JWT_EXPECTED_AUD -- `audience` here must match that value, not
 * this client's own identity.
 *
 * A fresh instance owns its own cache; two instances (e.g. one per
 * provisioning-service deployment, if IGA talks to more than one) never
 * share a token by accident.
 */
function createTokenProvider(options = {}) {
  const {
    tokenUrl,
    clientId,
    clientSecret,
    audience,
    scope,
    resource,
    fetchImpl = fetch,
    earlyExpiryMs = DEFAULT_EARLY_EXPIRY_MS,
  } = options;

  if (!tokenUrl) throw new Error('createTokenProvider: tokenUrl is required');
  if (!clientId) throw new Error('createTokenProvider: clientId is required');
  if (!clientSecret) throw new Error('createTokenProvider: clientSecret is required');

  let cachedToken = null;
  let expiresAt = 0;

  async function getAccessToken() {
    if (cachedToken && Date.now() < expiresAt - earlyExpiryMs) {
      return cachedToken;
    }

    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
    if (audience) body.set('audience', audience);
    if (scope) body.set('scope', scope);
    if (resource) body.set('resource', resource);

    const res = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`token request failed (${res.status} ${res.statusText}): ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    if (typeof json.access_token !== 'string' || json.access_token === '') {
      throw new Error('token response missing access_token');
    }

    const expiresInSec = typeof json.expires_in === 'number' && json.expires_in > 0
        ? json.expires_in
        : DEFAULT_EXPIRES_IN_SEC;

    cachedToken = json.access_token;
    expiresAt = Date.now() + expiresInSec * 1000;
    return cachedToken;
  }

  /** Forces the next getAccessToken() to fetch, regardless of cached expiry. Use on a 401. */
  function invalidate() {
    cachedToken = null;
    expiresAt = 0;
  }

  return { getAccessToken, invalidate };
}

module.exports = { createTokenProvider };
