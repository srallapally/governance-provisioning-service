// test/waitForOutcome.test.js
'use strict';

const { createWaitForOutcome } = require('../src/waitForOutcome');
const { TimeoutError } = require('../src/errors');

function fakeHttpClient(sequence) {
  let i = 0;
  return { call: vi.fn(async () => sequence[Math.min(i++, sequence.length - 1)]) };
}

describe('waitForOutcome', () => {
  it('returns immediately once a terminal outcome appears', async () => {
    const httpClient = fakeHttpClient([
      { status: 'PENDING' },
      { status: 'RUNNING' },
      { status: 'SUCCEEDED', outcome: 'SUCCEEDED', result: { uid: 'u-1' } },
    ]);
    const { waitForOutcome } = createWaitForOutcome(httpClient);
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    const final = await waitForOutcome('op-1', { sleepImpl, pollMs: 1 });

    expect(final.outcome).toBe('SUCCEEDED');
    expect(httpClient.call).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
  });

  it('returns on the first call if already terminal', async () => {
    const httpClient = fakeHttpClient([{ status: 'FAILED_CONFIRMED', outcome: 'FAILED_CONFIRMED' }]);
    const { waitForOutcome } = createWaitForOutcome(httpClient);

    const final = await waitForOutcome('op-1', { sleepImpl: vi.fn() });
    expect(final.outcome).toBe('FAILED_CONFIRMED');
  });

  it('throws TimeoutError when the deadline elapses with no terminal outcome', async () => {
    const httpClient = fakeHttpClient([{ status: 'PENDING' }]);
    const { waitForOutcome } = createWaitForOutcome(httpClient);

    let now = 0;
    const sleepImpl = vi.fn(async (ms) => { now += ms; });
    const originalNow = Date.now;
    Date.now = () => now;

    try {
      await expect(waitForOutcome('op-1', { pollMs: 100, timeoutMs: 250, sleepImpl }))
          .rejects.toBeInstanceOf(TimeoutError);
    } finally {
      Date.now = originalNow;
    }
  });

  it('TimeoutError carries the operationId and timeoutMs', async () => {
    const httpClient = fakeHttpClient([{ status: 'RUNNING' }]);
    const { waitForOutcome } = createWaitForOutcome(httpClient);

    let now = 0;
    const sleepImpl = vi.fn(async (ms) => { now += ms; });
    const originalNow = Date.now;
    Date.now = () => now;

    expect.assertions(3);
    try {
      await waitForOutcome('op-42', { pollMs: 50, timeoutMs: 100, sleepImpl });
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      expect(err.operationId).toBe('op-42');
      expect(err.timeoutMs).toBe(100);
    } finally {
      Date.now = originalNow;
    }
  });
});
