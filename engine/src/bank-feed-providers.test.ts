import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import {
  getBankFeedAdapter,
  plaidApiBase,
  runDueBankFeeds,
  sealCredentials,
} from "./bank-feed-providers.ts";
import { addCalendarDays } from "./business-date.ts";
import { db } from "./db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
} from "./test-fixtures.ts";

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

// Every 3xx with a Location must be refused, not followed: 307/308 preserve
// method AND body; 301/302/303 still leak whichever headers survive the
// re-request. Each adapter carries secrets (client secret, bearer token),
// so none of them may ever cross an HTTP redirect boundary.
const redirectStatuses = [301, 302, 303, 307, 308] as const;

test("bank-feed adapters refuse every redirect class without forwarding credentials", async () => {
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
    // Cycle the status so each adapter call meets a different redirect class.
    res.writeHead(redirectStatuses[providerPaths.length % redirectStatuses.length]!, {
      location: `${attackerOrigin}/credential-capture`,
    });
    res.end();
  });
  const providerOrigin = await listen(redirector);
  const originalFetch = globalThis.fetch;
  const providerOrigins = [
    "https://sandbox.plaid.com",
    "https://production.plaid.com",
    "https://bankaccountdata.gocardless.com",
    "https://api.truelayer.com",
  ];
  const redirectModes: Array<RequestRedirect | undefined> = [];
  globalThis.fetch = (input, init) => {
    redirectModes.push(init?.redirect);
    let providerUrl = String(input);
    for (const origin of providerOrigins) providerUrl = providerUrl.replace(origin, providerOrigin);
    return originalFetch(providerUrl, init);
  };

  try {
    const gocardless = getBankFeedAdapter("gocardless");
    assert.ok(gocardless);
    const gocardlessCredentials = { secretId: "secret-id", secretKey: "secret-key" };
    assert.equal((await gocardless.test(gocardlessCredentials)).ok, false);
    await assert.rejects(
      gocardless.fetch(gocardlessCredentials, "account-id", "2026-01-01", "2026-01-31"),
      /fetch failed|redirect/i,
    );

    const plaid = getBankFeedAdapter("plaid");
    assert.ok(plaid);
    const plaidCredentials = {
      clientId: "client-id",
      secret: "provider-secret",
      accessToken: "access-token",
      env: "sandbox",
    };
    assert.equal((await plaid.test(plaidCredentials)).ok, false);
    await assert.rejects(
      plaid.fetch(plaidCredentials, "account-id", "2026-01-01", "2026-01-31"),
      /fetch failed|redirect/i,
    );

    const truelayer = getBankFeedAdapter("truelayer");
    assert.ok(truelayer);
    const truelayerCredentials = { accessToken: "access-token" };
    assert.equal((await truelayer.test(truelayerCredentials)).ok, false);
    await assert.rejects(
      truelayer.fetch(truelayerCredentials, "account-id", "2026-01-01", "2026-01-31"),
      /fetch failed|redirect/i,
    );

    // Exactly one request per adapter call reaches the allowlisted origin —
    // never a second, followed hop — and the attacker sees zero traffic.
    // GoCardless fails at its token exchange on both paths, so its transaction
    // URL is never reached; Plaid/TrueLayer fail on their first data request.
    assert.deepEqual(providerPaths, [
      "/api/v2/token/new/",
      "/api/v2/token/new/",
      "/accounts/get",
      "/transactions/get",
      "/data/v1/accounts",
      `/data/v1/accounts/${encodeURIComponent("account-id")}/transactions?from=2026-01-01T00:00:00Z&to=2026-01-31T23:59:59Z`,
    ]);
    assert.deepEqual(redirectModes, ["error", "error", "error", "error", "error", "error"]);
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

test("scheduled bank-feed syncs carry the documented system actor, never the zero UUID", async () => {
  // Dynamic access on purpose: the documented constant is pinned when it
  // exists, and its absence can never mask the zero-UUID regressions below.
  const banking = (await import("./banking.ts")) as { SYSTEM_ACTOR_ID?: string };
  const systemActorId = banking.SYSTEM_ACTOR_ID;
  assert.ok(systemActorId, "banking.ts must export an explicit system actor id");
  assert.match(systemActorId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  // The zero UUID means "no actor at all"; persisting it would destroy the
  // audit trail for an engine-initiated financial import.
  assert.notEqual(systemActorId, "00000000-0000-0000-0000-000000000000");
});

// ---------------------------------------------------------------------------
// Live-Postgres regressions for API bank-feed syncs. Two invariants that only
// hold against the real scheduler/route write paths:
//
// 1. `last_sync_at` is the SUCCESS watermark `sinceFor` derives the next pull
//    window from — a failed sync (provider outage or post-fetch import
//    rejection) must leave it untouched, or the retry starts AFTER transactions
//    that were never imported and they are silently lost forever.
// 2. Every persisted actor column carries real provenance: the authenticated
//    operator for an interactive Sync Now (through the actual API route), and
//    a documented system actor for scheduled pulls — never the zero UUID.
// ---------------------------------------------------------------------------

const DB = !!process.env.OPENBOOKS_DB_URL;

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The interactive case drives the shipped route handler behind a mocked auth
// gate (same seam as the labor-costing route integration test); only the
// session boundary is scripted.
const stateKey = Symbol.for("openbooks.bank-feed-sync-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.bank-feed-sync-route-test')]
  export async function guardFeaturePermission(_permission, _featureKey) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

const routeHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // The server-only marker gates RSC bundling; shim it so server modules
    // load under the plain runner (same seam as platform.test.ts).
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (context.parentURL?.includes("bank-feeds") && specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    if (
      context.parentURL?.includes("bank-feeds") &&
      specifier === "../../../../../lib/feature-gates"
    ) {
      return { url: "mock:feature-gates", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:feature-gates") {
      return { format: "module", source: mockFeatureGates, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

type SyncRouteModule = {
  POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response>;
};
const routeModuleHref = pathToFileURL(
  fileURLToPath(new URL("../../web/app/api/banking/bank-feeds/[id]/route.ts", import.meta.url)),
).href;
const { POST: syncRoutePOST } = (await import(routeModuleHref)) as unknown as SyncRouteModule;
routeHooks.deregister();

interface FeedFixture {
  orgId: string;
  userId: string;
  connectionId: string;
  accountId: string;
}

async function seedFeedFixture(): Promise<FeedFixture> {
  const org = await createScratchOrg();
  const userId = await createScratchUser(org.orgId, "Bank Feed Admin", "admin");
  await db.execute(sql`
    update accounts
       set reconcilable = true, currency_restriction = 'CAD'
     where id = ${org.accounts.bank} and org_id = ${org.orgId}
  `);
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"bankFeeds": true}'::jsonb)
     where id = ${org.orgId}
  `);
  const connectionId = randomUUID();
  await db.execute(sql`
    insert into bank_feed_connections
      (id, org_id, name, provider, account_id, status, credentials, external_account_id,
       sync_cadence, next_sync_at, is_active, created_by)
    values (${connectionId}, ${org.orgId}, 'Scratch feed', 'plaid', ${org.accounts.bank}, 'pending',
            ${sealCredentials({ clientId: "client-id", secret: "provider-secret", accessToken: "access-token", env: "sandbox" })},
            'plaid-external-1', 'hourly', null, true, ${userId})
  `);
  return { orgId: org.orgId, userId, connectionId, accountId: org.accounts.bank };
}

/** Put a connection back in the scheduler's due set after a claimed sync. */
async function makeDue(connectionId: string): Promise<void> {
  await db.execute(sql`
    update bank_feed_connections set next_sync_at = null where id = ${connectionId}
  `);
}

interface ConnectionRow {
  last_sync_at: Date | null;
  status: string;
  last_error: string | null;
}

async function loadConnection(connectionId: string): Promise<ConnectionRow> {
  const r = (await db.execute<ConnectionRow>(sql`
    select last_sync_at, status, last_error
      from bank_feed_connections where id = ${connectionId}
  `));
  return r.rows[0]!;
}

/** Raw SQL reads surface timestamptz as Date or string depending on driver; compare instants. */
function asWatermarkMs(value: ConnectionRow["last_sync_at"]): number | null {
  if (value === null) return null;
  return value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
}

interface PlaidTransaction {
  transaction_id: string;
  date: string;
  /** Plaid convention: POSITIVE amounts are outflows; the adapter negates. */
  amount: string;
  name: string;
  iso_currency_code: string;
}

function feedTxn(
  id: string,
  postedOn: string,
  amount: string,
  currency = "CAD",
): PlaidTransaction {
  return { transaction_id: id, date: postedOn, amount, name: `Feed ${id}`, iso_currency_code: currency };
}

interface ScriptedResponse {
  status: number;
  body?: unknown;
}

function plaidPage(transactions: PlaidTransaction[]): ScriptedResponse {
  return { status: 200, body: { transactions, has_more: false } };
}

/**
 * Script the Plaid transactions/get endpoint. Records every requested window
 * so tests can assert WHICH range a retry asked for.
 */
function scriptProvider(t: TestContext, script: ScriptedResponse[]) {
  const originalFetch = globalThis.fetch;
  const windows: Array<{ start_date?: string; end_date?: string }> = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    windows.push({ start_date: body.start_date, end_date: body.end_date });
    const next = script.shift();
    if (!next) throw new Error("test provider script exhausted");
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return windows;
}

function myOutcome(outcomes: Awaited<ReturnType<typeof runDueBankFeeds>>, connectionId: string) {
  const mine = outcomes.filter((o) => o.connectionId === connectionId);
  assert.equal(mine.length, 1, "the seeded connection must sync exactly once per due pass");
  return mine[0]!;
}

interface StatementLineRow {
  id: string;
  bank_transaction_id: string | null;
}

async function loadStatementLines(orgId: string, accountId: string): Promise<StatementLineRow[]> {
  const r = (await db.execute<StatementLineRow>(sql`
    select id, bank_transaction_id
      from bank_statement_lines
     where org_id = ${orgId} and account_id = ${accountId}
     order by bank_transaction_id
  `));
  return r.rows;
}

interface FeedImportActors {
  statementActor: string | null;
  lineActor: string | null;
  auditActor: string | null;
}

async function loadLatestFeedImportActors(orgId: string): Promise<FeedImportActors> {
  const r = (await db.execute<FeedImportActors>(sql`
    select bs.created_by as "statementActor",
           (select bsl.created_by from bank_statement_lines bsl
             where bsl.statement_id = bs.id order by bsl.line_number limit 1) as "lineActor",
           al.actor_id as "auditActor"
      from bank_statements bs
      join audit_log al
        on al.org_id = bs.org_id and al.table_name = 'bank_statements' and al.row_id = bs.id
     where bs.org_id = ${orgId} and bs.source = 'feed_api'
     order by bs.imported_at desc
     limit 1
  `));
  return r.rows[0]!;
}

/** Zero UUID must be absent from every actor column the sync can touch. */
async function countZeroUuidActorRows(orgId: string): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select (
      (select count(*) from audit_log where org_id = ${orgId} and actor_id = ${ZERO_UUID}) +
      (select count(*) from bank_statements where org_id = ${orgId} and created_by = ${ZERO_UUID}) +
      (select count(*) from bank_statement_lines where org_id = ${orgId} and created_by = ${ZERO_UUID})
    )::int as n
  `));
  return Number(r.rows[0]!.n);
}

test(
  "a failed bank-feed sync leaves the success watermark alone so retries recover the missed window",
  { skip: !DB },
  async (t) => {
    const f = await seedFeedFixture();
    try {
      const today = new Date().toISOString().slice(0, 10);

      // Cold start, provider outage: the 90-day history window must survive.
      const script: ScriptedResponse[] = [
        { status: 500, body: { error: "provider outage" } },
        { status: 200, body: {} }, // placeholder, rewritten below
      ];
      const windows = scriptProvider(t, script);
      let outcome = myOutcome(await runDueBankFeeds(), f.connectionId);
      assert.ok(outcome.error, "the scripted outage must surface as an error outcome");

      let row = await loadConnection(f.connectionId);
      // THE regression: a failed sync used to advance last_sync_at, shrinking
      // the next window from 90 days to two and silently dropping everything
      // older. Attempt bookkeeping still records the failure.
      assert.equal(row.last_sync_at, null);
      assert.equal(row.status, "error");
      assert.ok(row.last_error);

      // Success control: the very next pull must still ask for the untouched
      // cold-start window — proof the retry reaches what the failure could
      // have lost — and import every backdated transaction exactly once.
      await makeDue(f.connectionId);
      script.length = 0;
      script.push(plaidPage([
        feedTxn("feed-deposit-40d", addCalendarDays(today, -40), "-100.50"),
        feedTxn("feed-withdrawal-45d", addCalendarDays(today, -45), "20.25"),
      ]));
      outcome = myOutcome(await runDueBankFeeds(), f.connectionId);
      assert.equal(outcome.error, undefined);
      assert.deepEqual(windows[1], { start_date: addCalendarDays(today, -90), end_date: today });
      assert.equal(outcome.imported, 2);

      row = await loadConnection(f.connectionId);
      const watermarkMs = asWatermarkMs(row.last_sync_at);
      assert.ok(watermarkMs, "a successful non-empty sync advances the watermark");
      assert.equal(row.status, "connected");
      assert.equal(row.last_error, null);

      // A post-fetch import rejection (currency mismatch surfaces only inside
      // importStatement, after the provider already answered) must ALSO leave
      // the watermark exactly where the successful import ended.
      await makeDue(f.connectionId);
      script.length = 0;
      script.push(plaidPage([feedTxn("feed-eur-mismatch", addCalendarDays(today, -1), "-5.00", "EUR")]));
      outcome = myOutcome(await runDueBankFeeds(), f.connectionId);
      assert.match(String(outcome.error), /currency/i);
      row = await loadConnection(f.connectionId);
      assert.equal(asWatermarkMs(row.last_sync_at), watermarkMs);
      assert.equal(row.status, "error");

      // Recovery: the retry asks from the prior successful cursor (two-day
      // overlap over it) and imports the missed transaction exactly once.
      await makeDue(f.connectionId);
      script.length = 0;
      const recoveredPostedOn = addCalendarDays(today, -1);
      script.push(plaidPage([feedTxn("feed-recovered", recoveredPostedOn, "-99.00")]));
      const beforeRecovery = windows.length;
      outcome = myOutcome(await runDueBankFeeds(), f.connectionId);
      assert.equal(outcome.error, undefined);
      assert.equal(outcome.imported, 1);
      const recoveryWindow = windows[beforeRecovery]!;
      assert.ok(
        recoveryWindow.start_date !== undefined && recoveryWindow.start_date <= recoveredPostedOn,
        "the retry window must cover the transaction the failures could have dropped",
      );

      const lines = await loadStatementLines(f.orgId, f.accountId);
      assert.deepEqual(
        lines.map((l) => l.bank_transaction_id),
        ["feed-deposit-40d", "feed-recovered", "feed-withdrawal-45d"],
      );
      // Identity, not counts: every provider transaction exists exactly once.
      const seen = new Set<string>();
      for (const line of lines) {
        const key = line.bank_transaction_id!;
        assert.ok(!seen.has(key), `${key} imported more than once`);
        seen.add(key);
      }
      assert.equal(seen.size, 3);
    } finally {
      await dropScratchOrgReporting(f.orgId);
    }
  },
);

test(
  "a scheduled bank-feed sync persists one named system actor across statement, lines, and audit",
  { skip: !DB },
  async (t) => {
    const f = await seedFeedFixture();
    try {
      // Dynamic access on purpose: the documented constant is pinned when it
      // exists, and its absence can never mask the zero-UUID regression below.
      const banking = (await import("./banking.ts")) as { SYSTEM_ACTOR_ID?: string };

      scriptProvider(t, [
        plaidPage([feedTxn("feed-scheduled", addCalendarDays(new Date().toISOString().slice(0, 10), -3), "-250.00")]),
      ]);
      const outcome = myOutcome(await runDueBankFeeds(), f.connectionId);
      assert.equal(outcome.error, undefined, "the scheduled sync must succeed for this control");
      assert.equal(outcome.imported, 1);

      const actors = await loadLatestFeedImportActors(f.orgId);
      assert.ok(actors, "the scheduled sync must persist an import");
      // Durable named provenance — identical on all three actor columns —
      // never the zero-UUID sentinel.
      assert.ok(actors.statementActor && UUID_SHAPE.test(actors.statementActor));
      assert.notEqual(actors.statementActor, ZERO_UUID);
      if (banking.SYSTEM_ACTOR_ID !== undefined) {
        assert.equal(actors.statementActor, banking.SYSTEM_ACTOR_ID);
      }
      assert.equal(actors.lineActor, actors.statementActor);
      assert.equal(actors.auditActor, actors.statementActor);
      assert.equal(await countZeroUuidActorRows(f.orgId), 0);
    } finally {
      await dropScratchOrgReporting(f.orgId);
    }
  },
);

test(
  "Sync Now through the API route persists the authenticated operator, not the zero UUID",
  { skip: !DB },
  async (t) => {
    const f = await seedFeedFixture();
    try {
      routeState.authz = {
        user: { orgId: f.orgId, id: f.userId },
        permissions: new Set(["admin.setup.manage"]),
        allowedSubsidiaryIds: null,
      };
      scriptProvider(t, [
        plaidPage([feedTxn("feed-interactive", addCalendarDays(new Date().toISOString().slice(0, 10), -2), "-75.25")]),
      ]);

      const response = await syncRoutePOST(
        new Request(`http://localhost/api/banking/bank-feeds/${f.connectionId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "sync" }),
        }),
        { params: Promise.resolve({ id: f.connectionId }) },
      );
      assert.equal(response.status, 200);
      const payload = (await response.json()) as { imported?: number; error?: string };
      assert.equal(payload.error, undefined);
      assert.equal(payload.imported, 1, "the interactive sync must import for this control");

      const actors = await loadLatestFeedImportActors(f.orgId);
      assert.ok(actors, "the interactive sync must persist an import");
      // THE regression: the route discarded authz.user.id, so a human-triggered
      // Sync Now landed with the zero-UUID sentinel instead of the operator.
      assert.equal(actors.statementActor, f.userId);
      assert.equal(actors.lineActor, f.userId);
      assert.equal(actors.auditActor, f.userId);
      assert.equal(await countZeroUuidActorRows(f.orgId), 0);
    } finally {
      routeState.authz = null;
      await dropScratchOrgReporting(f.orgId);
    }
  },
);
