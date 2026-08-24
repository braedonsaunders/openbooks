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

const hostilePlaidEnvironments = [
  "https://127.0.0.1",
  "//169.254.169.254/latest/meta-data",
  "production.plaid.com@127.0.0.1",
  "sandbox/../../127.0.0.1",
  "sandbox.plaid.com",
  "localhost",
  "[::1]",
  "production%2eplaid%2ecom",
  "toString",
  "constructor",
  "__proto__",
  "hasOwnProperty",
] as const;

test("Plaid endpoint allowlist rejects SSRF payloads and inherited keys", () => {
  assert.equal(plaidApiBase(), "https://production.plaid.com");
  assert.equal(plaidApiBase(" SANDBOX "), "https://sandbox.plaid.com");
  assert.equal(plaidApiBase("PRODUCTION"), "https://production.plaid.com");

  for (const environment of hostilePlaidEnvironments) {
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

test("Plaid environment resolution requires a string name hitting an own allowlist key", () => {
  // Absent environment keeps its documented production default.
  assert.equal(plaidApiBase(), "https://production.plaid.com");
  // A crafted object whose toString() spoofs an allowed environment must not
  // reach String coercion, and inherited/polluted names never resolve.
  const spoofingEnvironment = { toString: () => "sandbox" };
  for (const environment of [null, 5, true, {}, ["sandbox"], spoofingEnvironment]) {
    assert.throws(() => plaidApiBase(environment), /production or sandbox/);
  }
});

test("Plaid credentials with non-string environments fail closed before network I/O", async (t) => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error("non-string Plaid environments must not be contacted");
  };

  const plaid = getBankFeedAdapter("plaid");
  assert.ok(plaid);
  for (const env of [5, null, true, {}, ["sandbox"], { toString: () => "sandbox" }]) {
    const credentials = {
      clientId: "client-id",
      secret: "provider-secret",
      accessToken: "access-token",
      env,
    } as unknown as Record<string, string>;
    assert.deepEqual(await plaid.test(credentials), {
      ok: false,
      detail: "Plaid environment must be production or sandbox",
    });
    await assert.rejects(
      plaid.fetch(credentials, "account-id", "2026-01-01", "2026-01-31"),
      /Plaid environment must be production or sandbox/,
    );
  }
  assert.equal(requests, 0);
});

test("Plaid rejects non-allowlisted endpoints before network I/O", async (t) => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error("non-allowlisted Plaid endpoints must not be contacted");
  };

  const plaid = getBankFeedAdapter("plaid");
  assert.ok(plaid);
  for (const env of hostilePlaidEnvironments) {
    const credentials = {
      clientId: "client-id",
      secret: "provider-secret",
      accessToken: "access-token",
      env,
    };
    assert.deepEqual(await plaid.test(credentials), {
      ok: false,
      detail: "Plaid environment must be production or sandbox",
    });
    await assert.rejects(
      plaid.fetch(credentials, "account-id", "2026-01-01", "2026-01-31"),
      /Plaid environment must be production or sandbox/,
    );
  }
  assert.equal(requests, 0);
});

test("bank-feed provider allowlist accepts only exact adapter keys", () => {
  for (const provider of ["gocardless", "plaid", "truelayer"] as const) {
    assert.equal(getBankFeedAdapter(provider)?.key, provider);
  }
  for (const provider of [
    "",
    "PLAID",
    " plaid ",
    "plaid.example.com",
    "__proto__",
    "constructor",
    "toString",
  ]) {
    assert.equal(getBankFeedAdapter(provider), null);
  }

  const pollutedAdapter = getBankFeedAdapter("plaid");
  Object.defineProperty(Object.prototype, "pollutedbankfeed", {
    configurable: true,
    value: pollutedAdapter,
  });
  try {
    assert.equal(getBankFeedAdapter("pollutedbankfeed"), null);
  } finally {
    delete (Object.prototype as Record<string, unknown>).pollutedbankfeed;
  }
});

test("every bank-feed adapter confines hostile inputs to trusted HTTPS origins", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    let body: unknown = {};
    if (url.pathname === "/api/v2/token/new/") {
      body = { access: "access-token" };
    } else if (url.pathname === "/transactions/get") {
      body = { transactions: [], has_more: false };
    } else if (url.hostname === "bankaccountdata.gocardless.com") {
      body = { transactions: { booked: [] } };
    } else if (url.hostname === "api.truelayer.com" && url.pathname.endsWith("/transactions")) {
      body = { results: [] };
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const credentialPayload = "credential-must-not-appear-in-a-provider-url";
  const hostileAccountId = "https://169.254.169.254/latest/meta-data/?next=//127.0.0.1#fragment";
  const encodedAccountId = encodeURIComponent(hostileAccountId);

  const gocardless = getBankFeedAdapter("gocardless");
  assert.ok(gocardless);
  assert.deepEqual(await gocardless.test({
    secretId: credentialPayload,
    secretKey: credentialPayload,
  }), { ok: true });
  await gocardless.fetch(
    { secretId: credentialPayload, secretKey: credentialPayload },
    hostileAccountId,
    "2026-01-01",
    "2026-01-31",
  );

  const plaid = getBankFeedAdapter("plaid");
  assert.ok(plaid);
  const plaidCredentials = {
    clientId: credentialPayload,
    secret: credentialPayload,
    accessToken: credentialPayload,
    env: "sandbox",
  };
  assert.deepEqual(await plaid.test(plaidCredentials), { ok: true });
  await plaid.fetch(plaidCredentials, hostileAccountId, "2026-01-01", "2026-01-31");

  const truelayer = getBankFeedAdapter("truelayer");
  assert.ok(truelayer);
  assert.deepEqual(await truelayer.test({ accessToken: credentialPayload }), { ok: true });
  await truelayer.fetch(
    { accessToken: credentialPayload },
    hostileAccountId,
    "2026-01-01",
    "2026-01-31",
  );

  assert.deepEqual(
    requests.map(({ url }) => `${url.origin}${url.pathname}`),
    [
      "https://bankaccountdata.gocardless.com/api/v2/token/new/",
      "https://bankaccountdata.gocardless.com/api/v2/token/new/",
      `https://bankaccountdata.gocardless.com/api/v2/accounts/${encodedAccountId}/transactions/`,
      "https://sandbox.plaid.com/accounts/get",
      "https://sandbox.plaid.com/transactions/get",
      "https://api.truelayer.com/data/v1/accounts",
      `https://api.truelayer.com/data/v1/accounts/${encodedAccountId}/transactions`,
    ],
  );
  for (const { url, init } of requests) {
    assert.equal(url.protocol, "https:");
    assert.equal(url.username, "");
    assert.equal(url.password, "");
    assert.equal(init?.redirect, "error");
    assert.ok(!url.href.includes(credentialPayload));
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

const plaidCredentials = {
  clientId: "client-id",
  secret: "provider-secret",
  accessToken: "access-token",
  env: "sandbox",
};

test("Plaid refuses a blank account mapping before contacting the provider", async (t) => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error("Plaid must not be contacted without an account mapping");
  };

  const plaid = getBankFeedAdapter("plaid");
  assert.ok(plaid);
  for (const accountId of ["", " \t "]) {
    await assert.rejects(
      plaid.fetch(plaidCredentials, accountId, "2026-08-01", "2026-08-23"),
      /Plaid account id required/,
    );
  }
  assert.equal(requests, 0);
});

test("Plaid scopes every transaction page to the configured account mapping", async (t) => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Array<{
    start_date: string;
    end_date: string;
    options: { account_ids?: string[]; count: number; offset: number };
  }> = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as (typeof requestBodies)[number];
    requestBodies.push(body);
    return new Response(JSON.stringify({
      transactions: [],
      has_more: requestBodies.length === 1,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const plaid = getBankFeedAdapter("plaid");
  assert.ok(plaid);
  await plaid.fetch(
    plaidCredentials,
    "  plaid-account-42  ",
    "2026-08-01",
    "2026-08-23",
  );

  assert.deepEqual(
    requestBodies.map(({ start_date, end_date, options }) => ({
      start_date,
      end_date,
      options,
    })),
    [
      {
        start_date: "2026-08-01",
        end_date: "2026-08-23",
        options: { account_ids: ["plaid-account-42"], count: 500, offset: 0 },
      },
      {
        start_date: "2026-08-01",
        end_date: "2026-08-23",
        options: { account_ids: ["plaid-account-42"], count: 500, offset: 500 },
      },
    ],
  );
});
