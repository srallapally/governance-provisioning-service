/**
 * Per-application instance configuration, and the split that CP-5 forced.
 *
 * An operator still writes one JSON document per application instance, with a
 * single `runtime` block, exactly as they did before the framework and the
 * provisioning service parted company. Nothing about the operator-facing shape
 * changed -- the split is this service's problem, not theirs.
 *
 * Internally the block has two halves. `attemptDeadlineMs`, the concurrency
 * budgets, and `readCache` are execution settings and belong to core's
 * `resolveRuntimeConfig`. `interactiveSliceFraction` and `rateLimits` are
 * claim-loop settings and stay here. Core rejects the second pair *by name*,
 * so the split has to happen before `registerInstance` is called rather than
 * around a caught error.
 *
 * Both halves keep their own unknown-key rejection, which is why the split is
 * by membership in a known scheduling set rather than by subtraction: a
 * misspelled `mutationConcurency` is not a scheduling key, falls through to
 * core, and is reported there with the message operators already know.
 */
import type { RuntimeConfigInput } from "@governance-connector-framework/core";
import type { SchedulingConfigInput } from "./scheduling.js";

/** Keys the provisioning service owns. Everything else is core's. */
export const SCHEDULING_KEYS = ["interactiveSliceFraction", "rateLimits"] as const;

/**
 * One application instance, as stored in the IGA repository.
 *
 * `connectorConfig` is passed to the connector factory untouched; this service
 * never inspects it, and it routinely carries secrets.
 */
export interface ApplicationConfig {
    /** Stable id. Doubles as the connector instance id and appears in lane keys. */
    applicationId: string;
    connectorType: string;
    connectorVersion: string;
    connectorConfig: Record<string, unknown>;
    /** The mixed block. Absent means every default on both sides. */
    runtime?: Record<string, unknown> | undefined;
}

/**
 * A config plus an opaque version.
 *
 * The version is compared, never parsed. It exists so a cached connector
 * instance built from an older document can be detected and rebuilt; see the
 * store implementations for how each derives one.
 */
export interface VersionedApplicationConfig {
    config: ApplicationConfig;
    version: string;
}

export interface ApplicationConfigStore {
    /** Returns null when no application has that id. */
    get(applicationId: string): Promise<VersionedApplicationConfig | null>;
}

export interface SplitRuntime {
    execution: RuntimeConfigInput;
    scheduling: SchedulingConfigInput;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Divide a `runtime` block into the half core validates and the half this
 * service validates.
 *
 * Neither half is validated here -- that is deliberate. Validation lives with
 * whoever owns the setting, so the error messages stay consistent with the
 * package that documents them.
 */
export function splitRuntimeBlock(runtime: Record<string, unknown> | undefined): SplitRuntime {
    const execution: Record<string, unknown> = {};
    const scheduling: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(runtime ?? {})) {
        if ((SCHEDULING_KEYS as readonly string[]).includes(k)) scheduling[k] = v;
        else execution[k] = v;
    }
    return {
        execution: execution as RuntimeConfigInput,
        scheduling: scheduling as SchedulingConfigInput,
    };
}

/**
 * Reject a document that is not shaped like an ApplicationConfig at all.
 *
 * Deep validation of the two runtime halves belongs to their owners; this is
 * only the identity fields, without which there is nothing to register.
 */
export function validateApplicationConfig(raw: unknown, source: string): ApplicationConfig {
    if (!isPlainObject(raw)) {
        throw new Error(`${source}: expected a JSON object, got ${raw === null ? "null" : typeof raw}`);
    }
    const required = ["applicationId", "connectorType", "connectorVersion"] as const;
    for (const key of required) {
        const v = raw[key];
        if (typeof v !== "string" || v.length === 0) {
            throw new Error(`${source}: ${key} must be a non-empty string`);
        }
    }
    const connectorConfig = raw["connectorConfig"];
    if (connectorConfig !== undefined && !isPlainObject(connectorConfig)) {
        throw new Error(`${source}: connectorConfig must be an object when present`);
    }
    const runtime = raw["runtime"];
    if (runtime !== undefined && !isPlainObject(runtime)) {
        throw new Error(`${source}: runtime must be an object when present`);
    }

    return {
        applicationId: raw["applicationId"] as string,
        connectorType: raw["connectorType"] as string,
        connectorVersion: raw["connectorVersion"] as string,
        connectorConfig: (connectorConfig ?? {}) as Record<string, unknown>,
        runtime: runtime as Record<string, unknown> | undefined,
    };
}
