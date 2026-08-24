import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import {
  getBankFeedAdapter,
  plaidApiBase,
} from "./bank-feed-providers.ts";

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
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("Plaid environment allowlist rejects inherited and prototype-polluted keys", () => {
  assert.equal(plaidApiBase(), "https://production.plaid.com");
  assert.equal(plaidApiBase(" SANDBOX "), "https://sandbox.plaid.com");

  for (const environment of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    assert.throws(() => plaidApiBase(environment), /production or sandbox/);
  }

  Object.defineProperty(Object.prototype, "pollutedplaid", {
    configurable: true,
    value: "http://127.0.0.1",
  });
  try {
    assert.throws(() => plaidApiBase("pollutedPlaid"), /production or sandbox/);
  } finally {
    delete (Object.prototype as Record<string, unknown>).pollutedplaid;
  }
});

test("Plaid requests refuse 307 redirects without forwarding credentials", async () => {
  let attackerRequests = 0;
  const attacker = createServer((_req, res) => {
    attackerRequests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const attackerOrigin = await listen(attacker);
  const providerPaths: string[] = [];
  const redirector = createServer((req, res) => {
    providerPaths.push(req.url ?? "");
    res.writeHead(307, { location: `${attackerOrigin}/credential-capture` });
    res.end();
  });
  const providerOrigin = await listen(redirector);
  const originalFetch = globalThis.fetch;
  const redirectModes: Array<RequestRedirect | undefined> = [];
  globalThis.fetch = (input, init) => {
    redirectModes.push(init?.redirect);
    const providerUrl = String(input).replace("https://sandbox.plaid.com", providerOrigin);
    return originalFetch(providerUrl, init);
  };

  try {
    const plaid = getBankFeedAdapter("plaid");
    assert.ok(plaid);
    const credentials = {
      clientId: "client-id",
      secret: "provider-secret",
      accessToken: "access-token",
      env: "sandbox",
    };

    const tested = await plaid.test(credentials);
    assert.equal(tested.ok, false);
    await assert.rejects(
      plaid.fetch(credentials, "account-id", "2026-01-01", "2026-01-31"),
      /fetch failed|redirect/i,
    );

    assert.deepEqual(providerPaths, ["/accounts/get", "/transactions/get"]);
    assert.deepEqual(redirectModes, ["error", "error"]);
    assert.equal(attackerRequests, 0, "credentials must never reach the redirect target");
  } finally {
    globalThis.fetch = originalFetch;
    await close(redirector);
    await close(attacker);
  }
});
