# Bug log — governance-provisioning-service

Tracking for defects and enhancement requests found outside the normal review
cycle. Append-only in spirit: entries are edited to change `Status` and to add
resolution notes, but the original report is not rewritten.

Companion to the design record. `PROVISIONING_SERVICE_PLAN.md` says what was
planned and the framework's `governance-connector-framework_checkpoint_log.md`
says what was decided; this file says what is wrong with what was built.

Conventions are carried over from the framework's `BUG_LOG.md` so an entry
that moves between the two repositories does not change shape.

## Conventions

**IDs** — `BUG-n` for defects, `RFE-n` for enhancements. Numbers are never
reused, including for entries that are closed as invalid.

Numbering is shared with the framework's log for entries that moved: BUG-4
arrives here as BUG-4, keeping the id it was filed under. Entries first found
in this repository continue from the highest number in use across both logs,
so an id is unambiguous when quoted without its repository.

**Status** — `OPEN` · `IN PROGRESS` · `FIXED` · `WONTFIX` · `INVALID` ·
`MOVED`.
A `FIXED` entry names the commit that fixed it.
A `MOVED` entry names the repository it moved to and stays readable in the
origin repo as history; it is not a resolution. The entry is only closed in
the repository that now owns the code. Entries already `FIXED` before a move
stay as history in the origin repository and do not travel; open entries
travel.

**Severity**

| Level | Meaning |
|---|---|
| `critical` | Data loss, corruption, or a wrong provisioning outcome. Duplicate accounts belong here. |
| `high` | Correctness broken under conditions that occur in normal operation. |
| `medium` | Correct but degrades under load or misconfiguration; no wrong outcome. |
| `low` | Cosmetic, or only reachable through operator error that is already reported. |

Severity describes consequence, not effort.

---

## Summary

| ID | Sev | Status | Component | Title |
|---|---|---|---|---|
| [BUG-4](#bug-4) | medium | FIXED | `ops/Dispatcher`, `ops/OperationStore` | The reserved interactive slice is computed but never enforced |
| [BUG-7](#bug-7) | medium | FIXED | `tsconfig.json` | Test sources were never typechecked, so a signature change failed silently at runtime |
| [BUG-8](#bug-8) | high | FIXED | `ops/Dispatcher` | A claim cycle racing `stop()`'s pool closure crashed the process |

---

<a id="bug-4"></a>
## BUG-4 — The reserved interactive slice is computed but never enforced

| | |
|---|---|
| **Severity** | medium |
| **Status** | FIXED in Phase P1.5 |
| **Component** | `src/ops/Dispatcher.ts`, `src/ops/OperationStore.ts` |
| **Reported** | 2026-08-01 (as [BUG-4][fw4] in the framework, MOVED here at CP-5) |
| **Affects** | framework `main@491d2ac` through service `main@00360ea` |
| **Authority** | CP-2, which LOCKED the interactive/batch asymmetry |

[fw4]: https://github.com/srallapally/governance-connector-framework/blob/main/BUG_LOG.md#bug-4

### Symptom

`resolveSchedulingConfig` computed `interactiveSlots` and `batchSlots`, and
**nothing read them.** `computeAvailability` offered one number per instance:

```ts
const free = runtime.mutationConcurrency - inFlight;
```

That is the whole budget, offered to either class. So a batch flood could
legitimately occupy every mutation slot on an instance, and an interactive
operation arriving mid-flood waited a full attempt duration for one to free.

CP-2 locked the opposite: interactive work may draw on the whole budget, batch
work is capped at the budget minus a reserved slice. The reservation existed in
the config and nowhere else.

### Why it survived so long

**The soak looked like it worked.** At 50k operations it measured interactive
p50 at 825ms against batch p50 at 12,775ms — a 15× separation, with no
reservation in existence.

That separation is real, and it comes entirely from the claim query's
`ORDER BY (priority = 'interactive') DESC`. Ordering decides *who takes the
next free slot*. A reservation decides *whether a slot is free at all*. Under
sustained saturation the ordering advantage collapses, because there is no next
free slot — which is precisely the condition the slice exists for, and the one
a p50 comparison never reaches.

RFE-1 is the same lesson in miniature: it corrected the arithmetic that
produces `interactiveSlots`, which improved a number that no code consumed. The
fix was real and its runtime effect was nil.

### Fix

The availability contract carries two numbers instead of one:

```ts
export interface InstanceAvailability {
  batchFree: number;   // batchSlots - batchInFlight
  totalFree: number;   // mutationConcurrency - inFlight
}
```

- The dispatcher counts in-flight **per class per instance**
  (`runningBatch`), not just per instance. Counting only within a cycle would
  let batch rows claimed earlier and still running consume the slice.
- `computeAvailability` yields both, clamping `batchFree` to `totalFree`.
- Both stores enforce it. The claim query gains a second cap parameter and a
  `class_rn` window partitioned by `(instance_id, priority)`, so batch rows are
  cut at `batch_cap` without disturbing where interactive rows sit in `rn`.
  `MemoryOperationStore` mirrors it, and the shared contract suite holds both
  to the same six cases.
- Claim ordering is unchanged. Scheduling config already lived here since
  CP-5, so **core did not change.**

At a slice fraction of 0, or a budget of 1 where there is nothing to divide,
`batchSlots` equals the budget and this reduces to the previous behaviour
exactly.

### Tests

The discriminating test is deliberately **not** a latency comparison: saturate
an instance with slow batch work, enqueue one interactive operation, and assert
it **starts before any in-flight batch attempt completes**. Ordering alone
cannot satisfy that.

Both reservation tests were confirmed to fail with the fix reverted, while the
three cases asserting unchanged behaviour (interactive reaching the full
budget, fraction 0, budget 1) still passed. A test that passes either way would
have proved nothing here — which is exactly how the original defect hid.

---

<a id="bug-7"></a>
## BUG-7 — Test sources were never typechecked

| | |
|---|---|
| **Severity** | medium |
| **Status** | FIXED in Phase P1.5 |
| **Component** | `tsconfig.json` |
| **Reported** | 2026-08-01 |
| **Affects** | P0 onward |
| **Found by** | changing `claimBatch`'s signature during P1.5 |

### Symptom

`tsconfig.json` excludes `**/*.test.ts`, correctly, so tests are not emitted
into `dist`. The side effect was that **nothing typechecked them at all**:
`npm run build` and `npm run typecheck` both skipped every test file.

When `claimBatch`'s availability parameter changed from
`ReadonlyMap<string, number>` to `ReadonlyMap<string, InstanceAvailability>`,
every test call site still compiled. At runtime the caps arrived as `undefined`,
`Math.min(undefined, n)` produced `NaN`, Postgres received `NULL` for the cap
array, and `class_rn <= NULL` filtered every batch row out. The claim returned
zero rows and the failure surfaced as an unrelated-looking assertion about
concurrent claimers.

The same gap was hiding an existing defect: `MemoryOperationStore` still
imported `OperationOutcome`, `OperationPendingStatus`, and `OperationStatus`
from `@governance-connector-framework/core`, where P1 had removed them. Type-only
imports are erased at runtime, so the suite passed while referring to types
that no longer existed.

### Fix

`tsconfig.test.json` extends the base config with `noEmit`, includes `test/**`,
and is run by `npm run typecheck`. Both defects above surfaced on the first run.

CI runs `typecheck` alongside `build`, `lint`, and `test`, so neither defect
class can return quietly.

---

<a id="bug-8"></a>
## BUG-8 — A claim cycle racing `stop()`'s pool closure crashed the process

| | |
|---|---|
| **Severity** | high |
| **Status** | FIXED in Phase P8, commit `d68ccd8` (PR #12) |
| **Component** | `ops/Dispatcher.ts` (`runCycle`) |
| **Reported** | 2026-08-02 |
| **Affects** | P2 onward (`Dispatcher.start`/`stop` existed since P2; only real
network latency between the claim query and `stop()` opens the window) |
| **Found by** | a real Cloud SQL soak run (P8), not reproducible against local
Postgres |

### Symptom

`Dispatcher.stop()` awaits `inFlight` (attempts already claimed and
executing) before returning, but has no way to know about, or wait for, a
`runCycle()` currently stuck awaiting `claimBatch()` itself — nothing is
added to `inFlight` until the claim resolves. Under local Postgres's
near-zero round-trip latency this window never manifested in any test or
soak run in this repository's history. Against real Cloud SQL, a round trip
of 60-200ms+ was wide enough for a straggling claim cycle to still be
querying the moment `stop()` returned and the caller closed the pool
underneath it.

`runCycle()`'s body had no `try`/`catch` around it — unlike its siblings
`finalize()` and `safeRequeue()` in the same file, which already tolerate a
closed pool the same way `stop()`'s own docstring describes for in-flight
attempts. Invoked via a bare `void this.runCycle()` in `start()`'s
`setInterval` callback, the resulting `Error: Cannot use a pool after
calling end on the pool` became an unhandled rejection that crashed the
whole process — not a stranded row `reapStale()` could recover, an outright
process exit, observed during a real soak script's shutdown sequence after
the run itself had already completed and reported clean numbers.

### Fix

Added a `catch` clause to `runCycle()` that logs and returns `0`, degrading
a straggling claim cycle to the same "stranded `RUNNING` row, recovered by
`reapStale()`" case the rest of the file already accepts, instead of an
unhandled rejection. Regression test in `test/Dispatcher.test.ts`
(`lifecycle` describe block) reproduces the race deterministically with a
mocked `store.claimBatch()` rejection, so it does not depend on real network
latency to catch a regression.
