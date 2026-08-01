import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { IgaTokenProvider } from "../../src/config/IgaTokenProvider.js";

/**
 * A throwaway token endpoint. Real HTTP rather than a mocked `fetch`: the
 * class under test is a straight port of the framework's `OAuthTokenProvider`,
 * and the point of these tests is confidence the port didn't drift, not that
 * `fetch` was called with the right arguments.
 */
async function startServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
    const server: Server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
    return {
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
}

let servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
    await Promise.all(servers.map((s) => s.close()));
    servers = [];
    vi.useRealTimers();
});

describe("IgaTokenProvider", () => {
    it("fetches a token and returns it", async () => {
        const server = await startServer((_req, res) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }));
        });
        servers.push(server);

        const provider = new IgaTokenProvider({
            tokenUrl: server.url, clientId: "c", clientSecret: "s",
        });

        expect(await provider.getToken()).toBe("tok-1");
    });

    it("sends the client-credentials grant with client id and secret in the body", async () => {
        let received: URLSearchParams | undefined;
        const server = await startServer(async (req, res) => {
            received = new URLSearchParams(await readBody(req));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ access_token: "tok", expires_in: 60 }));
        });
        servers.push(server);

        await new IgaTokenProvider({ tokenUrl: server.url, clientId: "the-id", clientSecret: "the-secret" })
            .getToken();

        expect(received?.get("grant_type")).toBe("client_credentials");
        expect(received?.get("client_id")).toBe("the-id");
        expect(received?.get("client_secret")).toBe("the-secret");
    });

    it("includes scope, audience, and resource only when supplied", async () => {
        let received: URLSearchParams | undefined;
        const server = await startServer(async (req, res) => {
            received = new URLSearchParams(await readBody(req));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ access_token: "tok", expires_in: 60 }));
        });
        servers.push(server);

        await new IgaTokenProvider({
            tokenUrl: server.url, clientId: "c", clientSecret: "s",
            scope: "fr:iga:*", audience: "svc", resource: "res",
        }).getToken();

        expect(received?.get("scope")).toBe("fr:iga:*");
        expect(received?.get("audience")).toBe("svc");
        expect(received?.get("resource")).toBe("res");
    });

    it("omits scope/audience/resource entirely when not configured", async () => {
        let received: URLSearchParams | undefined;
        const server = await startServer(async (req, res) => {
            received = new URLSearchParams(await readBody(req));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ access_token: "tok", expires_in: 60 }));
        });
        servers.push(server);

        await new IgaTokenProvider({ tokenUrl: server.url, clientId: "c", clientSecret: "s" }).getToken();

        expect(received?.has("scope")).toBe(false);
        expect(received?.has("audience")).toBe(false);
        expect(received?.has("resource")).toBe(false);
    });

    it("fails with the token endpoint's status embedded in the message (P2 accept criterion)", async () => {
        const server = await startServer((_req, res) => {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_client" }));
        });
        servers.push(server);

        const provider = new IgaTokenProvider({ tokenUrl: server.url, clientId: "c", clientSecret: "wrong" });

        await expect(provider.getToken()).rejects.toThrow(/401/);
        await expect(provider.getToken()).rejects.toThrow(/invalid_client/);
    });

    it("fails distinctly when the response has no access_token", async () => {
        const server = await startServer((_req, res) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ expires_in: 60 }));
        });
        servers.push(server);

        await expect(
            new IgaTokenProvider({ tokenUrl: server.url, clientId: "c", clientSecret: "s" }).getToken(),
        ).rejects.toThrow(/missing access_token/);
    });

    it("accepts expires_in as a number, a numeric string, or absent (defaulting to 300s)", async () => {
        let expiresInBody = "3600";
        const server = await startServer((_req, res) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            const body: Record<string, unknown> = { access_token: "tok" };
            if (expiresInBody !== "absent") {
                body["expires_in"] = expiresInBody === "60" ? 60 : expiresInBody;
            }
            res.end(JSON.stringify(body));
        });
        servers.push(server);

        vi.useFakeTimers();
        vi.setSystemTime(0);
        const provider = new IgaTokenProvider({ tokenUrl: server.url, clientId: "c", clientSecret: "s" });

        expiresInBody = "60";
        await provider.getToken();
        expect(provider.getTokenExpiryTime()).toBe(60_000);

        provider.invalidate();
        expiresInBody = "120"; // numeric string
        await provider.getToken();
        expect(provider.getTokenExpiryTime()).toBe(120_000);

        provider.invalidate();
        expiresInBody = "absent";
        await provider.getToken();
        expect(provider.getTokenExpiryTime()).toBe(300_000);
    });

    it("refetches lazily: cached token is reused inside the early-expiry margin, refetched once inside it", async () => {
        let calls = 0;
        const server = await startServer((_req, res) => {
            calls++;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ access_token: `tok-${calls}`, expires_in: 3600 }));
        });
        servers.push(server);

        vi.useFakeTimers();
        vi.setSystemTime(0);
        const provider = new IgaTokenProvider({ tokenUrl: server.url, clientId: "c", clientSecret: "s" });

        expect(await provider.getToken()).toBe("tok-1");
        expect(await provider.getToken()).toBe("tok-1"); // cached, no second call
        expect(calls).toBe(1);

        // 3600s expiry, inside the 30s early-expiry margin: 3600_000 - 30_000 + 1
        vi.setSystemTime(3_600_000 - 30_000 + 1);
        expect(await provider.getToken()).toBe("tok-2");
        expect(calls).toBe(2);
    });

    it("invalidate() forces the next getToken() to refetch regardless of expiry", async () => {
        let calls = 0;
        const server = await startServer((_req, res) => {
            calls++;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ access_token: `tok-${calls}`, expires_in: 3600 }));
        });
        servers.push(server);

        const provider = new IgaTokenProvider({ tokenUrl: server.url, clientId: "c", clientSecret: "s" });
        expect(await provider.getToken()).toBe("tok-1");

        provider.invalidate();
        expect(provider.getTokenExpiryTime()).toBe(0);
        expect(await provider.getToken()).toBe("tok-2");
        expect(calls).toBe(2);
    });

    it("fails when the endpoint is unreachable", async () => {
        // Port 1 is reserved; nothing answers, and fetch rejects at the
        // network layer rather than returning a response to inspect.
        const provider = new IgaTokenProvider({
            tokenUrl: "http://127.0.0.1:1", clientId: "c", clientSecret: "s",
        });
        await expect(provider.getToken()).rejects.toThrow();
    });
});
