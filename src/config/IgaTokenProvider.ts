/**
 * OAuth 2.0 client-credentials token provider for outbound calls to IGA.
 *
 * Ported from the framework's `packages/websocket/src/server/OAuthTokenProvider.ts`
 * rather than depended upon -- that package is a deployable service, not a
 * library, and this repo consumes `@governance-connector-framework/core` only
 * (settled at P0, finding 6). The class is unchanged in shape and behaviour;
 * only the name and this file's home moved.
 *
 * Two decisions carried over deliberately rather than re-made:
 *
 * - Renewal is lazy, on use, inside a 30-second early-expiry margin. A
 *   background refresh timer would be a second thing for `wiring.ts` to shut
 *   down cleanly and would keep firing in an idle container for no benefit.
 * - `getToken()`'s failure message already embeds the token endpoint's HTTP
 *   status. `wiring.ts` calls this once at `start()` specifically so a bad
 *   client secret fails at deploy time with that status in the message,
 *   rather than surfacing opaquely on the first operation that reaches IGA.
 */
export interface IgaTokenOptions {
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    scope?: string | undefined;
    audience?: string | undefined;
    resource?: string | undefined;
}

export class IgaTokenProvider {
    private accessToken: string | null = null;
    private expiresAt = 0;
    private readonly earlyExpiryMs = 30_000;

    constructor(private readonly opts: IgaTokenOptions) {}

    /** Forces the next `getToken()` to fetch, regardless of expiry. Use on a 401 from IGA. */
    invalidate(): void {
        this.accessToken = null;
        this.expiresAt = 0;
    }

    private isTokenValid(): boolean {
        return this.accessToken !== null && Date.now() + this.earlyExpiryMs < this.expiresAt;
    }

    getTokenExpiryTime(): number {
        return this.expiresAt;
    }

    async getToken(): Promise<string> {
        if (this.isTokenValid()) return this.accessToken!;

        const body = new URLSearchParams({
            grant_type: "client_credentials",
            client_id: this.opts.clientId,
            client_secret: this.opts.clientSecret,
        });
        if (this.opts.scope) body.set("scope", this.opts.scope);
        if (this.opts.audience) body.set("audience", this.opts.audience);
        if (this.opts.resource) body.set("resource", this.opts.resource);

        const res = await fetch(this.opts.tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
        });

        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(
                `OAuth token request failed (${res.status} ${res.statusText}): ${text.slice(0, 200)}`,
            );
        }

        const json = (await res.json()) as Record<string, unknown>;
        const token = typeof json["access_token"] === "string" ? json["access_token"] : null;
        if (!token) throw new Error("OAuth token response missing access_token");

        const rawExpires = json["expires_in"];
        const expires = typeof rawExpires === "number"
            ? rawExpires
            : typeof rawExpires === "string"
                ? Number.parseInt(rawExpires, 10)
                : null;
        const expiresInSec = expires !== null && Number.isFinite(expires) && expires > 0 ? expires : 300;

        this.accessToken = token;
        this.expiresAt = Date.now() + expiresInSec * 1000;
        return token;
    }
}
