// src/idempotencyKey.js
'use strict';

/**
 * The provisioning service dedupes Idempotency-Key GLOBALLY, not scoped to
 * instance or object class (see the security review, finding SEC-2). Until
 * that's fixed server-side, a well-formed key is what stands between two
 * unrelated writes colliding. Four components, always in this order:
 *
 *   1. instanceId   -- which connector instance. Without this, the same
 *                       orderingKey reused against two instances collides.
 *   2. objectClass  -- which kind of object. Without this, a create and a
 *                       group update issued under the same task id collide.
 *   3. identity     -- WHICH object. uid for update/delete/deltas; the
 *                       naming-attribute value for create, because no uid
 *                       exists yet (buildCreateKey below).
 *   4. orderingKey  -- the caller's own change/task id. NOT a random value:
 *                       a random key defeats retry-safety (a genuine retry
 *                       of the same task mints a new key and enqueues
 *                       twice). NOT omitted either: omitting it collides
 *                       every call against the same object, including two
 *                       legitimately different sequential updates.
 *
 * Delimited with ":". objectClass and uid values from ICF connectors are
 * not expected to contain it, but a deployment should confirm that against
 * its own connectors before relying on it for uniqueness -- this module
 * does not currently reject a colon inside a component.
 */

function assertNonEmpty(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`idempotencyKey: ${name} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
}

function buildKey(instanceId, objectClass, identity, orderingKey) {
  assertNonEmpty(instanceId, 'instanceId');
  assertNonEmpty(objectClass, 'objectClass');
  assertNonEmpty(identity, 'identity');
  assertNonEmpty(orderingKey, 'orderingKey');
  return `${instanceId}:${objectClass}:${identity}:${orderingKey}`;
}

/** UPDATE / DELETE / ADD_VALUES / REMOVE_VALUES -- identity is the uid. */
function buildMutationKey(instanceId, objectClass, uid, orderingKey) {
  return buildKey(instanceId, objectClass, uid, orderingKey);
}

/**
 * CREATE -- no uid exists yet. Identity is the naming attribute value,
 * which is required on every create request anyway (the service 400s
 * without it). A retried create for the same intended object reuses the
 * same key even though the object itself doesn't exist server-side yet
 * to key on.
 */
function buildCreateKey(instanceId, objectClass, nameAttrValue, orderingKey) {
  return buildKey(instanceId, objectClass, nameAttrValue, orderingKey);
}

module.exports = { buildMutationKey, buildCreateKey };
