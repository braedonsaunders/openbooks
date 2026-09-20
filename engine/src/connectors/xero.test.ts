import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { XeroClient, exchangeCode, listConnections, refreshTokens } from "./xero.ts";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

const app = { clientId: "client-id", clientSecret: "client-secret", redirectUri: "https://app.example/callback" };
const tokens = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

// Every credentialed surface of the Xero client: the OAuth token endpoints
// carry the Basic-auth client secret, every API call carries a bearer token
// (plus the tenant id). None of them may ever follow an HTTP redirect, which
// would re-send those headers to whatever host the Location points at.
test("every credentialed Xero request opts out of redirect-following", async () => {
  const originalFetch = globalThis.fetch;
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = ((input, init) => {
    seen.push({ url: String(input), init });
    const pathname = new URL(String(input)).pathname;
    const body = pathname === "/connect/token"
      ? JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 1800 })
      : pathname === "/connections"
      ? "[]"
      : "{}";
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;

  try {
    await exchangeCode(app, "auth-code");
    await refreshTokens(app, "refresh-token");
    await listConnections(tokens.accessToken);
    await new XeroClient(app, "tenant-id", tokens).get("Invoices");

    assert.deepEqual(seen.map(({ url }) => new URL(url).href), [
      "https://identity.xero.com/connect/token",
      "https://identity.xero.com/connect/token",
      "https://api.xero.com/connections",
      "https://api.xero.com/api.xro/2.0/Invoices",
    ]);
    const authorization = seen.map(({ init }) =>
      String((init?.headers as Record<string, string> | undefined)?.Authorization)
    );
    assert.match(authorization[0]!, /^Basic /);
    assert.match(authorization[1]!, /^Basic /);
    assert.equal(authorization[2], "Bearer access-token");
    assert.equal(authorization[3], "Bearer access-token");
    const apiCall = seen[3]!;
    assert.equal(
      String((apiCall.init?.headers as Record<string, string> | undefined)?.["xero-tenant-id"]),
      "tenant-id",
    );
    // The exact opt-out: without it, fetch follows redirects and replays the
    // Authorization header against the redirect target.
    assert.deepEqual(
      seen.map(({ init }) => init?.redirect),
      ["manual", "manual", "manual", "manual"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Every 3xx class must be refused, not followed: 307/308 preserve method AND
// body; 301/302/303 still leak whichever headers survive the re-request. The
// refusal must also be terminal — a deterministic security answer from the
// origin, not a transient fault worth retrying four times.
const redirectStatuses = [301, 302, 303, 307, 308] as const;

test("Xero OAuth and API calls refuse every redirect class without forwarding credentials", async () => {
  let attackerRequests = 0;
  const attacker = createServer((_req, res) => {
    attackerRequests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const attackerOrigin = await listen(attacker);
  const attemptedPaths: string[] = [];
  // Cycle the status so successive calls meet different redirect classes.
  const redirector = createServer((req, res) => {
    attemptedPaths.push(req.url ?? "");
    res.writeHead(redirectStatuses[(attemptedPaths.length - 1) % redirectStatuses.length]!, {
      location: `${attackerOrigin}/credential-capture`,
    });
    res.end();
  });
  const xeroOrigin = await listen(redirector);
  const originalFetch = globalThis.fetch;
  const xeroHosts = ["https://identity.xero.com", "https://api.xero.com"];
  const redirectModes: Array<RequestRedirect | undefined> = [];
  globalThis.fetch = (input, init) => {
    redirectModes.push(init?.redirect);
    let rewritten = String(input);
    for (const host of xeroHosts) rewritten = rewritten.replace(host, xeroOrigin);
    return originalFetch(rewritten, init);
  };

  const client = new XeroClient(app, "tenant-id", tokens);
  try {
    await assert.rejects(exchangeCode(app, "auth-code"), /HTTP 301 redirect.*credential-capture/s);
    await assert.rejects(refreshTokens(app, "refresh-token"), /redirect/i);
    await assert.rejects(listConnections(tokens.accessToken), /redirect/i);
    await assert.rejects(client.get("Invoices"), /redirect/i);

    // Exactly one hop per call reaches the allowlisted origin — never a
    // second, followed hop — even though XeroClient.get retries transient
    // faults: a redirect refusal is terminal by design.
    assert.deepEqual(attemptedPaths, ["/connect/token", "/connect/token", "/connections", "/api.xro/2.0/Invoices"]);
    assert.deepEqual(redirectModes, ["manual", "manual", "manual", "manual"]);
    assert.equal(attackerRequests, 0, "credentials must never reach the redirect target");
  } finally {
    globalThis.fetch = originalFetch;
    await close(redirector);
    await close(attacker);
  }
});
