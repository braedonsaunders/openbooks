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
  async (t) => {
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

    const { db, withOrgTransaction } = await import("@openbooks/engine/src/db.ts");
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
    let auditWrites = 0;
    let injectedFailures = 0;
    let failureCode = "40P01";
    let synchronizePreflights = false;
    let releasePreflights: (() => void) | undefined;
    let bothPreflightsComplete: Promise<void> = Promise.resolve();
    let synchronizeBeforeReads = false;
    let beforeReadCount = 0;
    let releaseSecondBeforeRead: (() => void) | undefined;
    let secondBeforeReadStarted: Promise<void> = Promise.resolve();

    poolPrototype.connect = async function synchronizedConnect(this: unknown) {
      const client = await originalConnect.call(this);
      if (!originalQueries.has(client)) {
        const originalQuery = client.query.bind(client);
        originalQueries.set(client, originalQuery);
        wrappedClients.add(client);
        client.query = async (...args: unknown[]) => {
          const query = args[0];
          const text = typeof query === "string"
            ? query
            : query && typeof query === "object" && "text" in query
              ? String((query as { text: unknown }).text)
              : "";
          const isBeforeRead = synchronizeBeforeReads
            && text.includes('fee_income_account_id as "feeIncomeAccountId"')
            && text.includes("from payment_surcharge_rules");
          const readNumber = isBeforeRead ? ++beforeReadCount : 0;
          const pendingQuery = originalQuery(...args);
          if (readNumber === 2) releaseSecondBeforeRead?.();
          const result = await pendingQuery;
          // Hold the first locked snapshot until the competing request has
          // submitted its read. Its SELECT must wait for the first commit.
          if (readNumber === 1) await secondBeforeReadStarted;
          if (
            synchronizePreflights &&
            text.includes("select id from payment_surcharge_rules") &&
            text.includes("daterange(effective_from, effective_to")
          ) {
            preflightCount += 1;
            if (preflightCount === 2) releasePreflights?.();
            await bothPreflightsComplete;
          }
          if (text.includes("insert into audit_log") && text.includes("'payment_surcharge_rules'")) {
            auditWrites += 1;
            if (injectedFailures > 0) {
              injectedFailures -= 1;
              // Fail on the server *after* both row and audit writes. This
              // aborts the actual transaction, exercising rollback ownership.
              await originalQuery(`do $$ begin raise exception using errcode = '${failureCode}', message = 'injected transaction failure'; end $$`);
            }
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
      effectiveTo: null as string | null,
    };
    const request = (changes: Record<string, unknown> = {}) => new Request("http://localhost/api/admin/setup/payment-providers", {
      method: "POST",
      body: JSON.stringify({ ...body, ...changes }),
    });
    const storedState = async () => {
      const stored = await db.execute<{ rules: number; audits: number }>(sql`
        select (select count(*)::int from payment_surcharge_rules where org_id = ${org.orgId}
                  and effective_from = ${body.effectiveFrom}::date) as rules,
               (select count(*)::int from audit_log where org_id = ${org.orgId}
                  and table_name = 'payment_surcharge_rules'
                  and changes->'rule'->1->>'effectiveFrom' = ${body.effectiveFrom}) as audits
      `);
      return stored.rows[0]!;
    };
    let scenario = 0;
    const reset = async () => {
      // Give each scenario a disjoint day, preserving all append-only audit
      // evidence until the scratch organization is torn down.
      scenario += 1;
      body.effectiveFrom = `2026-01-${String(scenario).padStart(2, "0")}`;
      body.effectiveTo = body.effectiveFrom;
      auditWrites = 0;
      injectedFailures = 0;
      failureCode = "40P01";
      synchronizePreflights = false;
      preflightCount = 0;
      beforeReadCount = 0;
    };

    try {
      for (let round = 1; round <= 6; round += 1) {
        await t.test(`real exclusion race ${round}: one rule and one audit commit`, async () => {
          await reset();
          synchronizePreflights = true;
          bothPreflightsComplete = new Promise<void>((resolve) => { releasePreflights = resolve; });
          let timedOut = false;
          const timeout = setTimeout(() => { timedOut = true; releasePreflights?.(); }, 10_000);
          try {
            const responses = await Promise.all([POST(request()), POST(request())]);
            assert.equal(timedOut, false, "both preflights must reach the barrier without timeout");
            assert.ok(preflightCount >= 2, "both initial requests must reach the preflight (a deadlock retry may read again)");
            assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
            assert.deepEqual(await responses.find((response) => response.status === 200)!.json(), { ok: true });
            assert.deepEqual(await responses.find((response) => response.status === 409)!.json(), {
              error: `another active surcharge rule already takes effect on ${body.effectiveFrom}`,
            });
            assert.deepEqual(await storedState(), { rules: 1, audits: 1 });
          } finally {
            clearTimeout(timeout);
            releasePreflights?.();
          }
        });
      }

      await t.test("deadlocks after audit roll back before retrying the whole save", async () => {
        await reset();
        injectedFailures = 2;
        assert.equal((await POST(request())).status, 200);
        assert.equal(auditWrites, 3, "both aborted attempts must have reached the audit write");
        assert.deepEqual(await storedState(), { rules: 1, audits: 1 });
      });

      await t.test("repeated deadlocks stop after three attempts without partial state", async () => {
        await reset();
        injectedFailures = 3;
        const response = await POST(request());
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), {
          error: "surcharge rule save conflicted with another transaction; retry the save",
        });
        assert.equal(auditWrites, 3);
        assert.deepEqual(await storedState(), { rules: 0, audits: 0 });
      });

      await t.test("an ambient transaction is never retried on its aborted connection", async () => {
        await reset();
        injectedFailures = 1;
        const response = await withOrgTransaction(org.orgId, () => POST(request()));
        assert.equal(response.status, 409);
        assert.equal(auditWrites, 1);
        assert.deepEqual(await storedState(), { rules: 0, audits: 0 });
      });

      await t.test("unrecognized database failures are not retried or mislabeled as overlap", async () => {
        await reset();
        injectedFailures = 1;
        failureCode = "XX000";
        await assert.rejects(POST(request()), (error: unknown) => {
          const cause = (error as { cause?: { code?: string } }).cause;
          return cause?.code === "XX000";
        });
        assert.equal(auditWrites, 1);
        assert.deepEqual(await storedState(), { rules: 0, audits: 0 });
      });

      for (const secondAction of ["saveRule", "deleteRule"]) {
        await t.test(`concurrent save/${secondAction} capture the immediately preceding row in their audit`, async () => {
          await reset();
          assert.equal((await POST(request())).status, 200);
          const rows = await db.execute<{ id: string }>(sql`
            select id from payment_surcharge_rules where org_id = ${org.orgId}
              and effective_from = ${body.effectiveFrom}::date
          `);
          const id = rows.rows[0]!.id;
          synchronizeBeforeReads = true;
          secondBeforeReadStarted = new Promise<void>((resolve) => { releaseSecondBeforeRead = resolve; });
          let timedOut = false;
          const timeout = setTimeout(() => { timedOut = true; releaseSecondBeforeRead?.(); }, 10_000);
          let responses: Response[];
          try {
            responses = await Promise.all([
              POST(request({ id, name: "First editor" })),
              POST(request({ id, action: secondAction, name: "Second editor" })),
            ]);
            assert.equal(timedOut, false, "the competing update must submit its read while the first holds its snapshot");
            assert.equal(beforeReadCount, 2);
          } finally {
            synchronizeBeforeReads = false;
            clearTimeout(timeout);
            releaseSecondBeforeRead?.();
          }
          assert.deepEqual(responses.map((response) => response.status), [200, 200]);
          const audits = await db.execute<{
            before: { name: string; isActive: boolean };
            after: { name: string; isActive: boolean };
          }>(sql`
            select changes->'rule'->0 as before, changes->'rule'->1 as after
              from audit_log where org_id = ${org.orgId} and row_id = ${id} and action in ('update', 'delete')
          `);
          assert.equal(audits.rows.length, 2);
          const first = audits.rows.find((row) => row.before.name === body.name && row.before.isActive);
          assert.ok(first);
          const second = audits.rows.find((row) => row !== first);
          assert.ok(second);
          assert.deepEqual(second.before, first.after, "second audit before must be the first editor's committed row");
          const live = await db.execute<{ name: string; isActive: boolean }>(sql`
            select name, is_active as "isActive" from payment_surcharge_rules where org_id = ${org.orgId} and id = ${id}
          `);
          assert.deepEqual(live.rows[0], { name: second.after.name, isActive: second.after.isActive });
          assert.deepEqual(await storedState(), { rules: 1, audits: 3 });
        });
      }
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
