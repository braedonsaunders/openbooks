import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import test from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import { sealJson, unsealJson } from "../platform/secrets.ts";
import { dropScratchOrg } from "../testing/fixtures.ts";
import {
  quoteExternalTax,
  quoteFromRate,
  readTaxRateProviderConfigView,
  quoteViaAvalara,
  quoteViaCustomHttp,
  quoteViaTaxJar,
  saveTaxRateProviderConfig,
  TaxRateProviderError,
  validateTaxProviderEndpointUrl,
  type TaxQuoteRequest,
} from "./rate-providers.ts";

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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

/** Record the redirect mode every provider request is issued with so the tests
 *  can prove the credential-bearing POSTs never opt into following redirects. */
function spyRedirectMode(originalFetch: typeof fetch): Array<RequestRedirect | undefined> {
  const redirectModes: Array<RequestRedirect | undefined> = [];
  globalThis.fetch = (input, init) => {
    redirectModes.push(init?.redirect);
    return originalFetch(input, init);
  };
  return redirectModes;
}

// Every 3xx with a Location must be refused, not followed: fetch would replay
// the Authorization header — the Avalara accountId:licenseKey basic auth, the
// TaxJar API key, or the custom hook's bearer secret — to whichever host the
// Location names (307/308 preserve method AND body).
const redirectStatuses = [301, 302, 303, 307, 308] as const;

const quoteRequest: TaxQuoteRequest = {
  taxableAmount: "100.0000",
  currency: "USD",
  shipFrom: { country: "US", region: "WA", postalCode: "98101" },
  shipTo: {
    line1: "123 Main St",
    city: "Seattle",
    region: "WA",
    postalCode: "98101",
    country: "US",
  },
  quotedOn: "2026-08-25",
};

const AVALARA_ACCOUNT_ID = "ACCT42";
const AVALARA_LICENSE_KEY = "AVALARA-LICENSE-KEY";
const TAXJAR_API_KEY = "TAXJAR-API-KEY";
const CUSTOM_HOOK_KEY = "CUSTOM-HOOK-KEY";

function callEachProviderAt(
  origin: string,
): Array<{ name: string; call: () => Promise<unknown> }> {
  // Local stub servers speak plain http on loopback: the test switch opts out
  // of the public-address guard explicitly per call — production callers
  // never pass it.
  const local = { allowPrivateEndpoints: true } as const;
  return [
    {
      name: "avalara",
      call: () =>
        quoteViaAvalara(
          quoteRequest,
          {
            accountId: AVALARA_ACCOUNT_ID,
            licenseKey: AVALARA_LICENSE_KEY,
            baseUrl: origin,
            quotedOn: quoteRequest.quotedOn!,
          },
          local,
        ),
    },
    {
      name: "taxjar",
      call: () => quoteViaTaxJar(quoteRequest, { apiKey: TAXJAR_API_KEY, baseUrl: origin }, local),
    },
    {
      name: "custom_http",
      call: () => quoteViaCustomHttp(quoteRequest, { url: `${origin}/hook-quote`, apiKey: CUSTOM_HOOK_KEY }, local),
    },
  ];
}

test("provider redirect regressions: every credential-bearing tax request fails closed without forwarding license keys", async () => {
  let attackerRequests = 0;
  const attackerAuthorization: string[] = [];
  const attacker = createServer((req, res) => {
    attackerRequests += 1;
    attackerAuthorization.push(req.headers.authorization ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const attackerOrigin = await listen(attacker);

  // Cycle the status so each provider meets every redirect class (301→308).
  const redirectorPaths: string[] = [];
  const redirector = createServer((req, res) => {
    redirectorPaths.push(req.url ?? "");
    res.writeHead(redirectStatuses[(redirectorPaths.length - 1) % redirectStatuses.length]!, {
      location: `${attackerOrigin}/credential-capture`,
    });
    res.end();
  });
  const redirectorOrigin = await listen(redirector);
  const originalFetch = globalThis.fetch;
  const redirectModes = spyRedirectMode(originalFetch);

  try {
    const providers = callEachProviderAt(redirectorOrigin);
    for (const status of redirectStatuses) {
      for (const provider of providers) {
        await assert.rejects(provider.call(), /fetch failed|redirect/i, `${provider.name} must refuse HTTP ${status}`);
      }
    }

    // Exactly one hop per call reaches the configured origin — never a second,
    // followed one — and every request opted out of redirect following.
    const expectedPaths = redirectStatuses.flatMap(() => [
      "/api/v2/transactions/create",
      "/v2/taxes",
      "/hook-quote",
    ]);
    assert.deepEqual(
      redirectorPaths.map((p) => new URL(p, redirectorOrigin).pathname),
      expectedPaths,
    );
    assert.deepEqual(redirectModes, new Array(expectedPaths.length).fill("error"));

    // The exact credential material must never reach the redirect target.
    assert.equal(attackerRequests, 0, "license keys must never reach the redirect target");
    assert.deepEqual(attackerAuthorization, []);
  } finally {
    globalThis.fetch = originalFetch;
    await close(redirector);
    await close(attacker);
  }
});

test("Avalara and TaxJar refuse an empty destination instead of defaulting it to the US", async () => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const origin = await listen(server);
  try {
    await assert.rejects(
      quoteViaAvalara({ ...quoteRequest, shipTo: {} }, {
        accountId: AVALARA_ACCOUNT_ID,
        licenseKey: AVALARA_LICENSE_KEY,
        baseUrl: origin,
        quotedOn: quoteRequest.quotedOn!,
      }),
      /Avalara quote needs a destination country/,
    );
    await assert.rejects(
      quoteViaTaxJar({ ...quoteRequest, shipFrom: {}, shipTo: {} }, { apiKey: TAXJAR_API_KEY, baseUrl: origin }),
      /TaxJar quote needs an origin country/,
    );
    await assert.rejects(
      quoteViaTaxJar(
        { ...quoteRequest, shipFrom: { country: "CA" }, shipTo: {} },
        { apiKey: TAXJAR_API_KEY, baseUrl: origin },
      ),
      /TaxJar quote needs a destination country/,
    );
    assert.equal(calls, 0, "no provider call may go out with a fabricated destination");
  } finally {
    await close(server);
  }
});

test("normal provider responses pass with credentials confined to the configured origin", async () => {
  interface SeenCall {
    pathname: string;
    authorization: string | undefined;
    body: Record<string, unknown>;
  }

  let avalaraAuth: string | undefined;
  let avalaraBody: Record<string, unknown> = {};
  const avalara = createServer(async (req, res) => {
    avalaraAuth = req.headers.authorization;
    avalaraBody = JSON.parse(await readBody(req)) as Record<string, unknown>;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        totalTax: 8.25,
        code: "QT-1001",
        summary: [
          { jurisdictionType: "State", rate: 0.065, tax: 6.5, taxName: "WA State" },
          { jurisdictionType: "City", rate: 0.0175, tax: 1.75, taxName: "Seattle" },
        ],
      }),
    );
  });
  const avalaraOrigin = await listen(avalara);

  let taxjarAuth: string | undefined;
  let taxjarBody: Record<string, unknown> = {};
  const taxjar = createServer(async (req, res) => {
    taxjarAuth = req.headers.authorization;
    taxjarBody = JSON.parse(await readBody(req)) as Record<string, unknown>;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        tax: {
          amount_to_collect: 8.25,
          rate: 0.0825,
          breakdown: {
            state_tax_collectable: 6.5,
            state_tax_rate: 0.065,
            city_tax_collectable: 1.75,
            city_tax_rate: 0.0175,
            // County reports an amount but omits its own rate: the component
            // falls back to the blended rate and must say so explicitly.
            county_tax_collectable: 0,
          },
        },
      }),
    );
  });
  const taxjarOrigin = await listen(taxjar);

  const customSeen: SeenCall[] = [];
  const custom = createServer(async (req, res) => {
    customSeen.push({
      pathname: req.url ?? "",
      authorization: req.headers.authorization,
      body: JSON.parse(await readBody(req)) as Record<string, unknown>,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        taxAmount: "3.20",
        components: [{ jurisdiction: "WA", ratePercent: "3.2000", taxAmount: "3.2000" }],
        externalRef: "HOOK-REF",
      }),
    );
  });
  const customOrigin = await listen(custom);

  const originalFetch = globalThis.fetch;
  const redirectModes = spyRedirectMode(originalFetch);
  const local = { allowPrivateEndpoints: true } as const;
  try {
    const [avalaraQuote, taxjarQuote, customQuote] = await Promise.all([
      quoteViaAvalara(
        quoteRequest,
        {
          accountId: AVALARA_ACCOUNT_ID,
          licenseKey: AVALARA_LICENSE_KEY,
          baseUrl: avalaraOrigin,
          quotedOn: quoteRequest.quotedOn!,
        },
        local,
      ),
      quoteViaTaxJar(quoteRequest, { apiKey: TAXJAR_API_KEY, baseUrl: taxjarOrigin }, local),
      quoteViaCustomHttp(quoteRequest, { url: `${customOrigin}/hook-quote`, apiKey: CUSTOM_HOOK_KEY }, local),
    ]);

    // Avalara: license key crosses as basic auth on the configured origin only,
    // amounts parse on their exact string forms (never float math), and rates
    // arrive as decimal fractions converted to ledger-scale percents.
    const expectedAvalaraBasic = Buffer.from(`${AVALARA_ACCOUNT_ID}:${AVALARA_LICENSE_KEY}`).toString("base64");
    assert.equal(avalaraAuth, `Basic ${expectedAvalaraBasic}`);
    assert.equal(avalaraQuote.taxAmount, "8.2500");
    assert.deepEqual(avalaraQuote.components, [
      { jurisdiction: "State", ratePercent: "6.5000", taxAmount: "6.5000", taxName: "WA State" },
      { jurisdiction: "City", ratePercent: "1.7500", taxAmount: "1.7500", taxName: "Seattle" },
    ]);
    assert.equal(avalaraQuote.externalRef, "QT-1001");
    assert.equal(avalaraQuote.provider, "avalara");
    assert.equal((avalaraBody as { date?: string }).date, "2026-08-25");
    assert.equal((avalaraBody as { lines?: { amount?: number }[] }).lines?.[0]?.amount, 100);

    // TaxJar: API key crosses as a bearer token; per-jurisdiction own rates win
    // over the blended rate, and the omitted-rate county is flagged.
    assert.equal(taxjarAuth, `Bearer ${TAXJAR_API_KEY}`);
    assert.equal(taxjarQuote.taxAmount, "8.2500");
    assert.deepEqual(taxjarQuote.components, [
      { jurisdiction: "state", ratePercent: "6.5000", taxAmount: "6.5000" },
      { jurisdiction: "city", ratePercent: "1.7500", taxAmount: "1.7500" },
      { jurisdiction: "county", ratePercent: "8.2500", taxAmount: "0.0000", rateIsBlendedFallback: true },
    ]);
    assert.equal(taxjarQuote.provider, "taxjar");
    assert.equal((taxjarBody as { amount?: number }).amount, 100);

    // Custom hook: bearer key attached when configured; component sums win over
    // the headline amount; the quoted request itself crosses as the body.
    assert.equal(customQuote.taxAmount, "3.2000");
    assert.deepEqual(customQuote.components, [
      { jurisdiction: "WA", ratePercent: "3.2000", taxAmount: "3.2000" },
    ]);
    assert.equal(customQuote.externalRef, "HOOK-REF");
    assert.equal(customQuote.provider, "custom_http");
    assert.equal(customSeen[0]?.authorization, `Bearer ${CUSTOM_HOOK_KEY}`);
    assert.deepEqual(customSeen[0]?.body.taxableAmount, "100.0000");

    // Same hook without a key sends no Authorization header at all.
    await quoteViaCustomHttp(quoteRequest, { url: `${customOrigin}/hook-quote` }, local);
    assert.equal(customSeen[1]?.authorization, undefined);

    // The redirect opt-out is structural on every request, success paths included.
    assert.notEqual(redirectModes.length, 0);
    assert.deepEqual([...new Set(redirectModes)], ["error"]);
  } finally {
    globalThis.fetch = originalFetch;
    await close(avalara);
    await close(taxjar);
    await close(custom);
  }
});

test("provider error statuses surface as TaxRateProviderError without leaking credentials", async () => {
  const errors = createServer((req, res) => {
    const path = req.url ?? "";
    let status = 400;
    if (path.endsWith("/v2/taxes")) status = 401;
    else if (path.includes("/hook-error")) status = 502;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "nope" } }));
  });
  const errorsOrigin = await listen(errors);
  const local = { allowPrivateEndpoints: true } as const;
  try {
    await assert.rejects(
      quoteViaAvalara(
        quoteRequest,
        {
          accountId: AVALARA_ACCOUNT_ID,
          licenseKey: AVALARA_LICENSE_KEY,
          baseUrl: errorsOrigin,
          quotedOn: quoteRequest.quotedOn!,
        },
        local,
      ),
      (e: unknown) => e instanceof TaxRateProviderError && /Avalara 400:/.test(e.message),
    );
    await assert.rejects(
      quoteViaTaxJar(quoteRequest, { apiKey: TAXJAR_API_KEY, baseUrl: errorsOrigin }, local),
      (e: unknown) => e instanceof TaxRateProviderError && /TaxJar 401:/.test(e.message),
    );
    await assert.rejects(
      quoteViaCustomHttp(quoteRequest, { url: `${errorsOrigin}/hook-error`, apiKey: CUSTOM_HOOK_KEY }, local),
      (e: unknown) => e instanceof TaxRateProviderError && /custom tax hook 502/.test(e.message),
    );
  } finally {
    await close(errors);
  }
});

test("a 200 response without the amount it owes is refused by name, never quoted as zero", async () => {
  // A 200 that omits the headline amount — API shape drift, a misconfigured
  // baseUrl serving a different API, a proxy truncating the body — used to
  // produce a successful $0.0000 quote, which the bill writer then posted
  // with taxOverridden: true: tax silently not owed, indistinguishable from
  // correctly nil. Both providers now refuse naming the missing field, and a
  // missing blended rate is not 0% calculation evidence either.
  const avalara = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "OK", summary: [] }));
  });
  const taxjar = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ tax: {} }));
  });
  const taxjarNoRate = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ tax: { amount_to_collect: 8.25 } }));
  });
  const avalaraOrigin = await listen(avalara);
  const taxjarOrigin = await listen(taxjar);
  const taxjarNoRateOrigin = await listen(taxjarNoRate);
  const local = { allowPrivateEndpoints: true } as const;
  try {
    await assert.rejects(
      () =>
        quoteViaAvalara(
          quoteRequest,
          {
            accountId: AVALARA_ACCOUNT_ID,
            licenseKey: AVALARA_LICENSE_KEY,
            baseUrl: avalaraOrigin,
            quotedOn: quoteRequest.quotedOn!,
          },
          local,
        ),
      (e: unknown) => e instanceof TaxRateProviderError && /missing totalTax/.test(e.message),
    );
    await assert.rejects(
      () => quoteViaTaxJar(quoteRequest, { apiKey: TAXJAR_API_KEY, baseUrl: taxjarOrigin }, local),
      (e: unknown) => e instanceof TaxRateProviderError && /missing amount_to_collect/.test(e.message),
    );
    await assert.rejects(
      () => quoteViaTaxJar(quoteRequest, { apiKey: TAXJAR_API_KEY, baseUrl: taxjarNoRateOrigin }, local),
      (e: unknown) => e instanceof TaxRateProviderError && /missing tax\.rate/.test(e.message),
    );
  } finally {
    await close(avalara);
    await close(taxjar);
    await close(taxjarNoRate);
  }
});

test("endpoint save validation refuses internal targets and names the settings field", async () => {
  // Loopback, RFC1918, link-local/metadata and IPv6-internal literals are
  // refused without any DNS round trip; the message names the settings field
  // holding the URL so the operator knows exactly what to change.
  await assert.rejects(
    validateTaxProviderEndpointUrl("custom_http", { quoteUrl: "https://127.0.0.1/quote" }),
    (e: unknown) =>
      e instanceof TaxRateProviderError &&
      /127\.0\.0\.1.*public address/.test(e.message) &&
      /settings\.quoteUrl/.test(e.message),
  );
  await assert.rejects(
    validateTaxProviderEndpointUrl("custom_http", { quoteUrl: "https://10.0.0.5/quote" }),
    /did not resolve to a public address/,
  );
  await assert.rejects(
    validateTaxProviderEndpointUrl("custom_http", { quoteUrl: "https://169.254.169.254/latest/" }),
    /did not resolve to a public address/,
  );
  await assert.rejects(
    validateTaxProviderEndpointUrl("custom_http", { quoteUrl: "https://[::1]/quote" }),
    /did not resolve to a public address/,
  );
  await assert.rejects(
    validateTaxProviderEndpointUrl("custom_http", { quoteUrl: "https://[::ffff:127.0.0.1]/quote" }),
    /did not resolve to a public address/,
  );
  // Plain http is refused even for a public-looking host: credentials must
  // never cross cleartext.
  await assert.rejects(
    validateTaxProviderEndpointUrl("avalara", { baseUrl: "http://rest.avatax.com" }),
    (e: unknown) => e instanceof TaxRateProviderError && /must use HTTPS/.test(e.message) && /baseUrl/.test(e.message),
  );
  await assert.rejects(
    validateTaxProviderEndpointUrl("taxjar", { baseUrl: "http://127.0.0.1:9/v2/taxes" }),
    /must use HTTPS/,
  );
  await assert.rejects(
    validateTaxProviderEndpointUrl("custom_http", { quoteUrl: "not a url" }),
    /is not a URL/,
  );
  await assert.rejects(
    validateTaxProviderEndpointUrl("custom_http", { quoteUrl: 42 }),
    /must be an https URL string/,
  );
  // A hostname whose DNS answers are private is refused at save, before any
  // key travels; a public answer passes.
  await assert.rejects(
    validateTaxProviderEndpointUrl("custom_http", { quoteUrl: "https://tax-stub.test/hook" }, { lookup: async () => ["10.9.9.9"] }),
    /tax-stub\.test.*public address/,
  );
  await validateTaxProviderEndpointUrl(
    "custom_http",
    { quoteUrl: "https://tax-stub.test/hook" },
    { lookup: async () => ["93.184.216.34"] },
  );
  // Unset means the vendor's built-in public https origin — nothing to check
  // here; the fetch layer still verifies at connect time. Manual reads no URL.
  await validateTaxProviderEndpointUrl("avalara", {});
  await validateTaxProviderEndpointUrl("custom_http", { quoteUrl: "  " });
  await validateTaxProviderEndpointUrl("manual", { quoteUrl: "http://127.0.0.1/quote" });
  // The explicit test switch is the only bypass, and it is per call.
  await validateTaxProviderEndpointUrl("custom_http", { quoteUrl: "http://127.0.0.1:9/quote" }, { allowPrivateEndpoints: true });
});

test("fetch refuses internal targets on every adapter before credentials travel", async () => {
  let requests = 0;
  let authorization = "";
  const stub = createServer((req, res) => {
    requests += 1;
    authorization = req.headers.authorization ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ taxAmount: "1.0000", components: [] }));
  });
  await new Promise<void>((resolve, reject) => {
    stub.once("error", reject);
    stub.listen(0, "127.0.0.1", () => resolve());
  });
  const address = stub.address();
  if (!address || typeof address === "string") throw new Error("stub did not bind");
  const port = address.port;
  try {
    // Literal loopback on every adapter WITHOUT the test switch: refused,
    // never connected. (callEachProviderAt carries the switch for the stub
    // servers above, so these calls are spelled out bare.)
    const guarded: Array<{ name: string; call: () => Promise<unknown> }> = [
      {
        name: "avalara",
        call: () =>
          quoteViaAvalara(quoteRequest, {
            accountId: AVALARA_ACCOUNT_ID,
            licenseKey: AVALARA_LICENSE_KEY,
            baseUrl: `https://127.0.0.1:${port}`,
            quotedOn: quoteRequest.quotedOn!,
          }),
      },
      {
        name: "taxjar",
        call: () => quoteViaTaxJar(quoteRequest, { apiKey: TAXJAR_API_KEY, baseUrl: `https://127.0.0.1:${port}` }),
      },
      {
        name: "custom_http",
        call: () => quoteViaCustomHttp(quoteRequest, { url: `https://127.0.0.1:${port}/hook`, apiKey: CUSTOM_HOOK_KEY }),
      },
    ];
    for (const provider of guarded) {
      await assert.rejects(
        provider.call(),
        (e: unknown) => e instanceof TaxRateProviderError && /public address/.test(e.message),
        `${provider.name} must refuse loopback at fetch`,
      );
    }
    // A hostname that answers loopback at fetch time (rebound after a clean
    // save) is refused the same way.
    await assert.rejects(
      quoteViaCustomHttp(
        quoteRequest,
        { url: `https://rebound.test:${port}/hook`, apiKey: CUSTOM_HOOK_KEY },
        { lookup: async () => ["127.0.0.1"] },
      ),
      (e: unknown) => e instanceof TaxRateProviderError && /rebound\.test.*public address/.test(e.message),
    );
    // A hostname that answers public at the pre-check and private at connect
    // time is still refused: the shared guard pins the socket to an address
    // it verified itself.
    let resolutions = 0;
    await assert.rejects(
      quoteViaTaxJar(
        quoteRequest,
        { apiKey: TAXJAR_API_KEY, baseUrl: `https://flapping.test:${port}` },
        {
          lookup: async () => {
            resolutions += 1;
            return resolutions === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
          },
        },
      ),
      TaxRateProviderError,
    );
    assert.ok(resolutions >= 2, "both the pre-check and the connect must resolve");
    assert.equal(requests, 0, "no credential-bearing request may reach an internal host");
    assert.equal(authorization, "");
  } finally {
    await close(stub);
  }
});

test("a stalled provider body refuses by name within the deadline", async () => {
  // The provider accepts the connection, sends headers, then never finishes
  // the body — the shape that used to strand the financial save forever.
  const stalled = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"taxAmount":"1.00",');
  });
  const origin = await listen(stalled);
  const started = Date.now();
  try {
    await assert.rejects(
      quoteViaCustomHttp(quoteRequest, { url: `${origin}/hook` }, { allowPrivateEndpoints: true, timeoutMs: 300 }),
      (e: unknown) =>
        e instanceof TaxRateProviderError &&
        /timed out after 300ms/.test(e.message) &&
        /check the provider endpoint/.test(e.message),
    );
    assert.ok(Date.now() - started < 10_000, "the stall must refuse on the deadline, not the 15s default");
  } finally {
    stalled.closeAllConnections();
    await close(stalled);
  }
});

test("an oversize provider body refuses by name before it is buffered", async () => {
  // Chunked 2 MiB with no content-length, so the streaming cap — not the
  // declared-length shortcut — fires mid-body, before the payload is held.
  const huge = createServer((req, res) => {
    res.on("error", () => {});
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"taxAmount":"1.0000","components":[],"pad":"');
    const chunk = "x".repeat(256 * 1024);
    for (let i = 0; i < 8; i += 1) res.write(chunk);
    res.end('"}');
  });
  const origin = await listen(huge);
  try {
    await assert.rejects(
      quoteViaCustomHttp(quoteRequest, { url: `${origin}/hook` }, { allowPrivateEndpoints: true }),
      (e: unknown) =>
        e instanceof TaxRateProviderError &&
        /exceeded 1048576 bytes/.test(e.message) &&
        /refusing rather than persisting/.test(e.message),
    );
  } finally {
    huge.closeAllConnections();
    await close(huge);
  }
});

test("quoteFromRate rejects over-precision rates with the module error type", () => {
  // The rate-provider route maps TaxRateProviderError to 422; the decimal
  // normalization fault escaped as a plain Error (a 500) on rates finer than
  // the 4-decimal percent scale.
  assert.throws(
    () => quoteFromRate("100.0000", "8.25333", "LOCAL"),
    (e: unknown) => e instanceof TaxRateProviderError && /exact decimal/.test((e as Error).message),
  );
  // Sanity: a 4-decimal rate still quotes exactly (8.25% of 100 = 8.25).
  assert.equal(quoteFromRate("100.0000", "8.25", "LOCAL").taxAmount, "8.2500");
});

// ---------------------------------------------------------------------------
// Provider configuration persistence (live PostgreSQL): attributable
// before/after audit evidence, optimistic concurrency over concurrent admin
// edits, atomic sealed-secret updates, and rollback safety.
// ---------------------------------------------------------------------------

const DB = !!process.env.OPENBOOKS_DB_URL;

const REVISION_COL = sql`to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

type CommittedConfig = {
  provider: string;
  displayName: string;
  isEnabled: boolean;
  preferProvider: boolean;
  settings: Record<string, unknown>;
  secrets: string | null;
  lastError: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

interface ConfigAuditState {
  provider?: string;
  displayName?: string;
  isEnabled?: boolean;
  preferProvider?: boolean;
  settings?: Record<string, unknown>;
  hasSecret?: boolean;
  revision?: string | null;
  secretKeys?: string[];
  secretChange?: { added: string[]; removed: string[] };
}

type ConfigAuditRow = {
  action: string;
  actor_id: string | null;
  changes: { reason: string | null; before: ConfigAuditState | null; after: ConfigAuditState };
};

async function seedTaxConfigOrg(): Promise<string> {
  const orgId = randomUUID();
  await withBypass(async () => {
    await db.execute(sql`
      insert into orgs (id, name, base_currency, country, settings, env_kind)
      values (${orgId}, ${"Scratch " + orgId.slice(0, 8)}, 'CAD', 'CA', '{}'::jsonb, 'production')`);
  });
  return orgId;
}

async function dropTaxConfigOrg(orgId: string): Promise<void> {
  // The canonical scratch teardown removes audit evidence and seeded segment
  // rows under its test-only boundary and verifies every org-scoped table.
  // Removing only the provider config leaves an unowned tenant behind.
  await dropScratchOrg(orgId);
}

/** Read the COMMITTED row through its own trusted boundary, bypassing the product. */
async function committedConfig(orgId: string): Promise<CommittedConfig | null> {
  return (
    (await withBypass(() =>
      db.execute<CommittedConfig>(sql`
        select provider, display_name as "displayName", is_enabled as "isEnabled",
               prefer_provider as "preferProvider", settings, secrets, last_error as "lastError",
               ${REVISION_COL} as "updatedAt", updated_by as "updatedBy"
          from tax_rate_provider_configs where org_id = ${orgId}
      `),
    )).rows[0] ?? null
  );
}

async function configAuditRows(orgId: string): Promise<ConfigAuditRow[]> {
  return (
    (await withBypass(() =>
      db.execute<ConfigAuditRow>(sql`
        select action, actor_id, changes
          from audit_log
         where org_id = ${orgId} and table_name = 'tax_rate_provider_configs'
         order by at, id
      `),
    )).rows
  );
}

test(
  "provider config saves record attributable before/after audit evidence without disclosing secrets",
  { skip: !DB },
  async () => {
    const orgId = await seedTaxConfigOrg();
    try {
      const admin1 = randomUUID();
      // `expectedUpdatedAt: null` asserts "no row yet" on first creation.
      const revision1 = await saveTaxRateProviderConfig(
        orgId,
        { provider: "manual", isEnabled: true, settings: { defaultRatePercent: "5" } },
        admin1,
        { expectedUpdatedAt: null, reason: "initial setup" },
      );
      assert.ok(revision1);

      const admin2 = randomUUID();
      const licenseKey = "AVALARA-LICENSE-SECRET-9f3b";
      const apiKey = "TAXJAR-KEY-SECRET-2c7d";
      await saveTaxRateProviderConfig(
        orgId,
        {
          provider: "avalara",
          displayName: "Avalara production",
          isEnabled: false,
          settings: { defaultRatePercent: "7.25", companyCode: "MAIN" },
          apiKey,
          accountId: "ACCT-99",
          licenseKey,
        },
        admin2,
        { reason: "wire avalara provider" },
      );
      const row2 = (await committedConfig(orgId))!;

      const audits = await configAuditRows(orgId);
      assert.equal(audits.length, 2);

      const insertAudit = audits[0]!;
      assert.equal(insertAudit.action, "insert");
      assert.equal(insertAudit.actor_id, admin1);
      assert.equal(insertAudit.changes.reason, "initial setup");
      assert.equal(insertAudit.changes.before, null);
      assert.equal(insertAudit.changes.after.isEnabled, true);
      assert.deepEqual(insertAudit.changes.after.settings, { defaultRatePercent: "5.0000" });
      assert.equal(insertAudit.changes.after.hasSecret, false);
      assert.equal(insertAudit.changes.after.revision, revision1);

      const updateAudit = audits[1]!;
      assert.equal(updateAudit.action, "update");
      assert.equal(updateAudit.actor_id, admin2);
      assert.equal(updateAudit.changes.reason, "wire avalara provider");
      const before = updateAudit.changes.before!;
      const after = updateAudit.changes.after;
      // Authoritative before/after for every material field.
      assert.equal(before.provider, "manual");
      assert.equal(after.provider, "avalara");
      assert.equal(before.displayName, "Manual rates");
      assert.equal(after.displayName, "Avalara production");
      assert.equal(before.isEnabled, true);
      assert.equal(after.isEnabled, false);
      assert.deepEqual(before.settings, { defaultRatePercent: "5.0000" });
      assert.deepEqual(after.settings, { defaultRatePercent: "7.2500", companyCode: "MAIN" });
      // The audit chains revisions: before.token is the caller's read, after.token the committed row.
      assert.equal(before.revision, revision1);
      assert.equal(after.revision, row2.updatedAt);
      // Credential evidence records WHICH KEYS changed — never their values.
      assert.equal(before.hasSecret, false);
      assert.deepEqual(before.secretKeys, []);
      assert.equal(after.hasSecret, true);
      assert.deepEqual(after.secretKeys, ["accountId", "apiKey", "licenseKey"]);
      assert.deepEqual(after.secretChange!.added, ["accountId", "apiKey", "licenseKey"]);
      assert.deepEqual(after.secretChange!.removed, []);

      // The serialized evidence must carry no secret material at all — the
      // plaintexts above exist only inside the sealed blob on the row.
      const evidenceText = JSON.stringify(audits);
      for (const secretValue of [licenseKey, apiKey, "ACCT-99"]) {
        assert.ok(!evidenceText.includes(secretValue), "audit evidence must never contain a secret value");
      }

      // The read view exposes the revision token and the secret's existence — never the secret.
      const view = await withOrgContext(orgId, () => readTaxRateProviderConfigView(orgId));
      assert.equal(view!.hasSecret, true);
      assert.equal("secrets" in view!, false);
      assert.equal(view!.updatedAt, row2.updatedAt);
      const sealed = unsealJson<Record<string, string>>(row2.secrets);
      assert.deepEqual(Object.keys(sealed!).sort(), ["accountId", "apiKey", "licenseKey"]);

      // Clearing one credential is atomic: the rest survive in the same commit,
      // with removed-key evidence attributable to the actor.
      await saveTaxRateProviderConfig(
        orgId,
        { provider: "avalara", isEnabled: false, apiKey: null },
        admin2,
        { expectedUpdatedAt: row2.updatedAt, reason: "drop stray key" },
      );
      const cleared = (await committedConfig(orgId))!;
      assert.deepEqual(Object.keys(unsealJson<Record<string, string>>(cleared.secrets)!).sort(), [
        "accountId",
        "licenseKey",
      ]);
      assert.notEqual(cleared.updatedAt, row2.updatedAt);
      const clearAudit = (await configAuditRows(orgId)).at(-1)!;
      assert.equal(clearAudit.actor_id, admin2);
      assert.equal(clearAudit.changes.reason, "drop stray key");
      assert.deepEqual(clearAudit.changes.before!.secretKeys, ["accountId", "apiKey", "licenseKey"]);
      assert.equal(clearAudit.changes.before!.hasSecret, true);
      assert.deepEqual(clearAudit.changes.after.secretChange!.removed, ["apiKey"]);
      assert.deepEqual(clearAudit.changes.after.secretKeys, ["accountId", "licenseKey"]);
      assert.equal(clearAudit.changes.after.hasSecret, true);
    } finally {
      await dropTaxConfigOrg(orgId);
    }
  },
);

test(
  "a stale expectedUpdatedAt revision is rejected with zero partial write",
  { skip: !DB },
  async () => {
    const orgId = await seedTaxConfigOrg();
    try {
      const admin1 = randomUUID();
      await saveTaxRateProviderConfig(
        orgId,
        { provider: "manual", isEnabled: true, settings: { defaultRatePercent: "5" } },
        admin1,
      );
      const staleToken = (await committedConfig(orgId))!.updatedAt;

      // A committed concurrent write advances the revision under the other save.
      const admin2 = randomUUID();
      await saveTaxRateProviderConfig(
        orgId,
        { provider: "manual", isEnabled: true, settings: { defaultRatePercent: "6" }, accountId: "ACCT-CONCURRENT" },
        admin2,
        { reason: "concurrent edit" },
      );
      const current = (await committedConfig(orgId))!;
      assert.notEqual(current.updatedAt, staleToken);

      const admin3 = randomUUID();
      await assert.rejects(
        saveTaxRateProviderConfig(
          orgId,
          { provider: "taxjar", isEnabled: false, settings: { defaultRatePercent: "9" }, apiKey: "ROGUE-KEY" },
          admin3,
          { expectedUpdatedAt: staleToken },
        ),
        (e: unknown) => e instanceof TaxRateProviderError && /concurrent/.test(e.message),
      );
      // A stale "config does not exist yet" expectation is refused the same way.
      await assert.rejects(
        saveTaxRateProviderConfig(orgId, { provider: "manual", isEnabled: true }, admin3, { expectedUpdatedAt: null }),
        TaxRateProviderError,
      );

      // Zero partial write: the row is exactly what the concurrent save committed.
      const after = (await committedConfig(orgId))!;
      assert.deepEqual(after.settings, current.settings);
      assert.deepEqual(Object.keys(unsealJson<Record<string, string>>(after.secrets)!), ["accountId"]);
      assert.equal(after.isEnabled, true);
      assert.equal(after.provider, "manual");
      assert.equal(after.updatedAt, current.updatedAt);
      assert.equal(after.updatedBy, admin2);
      // The rejected save leaked no audit rows either.
      assert.equal((await configAuditRows(orgId)).length, 2);
    } finally {
      await dropTaxConfigOrg(orgId);
    }
  },
);

test(
  "concurrent disjoint secret edits serialize on the row lock and lose neither",
  { skip: !DB },
  async () => {
    const orgId = await seedTaxConfigOrg();
    let editor: pg.Client | null = null;
    try {
      const admin1 = randomUUID();
      await saveTaxRateProviderConfig(
        orgId,
        { provider: "custom_http", isEnabled: true, settings: { quoteUrl: "https://tax.example.internal/quote" } },
        admin1,
        // Documentation-only hostname: stub public DNS so the save-time
        // address check stays hermetic.
        { lookup: async () => ["93.184.216.34"] },
      );
      assert.equal((await committedConfig(orgId))!.secrets, null);

      // A second session holds the config row's lock while the product save is
      // already in flight — exactly the interleaving that used to lose one
      // side's credential: the save must merge on the lock, not on a stale read.
      editor = new pg.Client({ connectionString: process.env.OPENBOOKS_DB_URL });
      await editor.connect();
      await editor.query("begin");
      await editor.query("select set_config('app.bypass_rls', 'on', true)");
      await editor.query("select id from tax_rate_provider_configs where org_id = $1 for update", [orgId]);

      const admin2 = randomUUID();
      const racingSave = saveTaxRateProviderConfig(
        orgId,
        { provider: "custom_http", isEnabled: true, apiKey: "RACING-KEY-VALUE" },
        admin2,
        // The row carries the documentation-only stub hostname; keep its
        // re-validation hermetic with the same stub DNS.
        { reason: "rotate api key", lookup: async () => ["93.184.216.34"] },
      );

      // Deterministic barrier: the save must be parked on the editor's lock
      // before the competing edit commits (ungranted transactionid waiter).
      let parked = false;
      for (let waited = 0; waited < 10_000 && !parked; waited += 25) {
        const waiting = (
          await withBypass(() =>
            db.execute<{ n: number }>(sql`
              select count(*)::int as n from pg_locks where locktype = 'transactionid' and not granted
            `),
          )
        ).rows[0]!.n;
        parked = waiting > 0;
        if (!parked) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(parked, "the save must block on the concurrent editor's row lock");

      // The competing administrator commits a disjoint credential while the
      // save sits parked on the lock.
      const admin3 = randomUUID();
      await editor.query(
        "update tax_rate_provider_configs set secrets = $2, updated_at = now(), updated_by = $3 where org_id = $1",
        [orgId, sealJson({ accountId: "EDITOR-ACCT" }), admin3],
      );
      await editor.query("commit");

      // The save must succeed and merge against the editor's committed secret.
      await racingSave;

      const final = (await committedConfig(orgId))!;
      const secrets = unsealJson<Record<string, string>>(final.secrets);
      assert.ok(secrets);
      // NEITHER side's credential was lost to the other.
      assert.deepEqual(Object.keys(secrets).sort(), ["accountId", "apiKey"]);
      assert.equal(secrets.apiKey, "RACING-KEY-VALUE");
      assert.equal(secrets.accountId, "EDITOR-ACCT");
      assert.equal(final.updatedBy, admin2);

      // The save's audit evidence shows it merged on top of the editor's write.
      const audits = await configAuditRows(orgId);
      const saveAudit = audits.at(-1)!;
      assert.equal(saveAudit.actor_id, admin2);
      assert.equal(saveAudit.changes.reason, "rotate api key");
      assert.deepEqual(saveAudit.changes.before!.secretKeys, ["accountId"]);
      assert.equal(saveAudit.changes.before!.hasSecret, true);
      assert.deepEqual(saveAudit.changes.after.secretChange!.added, ["apiKey"]);
      assert.deepEqual(saveAudit.changes.after.secretChange!.removed, []);
    } finally {
      if (editor) await editor.end().catch(() => {});
      await dropTaxConfigOrg(orgId);
    }
  },
);

test(
  "a forced audit failure rolls the configuration write back atomically",
  { skip: !DB },
  async () => {
    const orgId = await seedTaxConfigOrg();
    const guardHex = orgId.replace(/-/g, "");
    const fnName = `block_tax_provider_audit_${guardHex}`;
    const triggerName = `tr_block_tax_provider_audit_${guardHex}`;
    try {
      const admin1 = randomUUID();
      await saveTaxRateProviderConfig(
        orgId,
        { provider: "manual", isEnabled: true, settings: { defaultRatePercent: "5" }, apiKey: "KEEP-KEY-VALUE" },
        admin1,
        { reason: "seed" },
      );
      const prior = (await committedConfig(orgId))!;
      assert.equal((await configAuditRows(orgId)).length, 1);

      // Force every provider-config audit insert to fail inside the transaction.
      await withBypass(async () => {
        await db.execute(sql`
          create function ${sql.identifier(fnName)}() returns trigger language plpgsql as $$
          begin
            raise exception 'forced audit failure';
          end $$`);
        await db.execute(sql`
          create trigger ${sql.identifier(triggerName)}
            after insert on audit_log for each row
            when (new.table_name = 'tax_rate_provider_configs')
            execute function ${sql.identifier(fnName)}()`);
      });

      const admin2 = randomUUID();
      try {
        // Drizzle wraps driver errors, so the assertion must unwrap the cause.
        const messageOf = (e: unknown): string => {
          const cause = e instanceof Error && e.cause instanceof Error ? ` ${e.cause.message}` : "";
          return e instanceof Error ? `${e.message}${cause}` : String(e);
        };
        await assert.rejects(
          saveTaxRateProviderConfig(
            orgId,
            {
              provider: "taxjar",
              isEnabled: false,
              settings: { defaultRatePercent: "9" },
              apiKey: "ROTATED-KEY-VALUE",
              accountId: "NEW-ACCT",
            },
            admin2,
            { reason: "credential rotation" },
          ),
          (e: unknown) => /forced audit failure/.test(messageOf(e)),
        );
      } finally {
        await withBypass(async () => {
          await db.execute(sql`drop trigger if exists ${sql.identifier(triggerName)} on audit_log`);
          await db.execute(sql`drop function if exists ${sql.identifier(fnName)}()`);
        });
      }

      // The prior row survives byte-for-byte: settings, sealed secret and
      // revision are exactly what the last committed save left behind.
      const after = (await committedConfig(orgId))!;
      assert.deepEqual(after, prior);
      assert.equal(unsealJson<Record<string, string>>(after.secrets)!.apiKey, "KEEP-KEY-VALUE");
      assert.equal(after.updatedBy, admin1);
      // No audit row leaked from the rolled-back attempt either.
      assert.equal((await configAuditRows(orgId)).length, 1);
    } finally {
      await dropTaxConfigOrg(orgId);
    }
  },
);

test(
  "provider config save refuses internal endpoints and writes nothing",
  { skip: !DB },
  async () => {
    const orgId = await seedTaxConfigOrg();
    try {
      const admin = randomUUID();
      // Plain-http loopback is refused at save, before any row exists.
      await assert.rejects(
        saveTaxRateProviderConfig(
          orgId,
          { provider: "custom_http", isEnabled: true, settings: { quoteUrl: "http://127.0.0.1:9/quote" } },
          admin,
        ),
        (e: unknown) => e instanceof TaxRateProviderError && /must use HTTPS/.test(e.message),
      );
      await assert.rejects(
        saveTaxRateProviderConfig(
          orgId,
          { provider: "avalara", isEnabled: true, settings: { baseUrl: "https://10.0.0.5/avatax" } },
          admin,
        ),
        (e: unknown) => e instanceof TaxRateProviderError && /public address/.test(e.message),
      );
      assert.equal(await committedConfig(orgId), null, "refused saves must not create a row");
      assert.deepEqual(await configAuditRows(orgId), [], "refused saves must not write audit evidence");
      // The explicit test switch is the only bypass, and it is per call.
      await saveTaxRateProviderConfig(
        orgId,
        { provider: "custom_http", isEnabled: true, settings: { quoteUrl: "http://127.0.0.1:9/quote" } },
        admin,
        { allowPrivateEndpoints: true, reason: "test stub" },
      );
      assert.equal((await committedConfig(orgId))!.provider, "custom_http");
    } finally {
      await dropTaxConfigOrg(orgId);
    }
  },
);

test(
  "an oversize provider body refuses by name and persists no quote evidence",
  { skip: !DB },
  async () => {
    const orgId = await seedTaxConfigOrg();
    const huge = createServer((req, res) => {
      res.on("error", () => {});
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"taxAmount":"1.0000","components":[],"pad":"');
      const chunk = "x".repeat(256 * 1024);
      for (let i = 0; i < 8; i += 1) res.write(chunk);
      res.end('"}');
    });
    const origin = await listen(huge);
    try {
      const admin = randomUUID();
      await saveTaxRateProviderConfig(
        orgId,
        { provider: "custom_http", isEnabled: true, settings: { quoteUrl: `${origin}/hook` } },
        admin,
        { allowPrivateEndpoints: true },
      );
      await assert.rejects(
        quoteExternalTax(
          orgId,
          {
            taxableAmount: "100.0000",
            currency: "USD",
            shipFrom: {},
            shipTo: {},
            quotedOn: "2026-08-25",
          },
          null,
          { allowPrivateEndpoints: true },
        ),
        (e: unknown) => e instanceof TaxRateProviderError && /exceeded 1048576 bytes/.test(e.message),
      );
      const quotes = (
        await withBypass(() =>
          db.execute<{ n: string }>(sql`select count(*)::text as n from tax_rate_quotes where org_id = ${orgId}`),
        )
      ).rows[0]!.n;
      assert.equal(quotes, "0", "an oversize body must persist no quote evidence");
      const config = (await committedConfig(orgId))!;
      assert.match(config.lastError ?? "", /exceeded 1048576 bytes/, "the refusal is recorded, not swallowed");
    } finally {
      huge.closeAllConnections();
      await close(huge);
      await dropTaxConfigOrg(orgId);
    }
  },
);
