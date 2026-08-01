/**
 * Turn an {@link ApplicationConfig} into a registered connector instance plus
 * the scheduling config this service keeps for it.
 *
 * Registration is lazy: nothing is registered at boot, and an application
 * becomes known the first time an operation names it. That matches the
 * framework's own lazy lifecycle -- CP-3 rejected eager `initInstance` looping
 * at boot -- and means a newly onboarded application needs no restart.
 *
 * The cost of lazy registration is that a bad config surfaces at first
 * dispatch rather than at startup, which is why `ApplicationRegistrationError`
 * names the application: an operator reading it should not have to guess which
 * document is wrong.
 */
import type { ConnectorRegistry } from "@governance-connector-framework/core";
import {
    splitRuntimeBlock,
    type ApplicationConfig,
    type ApplicationConfigStore,
} from "./application.js";
import {
    resolveSchedulingConfig,
    type ResolvedSchedulingConfig,
    type SchedulingConfigInput,
} from "./scheduling.js";

export class ApplicationRegistrationError extends Error {
    constructor(readonly applicationId: string, message: string, options?: { cause?: unknown }) {
        super(`application ${applicationId}: ${message}`, options as ErrorOptions);
        this.name = "ApplicationRegistrationError";
    }
}

export interface RegisteredApplication {
    applicationId: string;
    version: string;
    scheduling: ResolvedSchedulingConfig;
    schedulingInput: SchedulingConfigInput;
}

/**
 * Resolves configs, registers instances, and rebuilds when a version changes.
 *
 * Holds no connectors of its own -- the registry and `ConnectorManager` own
 * those. What it owns is the mapping from application id to the scheduling
 * half of its config, which core has no place for.
 */
/** The slice of `ConnectorManager` this needs, so tests need not build one. */
export interface LeaseCounter {
    refcountOf(instanceId: string): number;
}

export interface RegistrarOptions {
    /**
     * Consulted before disposing an instance whose config changed. Omit and a
     * changed config replaces the instance immediately, which is only safe
     * when nothing holds leases -- true in tests, not in the wired service.
     */
    manager?: LeaseCounter | undefined;
    /** How long to wait for leases to drain before giving up. Default 30s. */
    drainTimeoutMs?: number | undefined;
    /** Poll interval while draining. Default 50ms. */
    drainPollMs?: number | undefined;
    now?: (() => number) | undefined;
    sleep?: ((ms: number) => Promise<void>) | undefined;
}

export class ApplicationRegistrar {
    private readonly registered = new Map<string, RegisteredApplication>();
    private readonly inFlight = new Map<string, Promise<RegisteredApplication>>();
    private readonly manager: LeaseCounter | undefined;
    private readonly drainTimeoutMs: number;
    private readonly drainPollMs: number;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(
        private readonly store: ApplicationConfigStore,
        private readonly registry: ConnectorRegistry,
        opts: RegistrarOptions = {},
    ) {
        this.manager = opts.manager;
        this.drainTimeoutMs = opts.drainTimeoutMs ?? 30_000;
        this.drainPollMs = opts.drainPollMs ?? 50;
        this.now = opts.now ?? (() => Date.now());
        this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    }

    /** Scheduling input for an already-registered application, for the dispatcher. */
    schedulingOf(applicationId: string): SchedulingConfigInput | undefined {
        return this.registered.get(applicationId)?.schedulingInput;
    }

    /**
     * Ensure the application is registered against its current config.
     *
     * Concurrent callers for the same id share one resolution; without that,
     * a burst of operations for a newly seen application would each fetch and
     * register it, and the last writer would win an arbitrary race.
     */
    async ensure(applicationId: string): Promise<RegisteredApplication> {
        const pending = this.inFlight.get(applicationId);
        if (pending) return pending;

        const work = this.resolve(applicationId).finally(() => {
            this.inFlight.delete(applicationId);
        });
        this.inFlight.set(applicationId, work);
        return work;
    }

    private async resolve(applicationId: string): Promise<RegisteredApplication> {
        let entry;
        try {
            entry = await this.store.get(applicationId);
        } catch (err) {
            throw new ApplicationRegistrationError(
                applicationId, `config could not be read -- ${(err as Error).message}`,
                { cause: err });
        }
        if (!entry) {
            throw new ApplicationRegistrationError(applicationId, "no configuration found");
        }

        const current = this.registered.get(applicationId);
        if (current && current.version === entry.version) return current;

        // A changed config means the built instance was made from the old
        // document and is wrong. The registry refuses to overwrite, which is
        // the right default -- replacing it silently would leave a pool
        // holding connections built from superseded settings.
        if (this.registry.getDefinition(applicationId)) {
            await this.drainLeases(applicationId);
            await this.registry.disposeInstance(applicationId);
        }

        const registered = this.register(entry.config, entry.version);
        this.registered.set(applicationId, registered);
        return registered;
    }

    /**
     * Wait for outstanding leases on an instance to be released.
     *
     * Disposing under a live lease would pull the connector out from under an
     * attempt that is mid-flight against a target, which is the one thing the
     * resolution protocol cannot classify: the operation would fail locally
     * having possibly already applied. Waiting is always the safer error.
     */
    private async drainLeases(instanceId: string): Promise<void> {
        if (!this.manager) return;
        const deadline = this.now() + this.drainTimeoutMs;
        while (this.manager.refcountOf(instanceId) > 0) {
            if (this.now() >= deadline) {
                throw new ApplicationRegistrationError(
                    instanceId,
                    `configuration changed but ${this.manager.refcountOf(instanceId)} lease(s) ` +
                    `are still outstanding after ${this.drainTimeoutMs}ms; not replacing the ` +
                    `instance while work is in flight`,
                );
            }
            await this.sleep(this.drainPollMs);
        }
    }

    private register(config: ApplicationConfig, version: string): RegisteredApplication {
        const { execution, scheduling } = splitRuntimeBlock(config.runtime);

        let resolvedScheduling: ResolvedSchedulingConfig;
        try {
            this.registry.registerInstance(
                config.applicationId,
                config.connectorType,
                config.connectorVersion,
                config.connectorConfig,
                execution,
            );
            const definition = this.registry.getDefinition(config.applicationId);
            /* c8 ignore next 3 -- registerInstance either throws or records */
            if (!definition) {
                throw new Error("registerInstance did not record a definition");
            }
            resolvedScheduling = resolveSchedulingConfig(
                scheduling, definition.runtime.mutationConcurrency);
        } catch (err) {
            throw new ApplicationRegistrationError(
                config.applicationId, (err as Error).message, { cause: err });
        }

        return {
            applicationId: config.applicationId,
            version,
            scheduling: resolvedScheduling,
            schedulingInput: scheduling,
        };
    }
}
