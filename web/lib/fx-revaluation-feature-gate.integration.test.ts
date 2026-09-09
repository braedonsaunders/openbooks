import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { runRevaluation } from "@openbooks/engine/src/fx-revaluation.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "@openbooks/engine/src/test-fixtures.ts";
import type { Authz } from "./authz";

const enabled = !!process.env.OPENBOOKS_DB_URL;
const state: { gate: Authz | null } = { gate: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.fx-feature-race")] = state;
// Substitute identity only; the feature gate, parser, service and writes remain native.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "./authz" && (context.parentURL ?? "").endsWith("/lib/feature-gates.ts")) {
    return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
      `export async function guardPermission(){return globalThis[Symbol.for('openbooks.fx-feature-race')].gate}`) };
  }
  return next(specifier, context);
} });
// Finish async module registration before declaring any tests (--test-force-exit).
const { POST } = await import("../app/api/close/run-revaluation/route");

async function setFeature(orgId: string, multiCurrency: boolean) {
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
    coalesce(settings->'features','{}'::jsonb)||${JSON.stringify({ multiCurrency })}::jsonb) where id=${orgId}`);
}

async function fixture() {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await setFeature(org.orgId, true);
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts}',
    coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('fxUnrealizedGainLoss',${org.accounts.fxGainLoss}::text))
    where id=${org.orgId}`);
  await db.execute(sql`insert into accounting_periods
    (id,org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
    select ${randomUUID()},${org.orgId},2026,8,'2026-08','2026-08-01','2026-08-31',false,fiscal_calendar_id
    from accounting_periods where id=${org.periodId}`);
  await db.execute(sql`insert into fx_rates(org_id,from_currency,to_currency,as_of,rate_type,rate)
    values(${org.orgId},'USD','CAD','2026-07-31','spot',1.37)`);
  const entryId = randomUUID();
  await db.execute(sql`insert into journal_entries
    (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
    values(${entryId},${org.orgId},${org.bookId},${org.subsidiaryId},'FX-GATE','2026-07-15',${org.periodId},'draft','manual')`);
  await db.execute(sql`insert into journal_lines
    (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
    values(${org.orgId},${entryId},1,${org.accounts.ar},${org.subsidiaryId},136,'USD',100,1.36),
      (${org.orgId},${entryId},2,${org.accounts.clearing},${org.subsidiaryId},-136,'CAD',-136,1)`);
  await db.execute(sql`update journal_entries set status='posted',posted_at=now() where org_id=${org.orgId} and id=${entryId}`);
  state.gate = { user: { orgId: org.orgId, id: actorId }, permissions: new Set(["*"]), allowedSubsidiaryIds: null } as Authz;
  return { ...org, actorId };
}

async function evidence(orgId: string) {
  return (await db.execute(sql`select * from (
    select 'journal' as kind,to_jsonb(e) as row from journal_entries e where org_id=${orgId}
    union all select 'audit',to_jsonb(a) from audit_log a where org_id=${orgId}
  ) evidence order by kind,row::text`)).rows;
}

test("disabled multi-currency blocks the FX service before any journal or audit mutation", { skip: !enabled }, async () => {
  const org = await fixture();
  try {
    await setFeature(org.orgId, false);
    const before = await evidence(org.orgId);
    await assert.rejects(() => runRevaluation(org.orgId, org.periodId, org.actorId), /multiCurrency feature is disabled/);
    assert.deepEqual(await evidence(org.orgId), before);
    await setFeature(org.orgId, true);
    assert.equal((await runRevaluation(org.orgId, org.periodId, org.actorId)).posted.length, 1);
  } finally { state.gate = null; await dropScratchOrg(org.orgId); }
});

test("FX route rejects a feature disable committed after its initial guard", { skip: !enabled }, async () => {
  const org = await fixture();
  try {
    const req = new Request("https://openbooks.test/api/close/run-revaluation", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ periodId: org.periodId }),
    });
    const original = req.json.bind(req);
    let before: Awaited<ReturnType<typeof evidence>> | undefined;
    req.json = async () => {
      await setFeature(org.orgId, false);
      before = await evidence(org.orgId);
      return original();
    };
    const response = await POST(req);
    assert.ok(before, "the native initial gate must have passed before disabling");
    assert.equal(response.status, 404, JSON.stringify(await response.json()));
    assert.deepEqual(await evidence(org.orgId), before);
  } finally { state.gate = null; await dropScratchOrg(org.orgId); }
});
