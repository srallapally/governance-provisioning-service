/**
 * A `MetricsSink` that writes one line per measurement to the console.
 *
 * Deliberately minimal: P6 is where the real bindings from the P0 finding
 * land -- a structured-JSON stdout sink and an in-memory snapshot, with no
 * metrics client library taken as a dependency until a stack exists to talk
 * to. This exists only so `wiring.ts` has something satisfying the interface
 * to construct now, with no call site to revisit when P6 replaces it.
 */
import type { MetricLabels, MetricsSink } from "@governance-connector-framework/core";

function line(kind: string, name: string, value: number, labels?: MetricLabels): void {
    const suffix = labels && Object.keys(labels).length > 0 ? ` ${JSON.stringify(labels)}` : "";
    console.log(`[metrics] ${kind} ${name}=${value}${suffix}`);
}

export const consoleMetricsSink: MetricsSink = {
    counter: (name, value, labels) => line("counter", name, value, labels),
    gauge: (name, value, labels) => line("gauge", name, value, labels),
    histogram: (name, value, labels) => line("histogram", name, value, labels),
};
