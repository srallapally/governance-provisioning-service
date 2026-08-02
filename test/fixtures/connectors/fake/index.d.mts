// Declarations for index.mjs's P8 soak instrumentation exports, so
// test/load/soakHttp.ts (TypeScript) can import them with real types instead
// of an implicit `any`. The factory's default export isn't declared here --
// nothing outside loadExternalConnectors calls it directly.
export interface SoakAttempt {
    priority: string;
    instanceId: string;
    start: number;
    end?: number;
}

export const attemptLog: SoakAttempt[];
export let laneViolations: number;
export function resetSoakInstrumentation(): void;
