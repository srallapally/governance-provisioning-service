// test/idempotencyKey.test.js
'use strict';

const { buildMutationKey, buildCreateKey } = require('../src/idempotencyKey');

describe('buildMutationKey', () => {
  it('joins instanceId, objectClass, uid, and orderingKey in order', () => {
    expect(buildMutationKey('workday-prod', '__ACCOUNT__', 'uid-123', 'task-9'))
        .toBe('workday-prod:__ACCOUNT__:uid-123:task-9');
  });

  it('produces different keys for the same uid on different instances', () => {
    const a = buildMutationKey('workday-prod', '__ACCOUNT__', 'uid-123', 'task-9');
    const b = buildMutationKey('successfactors-hr', '__ACCOUNT__', 'uid-123', 'task-9');
    expect(a).not.toBe(b);
  });

  it('produces different keys for the same uid on different object classes', () => {
    const a = buildMutationKey('workday-prod', '__ACCOUNT__', 'uid-123', 'task-9');
    const b = buildMutationKey('workday-prod', '__GROUP__', 'uid-123', 'task-9');
    expect(a).not.toBe(b);
  });

  it('produces different keys for the same object across different ordering keys', () => {
    const a = buildMutationKey('workday-prod', '__ACCOUNT__', 'uid-123', 'task-9');
    const b = buildMutationKey('workday-prod', '__ACCOUNT__', 'uid-123', 'task-10');
    expect(a).not.toBe(b);
  });

  it('produces the same key for a genuine retry (identical inputs)', () => {
    const a = buildMutationKey('workday-prod', '__ACCOUNT__', 'uid-123', 'task-9');
    const b = buildMutationKey('workday-prod', '__ACCOUNT__', 'uid-123', 'task-9');
    expect(a).toBe(b);
  });

  it.each([
    ['instanceId', ''],
    ['objectClass', undefined],
    ['uid', null],
    ['orderingKey', '   '],
  ])('rejects an empty %s', (_name, badValue) => {
    const args = ['workday-prod', '__ACCOUNT__', 'uid-123', 'task-9'];
    const argIndex = ['instanceId', 'objectClass', 'uid', 'orderingKey'].indexOf(_name);
    args[argIndex] = badValue;
    expect(() => buildMutationKey(...args)).toThrow(TypeError);
  });
});

describe('buildCreateKey', () => {
  it('keys on the naming attribute value, not a uid', () => {
    expect(buildCreateKey('workday-prod', '__ACCOUNT__', 'jdoe', 'task-9'))
        .toBe('workday-prod:__ACCOUNT__:jdoe:task-9');
  });

  it('produces the same key for a retried create with the same intended identity', () => {
    const a = buildCreateKey('workday-prod', '__ACCOUNT__', 'jdoe', 'task-9');
    const b = buildCreateKey('workday-prod', '__ACCOUNT__', 'jdoe', 'task-9');
    expect(a).toBe(b);
  });
});
