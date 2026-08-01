import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConnectorRegistry } from "@governance-connector-framework/core";
import { makeFakeConnector } from "@governance-connector-framework/core/testing";
import { splitRuntimeBlock, validateApplicationConfig } from "../src/config/application.js";
import { FileApplicationConfigStore } from "../src/config/FileApplicationConfigStore.js";
import {
    ApplicationRegistrar,
    ApplicationRegistrationError,
} from "../src/config/registerApplication.js";
import { resolveSchedulingConfig, computeInteractiveSlots } from "../src/config/scheduling.js";

let dir: string;

async function write(id: string, body: unknown): Promise<void> {
    await writeFile(path.join(dir, `${id}.json`), JSON.stringify(body, null, 2));
}

function appDoc(id: string, runtime?: Record<string, unknown>): Record<string, unknown> {
    return {
        applicationId: id,
        connectorType: "fake",
        connectorVersion: "1.0.0",
        connectorConfig: { host: "example.test" },
        ...(runtime ? { runtime } : {}),
    };
}

function newRegistry(): ConnectorRegistry {
    const r = new ConnectorRegistry();
    r.registerFactory("fake", "1.0.0", async () => makeFakeConnector());
    return r;
}

beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "appcfg-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("splitRuntimeBlock", () => {
    it("routes each half to its owner", () => {
        const { execution, scheduling } = splitRuntimeBlock({
            attemptDeadlineMs: 5_000,
            mutationConcurrency: 8,
            interactiveSliceFraction: 0.5,
            rateLimits: { create: { requestLimit: 10, requestPeriodMs: 1_000 } },
        });
        expect(execution).toEqual({ attemptDeadlineMs: 5_000, mutationConcurrency: 8 });
        expect(scheduling).toEqual({
            interactiveSliceFraction: 0.5,
            rateLimits: { create: { requestLimit: 10, requestPeriodMs: 1_000 } },
        });
    });

    it("treats an absent block as two empty halves", () => {
        expect(splitRuntimeBlock(undefined)).toEqual({ execution: {}, scheduling: {} });
    });

    it("sends an unknown key to core rather than swallowing it", () => {
        // The split is by membership in the scheduling set, not by subtraction,
        // so a typo falls through to the validator that already reports it.
        const { execution, scheduling } = splitRuntimeBlock({ mutationConcurency: 50 });
        expect(execution).toEqual({ mutationConcurency: 50 });
        expect(scheduling).toEqual({});
    });
});

describe("FileApplicationConfigStore", () => {
    it("reads a document and versions it by content", async () => {
        await write("app-1", appDoc("app-1"));
        const store = new FileApplicationConfigStore(dir);

        const first = await store.get("app-1");
        expect(first?.config.connectorType).toBe("fake");
        expect(first?.version).toMatch(/^[0-9a-f]{64}$/);

        // Same bytes, same version: a re-read must not invalidate a built instance.
        expect((await store.get("app-1"))?.version).toBe(first?.version);
    });

    it("changes version when the document changes", async () => {
        await write("app-1", appDoc("app-1"));
        const store = new FileApplicationConfigStore(dir);
        const before = await store.get("app-1");

        await write("app-1", appDoc("app-1", { mutationConcurrency: 4 }));
        const after = await store.get("app-1");

        expect(after?.version).not.toBe(before?.version);
    });

    it("returns null for an unknown application", async () => {
        expect(await new FileApplicationConfigStore(dir).get("absent")).toBeNull();
    });

    it("refuses an id that could escape the directory", async () => {
        const store = new FileApplicationConfigStore(dir);
        for (const bad of ["../secrets", "a/b", "..", "", ".hidden"]) {
            await expect(store.get(bad), bad).rejects.toThrow(/not a valid identifier/);
        }
    });

    it("refuses a document whose applicationId disagrees with its filename", async () => {
        // Registering under one id with another's config would dispatch
        // operations at the wrong target, and only much later.
        await write("app-1", appDoc("app-2"));
        await expect(new FileApplicationConfigStore(dir).get("app-1"))
            .rejects.toThrow(/but the file is named for/);
    });

    it("reports malformed JSON with the file named", async () => {
        await writeFile(path.join(dir, "app-1.json"), "{ not json");
        await expect(new FileApplicationConfigStore(dir).get("app-1"))
            .rejects.toThrow(/app-1\.json: not valid JSON/);
    });
});

describe("validateApplicationConfig", () => {
    it("requires the identity fields", () => {
        expect(() => validateApplicationConfig({ connectorType: "fake" }, "doc"))
            .toThrow(/applicationId must be a non-empty string/);
        expect(() => validateApplicationConfig(
            { applicationId: "a", connectorVersion: "1.0.0" }, "doc"))
            .toThrow(/connectorType must be a non-empty string/);
    });

    it("defaults connectorConfig to an empty object", () => {
        const c = validateApplicationConfig(
            { applicationId: "a", connectorType: "f", connectorVersion: "1.0.0" }, "doc");
        expect(c.connectorConfig).toEqual({});
    });

    it("rejects a non-object document", () => {
        expect(() => validateApplicationConfig([], "doc")).toThrow(/expected a JSON object/);
        expect(() => validateApplicationConfig(null, "doc")).toThrow(/got null/);
    });
});

describe("ApplicationRegistrar", () => {
    it("registers lazily and resolves both halves", async () => {
        await write("app-1", appDoc("app-1", {
            mutationConcurrency: 10,
            interactiveSliceFraction: 0.5,
        }));
        const registry = newRegistry();
        const registrar = new ApplicationRegistrar(new FileApplicationConfigStore(dir), registry);

        expect(registry.getDefinition("app-1")).toBeUndefined();

        const reg = await registrar.ensure("app-1");

        expect(registry.getDefinition("app-1")?.runtime.mutationConcurrency).toBe(10);
        expect(reg.scheduling.interactiveSlots).toBe(5);
        expect(reg.scheduling.batchSlots).toBe(5);
    });

    it("shares one resolution between concurrent callers", async () => {
        await write("app-1", appDoc("app-1"));
        let reads = 0;
        const inner = new FileApplicationConfigStore(dir);
        const counting = { get: async (id: string) => { reads++; return inner.get(id); } };

        const registrar = new ApplicationRegistrar(counting, newRegistry());
        await Promise.all(Array.from({ length: 5 }, () => registrar.ensure("app-1")));

        expect(reads).toBe(1);
    });

    it("re-registers when the version changes and not when it does not", async () => {
        await write("app-1", appDoc("app-1", { mutationConcurrency: 2 }));
        const registry = newRegistry();
        const registrar = new ApplicationRegistrar(new FileApplicationConfigStore(dir), registry);

        const first = await registrar.ensure("app-1");
        const again = await registrar.ensure("app-1");
        expect(again.version).toBe(first.version);
        expect(registry.getDefinition("app-1")?.runtime.mutationConcurrency).toBe(2);

        await write("app-1", appDoc("app-1", { mutationConcurrency: 7 }));
        const changed = await registrar.ensure("app-1");

        expect(changed.version).not.toBe(first.version);
        expect(registry.getDefinition("app-1")?.runtime.mutationConcurrency).toBe(7);
    });

    it("names the application when a config is invalid", async () => {
        // Lazy registration means this surfaces at first dispatch, so the
        // message has to say which document is wrong.
        await write("app-1", appDoc("app-1", { attemptDeadlineMs: -1 }));
        const registrar = new ApplicationRegistrar(new FileApplicationConfigStore(dir), newRegistry());

        await expect(registrar.ensure("app-1")).rejects.toThrow(ApplicationRegistrationError);
        await expect(registrar.ensure("app-1")).rejects.toThrow(/application app-1:/);
        await expect(registrar.ensure("app-1")).rejects.toThrow(/Unlimited \(-1\) is rejected/);
    });

    it("reports a missing application without registering anything", async () => {
        const registry = newRegistry();
        const registrar = new ApplicationRegistrar(new FileApplicationConfigStore(dir), registry);

        await expect(registrar.ensure("absent")).rejects.toThrow(/no configuration found/);
        expect(registry.getDefinition("absent")).toBeUndefined();
    });

    it("rejects a scheduling key core would have refused, and vice versa", async () => {
        await write("bad-sched", appDoc("bad-sched", { interactiveSliceFraction: 2 }));
        await write("bad-exec", appDoc("bad-exec", { mutationConcurency: 4 }));
        const registrar = new ApplicationRegistrar(new FileApplicationConfigStore(dir), newRegistry());

        await expect(registrar.ensure("bad-sched")).rejects.toThrow(/between 0 and 1 inclusive/);
        await expect(registrar.ensure("bad-exec")).rejects.toThrow(/not a recognised setting/);
    });

    it("exposes scheduling input for the dispatcher only once registered", async () => {
        await write("app-1", appDoc("app-1", { rateLimits: { create: { requestLimit: 5, requestPeriodMs: 1_000 } } }));
        const registrar = new ApplicationRegistrar(new FileApplicationConfigStore(dir), newRegistry());

        expect(registrar.schedulingOf("app-1")).toBeUndefined();
        await registrar.ensure("app-1");
        expect(registrar.schedulingOf("app-1")?.rateLimits?.create?.requestLimit).toBe(5);
    });
});

describe("resolveSchedulingConfig", () => {
    it("defaults the fraction and reserves against the budget", () => {
        const s = resolveSchedulingConfig(undefined, 10);
        expect(s.interactiveSliceFraction).toBe(0.2);
        expect(s.interactiveSlots).toBe(2);
        expect(s.batchSlots).toBe(8);
        expect(s.rateLimits).toEqual({});
    });

    it("reserves nothing at fraction 0 (RFE-1)", () => {
        const s = resolveSchedulingConfig({ interactiveSliceFraction: 0 }, 10);
        expect(s.interactiveSlots).toBe(0);
        expect(s.batchSlots).toBe(10);
    });

    it("reserves nothing at a budget of 1, where there is nothing to divide", () => {
        expect(computeInteractiveSlots(1, 0.5)).toBe(0);
        expect(resolveSchedulingConfig({ interactiveSliceFraction: 0.5 }, 1).batchSlots).toBe(1);
    });

    it("rounds a small positive fraction up to a whole slot", () => {
        // 0.2 of 3 is 0.6; flooring would leave no reservation on exactly the
        // instances where contention hurts most.
        expect(computeInteractiveSlots(3, 0.2)).toBe(1);
    });

    it("never reserves more than the budget", () => {
        expect(computeInteractiveSlots(4, 1)).toBe(4);
        expect(resolveSchedulingConfig({ interactiveSliceFraction: 1 }, 4).batchSlots).toBe(0);
    });

    it("validates rate limits and names the path", () => {
        expect(() => resolveSchedulingConfig({ rateLimits: { create: { requestLimit: 0, requestPeriodMs: 1 } } }, 4))
            .toThrow(/scheduling\.rateLimits\.create\.requestLimit must be at least 1/);
        expect(() => resolveSchedulingConfig({ rateLimits: { crate: {} } } as never, 4))
            .toThrow(/crate is not a known operation/);
        expect(() => resolveSchedulingConfig({ rateLimits: { create: { limit: 1 } } } as never, 4))
            .toThrow(/create\.limit is not a recognised setting/);
    });

    it("rejects an unknown scheduling key by name", () => {
        expect(() => resolveSchedulingConfig({ interactiveSlice: 0.2 } as never, 4))
            .toThrow(/scheduling\.interactiveSlice is not a recognised setting/);
    });
});

describe("ApplicationRegistrar — replacing a live instance", () => {
    it("waits for leases to drain before disposing", async () => {
        await write("app-1", appDoc("app-1", { mutationConcurrency: 2 }));
        const registry = newRegistry();
        let refcount = 2;
        const sleeps: number[] = [];

        const registrar = new ApplicationRegistrar(
            new FileApplicationConfigStore(dir), registry, {
                manager: { refcountOf: () => refcount },
                sleep: async (ms) => { sleeps.push(ms); if (sleeps.length === 3) refcount = 0; },
            });

        await registrar.ensure("app-1");
        await write("app-1", appDoc("app-1", { mutationConcurrency: 9 }));
        await registrar.ensure("app-1");

        // It polled rather than disposing under the live leases.
        expect(sleeps.length).toBe(3);
        expect(registry.getDefinition("app-1")?.runtime.mutationConcurrency).toBe(9);
    });

    it("refuses to replace an instance whose leases never drain", async () => {
        await write("app-1", appDoc("app-1"));
        const registry = newRegistry();
        let clock = 0;

        const registrar = new ApplicationRegistrar(
            new FileApplicationConfigStore(dir), registry, {
                manager: { refcountOf: () => 1 },
                drainTimeoutMs: 100,
                now: () => clock,
                sleep: async () => { clock += 50; },
            });

        await registrar.ensure("app-1");
        await write("app-1", appDoc("app-1", { mutationConcurrency: 3 }));

        await expect(registrar.ensure("app-1")).rejects.toThrow(/lease\(s\) are still outstanding/);
        // The old instance survives rather than being torn out mid-attempt.
        expect(registry.getDefinition("app-1")).toBeDefined();
    });
});
