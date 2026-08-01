/*
 * Entry point placeholder.
 *
 * Phase P0 is scaffold, config, and documents only -- no application code.
 * This file exists because `tsc` fails with TS18003 ("No inputs were found in
 * config file") when `include` matches nothing, so the acceptance criterion
 * "scaffold builds" needs at least one input.
 *
 * Phase P2 replaces it with the wiring module: dispatcher pg pool,
 * OperationStore, ConnectorRegistry + loader, ConnectorManager, MetricsSink,
 * Dispatcher, and start()/stop() behind SIGTERM.
 *
 * See PROVISIONING_SERVICE_PLAN.md.
 */

export {};
