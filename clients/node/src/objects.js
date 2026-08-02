// src/objects.js
'use strict';

/**
 * The five mutation routes plus the two synchronous read routes, all
 * generic over `objectClass` -- there is nothing account-specific about
 * the provisioning service itself (architecture overview, §6/§7), and a
 * client hardcoded to one object class would misrepresent that.
 */
function createObjectsApi(httpClient) {
  /**
   * CREATE -- 202 { operationId, status: "PENDING", idempotencyKey }.
   * `attributes` must include the object class's naming attribute (e.g.
   * `__NAME__` for the ICF default) or the service 400s before enqueueing;
   * which key that is varies per object class and per connector, and this
   * client does not resolve it for you.
   */
  async function createObject(instanceId, objectClass, attributes, opts = {}) {
    return httpClient.call('POST', `/instances/${instanceId}/objects/${objectClass}`, {
      body: { attributes, priority: opts.priority },
      idempotencyKey: opts.idempotencyKey,
    });
  }

  /** UPDATE -- always a full replace, not a merge. Safe to retry blind. */
  async function replaceObject(instanceId, objectClass, uid, attributes, opts = {}) {
    return httpClient.call('PUT', `/instances/${instanceId}/objects/${objectClass}/${uid}`, {
      body: { attributes },
      idempotencyKey: opts.idempotencyKey,
    });
  }

  /**
   * DELETE -- idempotent: a target reporting "already gone" still resolves
   * SUCCEEDED, so a caller retrying a delete never needs to special-case it.
   */
  async function deleteObject(instanceId, objectClass, uid, opts = {}) {
    return httpClient.call('DELETE', `/instances/${instanceId}/objects/${objectClass}/${uid}`, {
      idempotencyKey: opts.idempotencyKey,
    });
  }

  /**
   * ADD_VALUES / REMOVE_VALUES -- deltas against a multi-valued attribute,
   * not a flagged update. Only retried automatically server-side if the
   * target connector declares idempotent delta semantics -- otherwise a
   * retryable failure resolves INDETERMINATE rather than being replayed,
   * because blindly replaying a delta can double-apply a grant.
   */
  async function addValues(instanceId, objectClass, uid, attributes, opts = {}) {
    return httpClient.call('POST', `/instances/${instanceId}/objects/${objectClass}/${uid}/add-values`, {
      body: { attributes },
      idempotencyKey: opts.idempotencyKey,
    });
  }

  async function removeValues(instanceId, objectClass, uid, attributes, opts = {}) {
    return httpClient.call('POST', `/instances/${instanceId}/objects/${objectClass}/${uid}/remove-values`, {
      body: { attributes },
      idempotencyKey: opts.idempotencyKey,
    });
  }

  /** GET -- synchronous, not enqueued. Rejects with NotFoundError on 404. */
  async function getObject(instanceId, objectClass, uid) {
    return httpClient.call('GET', `/instances/${instanceId}/objects/${objectClass}/${uid}`);
  }

  /**
   * SEARCH -- synchronous, NDJSON stream, one object per line. Uses the raw
   * fetch Response rather than call(), since the body is a stream, not one
   * JSON document. `filter` is the service's flat "and"-only SCIM-keyword
   * grammar (eq/co/sw/ew/gt/ge/lt/le/pr) -- no or/not/parens.
   *
   * Returns an async generator; iterate with `for await`.
   */
  async function* search(instanceId, objectClass, filter) {
    const query = filter ? `?filter=${encodeURIComponent(filter)}` : '';
    const res = await httpClient.rawGet(`/instances/${instanceId}/objects/${objectClass}${query}`);

    if (!res.ok) {
      throw await httpClient.mapErrorResponse(res);
    }

    let buffer = '';
    for await (const chunk of res.body) {
      buffer += Buffer.from(chunk).toString('utf8');
      let newlineAt;
      while ((newlineAt = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineAt);
        buffer = buffer.slice(newlineAt + 1);
        if (line) yield JSON.parse(line);
      }
    }
    // A final line with no trailing newline, if the stream ended that way.
    if (buffer.trim() !== '') yield JSON.parse(buffer);
  }

  return { createObject, replaceObject, deleteObject, addValues, removeValues, getObject, search };
}

module.exports = { createObjectsApi };
