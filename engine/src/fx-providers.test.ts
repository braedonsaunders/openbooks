import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql, type SQL } from "drizzle-orm";
import { db, withBypass } from "./db.ts";
import {
  computeNextSyncAt,
  FxProviderError,
  FxRunLeaseLostError,
  normalizeFxSnapshots,
  parseBankOfCanadaJson,
  parseEcbCsv,
  ratioRate,
  runDueFxProviders,
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

test("FX run conflicts inspect wrapped database causes before returning a domain refusal", () => {
  const detectorStart = source.indexOf("function isFxRunInProgressConflict");
  const createRunStart = source.indexOf("async function createRun", detectorStart);
  assert.ok(detectorStart >= 0 && createRunStart > detectorStart, "the run-conflict detector is defined");
  const detector = source.slice(detectorStart, createRunStart);
  assert.match(detector, /candidate\.code === "23505" && candidate\.constraint === "fx_provider_runs_one_running"/);
  assert.match(detector, /current = candidate\.cause/);
  assert.match(
    source.slice(createRunStart, source.indexOf("\nexport async function runFxProvider", createRunStart)),
    /if \(isFxRunInProgressConflict\(error\)\) throw new FxProviderError\("an FX provider run is already in progress"\)/,
  );
});

// The completion stamp must live INSIDE the rates' transaction and be fenced
// on the per-claim lease token (same idiom as posting_effects), so a crash can
// never leave rates applied while the run/config still say running, and a
// reclaimed claim can neither resurrect its row nor promote schedule
// ownership. These static guards pin the structure that makes the recovery
// stages idempotent.
test("FX run claims are fenced by a per-claim lease token with an atomic completion unit", () => {
  const claimStart = source.indexOf("async function createRun");
  const runEnd = source.indexOf("\n/** Scheduler scan", claimStart);
  assert.ok(claimStart >= 0 && runEnd > claimStart, "runFxProvider is defined after createRun");

  // The takeover path clears the stale claim's token when reclaiming it...
  assert.match(source.slice(claimStart, source.indexOf("\nexport async function runFxProvider", claimStart)), /lease_token = null/);
  // ...every new claim mints its own token...
  assert.match(source.slice(claimStart, runEnd), /gen_random_uuid\(\)/);
  // ...rate application only happens under a held, token-matched running row...
  assert.match(source.slice(claimStart, runEnd), /and lease_token = \$\{claim\.leaseToken\} and status = 'running'\s+for update/);
  // ...the success stamp is executed on the transaction executor...
  const stampMatch = source.slice(claimStart, runEnd).match(/const stamped = await tx\.execute\(sql`[\s\S]*?`\);[\s\S]*?if \(!stamped\.rowCount\) throw new FxRunLeaseLostError\(\);/);
  assert.ok(stampMatch, "the success stamp runs inside the rates transaction with the lease fence");
  assert.match(stampMatch[0]!, /lease_token = null/);
  assert.match(stampMatch[0]!, /id = \$\{claim\.runId\} and org_id = \$\{orgId\} and lease_token = \$\{claim\.leaseToken\} and status = 'running'/);
  // ...and the failure stamp carries the identical fence.
  assert.match(source.slice(claimStart, runEnd), /where id = \$\{claim\.runId\} and org_id = \$\{orgId\} and lease_token = \$\{claim\.leaseToken\} and status = 'running'\s*`\);\s*if \(!stamped\.rowCount\) return;/);
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

// The scheduler cursor and its durable run claim must commit as one unit. If
// run-row creation loses a storage race, the occurrence stays due so a later
// tick can retry it; the old cursor-first ordering silently skipped it.
test(
  "a scheduler occurrence stays due when durable run creation fails",
  { skip: !DB },
  async () => {
    const org = await setupManualFxScratchOrg();
    const originalFetch = globalThis.fetch;
    const now = new Date();
    const dueAt = new Date(now.getTime() - 60_000);
    try {
      const actorId = await withBypass(async () => createScratchUser(org.orgId, "FX scheduler", "admin"));
      await saveFxProviderConfig(org.orgId, actorId, {
        provider: "bank_of_canada",
        baseCurrency: "CAD",
        currencies: ["USD", "EUR"],
        schedule: "daily",
        syncHourUtc: 0,
        lookbackDays: 7,
        isEnabled: true,
        apiKey: null,
      });
      await db.execute(sql`
        update fx_provider_configs set next_sync_at = ${dueAt}
         where id = ${org.configId}`);
      // A live run makes the durable insert fail. The occurrence claim must
      // roll back with it instead of leaving the cursor advanced and unbacked.
      await db.execute(sql`
        insert into fx_provider_runs
          (org_id, provider_config_id, trigger, requested_from, requested_to, started_at, lease_token)
        values (${org.orgId}, ${org.configId}, 'scheduler', current_date - 7, current_date, now(), gen_random_uuid())
      `);
      const failedTick = await runDueFxProviders(now);
      assert.equal(failedTick, 0, "a failed durable claim is not counted as dispatched");
      const afterFailedClaim = await db.execute<{ next_sync_at: string }>(sql`
        select next_sync_at::text from fx_provider_configs where id = ${org.configId}`);
      assert.equal(new Date(afterFailedClaim.rows[0]!.next_sync_at).getTime(), dueAt.getTime(),
        "the due cursor must remain unchanged when run creation rolls back");

      await db.execute(sql`delete from fx_provider_runs where org_id = ${org.orgId}`);
      globalThis.fetch = (async () => new Response(JSON.stringify({
        observations: [{ d: "2026-07-15", FXUSDCAD: { v: "1.2500" }, FXEURCAD: { v: "1.0900" } }],
      }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
      const successfulTick = await runDueFxProviders(now);
      assert.equal(successfulTick, 1, "the still-due occurrence dispatches on the next tick");
      const settled = await db.execute<{ status: string; next_sync_at: string }>(sql`
        select r.status, c.next_sync_at::text
          from fx_provider_runs r
          join fx_provider_configs c on c.id = r.provider_config_id
         where r.org_id = ${org.orgId}`);
      assert.deepEqual(settled.rows.map((row) => row.status), ["ok"]);
      assert.ok(new Date(settled.rows[0]!.next_sync_at).getTime() > dueAt.getTime(),
        "a successful dispatch advances the cursor after durable run creation");
    } finally {
      globalThis.fetch = originalFetch;
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

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

// A worker killed mid-run leaves its row at 'running', and
// fx_provider_runs_one_running then rejects every future run for that config
// forever — stale exchange rates plus an operator-facing "already in progress"
// error. Recovery must reclaim crashed rows by age while a genuinely live run
// still excludes concurrency.
test(
  "a crashed run's stale row is reclaimed instead of blocking synchronization forever",
  { skip: !DB },
  async () => {
    const provider = createServer((req, res) => {
      const today = new Date().toISOString().slice(0, 10);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        observations: [{ d: today, FXUSDCAD: { v: "1.2500" }, FXEURCAD: { v: "1.0900" } }],
      }));
    });
    const providerOrigin = await listen(provider);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const requested = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (requested.host === "www.bankofcanada.ca") {
        requested.protocol = "http:";
        requested.host = new URL(providerOrigin).host;
      }
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
      await saveFxProviderConfig(org.orgId, actorId, {
        provider: "bank_of_canada",
        baseCurrency: "CAD",
        currencies: ["USD", "EUR"],
        schedule: "manual",
        syncHourUtc: 0,
        lookbackDays: 7,
        isEnabled: true,
        apiKey: null,
      });
      const config = await db.execute<{ id: string }>(sql`
        select id from fx_provider_configs where org_id = ${org.orgId}`);
      const configId = config.rows[0]!.id;

      async function plantRunningRow(startedAt: SQL): Promise<void> {
        await db.execute(sql`
          insert into fx_provider_runs
            (org_id, provider_config_id, trigger, requested_from, requested_to, started_at, lease_token)
          values (${org.orgId}, ${configId}, 'scheduler', current_date - 7, current_date, ${startedAt}, gen_random_uuid())
        `);
      }
      async function runRows(): Promise<Array<{ status: string; error_message: string | null; lease_token: string | null }>> {
        const r = await db.execute<{ status: string; error_message: string | null; lease_token: string | null }>(sql`
          select status, error_message, lease_token from fx_provider_runs
           where org_id = ${org.orgId} order by started_at asc, id asc`);
        return r.rows;
      }

      // Crash stage one: the worker died before fetching anything.
      await plantRunningRow(sql`now() - interval '45 minutes'`);
      const recovered = await runFxProvider(org.orgId, "test");
      assert.equal(recovered.observationsReceived, 1, "the stale row must not block the new run");

      const rows = await runRows();
      assert.equal(rows.length, 2);
      assert.match(rows[0]!.error_message ?? "", /crashed|killed/i, "the abandonment must be operator-visible");
      assert.equal(rows[0]!.status, "failed");
      assert.equal(rows[0]!.lease_token, null, "the takeover must clear the dead claim's fencing token");
      assert.equal(rows[1]!.status, "ok");

      // Control: a fresh running row still excludes concurrent runs.
      await plantRunningRow(sql`now()`);
      await assert.rejects(
        runFxProvider(org.orgId, "test"),
        (error: unknown) => {
          assert.ok(error instanceof FxProviderError, "the insert race must remain a controlled domain refusal");
          assert.equal(error.message, "an FX provider run is already in progress");
          return true;
        },
      );
      // Age the control past the recovery budget so the next run reclaims it,
      // exactly as time itself would.
      await db.execute(sql`
        update fx_provider_runs set started_at = now() - interval '45 minutes'
         where org_id = ${org.orgId} and status = 'running'`);

      // Crash stage two: this time rates had already committed before the crash.
      const firstSync = await runFxProvider(org.orgId, "manual");
      assert.equal(firstSync.ratesInserted, 6, "CAD/EUR/USD materialize every directed pair");

      await plantRunningRow(sql`now() - interval '45 minutes'`);
      await db.execute(sql`
        update fx_rates set source = 'manual', rate = 99.0
         where org_id = ${org.orgId} and from_currency = 'EUR' and to_currency = 'USD' and rate_type = 'spot'`);

      const secondSync = await runFxProvider(org.orgId, "manual");
      assert.equal(secondSync.ratesInserted, 0, "retry after a post-commit crash stays idempotent");
      assert.equal(secondSync.ratesUpdated, 5);
      assert.equal(secondSync.manualOverridesPreserved, 1, "manual overrides survive the recovery path");
      const overridden = await db.execute<{ rate: string }>(sql`
        select rate::text from fx_rates
         where org_id = ${org.orgId} and from_currency = 'EUR' and to_currency = 'USD' and rate_type = 'spot'`);
      assert.ok(Number(overridden.rows[0]!.rate) > 90, "the manual override value must be untouched");

      const finalRows = await runRows();
      const abandoned = finalRows.filter((row) => (row.error_message ?? "").includes("abandoned"));
      assert.equal(abandoned.length, 3, "every planted stale row ends reclaimed and failed");
      assert.ok(abandoned.every((row) => row.status === "failed"));
      assert.ok(abandoned.every((row) => row.lease_token === null), "every reclaimed claim is unfenced");
      assert.equal(finalRows.at(-1)!.status, "ok");
    } finally {
      globalThis.fetch = originalFetch;
      await close(provider);
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

/** Scratch org, currencies, and a manual-schedule provider config for a sync whose observations come from `url`. */
async function setupManualFxScratchOrg(): Promise<{ orgId: string; configId: string }> {
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
    await saveFxProviderConfig(org.orgId, actorId, {
      provider: "bank_of_canada",
      baseCurrency: "CAD",
      currencies: ["USD", "EUR"],
      schedule: "manual",
      syncHourUtc: 0,
      lookbackDays: 7,
      isEnabled: true,
      apiKey: null,
    });
    const config = await db.execute<{ id: string }>(sql`
      select id from fx_provider_configs where org_id = ${org.orgId}`);
    return { orgId: org.orgId, configId: config.rows[0]!.id };
  } catch (error) {
    await withBypass(() => dropScratchOrg(org.orgId));
    throw error;
  }
}

// A crash DURING the rates upsert must persist nothing: the completion stamp
// shares one transaction with every rate write, so a failure partway through
// leaves zero partial rows while the claim records its failure — and replay
// from scratch applies everything exactly once.
test(
  "a mid-upsert crash persists no partial rates and recovery replays atomically",
  { skip: !DB },
  async () => {
    // CAD-per-USD collapses to 1e-10, so CAD→USD normalizes to
    // 10000000000.0000000000 — beyond numeric(19,10). The (CAD,EUR) insert
    // before it succeeds, then PostgreSQL rejects (CAD,USD) inside the same
    // transaction: a genuine storage fault fired after real writes began.
    let poisonUsd = true;
    const provider = createServer((req, res) => {
      const today = new Date().toISOString().slice(0, 10);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        observations: [{
          d: today,
          FXUSDCAD: { v: poisonUsd ? "0.0000000001" : "1.2500" },
          FXEURCAD: { v: "1.0900" },
        }],
      }));
    });
    const providerOrigin = await listen(provider);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const requested = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (requested.host === "www.bankofcanada.ca") {
        requested.protocol = "http:";
        requested.host = new URL(providerOrigin).host;
      }
      return originalFetch(requested, init);
    }) as typeof fetch;

    const org = await setupManualFxScratchOrg();
    try {
      // Drizzle wraps storage faults in a DrizzleQueryError; walk the cause
      // chain like isFxRunInProgressConflict does for constraint conflicts.
      const overflowFault = (error: unknown): boolean => {
        let current: unknown = error;
        for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
          const message = (current as { message?: string }).message ?? "";
          if (/numeric field overflow|out of range/i.test(message)) return true;
          current = (current as { cause?: unknown }).cause;
        }
        return false;
      };
      await assert.rejects(
        runFxProvider(org.orgId, "manual"),
        overflowFault,
        "the poisoned observation must fail inside the upsert transaction",
      );
      const rateCount = await db.execute<{ count: string }>(sql`
        select count(*)::text as count from fx_rates where org_id = ${org.orgId}`);
      assert.equal(rateCount.rows[0]!.count, "0", "no partial application may survive the crash stage");

      const crashed = await db.execute<{ status: string; lease_token: string | null }>(sql`
        select status, lease_token from fx_provider_runs where org_id = ${org.orgId}`);
      assert.deepEqual(crashed.rows, [{ status: "failed", lease_token: null }],
        "the crashed attempt must record its failure and release its fencing token");
      const configState = await db.execute<{ last_error: string | null; last_success_at: Date | null }>(sql`
        select last_error, last_success_at from fx_provider_configs where id = ${org.configId}`);
      assert.ok(
        /numeric field overflow|out of range/i.test(configState.rows[0]!.last_error ?? ""),
        "the config must carry the failure",
      );
      assert.equal(configState.rows[0]!.last_success_at, null, "a crashed attempt owns no success");

      // Replay from scratch: the recovery run re-claims cleanly and applies
      // every pair exactly once, with run state and rates committing together.
      poisonUsd = false;
      const replay = await runFxProvider(org.orgId, "manual");
      assert.equal(replay.ratesInserted, 6, "the replay materializes every directed pair exactly once");
      const pairs = await db.execute<{ from_currency: string; to_currency: string; rate: string }>(sql`
        select from_currency, to_currency, rate::text from fx_rates
         where org_id = ${org.orgId} order by from_currency, to_currency`);
      assert.equal(pairs.rows.length, 6);
      for (const row of pairs.rows) {
        assert.match(row.rate, /^\d+\.\d{10}$/, `${row.from_currency}→${row.to_currency} stays inside numeric(19,10)`);
      }
      const settledRows = await db.execute<{ status: string; lease_token: string | null }>(sql`
        select status, lease_token from fx_provider_runs where org_id = ${org.orgId} order by started_at asc, id asc`);
      assert.deepEqual(settledRows.rows, [
        { status: "failed", lease_token: null },
        { status: "ok", lease_token: null },
      ], "recovery ends with the failed stage terminal and the replay committed unfenced");
    } finally {
      globalThis.fetch = originalFetch;
      await close(provider);
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

// A superseded claim — one whose run aged past the lease TTL while still in
// flight and was reclaimed by a fresh attempt — must not stamp its outcome,
// resurrect its row, or promote schedule ownership. The winner's commit is the
// only visible effect.
test(
  "a reclaimed claim cannot complete or promote schedule ownership after losing its lease",
  { skip: !DB },
  async () => {
    let gated = false;
    let releaseLoser!: () => void;
    const gate = new Promise<void>((resolve) => { releaseLoser = resolve; });
    const provider = createServer((req, res) => {
      const today = new Date().toISOString().slice(0, 10);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        observations: [{ d: today, FXUSDCAD: { v: "1.2500" }, FXEURCAD: { v: "1.0900" } }],
      }));
    });
    const providerOrigin = await listen(provider);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const requested = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (requested.host === "www.bankofcanada.ca") {
        requested.protocol = "http:";
        requested.host = new URL(providerOrigin).host;
        if (gated) return gate.then(() => originalFetch(requested, init));
      }
      return originalFetch(requested, init);
    }) as typeof fetch;

    const org = await setupManualFxScratchOrg();
    try {
      // Start an attempt and hold it mid-fetch, exactly where a wedged worker
      // sits while everyone else thinks it died.
      gated = true;
      const loserPromise = runFxProvider(org.orgId, "manual").catch((error: unknown) => error);
      let lost: { id: string } | undefined;
      for (let waited = 0; waited < 10_000 && !lost; waited += 50) {
        const runningRow = await db.execute<{ id: string }>(sql`
          select id from fx_provider_runs
           where org_id = ${org.orgId} and status = 'running' limit 1`);
        lost = runningRow.rows[0];
        if (!lost) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(lost, "the held attempt must claim its run row before fetching");

      // Age it past the lease TTL so the next attempt is entitled to take over.
      await db.execute(sql`
        update fx_provider_runs set started_at = now() - interval '45 minutes' where id = ${lost.id}`);
      gated = false;
      const winner = await runFxProvider(org.orgId, "manual");
      assert.equal(winner.ratesInserted, 6, "the takeover completes the synchronization normally");

      // Only now may the former holder resume — straight into its fence.
      releaseLoser();
      const loserOutcome = await Promise.race([
        loserPromise,
        new Promise((resolve) => setTimeout(() => resolve(new Error("loser promise did not settle")), 15_000)),
      ]);
      assert.ok(
        loserOutcome instanceof FxRunLeaseLostError,
        `the supseded attempt must surface its lost lease, got: ${String(loserOutcome)}`,
      );

      const rows = await db.execute<{ id: string; status: string; error_message: string | null; lease_token: string | null }>(sql`
        select id, status, error_message, lease_token from fx_provider_runs
         where org_id = ${org.orgId} order by started_at asc, id asc`);
      assert.deepEqual(rows.rows.map((row) => ({
        status: row.status,
        messageAbandoned: (row.error_message ?? "").includes("abandoned"),
        lease_token: row.lease_token,
      })), [
        { status: "failed", messageAbandoned: true, lease_token: null },
        { status: "ok", messageAbandoned: false, lease_token: null },
      ], "exactly one ok row survives: the winner's");

      const rates = await db.execute<{ count: string }>(sql`
        select count(*)::text as count from fx_rates where org_id = ${org.orgId}`);
      assert.equal(rates.rows[0]!.count, "6", "the stale attempt applied nothing before or after losing its lease");

      const configState = await db.execute<{ last_error: string | null; last_success_at: Date | null }>(sql`
        select last_error, last_success_at from fx_provider_configs where id = ${org.configId}`);
      assert.equal(configState.rows[0]!.last_error, null, "the fenced attempt may not write config errors either");
      assert.notEqual(configState.rows[0]!.last_success_at, null, "schedule ownership stays with the winner");
    } finally {
      globalThis.fetch = originalFetch;
      await close(provider);
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
