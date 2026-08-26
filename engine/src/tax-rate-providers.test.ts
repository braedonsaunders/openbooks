import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import test from "node:test";
import {
  quoteViaAvalara,
  quoteViaCustomHttp,
  quoteViaTaxJar,
  TaxRateProviderError,
  type TaxQuoteRequest,
} from "./tax-rate-providers.ts";

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
  return [
    {
      name: "avalara",
      call: () =>
        quoteViaAvalara(quoteRequest, {
          accountId: AVALARA_ACCOUNT_ID,
          licenseKey: AVALARA_LICENSE_KEY,
          baseUrl: origin,
          quotedOn: quoteRequest.quotedOn!,
        }),
    },
    {
      name: "taxjar",
      call: () => quoteViaTaxJar(quoteRequest, { apiKey: TAXJAR_API_KEY, baseUrl: origin }),
    },
    {
      name: "custom_http",
      call: () => quoteViaCustomHttp(quoteRequest, { url: `${origin}/hook-quote`, apiKey: CUSTOM_HOOK_KEY }),
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
  try {
    const [avalaraQuote, taxjarQuote, customQuote] = await Promise.all([
      quoteViaAvalara(quoteRequest, {
        accountId: AVALARA_ACCOUNT_ID,
        licenseKey: AVALARA_LICENSE_KEY,
        baseUrl: avalaraOrigin,
        quotedOn: quoteRequest.quotedOn!,
      }),
      quoteViaTaxJar(quoteRequest, { apiKey: TAXJAR_API_KEY, baseUrl: taxjarOrigin }),
      quoteViaCustomHttp(quoteRequest, { url: `${customOrigin}/hook-quote`, apiKey: CUSTOM_HOOK_KEY }),
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
    await quoteViaCustomHttp(quoteRequest, { url: `${customOrigin}/hook-quote` });
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
  try {
    await assert.rejects(
      quoteViaAvalara(quoteRequest, {
        accountId: AVALARA_ACCOUNT_ID,
        licenseKey: AVALARA_LICENSE_KEY,
        baseUrl: errorsOrigin,
        quotedOn: quoteRequest.quotedOn!,
      }),
      (e: unknown) => e instanceof TaxRateProviderError && /Avalara 400:/.test(e.message),
    );
    await assert.rejects(
      quoteViaTaxJar(quoteRequest, { apiKey: TAXJAR_API_KEY, baseUrl: errorsOrigin }),
      (e: unknown) => e instanceof TaxRateProviderError && /TaxJar 401:/.test(e.message),
    );
    await assert.rejects(
      quoteViaCustomHttp(quoteRequest, { url: `${errorsOrigin}/hook-error`, apiKey: CUSTOM_HOOK_KEY }),
      (e: unknown) => e instanceof TaxRateProviderError && /custom tax hook 502/.test(e.message),
    );
  } finally {
    await close(errors);
  }
});
