import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

const routeSource = readFileSync(
  "web/app/api/admin/setup/payment-providers/route.ts",
  "utf8",
);
const migrationSource = readFileSync(
  "schema/migrations/generated/0023_payment_surcharge_rule_uniqueness.sql",
  "utf8",
);

test("surcharge setup maps both storage conflict codes to its existing 409 contract", () => {
  assert.match(routeSource, /code === "23P01" \|\| code === "23505"/);
  assert.match(
    routeSource,
    /error: new SurchargeRuleDatingConflict\(values\.effectiveFrom\)\.message/,
  );
  assert.match(migrationSource, /EXCLUDE USING gist/);
  assert.match(migrationSource, /daterange\(effective_from, effective_to, '\[\]'\)\) WITH &&/);
});

const stateKey = Symbol.for("openbooks.payment-surcharge-concurrency-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.payment-surcharge-concurrency-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

type QueryClient = {
  query: (...args: unknown[]) => Promise<unknown>;
};

/**
 * Drive two real route transactions through the unlocked preflight together.
 * Wrapping checked-out clients only synchronizes those two completed SELECTs;
 * the inserts, exclusion wait, commit/rollback, and HTTP responses remain the
 * production route and PostgreSQL behavior under test.
 */
test(
  "concurrent surcharge saves commit one rule and return the documented conflict for the loser",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "server-only") {
          return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
        }
        if (specifier.startsWith("@/") && context.parentURL) {
          return nextResolve(
            new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href,
            context,
          );
        }
        if (
          specifier === "../../../../../lib/authz" &&
          context.parentURL?.includes("setup/payment-providers")
        ) {
          return { url: "mock:payment-surcharge-authz", shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
      load(url, context, nextLoad) {
        if (url === "mock:payment-surcharge-authz") {
          return { format: "module", source: mockAuthz, shortCircuit: true };
        }
        return nextLoad(url, context);
      },
    });

    const routeUrl =
      "../app/api/admin/setup/payment-providers/route.ts?payment-surcharge-concurrency-test";
    const { POST } = (await import(routeUrl)) as typeof import(
      "../app/api/admin/setup/payment-providers/route.ts"
    );
    hooks.deregister();

    const { db } = await import("@openbooks/engine/src/db.ts");
    const { sql } = await import("drizzle-orm");
    const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(
      "@openbooks/engine/src/test-fixtures.ts"
    );
    const pg = (await import("pg")).default;

    const org = await createScratchOrg();
    const actorId = await createScratchUser(org.orgId, "Concurrent Payments Admin", "admin");
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(
           coalesce(settings, '{}'::jsonb),
           '{features}',
           coalesce(settings->'features', '{}'::jsonb)
             || ${JSON.stringify({ onlinePayments: true })}::jsonb
         )
       where id = ${org.orgId}
    `);
    routeState.authz = {
      user: { orgId: org.orgId, id: actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };

    const poolPrototype = pg.Pool.prototype as unknown as {
      connect: (this: unknown) => Promise<QueryClient>;
    };
    const originalConnect = poolPrototype.connect;
    const originalQueries = new WeakMap<QueryClient, QueryClient["query"]>();
    const wrappedClients = new Set<QueryClient>();
    let preflightCount = 0;
    let releasePreflights: (() => void) | undefined;
    const bothPreflightsComplete = new Promise<void>((resolve) => {
      releasePreflights = resolve;
    });

    poolPrototype.connect = async function synchronizedConnect(this: unknown) {
      const client = await originalConnect.call(this);
      if (!originalQueries.has(client)) {
        const originalQuery = client.query.bind(client);
        originalQueries.set(client, originalQuery);
        wrappedClients.add(client);
        client.query = async (...args: unknown[]) => {
          const result = await originalQuery(...args);
          const query = args[0];
          const text = typeof query === "string"
            ? query
            : query && typeof query === "object" && "text" in query
              ? String((query as { text: unknown }).text)
              : "";
          if (
            text.includes("select id from payment_surcharge_rules") &&
            text.includes("daterange(effective_from, effective_to")
          ) {
            preflightCount += 1;
            if (preflightCount === 2) releasePreflights?.();
            await bothPreflightsComplete;
          }
          return result;
        };
      }
      return client;
    };

    const body = {
      action: "saveRule",
      name: "Concurrent card fee",
      calculation: "percent",
      percent: "2.5",
      fixedAmount: null,
      capAmount: null,
      feeIncomeAccountId: org.accounts.revenue,
      provider: "stripe",
      paymentMethod: "card",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    };
    const request = () => new Request("http://localhost/api/admin/setup/payment-providers", {
      method: "POST",
      body: JSON.stringify(body),
    });

    try {
      const responses = await Promise.all([POST(request()), POST(request())]);
      assert.equal(preflightCount, 2, "both route transactions must pass the preflight before either writes");

      const winner = responses.find((response) => response.status === 200);
      const loser = responses.find((response) => response.status === 409);
      assert.ok(winner, "one concurrent request must retain the normal success path");
      assert.ok(loser, "storage must reject the racing writer as a conflict");
      assert.deepEqual(await winner.json(), { ok: true });
      assert.deepEqual(await loser.json(), {
        error: "another active surcharge rule already takes effect on 2026-01-01",
      });

      const stored = await db.execute<{ count: number }>(sql`
        select count(*)::int as count
          from payment_surcharge_rules
         where org_id = ${org.orgId}
           and provider = 'stripe'
           and payment_method = 'card'
           and is_active
      `);
      assert.equal(stored.rows[0]!.count, 1);
    } finally {
      poolPrototype.connect = originalConnect;
      for (const client of wrappedClients) {
        const originalQuery = originalQueries.get(client);
        if (originalQuery) client.query = originalQuery;
      }
      routeState.authz = null;
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
