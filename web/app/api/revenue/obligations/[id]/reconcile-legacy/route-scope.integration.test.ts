import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { NextResponse } from "next/server";
Object.assign(globalThis, { __reconcileLegacyOracleNextResponse: NextResponse });

/**
 * H-REVENUE (route): attesting a legacy-provenance obligation lifts its
 * rebuild refusal — a cross-subsidiary write. A subsidiary-restricted ar.post
 * holder naming another entity's obligation gets the same 404 as a missing
 * id, and stores nothing; in-scope and unrestricted callers proceed.
 * Only the gate is doubled; the engine, audit writer and database are real.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = {
  user: { orgId: "", id: "" },
  permissions: new Set<string>(),
  allowed: null as Set<string> | null,
};
Object.assign(globalThis, { __reconcileLegacyOracleState: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (
      (specifier === "@/lib/feature-gates" || specifier.endsWith("/lib/feature-gates")) &&
      context.parentURL?.includes("reconcile-legacy")
    ) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            const NextResponse = globalThis.__reconcileLegacyOracleNextResponse;
            export async function guardFeaturePermission(permission){
              if (!globalThis.__reconcileLegacyOracleState.permissions.has(permission)) {
                return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 });
              }
              return {
                user: globalThis.__reconcileLegacyOracleState.user,
                allowedSubsidiaryIds: globalThis.__reconcileLegacyOracleState.allowed,
              };
            }
          `),
      };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});

const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { buildRecognitionSchedule } = await import("@openbooks/engine/src/revenue/recognition.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { POST } = await import("./route.ts");

const REASON =
  "Schedule verified against the signed policy memo in force at creation; the later in-place rule edit postdates it";

const MONTHS_2026 = [
  ["2026-01", "2026-01-01", "2026-01-31"],
  ["2026-02", "2026-02-01", "2026-02-28"],
  ["2026-03", "2026-03-01", "2026-03-31"],
  ["2026-04", "2026-04-01", "2026-04-30"],
  ["2026-05", "2026-05-01", "2026-05-31"],
  ["2026-06", "2026-06-01", "2026-06-30"],
  ["2026-07", "2026-07-01", "2026-07-31"],
  ["2026-08", "2026-08-01", "2026-08-31"],
  ["2026-09", "2026-09-01", "2026-09-30"],
  ["2026-10", "2026-10-01", "2026-10-31"],
  ["2026-11", "2026-11-01", "2026-11-30"],
  ["2026-12", "2026-12-01", "2026-12-31"],
] as const;

async function legacyFixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const adminId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  const subB = randomUUID();
  await withBypassContext(
    () => db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Entity B', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`),
  );
  const calId = (
    (await withBypassContext(
      () => db.execute<{ id: string }>(sql`
        select id from fiscal_calendars where org_id = ${org.orgId} and is_default = true`),
    )) as { rows: { id: string }[] }
  ).rows[0]!.id;
  for (const [num, name, start, end] of MONTHS_2026.map(([name, start, end], i) => [i + 1, name, start, end] as const)) {
    if (num === 7) continue;
    await withBypassContext(
      () => db.execute(sql`
        insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${randomUUID()}, ${org.orgId}, 2026, ${num}, ${name}, ${start}, ${end}, false, ${calId})`),
    );
  }
  const ruleId = randomUUID();
  await withBypassContext(
    () => db.execute(sql`
      insert into recognition_rules
        (id, org_id, code, name, method, is_forecast, recognition_periods, start_date_source, end_date_source,
         period_offset, start_offset_days, initial_amount_percent, deferred_account_id, recognized_account_id, is_active)
      values (${ruleId}, ${org.orgId}, 'LEGACY-SL-ROUTE', 'Legacy straight line', 'straight_line_even', false, 12,
              'obligation', 'term', 0, 0, '0', ${org.accounts.deferred}, ${org.accounts.recognized}, true)`),
  );
  const ids = { own: randomUUID(), foreignDenied: randomUUID(), foreignAllowed: randomUUID() };
  const subs = { own: org.subsidiaryId, foreignDenied: subB, foreignAllowed: subB };
  for (const key of Object.keys(ids) as (keyof typeof ids)[]) {
    const contractId = randomUUID();
    await withBypassContext(
      () => db.execute(sql`
        insert into revenue_contracts
          (id, org_id, customer_id, contract_number, status, starts_on, currency, total_transaction_price, subsidiary_id, created_by, updated_by)
        values (${contractId}, ${org.orgId}, ${org.customerId}, ${`LEGACY-ROUTE-${key}`}, 'active', '2026-01-01',
                'CAD', '12000', ${subs[key]}, ${adminId}, ${adminId})`),
    );
    await withBypassContext(
      () => db.execute(sql`
        insert into performance_obligations
          (id, org_id, contract_id, description, recognition_rule_id,
           booked_amount, allocated_price, recognition_starts_on, status, created_by, updated_by)
        values (${ids[key]}, ${org.orgId}, ${contractId}, ${`Legacy service ${key}`}, ${ruleId},
                '12000', '12000', '2026-01-01', 'open', ${adminId}, ${adminId})`),
    );
    const build = await withBypassContext(() => buildRecognitionSchedule(ids[key], org.orgId, adminId));
    assert.equal(build.lineCount, 12);
  }
  await withBypassContext(
    () => db.execute(sql`
      update recognition_rules set method = 'point_in_time', updated_at = now()
       where id = ${ruleId} and org_id = ${org.orgId}`),
  );
  await withBypassContext(
    () => db.execute(sql`
      insert into upgrade_legacy_provenance (org_id, migration, table_name, row_id, note)
      values (${org.orgId}, '0297_recognition_rule_versions', 'recognition_rules', ${ruleId}, 'test mark')`),
  );
  return { org, adminId, subA: org.subsidiaryId, ids };
}

const post = (id: string) =>
  POST(
    new Request("https://openbooks.test/api/revenue/obligations/fixture/reconcile-legacy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: REASON }),
    }),
    { params: Promise.resolve({ id }) },
  );

async function reconciledAt(orgId: string, obligationId: string): Promise<string | null> {
  return (
    ((await db.execute<{ at: string | null }>(sql`
      select legacy_reconciled_at::text as at from performance_obligations
       where id = ${obligationId} and org_id = ${orgId}`)).rows[0]?.at ?? null)
  );
}

test("reconcile-legacy oracle: out-of-scope and missing obligations share one 404", {
  skip: !process.env.OPENBOOKS_DB_URL,
}, async () => {
  const { org, adminId, subA, ids } = await legacyFixture();
  try {
    state.user = { orgId: org.orgId, id: adminId };
    state.permissions = new Set<string>(["ar.post"]);
    state.allowed = new Set<string>([subA]);

    const denied = await post(ids.foreignDenied);
    assert.equal(denied.status, 404);
    assert.deepEqual(await denied.json(), { error: "not found" });
    assert.equal(await reconciledAt(org.orgId, ids.foreignDenied), null);

    const missing = await post(randomUUID());
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not found" });

    const own = await post(ids.own);
    assert.equal(own.status, 200);
    assert.deepEqual(await own.json(), { ok: true });

    state.allowed = null;
    const open = await post(ids.foreignAllowed);
    assert.equal(open.status, 200);
    assert.deepEqual(await open.json(), { ok: true });
  } finally {
    await db.execute(sql`delete from upgrade_legacy_provenance where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});
