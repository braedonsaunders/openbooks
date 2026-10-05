import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";
import { closingSpotRateWithinAgeLimit, averageSpotRateWithinAgeLimit, resolveFxRateAgeLimit } from "./rate-age-policy.ts";
import { periodFingerprint } from "../close/readiness.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("a stopped feed refuses closing and average rates under their effective policies", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await db.execute(sql`insert into fx_rates (org_id,from_currency,to_currency,as_of,rate_type,rate)
      values (${org.orgId},'USD','CAD','2026-07-01','spot','1.25')`);
    assert.equal((await closingSpotRateWithinAgeLimit(db,org.orgId,"USD","CAD","2026-07-31")).rate,"1.2500000000");
    assert.match((await closingSpotRateWithinAgeLimit(db,org.orgId,"USD","CAD","2026-08-02")).refusal!,/32 days old/);
    const beforePolicy = await periodFingerprint(org.orgId,org.periodId,org.bookId);
    await db.execute(sql`insert into fx_rate_age_policies (org_id,rate_kind,max_age_days,effective_from)
      values (${org.orgId},'closing',7,'2026-07-01'),(${org.orgId},'average',10,'2026-07-01'),
             (${org.orgId},'closing',60,'2026-08-01')`);
    assert.notEqual(await periodFingerprint(org.orgId,org.periodId,org.bookId),beforePolicy);
    const afterPolicy = await periodFingerprint(org.orgId,org.periodId,org.bookId);
    await db.execute(sql`insert into fx_rate_age_policies (org_id,rate_kind,max_age_days,effective_from)
      values (${org.orgId},'average',60,'2026-08-01')`);
    assert.equal(await periodFingerprint(org.orgId,org.periodId,org.bookId),afterPolicy,'future versions leave earlier close evidence intact');
    assert.deepEqual(await resolveFxRateAgeLimit(db,org.orgId,"closing","2026-07-31"),{ kind:"closing",maxAgeDays:7,effectiveFrom:"2026-07-01" });
    const closing = await closingSpotRateWithinAgeLimit(db,org.orgId,"USD","CAD","2026-07-31");
    assert.equal(closing.rate,null);
    assert.match(closing.refusal!,/30 days old.*7-day limit/);
    const average = await averageSpotRateWithinAgeLimit(db,org.orgId,"USD","CAD","2026-07-01","2026-07-31");
    assert.equal(average.rate,null);
    assert.match(average.refusal!,/30 days old.*10-day limit/);
    assert.equal((await closingSpotRateWithinAgeLimit(db,org.orgId,"USD","CAD","2026-08-02")).rate,"1.2500000000");
    assert.deepEqual(await closingSpotRateWithinAgeLimit(db,org.orgId,"CAD","CAD","2026-12-31"),{rate:"1",refusal:null});
  } finally { await dropScratchOrg(org.orgId); }
});

test("Setup creates an audited policy and preserves existing versions at API and storage boundaries", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"multiCurrency":true}'::jsonb) where id=${org.orgId}`);
    const actor = { orgId:org.orgId,id:(await seedFlowActors(org.orgId)).adminId,permissions:[] as string[] };
    const { createSetupRecord, updateSetupRecord, deleteSetupRecord } = await import("../../../web/lib/setup/write.ts");
    const created = await createSetupRecord(actor,"fx-rate-age-policies",{rateKind:"closing",maxAgeDays:7,effectiveFrom:"2026-07-01"});
    assert.equal(created.status,200,JSON.stringify(created.body));
    const row = (await db.execute<{id:string}>(sql`select id from fx_rate_age_policies where org_id=${org.orgId}`)).rows[0]!;
    const audit = (await db.execute<{actor_id:string}>(sql`select actor_id from audit_log where org_id=${org.orgId} and table_name='fx_rate_age_policies' and row_id=${row.id}`)).rows;
    assert.ok(audit.some(entry=>entry.actor_id===actor.id));
    const updated = await updateSetupRecord(actor,"fx-rate-age-policies",{id:row.id,maxAgeDays:99});
    assert.equal(updated.status,405);
    assert.match(String(updated.body.error),/create a new record.*effective date/);
    assert.equal((await deleteSetupRecord(actor,"fx-rate-age-policies",row.id)).status,405);
    await assert.rejects(
      db.execute(sql`update fx_rate_age_policies set max_age_days=99 where org_id=${org.orgId} and id=${row.id}`),
      (error: unknown) => error instanceof Error
        && /policy history is preserved/.test(String(error.cause ?? error.message)),
    );
    assert.equal((await resolveFxRateAgeLimit(db,org.orgId,"closing","2026-07-31")).maxAgeDays,7);
  } finally { await dropScratchOrg(org.orgId); }
});
