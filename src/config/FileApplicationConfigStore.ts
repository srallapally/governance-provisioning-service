/**
 * An {@link ApplicationConfigStore} over a directory of JSON documents.
 *
 * The default implementation, chosen for ease of testing: a store backed by
 * the IGA repository replaces it later behind the same interface, and nothing
 * that consumes a config has to change.
 *
 * One file per application, named `<applicationId>.json`. The version is a
 * content hash, so an edit is detected by comparison rather than by a timer,
 * and a file rewritten with identical bytes does not invalidate a built
 * connector instance.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
    validateApplicationConfig,
    type ApplicationConfigStore,
    type VersionedApplicationConfig,
} from "./application.js";

/**
 * Application ids reach this store from operation rows, which reach those from
 * HTTP paths. Anything that could climb out of the directory or name a file
 * other than `<id>.json` is refused rather than sanitised -- a rewritten id
 * would silently serve the wrong application's credentials.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class FileApplicationConfigStore implements ApplicationConfigStore {
    constructor(private readonly directory: string) {}

    async get(applicationId: string): Promise<VersionedApplicationConfig | null> {
        if (!SAFE_ID.test(applicationId) || applicationId.includes("..")) {
            throw new Error(
                `applicationId ${JSON.stringify(applicationId)} is not a valid identifier`,
            );
        }

        const file = path.join(this.directory, `${applicationId}.json`);
        let text: string;
        try {
            text = await readFile(file, "utf8");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw err;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch (err) {
            throw new Error(`${file}: not valid JSON -- ${(err as Error).message}`);
        }

        const config = validateApplicationConfig(parsed, file);
        if (config.applicationId !== applicationId) {
            // Serving it anyway would register an instance under one id whose
            // config claims another, and the mismatch would surface much later
            // as operations dispatched against the wrong target.
            throw new Error(
                `${file}: applicationId is ${JSON.stringify(config.applicationId)} ` +
                `but the file is named for ${JSON.stringify(applicationId)}`,
            );
        }

        // Hash the bytes, not the parsed object: key order and whitespace are
        // not semantic, but re-serialising to normalise them would cost more
        // than the rebuild it saves.
        return { config, version: createHash("sha256").update(text).digest("hex") };
    }
}
