# @iga/provisioning-service-client

A Node.js client for [`governance-provisioning-service`](../../README.md). Lives at `clients/node/` in this repository — a separately versioned, separately tested package, not wired into the service's own build/lint/CI. Covers auth, all five mutation routes, the two synchronous read routes, idempotency-key construction, and status polling. No dependencies beyond `vitest` for tests — uses the global `fetch` (Node ≥18).

This library exists because most of what's "hard" about calling the provisioning service — correct token caching, a correctly-scoped idempotency key, the poll/backoff loop, branching on the four terminal outcomes — is the same code every integration would otherwise hand-write. Import it instead of re-deriving it.

## Install

```bash
cd clients/node
npm install
```

Not published to a registry. Consumers outside this repository should vendor this directory or point at wherever it's mirrored to an internal package feed — the `package.json` is deliberately `"private": true` until that decision is made.

## Quick start

```js
const { createProvisioningClient } = require('.'); // or the package name, once published/vendored

const client = createProvisioningClient({
  baseUrl: process.env.PROVISIONING_SERVICE_URL,
  auth: {
    tokenUrl: process.env.IGA_TOKEN_URL,
    clientId: process.env.IGA_CLIENT_ID,
    clientSecret: process.env.IGA_CLIENT_SECRET,
    audience: 'provisioning-service', // must equal the service's JWT_EXPECTED_AUD
  },
});

const { operationId } = await client.createObject('workday-prod', '__ACCOUNT__', {
  __NAME__: 'jdoe',
  givenName: 'Jane',
  familyName: 'Doe',
}, {
  idempotencyKey: client.buildCreateKey('workday-prod', '__ACCOUNT__', 'jdoe', task.id),
});

const final = await client.waitForOutcome(operationId);
if (final.outcome === 'SUCCEEDED') {
  console.log('provisioned uid:', final.result.uid);
}
```

If IGA already owns its own token lifecycle, skip the built-in provider:

```js
const client = createProvisioningClient({
  baseUrl: process.env.PROVISIONING_SERVICE_URL,
  getAccessToken: async () => myExistingTokenManager.getToken('provisioning-service'),
});
```

## API

| Method | Maps to | Notes |
|---|---|---|
| `createObject(instanceId, objectClass, attributes, opts?)` | `POST /instances/:id/objects/:class` | `attributes` must include the class's naming attribute. `opts: { idempotencyKey?, priority? }`. |
| `replaceObject(instanceId, objectClass, uid, attributes, opts?)` | `PUT .../:class/:uid` | Always a full replace. |
| `deleteObject(instanceId, objectClass, uid, opts?)` | `DELETE .../:class/:uid` | Idempotent — already-absent resolves `SUCCEEDED`. |
| `addValues(instanceId, objectClass, uid, attributes, opts?)` | `POST .../:uid/add-values` | Delta, not a merge-flagged update. |
| `removeValues(instanceId, objectClass, uid, attributes, opts?)` | `POST .../:uid/remove-values` | |
| `getObject(instanceId, objectClass, uid)` | `GET .../:class/:uid` | Synchronous. Throws `NotFoundError` on 404. |
| `search(instanceId, objectClass, filter)` | `GET .../:class?filter=...` | Async generator; `for await (const obj of client.search(...))`. |
| `waitForOutcome(operationId, opts?)` | polls `GET /operations/:id` | `opts: { pollMs=500, timeoutMs=30000 }`. Throws `TimeoutError`, not a failure outcome, if the deadline elapses. |
| `buildCreateKey(instanceId, objectClass, nameAttrValue, orderingKey)` | — | See **Idempotency keys** below. |
| `buildMutationKey(instanceId, objectClass, uid, orderingKey)` | — | |

## Idempotency keys

The provisioning service currently dedupes `Idempotency-Key` **globally**, not scoped to `(instanceId, objectClass)` — a known gap (see the service's own security review, finding SEC-2). Until that's fixed server-side, always build keys with `buildCreateKey`/`buildMutationKey` rather than a bare string:

```
{instanceId}:{objectClass}:{identity}:{orderingKey}
```

- `identity` is the **uid** for update/delete/deltas, or the **naming-attribute value** for create (no uid exists yet).
- `orderingKey` should be your own change/task id — **not** a random value (defeats retry-safety) and **not** omitted (collides two legitimately different writes to the same object).

## Errors

All non-2xx responses throw. Catch specific subclasses when you need to branch:

```js
const { AdmissionRejectedError, NotFoundError, HttpError, TimeoutError } = require('.');

try {
  await client.createObject(/* ... */);
} catch (err) {
  if (err instanceof AdmissionRejectedError) {
    // backlog full for this instance/priority — err.backlogDepth, err.priority
  } else if (err instanceof HttpError) {
    // err.status, err.code (the service's own error string), err.body
  }
  throw err;
}
```

`waitForOutcome` throws `TimeoutError` — not any of the above — if the deadline elapses before an outcome appears; this says nothing about the operation itself.

## Testing

```bash
npm test
```

Covers idempotency-key construction and the error-mapping/caching logic in the HTTP client and token provider — the places correctness actually lives. Does not include integration tests against a live provisioning-service instance.

## Scope

Mirrors the provisioning service's own HTTP surface exactly — nothing here decides *which* application, object class, or object a call targets; that remains IGA's responsibility (see the architecture overview, §6, for how `instanceId` resolves to a connector instance server-side).
