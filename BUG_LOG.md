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
A `MOVED` entry names the repository it moved to and stays readable here as
history; it is not a resolution. The entry is only closed in the repository
that now owns the code. Entries already `FIXED` before a move stay as history
in the origin repository and do not travel; open entries travel.

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
| _(none yet)_ | | | | |

No entries. Phase P0 ships no code, so there is nothing here to be wrong yet.

BUG-4 — "the reserved interactive slice is computed but never enforced" — is
open in the [framework's bug log][fw] with status `MOVED`, and lands here as
this log's first entry at Phase P1.5, which is the phase that fixes it. It is
deliberately not filed in advance: the dispatcher it describes does not arrive
until P1.

[fw]: https://github.com/srallapally/governance-connector-framework/blob/feature/async-provisioning/BUG_LOG.md#bug-4
