/**
 * Scheduling configuration: the half of an instance's `runtime` block that
 * only the claim loop reads.
 *
 * CP-5's split rule put `attemptDeadlineMs`, the two concurrency budgets, and
 * the read-cache opt-in in the framework, because the facade needs them to
 * execute one operation. The interactive slice and the per-op rate limits stay
 * here, because nothing but a dispatcher deciding what to claim ever consults
 * them. Core rejects both by name, so a config carrying them must be split
 * before `registerInstance` sees it -- not passed through and caught.
 *
 * The parsing style is core's: hand-rolled, no schema library, unknown keys
 * rejected by name. A silently ignored typo in a rate limit is
 * indistinguishable from no rate limit until the target starts refusing.
 */
import {
    OP_KINDS,
    type OpKind,
    type PerOp,
    type ResolvedRuntimeConfig,
} from "@governance-connector-framework/core";

export const SCHEDULING_DEFAULTS = {
    /** Fraction of the mutation budget reserved for interactive work. */
    interactiveSliceFraction: 0.2,
} as const;

export interface RateLimitInput {
    /** Requests permitted per `requestPeriodMs`. */
    requestLimit: number;
    /** Window length in milliseconds. */
    requestPeriodMs: number;
    /** How long to wait for a token before giving up. Omit to fail fast. */
    requestTimeoutMs?: number | undefined;
}

export interface SchedulingConfigInput {
    interactiveSliceFraction?: number | undefined;
    rateLimits?: PerOp<RateLimitInput> | undefined;
}

export interface ResolvedRateLimit {
    requestLimit: number;
    requestPeriodMs: number;
    requestTimeoutMs: number | undefined;
}

export interface ResolvedSchedulingConfig {
    readonly interactiveSliceFraction: number;
    /**
     * Mutation slots reserved for `interactive` work.
     *
     * Interactive operations may use the whole mutation budget; this is the
     * portion batch work may *not* touch, which is what stops a large
     * reconciliation backlog from starving a helpdesk write.
     *
     * Computed here and, as of this phase, still consumed by nothing --
     * see BUG-4, which P1.5 fixes.
     */
    readonly interactiveSlots: number;
    /** Mutation slots available to `batch` work: budget minus the slice. */
    readonly batchSlots: number;
    readonly rateLimits: Readonly<Partial<Record<OpKind, ResolvedRateLimit>>>;
}

/**
 * What the dispatcher actually consumes: core's execution settings and this
 * service's scheduling settings, resolved together.
 */
export type ResolvedInstanceConfig = ResolvedRuntimeConfig & ResolvedSchedulingConfig;

const SCHEDULING_KEYS = ["interactiveSliceFraction", "rateLimits"] as const;
const RATE_LIMIT_FIELDS = ["requestLimit", "requestPeriodMs", "requestTimeoutMs"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describe(v: unknown): string {
    if (v === null) return "null";
    if (Array.isArray(v)) return "an array";
    return typeof v;
}

function requirePositiveInteger(v: unknown, path: string): number {
    if (typeof v !== "number" || !Number.isInteger(v)) {
        throw new Error(`${path} must be a whole number, got ${describe(v)}`);
    }
    if (v < 1) throw new Error(`${path} must be at least 1, got ${v}`);
    return v;
}

function parseRateLimits(raw: unknown): Partial<Record<OpKind, ResolvedRateLimit>> {
    const out: Partial<Record<OpKind, ResolvedRateLimit>> = {};
    if (raw === undefined) return out;

    if (!isPlainObject(raw)) {
        throw new Error(`scheduling.rateLimits must be a per-op object, got ${describe(raw)}`);
    }

    for (const key of Object.keys(raw)) {
        if (!(OP_KINDS as readonly string[]).includes(key)) {
            throw new Error(
                `scheduling.rateLimits.${key} is not a known operation. ` +
                `Expected one of: ${OP_KINDS.join(", ")}.`,
            );
        }
        const op = key as OpKind;
        const entry = raw[op];
        if (entry === undefined) continue;
        if (!isPlainObject(entry)) {
            throw new Error(`scheduling.rateLimits.${op} must be an object, got ${describe(entry)}`);
        }

        for (const field of Object.keys(entry)) {
            if (!(RATE_LIMIT_FIELDS as readonly string[]).includes(field)) {
                throw new Error(
                    `scheduling.rateLimits.${op}.${field} is not a recognised setting. ` +
                    `Expected requestLimit, requestPeriodMs, or requestTimeoutMs.`,
                );
            }
        }

        const requestTimeoutMs = entry["requestTimeoutMs"];
        out[op] = {
            requestLimit: requirePositiveInteger(
                entry["requestLimit"], `scheduling.rateLimits.${op}.requestLimit`),
            requestPeriodMs: requirePositiveInteger(
                entry["requestPeriodMs"], `scheduling.rateLimits.${op}.requestPeriodMs`),
            requestTimeoutMs: requestTimeoutMs === undefined
                ? undefined
                : requirePositiveInteger(
                    requestTimeoutMs, `scheduling.rateLimits.${op}.requestTimeoutMs`),
        };
    }
    return out;
}

function parseSliceFraction(raw: unknown): number {
    if (raw === undefined) return SCHEDULING_DEFAULTS.interactiveSliceFraction;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
        throw new Error(`scheduling.interactiveSliceFraction must be a number, got ${describe(raw)}`);
    }
    if (raw < 0 || raw > 1) {
        throw new Error(
            `scheduling.interactiveSliceFraction must be between 0 and 1 inclusive, got ${raw}`);
    }
    return raw;
}

/**
 * Size the reserved interactive slice.
 *
 * `ceil` so a small fraction against a small budget still reserves a whole
 * slot rather than rounding to nothing -- 0.2 of a budget of 3 is 0.6, and
 * flooring it would leave interactive work with no reservation at all on
 * exactly the instances where contention hurts most.
 *
 * At a budget of 1 there is nothing to divide: the single slot stays shared,
 * and interactive work still wins it whenever it is free, because interactive
 * may draw from the whole budget.
 *
 * A fraction of exactly 0 means no reservation. The floor exists to stop a
 * small positive fraction from rounding down to nothing, not to override an
 * operator who asked for zero (RFE-1, amended at CP-4).
 */
export function computeInteractiveSlots(mutationConcurrency: number, fraction: number): number {
    if (mutationConcurrency <= 1) return 0;
    if (fraction <= 0) return 0;
    return Math.min(mutationConcurrency, Math.max(1, Math.ceil(mutationConcurrency * fraction)));
}

/**
 * Validate a scheduling block and size the slice against an already-resolved
 * mutation budget.
 *
 * Pure: no I/O, no clock, no mutation of the input.
 */
export function resolveSchedulingConfig(
    input: SchedulingConfigInput | undefined,
    mutationConcurrency: number,
): ResolvedSchedulingConfig {
    if (input !== undefined && !isPlainObject(input)) {
        throw new Error(`scheduling must be an object, got ${describe(input)}`);
    }
    const source: Record<string, unknown> = (input ?? {}) as Record<string, unknown>;

    for (const key of Object.keys(source)) {
        if (!(SCHEDULING_KEYS as readonly string[]).includes(key)) {
            throw new Error(
                `scheduling.${key} is not a recognised setting. ` +
                `Expected one of: ${SCHEDULING_KEYS.join(", ")}.`,
            );
        }
    }

    const interactiveSliceFraction = parseSliceFraction(source["interactiveSliceFraction"]);
    const interactiveSlots = computeInteractiveSlots(mutationConcurrency, interactiveSliceFraction);

    return {
        interactiveSliceFraction,
        interactiveSlots,
        batchSlots: mutationConcurrency - interactiveSlots,
        rateLimits: parseRateLimits(source["rateLimits"]),
    };
}
