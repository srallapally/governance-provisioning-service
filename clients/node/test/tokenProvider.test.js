// test/tokenProvider.test.js
'use strict';

const { createTokenProvider } = require('../src/tokenProvider');

function tokenResponse(accessToken, expiresIn) {
  return { ok: true, json: async () => ({ access_token: accessToken, expires_in: expiresIn }) };
}

function baseOpts(fetchImpl) {
  return { tokenUrl: 'https://issuer.internal/oauth/token', clientId: 'iga', clientSecret: 'shh', audience: 'provisioning-service', fetchImpl };
}

describe('createTokenProvider', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('requires tokenUrl, clientId, and clientSecret', () => {
    expect(() => createTokenProvider({ clientId: 'a', clientSecret: 'b' })).toThrow(/tokenUrl/);
    expect(() => createTokenProvider({ tokenUrl: 'https://x', clientSecret: 'b' })).toThrow(/clientId/);
    expect(() => createTokenProvider({ tokenUrl: 'https://x', clientId: 'a' })).toThrow(/clientSecret/);
  });

  it('fetches a token using the client-credentials grant, including audience', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse('tok-1', 3600));
    const { getAccessToken } = createTokenProvider(baseOpts(fetchImpl));

    const token = await getAccessToken();
    expect(token).toBe('tok-1');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://issuer.internal/oauth/token');
    const body = new URLSearchParams(init.body);
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_id')).toBe('iga');
    expect(body.get('client_secret')).toBe('shh');
    expect(body.get('audience')).toBe('provisioning-service');
  });

  it('caches the token and does not refetch before the early-expiry margin', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse('tok-1', 3600));
    const { getAccessToken } = createTokenProvider(baseOpts(fetchImpl));

    await getAccessToken();
    vi.advanceTimersByTime(3600 * 1000 - 60_000); // well inside expiry
    await getAccessToken();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refetches once inside the early-expiry margin', async () => {
    const fetchImpl = vi.fn()
        .mockResolvedValueOnce(tokenResponse('tok-1', 3600))
        .mockResolvedValueOnce(tokenResponse('tok-2', 3600));
    const { getAccessToken } = createTokenProvider(baseOpts(fetchImpl));

    await getAccessToken();
    vi.advanceTimersByTime(3600 * 1000 - 10_000); // inside the default 30s margin
    const second = await getAccessToken();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(second).toBe('tok-2');
  });

  it('invalidate() forces the next call to refetch', async () => {
    const fetchImpl = vi.fn()
        .mockResolvedValueOnce(tokenResponse('tok-1', 3600))
        .mockResolvedValueOnce(tokenResponse('tok-2', 3600));
    const { getAccessToken, invalidate } = createTokenProvider(baseOpts(fetchImpl));

    await getAccessToken();
    invalidate();
    const second = await getAccessToken();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(second).toBe('tok-2');
  });

  it('defaults expires_in to 300s when the token endpoint omits it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: 'tok-1' }) });
    const { getAccessToken } = createTokenProvider(baseOpts(fetchImpl));

    await getAccessToken();
    vi.advanceTimersByTime(300 * 1000 - 60_000);
    await getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // still cached

    vi.advanceTimersByTime(60_000 + 1);
    await getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(2); // now past the default lifetime
  });

  it('throws when the token endpoint responds non-ok', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'invalid_client',
    });
    const { getAccessToken } = createTokenProvider(baseOpts(fetchImpl));
    await expect(getAccessToken()).rejects.toThrow(/401/);
  });

  it('throws when the response has no access_token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const { getAccessToken } = createTokenProvider(baseOpts(fetchImpl));
    await expect(getAccessToken()).rejects.toThrow(/access_token/);
  });
});
