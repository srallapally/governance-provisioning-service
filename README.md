# governance-provisioning-service

Async provisioning over the [governance connector framework][fw]. This service
owns the claim loop: the durable operation table, the dispatcher that decides
what to run and when, the admission gate, and the HTTP surface that answers
202 with an operationId.

The framework owns the other half — executing one connector operation
correctly, with attempt deadlines, abort propagation, circuit breakers, and
connection pooling. The boundary was locked at CP-5 under a single rule: what
the facade needs to execute one operation stays there; what only the claim
loop needs lives here.

## Status: Phase P0

Scaffold, config, and documents. **No application code.**

`src/index.ts` is a placeholder so `tsc` has an input. Phase P2 replaces it
with the wiring module.

See [`PROVISIONING_SERVICE_PLAN.md`](./PROVISIONING_SERVICE_PLAN.md) for the
phases and, at the top of that file, the P0 findings — including six items
that could not be determined and the phase each one blocks.

## Design

Four terminal outcomes, deliberately distinct because the remedy differs:

| Outcome | Meaning | Remedy |
|---|---|---|
| `SUCCEEDED` | The target applied it. | none |
| `REJECTED_PRE_DISPATCH` | Never reached the target. | retry wholesale |
| `FAILED_CONFIRMED` | The target refused. | will refuse again; fix the input |
| `INDETERMINATE` | The deadline expired with no answer. | reconciliation only |

Operations serialize by lane so two writes to the same object cannot
interleave: `create:<objectClass>:<nameAttrValue>` for creates,
`uid:<objectClass>:<uid>` for update, delete, and deltas.

The HTTP contract is [`openapi.yaml`](./openapi.yaml). Its schema vocabulary
came from the framework at CP-5; the paths are authored from the plan's Phase
P4 and are provisional until P4 implements them.

## Development

```bash
npm ci
npm run build
npm test
npm run lint
```

Node 22. TypeScript strict, with `exactOptionalPropertyTypes` and
`noUncheckedIndexedAccess` copied from the framework so code moves between the
two repositories without a typecheck surprise.

[fw]: https://github.com/srallapally/governance-connector-framework
