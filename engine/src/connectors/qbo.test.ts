import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { exchangeCode, type QboApp, QboClient, refreshTokens } from "./qbo.ts";

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

const app: QboApp = {
  clientId: "qbo-client-id",
  clientSecret: "qbo-client-secret",
  redirectUri: "https://books.example/qbo/callback",
  environment: "production",
};

const REALM_ID = "9130348395687776";

const liveTokens = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

/** Remap every allowlisted Intuit origin onto a local test server so the
 *  client exercises its real URL construction and credential placement
 *  without touching the network. Sandbox is listed before production because
 *  it contains the production host as a substring. */
function remapIntuitOrigins(originalFetch: typeof fetch, targetOrigin: string) {
  const intuitOrigins = [
    "https://sandbox-quickbooks.api.intuit.com",
    "https://quickbooks.api.intuit.com",
    "https://oauth.platform.intuit.com",
  ];
  const redirectModes: Array<RequestRedirect | undefined> = [];
  globalThis.fetch = (input, init) => {
    redirectModes.push(init?.redirect);
    let url = String(input);
    for (const origin of intuitOrigins) url = url.replace(origin, targetOrigin);
    return originalFetch(url, init);
  };
  return redirectModes;
}

// Every 3xx with a Location must be refused, not followed: 307/308 preserve
// method AND body (client secret, refresh token, authorization code); the
// re-request after 301/302/303 leaks whichever credentials survive it. Each
// call here carries secrets, so none may ever cross an HTTP redirect boundary.
const redirectStatuses = [301, 302, 303, 307, 308] as const;

test("QBO token exchange, refresh, and API calls refuse redirects without forwarding credentials", async () => {
  let attackerRequests = 0;
  const attacker = createServer((_req, res) => {
    attackerRequests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const attackerOrigin = await listen(attacker);
  const qboPaths: string[] = [];
  const redirector = createServer((req, res) => {
    qboPaths.push(req.url ?? "");
    // Cycle the status so each client call meets a different redirect class.
    res.writeHead(redirectStatuses[qboPaths.length % redirectStatuses.length]!, {
      location: `${attackerOrigin}/credential-capture`,
    });
    res.end();
  });
  const qboOrigin = await listen(redirector);
  const originalFetch = globalThis.fetch;
  const redirectModes = remapIntuitOrigins(originalFetch, qboOrigin);

  try {
    await assert.rejects(exchangeCode(app, "auth-code"), /fetch failed|redirect/i);
    await assert.rejects(refreshTokens(app, liveTokens.refreshToken), /fetch failed|redirect/i);

    const client = new QboClient(app, REALM_ID, liveTokens);
    await assert.rejects(client.queryAll("Account"), /fetch failed|redirect/i);
    await assert.rejects(client.report("TrialBalance"), /fetch failed|redirect/i);
    await assert.rejects(client.preferences(), /fetch failed|redirect/i);

    // Exactly one request per client call reaches the allowlisted Intuit
    // origin — never a second, followed hop — and the attacker sees zero.
    assert.deepEqual(
      qboPaths.map((p) => new URL(p, qboOrigin).pathname),
      [
        "/oauth2/v1/tokens/bearer",
        "/oauth2/v1/tokens/bearer",
        `/v3/company/${REALM_ID}/query`,
        `/v3/company/${REALM_ID}/reports/TrialBalance`,
        `/v3/company/${REALM_ID}/preferences`,
      ],
    );
    assert.deepEqual(redirectModes, ["error", "error", "error", "error", "error"]);
    assert.equal(attackerRequests, 0, "credentials must never reach the redirect target");
  } finally {
    globalThis.fetch = originalFetch;
    await close(redirector);
    await close(attacker);
  }
});

test("normal Intuit responses pass: token exchange, refresh rotation, and bearer API reads", async () => {
  interface SeenCall {
    path: string;
    authorization: string;
    grantType?: string;
  }
  const seen: SeenCall[] = [];
  const intuit = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const path = req.url ?? "";
      seen.push({
        path,
        authorization: req.headers.authorization ?? "",
        grantType: path.startsWith("/oauth2/") ? (new URLSearchParams(raw).get("grant_type") ?? undefined) : undefined,
      });
      if (path.startsWith("/oauth2/v1/tokens/bearer")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }));
        return;
      }
      if (path.includes("/query")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ QueryResponse: { Account: [{ Id: "1", Name: "Checking" }, { Id: "2", Name: "Savings" }] } }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Rows: [] }));
    });
  });
  const intuitOrigin = await listen(intuit);
  const originalFetch = globalThis.fetch;
  const redirectModes = remapIntuitOrigins(originalFetch, intuitOrigin);

  try {
    const exchanged = await exchangeCode(app, "auth-code");
    assert.equal(exchanged.accessToken, "at-new");
    assert.equal(exchanged.refreshToken, "rt-new");
    // The -60s safety skew keeps expiry strictly inside the real window.
    const expiresInMs = new Date(exchanged.expiresAt).getTime() - Date.now();
    assert.ok(expiresInMs > 3_500_000 && expiresInMs <= 3_600_000, "expiry must be ISO and ~59 minutes out");

    const rotated = await refreshTokens(app, "rt-old");
    assert.equal(rotated.accessToken, "at-new");
    assert.equal(rotated.refreshToken, "rt-new");

    const client = new QboClient(app, REALM_ID, { ...exchanged, accessToken: "access-token" });
    const accounts = await client.queryAll<{ Id: string; Name: string }>("Account");
    assert.deepEqual(accounts.map((a) => a.Name), ["Checking", "Savings"]);

    const trialBalance = await client.report<{ Rows: unknown[] }>("TrialBalance");
    assert.deepEqual(trialBalance, { Rows: [] });

    // Credentials travel only inside the request to the allowlisted origin:
    // Basic client auth + grant bodies on token calls, bearer on API calls.
    assert.deepEqual(redirectModes, ["error", "error", "error", "error"]);
    assert.deepEqual(
      seen.map((c) => new URL(c.path, intuitOrigin).pathname),
      [
        "/oauth2/v1/tokens/bearer",
        "/oauth2/v1/tokens/bearer",
        `/v3/company/${REALM_ID}/query`,
        `/v3/company/${REALM_ID}/reports/TrialBalance`,
      ],
    );
    const [exchangeCall, refreshCall, queryCall] = seen;
    assert.ok(exchangeCall && refreshCall && queryCall);
    assert.match(exchangeCall.authorization, /^Basic /);
    assert.equal(
      Buffer.from(exchangeCall.authorization.slice("Basic ".length), "base64").toString(),
      "qbo-client-id:qbo-client-secret",
    );
    assert.equal(exchangeCall.grantType, "authorization_code");
    assert.match(refreshCall.authorization, /^Basic /);
    assert.equal(refreshCall.grantType, "refresh_token");
    assert.match(queryCall.authorization, /^Bearer access-token$/);
  } finally {
    globalThis.fetch = originalFetch;
    await close(intuit);
  }
});
