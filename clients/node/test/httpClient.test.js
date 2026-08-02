// test/httpClient.test.js
'use strict';

const { createHttpClient } = require('../src/httpClient');
const { HttpError, AdmissionRejectedError, NotFoundError } = require('../src/errors');

function jsonResponse(status, body) {
  return {
    status,
    statusText: `status ${status}`,
    ok: status < 400,
    json: async () => body,
  };
}

function client(fetchImpl) {
  return createHttpClient({
    baseUrl: 'https://provisioning.internal:3000',
    getAccessToken: async () => 'test-token',
    fetchImpl,
  });
}

describe('createHttpClient', () => {
  it('requires baseUrl', () => {
    expect(() => createHttpClient({ getAccessToken: async () => 't' })).toThrow(/baseUrl/);
  });

  it('requires getAccessToken to be a function', () => {
    expect(() => createHttpClient({ baseUrl: 'https://x', getAccessToken: 'nope' })).toThrow(/getAccessToken/);
  });

  it('sends the bearer token and JSON content-type on every call', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(202, { operationId: 'op-1', status: 'PENDING' }));
    const { call } = client(fetchImpl);

    await call('POST', '/instances/x/objects/__ACCOUNT__', { body: { attributes: {} } });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://provisioning.internal:3000/instances/x/objects/__ACCOUNT__');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer test-token');
    expect(init.headers['content-type']).toBe('application/json');
  });

  it('includes an Idempotency-Key header only when one is given', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(202, {}));
    const { call } = client(fetchImpl);

    await call('POST', '/x', { body: {}, idempotencyKey: 'key-1' });
    expect(fetchImpl.mock.calls[0][1].headers['idempotency-key']).toBe('key-1');

    fetchImpl.mockClear();
    await call('POST', '/x', { body: {} });
    expect(fetchImpl.mock.calls[0][1].headers).not.toHaveProperty('idempotency-key');
  });

  it('returns the parsed JSON body on 2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { hello: 'world' }));
    const { call } = client(fetchImpl);
    await expect(call('GET', '/x')).resolves.toEqual({ hello: 'world' });
  });

  it('returns null on 204', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(204, {}));
    const { call } = client(fetchImpl);
    await expect(call('DELETE', '/x')).resolves.toBeNull();
  });

  it('throws AdmissionRejectedError on 429, carrying backlogDepth and priority', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse(429, { error: 'admission_rejected', message: 'backlog full', backlogDepth: 1000, priority: 'interactive' }));
    const { call } = client(fetchImpl);

    await expect(call('POST', '/x')).rejects.toBeInstanceOf(AdmissionRejectedError);
    try {
      await call('POST', '/x');
    } catch (err) {
      expect(err.backlogDepth).toBe(1000);
      expect(err.priority).toBe('interactive');
      expect(err.status).toBe(429);
    }
  });

  it('throws NotFoundError on 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, { error: 'not_found', message: 'no operation with that id' }));
    const { call } = client(fetchImpl);
    await expect(call('GET', '/operations/does-not-exist')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws a generic HttpError on other 4xx/5xx, preserving the service error code', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse(400, { error: 'validation_failed', message: 'attributes is required' }));
    const { call } = client(fetchImpl);

    await expect(call('POST', '/x')).rejects.toBeInstanceOf(HttpError);
    try {
      await call('POST', '/x');
    } catch (err) {
      expect(err.status).toBe(400);
      expect(err.code).toBe('validation_failed');
      expect(err.message).toBe('attributes is required');
    }
  });

  it('falls back to statusText when the error body is not valid JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 500, statusText: 'Internal Server Error', ok: false,
      json: async () => { throw new SyntaxError('not json'); },
    });
    const { call } = client(fetchImpl);

    await expect(call('POST', '/x')).rejects.toMatchObject({ message: 'Internal Server Error', status: 500 });
  });
});
