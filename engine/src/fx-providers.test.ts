import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "./db.ts";
import {
  computeNextSyncAt,
  normalizeFxSnapshots,
  parseBankOfCanadaJson,
  parseEcbCsv,
  ratioRate,
  runFxProvider,
  saveFxProviderConfig,
} from "./fx-providers.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "./test-fixtures.ts";

const source = readFileSync(new URL("./fx-providers.ts", import.meta.url), "utf8");
const DB = !!process.env.OPENBOOKS_DB_URL;

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

test("ratioRate uses exact decimal arithmetic and numeric(19,10) rounding", () => {
  assert.equal(ratioRate("1", "1.25"), "0.8000000000");
  assert.equal(ratioRate("1.25", "1"), "1.2500000000");
  assert.equal(ratioRate("1", "3"), "0.3333333333");
  assert.equal(ratioRate("1e-2", "2"), "0.0050000000");
});

test("ECB CSV parser groups EUR-anchored observations by date", () => {
  const snapshots = parseEcbCsv([
    "KEY,CURRENCY,TIME_PERIOD,OBS_VALUE",
    "EXR.D.USD.EUR.SP00.A,USD,2026-07-14,1.1650",
    "EXR.D.CAD.EUR.SP00.A,CAD,2026-07-14,1.5900",
  ].join("\n"));
  assert.deepEqual(snapshots, [{
    date: "2026-07-14",
    anchor: "EUR",
    unitsPerAnchor: { EUR: "1", USD: "1.1650", CAD: "1.5900" },
  }]);
});

test("Bank of Canada parser converts CAD-per-foreign observations to a CAD anchor", () => {
  const snapshots = parseBankOfCanadaJson(JSON.stringify({
    observations: [{ d: "2026-07-14", FXUSDCAD: { v: "1.2500" } }],
  }));
  assert.deepEqual(snapshots, [{
    date: "2026-07-14",
    anchor: "CAD",
    unitsPerAnchor: { CAD: "1", USD: "0.8000000000" },
  }]);
});

test("normalization materializes every directed currency pair", () => {
  const rates = normalizeFxSnapshots([{
    date: "2026-07-14",
    anchor: "EUR",
    unitsPerAnchor: { EUR: "1", USD: "1.2", CAD: "1.5" },
  }], "CAD", ["USD", "EUR"]);
  assert.equal(rates.length, 6);
  assert.equal(rates.find((rate) => rate.fromCurrency === "USD" && rate.toCurrency === "CAD")?.rate, "1.2500000000");
  assert.equal(rates.find((rate) => rate.fromCurrency === "CAD" && rate.toCurrency === "USD")?.rate, "0.8000000000");
});

test("FX provider observation window uses the org business day, not UTC today", () => {
  const start = source.indexOf("export async function runFxProvider");
  const end = source.indexOf("\nexport async function runDueFxProviders", start);
  assert.ok(start >= 0 && end > start, "runFxProvider is defined");
  const body = source.slice(start, end);
  assert.match(body, /const today = await businessToday\(orgId\)/);
  assert.match(body, /from: addDays\(today, -6\), to: today/);
  assert.match(body, /syncRange\(config, today\)/);
  assert.doesNotMatch(body, /isoDate\(now\)/);
});

test("weekday schedules skip weekends and weekly schedules remain seven days apart", () => {
  assert.equal(
    computeNextSyncAt("weekdays", 22, new Date("2026-07-17T23:00:00Z"))?.toISOString(),
    "2026-07-20T22:00:00.000Z",
  );
  assert.equal(
    computeNextSyncAt("weekly", 22, new Date("2026-07-16T10:00:00Z"))?.toISOString(),
    "2026-07-23T22:00:00.000Z",
  );
});

test("every outbound FX fetch is forced through the no-redirect guard", () => {
  assert.match(source, /function fxFetch\(/);
  assert.match(source, /redirect: "error"/);
  // Exactly one raw fetch call site may exist — inside fxFetch itself — so a
  // future provider path cannot quietly bypass the redirect refusal.
  assert.equal([...source.matchAll(/\bfetch\(/g)].length, 1, "all FX fetches must route through fxFetch");
});

// Every 3xx with a Location must be refused, not followed: Open Exchange Rates
// carries its app_id as a query parameter, and a query parameter is part of the
// URL — unlike the Authorization header, which fetch strips cross-origin, it
// would be replayed intact to whichever host the Location names (307/308
// preserve method AND query). The credential-free ECB and Bank of Canada feeds
// share the same choke point so a hijacked answer cannot impersonate them.
const redirectStatuses = [301, 302, 303, 307, 308] as const;

test(
  "FX provider requests refuse every redirect class without forwarding the API key",
  { skip: !DB },
  async () => {
    const OXR_SECRET = "oxr-secret-redirect-PROOF";
    let attackerRequests = 0;
    const attackerUrls: string[] = [];
    const attacker = createServer((req, res) => {
      attackerRequests += 1;
      attackerUrls.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"leak":"capture"}');
    });
    const attackerOrigin = await listen(attacker);

    let respondWithRedirects = true;
    const providerPaths: string[] = [];
    const redirector = createServer((req, res) => {
      const target = req.url ?? "";
      if (respondWithRedirects) {
        providerPaths.push(target);
        res.writeHead(redirectStatuses[(providerPaths.length - 1) % redirectStatuses.length]!, {
          location: `${attackerOrigin}/credential-capture${target}`,
        });
        res.end();
        return;
      }
      if (target.startsWith("/api/historical/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ base: "USD", rates: { EUR: 1.1, CAD: 1.35 } }));
      } else if (target.includes("/service/data/EXR")) {
        const today = new Date().toISOString().slice(0, 10);
        res.writeHead(200, { "content-type": "text/csv" });
        res.end([
          "KEY,CURRENCY,TIME_PERIOD,OBS_VALUE",
          `EXR.D.USD.EUR.SP00.A,USD,${today},1.1650`,
          `EXR.D.CAD.EUR.SP00.A,CAD,${today},1.5900`,
        ].join("\n"));
      } else {
        const today = new Date().toISOString().slice(0, 10);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          observations: [{ d: today, FXUSDCAD: { v: "1.2500" }, FXEURCAD: { v: "1.0900" } }],
        }));
      }
    });
    const redirectorOrigin = await listen(redirector);

    // Remap every real provider host onto the local redirector while recording
    // the exact redirect mode each request is issued with.
    const originalFetch = globalThis.fetch;
    const redirectModes: Array<RequestRedirect | undefined> = [];
    const fakeHosts: Record<string, string> = {
      "openexchangerates.org": new URL(redirectorOrigin).host,
      "www.bankofcanada.ca": new URL(redirectorOrigin).host,
      "data-api.ecb.europa.eu": new URL(redirectorOrigin).host,
    };
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const requested = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const mapped = fakeHosts[requested.host];
      redirectModes.push(init?.redirect);
      if (!mapped) return originalFetch(input, init);
      requested.protocol = "http:";
      requested.host = mapped;
      return originalFetch(requested, init);
    }) as typeof fetch;

    const org = await withBypass(() => createScratchOrg());
    try {
      for (const code of ["USD", "EUR"]) {
        await db.execute(sql`
          insert into currencies (code, name, minor_units) values (${code}, ${code}, 2)
          on conflict (code) do nothing`);
      }
      await db.execute(sql`
        update orgs set settings = settings || '{"features":{"multiCurrency":true}}'::jsonb
         where id = ${org.orgId}`);
      const actorId = await withBypass(() => createScratchUser(org.orgId, "FX operator", "admin"));

      const scenarios = [
        {
          provider: "open_exchange_rates" as const,
          baseCurrency: "USD",
          currencies: ["EUR", "CAD"],
          apiKey: OXR_SECRET as string | undefined,
          expectedObservations: 7,
          pathPrefix: "/api/historical/",
        },
        {
          provider: "ecb" as const,
          baseCurrency: "EUR",
          currencies: ["USD", "CAD"],
          apiKey: undefined,
          expectedObservations: 1,
          pathPrefix: "/service/data/EXR",
        },
        {
          provider: "bank_of_canada" as const,
          baseCurrency: "CAD",
          currencies: ["USD", "EUR"],
          apiKey: undefined,
          expectedObservations: 1,
          pathPrefix: "/valet/",
        },
      ];

      for (const scenario of scenarios) {
        await saveFxProviderConfig(org.orgId, actorId, {
          provider: scenario.provider,
          baseCurrency: scenario.baseCurrency,
          currencies: scenario.currencies,
          schedule: "manual",
          syncHourUtc: 0,
          lookbackDays: 7,
          isEnabled: true,
          apiKey: scenario.apiKey ?? null,
        });

        const refusalsStart = redirectModes.length;
        for (const status of redirectStatuses) {
          await assert.rejects(
            runFxProvider(org.orgId, "test"),
            /fetch failed|unexpected redirect|redirect/i,
            `${scenario.provider} must refuse HTTP ${status}`,
          );
        }

        // Exactly one hop per attempt reached the configured provider origin —
        // never a second, followed one — and every request opted out of
        // redirect following.
        assert.deepEqual(redirectModes.slice(refusalsStart), new Array(5).fill("error"));
        assert.equal(
          attackerRequests,
          0,
          `${scenario.provider} traffic must never reach the redirect target`,
        );

        if (scenario.provider === "open_exchange_rates") {
          // The secret really was in play on the first hop's URL — precisely
          // what a followed Location would have carried to the attacker.
          const firstHopQueries = providerPaths.filter((p) => p.startsWith(scenario.pathPrefix));
          assert.ok(firstHopQueries.length >= 5, "each refused attempt hit the provider exactly once");
          assert.ok(firstHopQueries.every((p) => p.includes(`app_id=${OXR_SECRET}`)));
        }
      }
      assert.equal(providerPaths.length, 15, "three providers x five statuses, one request each");

      // Happy-path control: with redirects out of the picture the same guarded
      // pipeline still syncs every provider end to end.
      respondWithRedirects = false;
      const happyStart = redirectModes.length;
      for (const scenario of scenarios) {
        await saveFxProviderConfig(org.orgId, actorId, {
          provider: scenario.provider,
          baseCurrency: scenario.baseCurrency,
          currencies: scenario.currencies,
          schedule: "manual",
          syncHourUtc: 0,
          lookbackDays: 7,
          isEnabled: true,
          apiKey: scenario.apiKey ?? null,
        });
        const result = await runFxProvider(org.orgId, "test");
        assert.equal(result.observationsReceived, scenario.expectedObservations);
        assert.ok(result.normalizedRates > 0);
        assert.equal(result.ratesInserted + result.ratesUpdated, 0, "test runs must not write rates");
      }
      assert.deepEqual(redirectModes.slice(happyStart), new Array(9).fill("error"));
      assert.equal(attackerRequests, 0, "the API key must never leave for any third host");
      assert.deepEqual(attackerUrls, []);
    } finally {
      globalThis.fetch = originalFetch;
      await close(redirector);
      await close(attacker);
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
