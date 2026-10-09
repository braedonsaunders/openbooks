import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { withholdingRemittanceFx } from "./remittance-fx.ts";
import { saveWithholdingStanding, validateWithholdingEnrollment } from "./service.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test("a nonresident registered payer can enroll and derive its standing from the actual active enrollment", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try { await withOrgContext(org.orgId, async () => {
    const actor = await createScratchUser(org.orgId, "Withholding administrator", "admin");
    await db.execute(sql`update app_roles set permissions='["admin.setup.manage"]'::jsonb where org_id=${org.orgId} and key='admin'`);
    await db.execute(sql`insert into vendor_roles(org_id,party_id) values(${org.orgId},${org.vendorId})`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"contractorWithholding":true}'::jsonb) where id=${org.orgId}`);
    await validateWithholdingEnrollment(db, org.orgId, {
      subsidiaryId: org.subsidiaryId, schemeCode: "GB_CIS", liabilityAccountId: org.accounts.withholding,
      authorityPartyId: org.vendorId, thresholdBasis: null,
    });
    await db.execute(sql`insert into withholding_enrollments(org_id,subsidiary_id,scheme_code,contractor_reference,liability_account_id,effective_from,created_by,updated_by)
      values(${org.orgId},${org.subsidiaryId},'GB_CIS','123PA00000000',${org.accounts.withholding},'2007-04-06',${actor},${actor})`);
    const standing = await saveWithholdingStanding(db, org.orgId, {
      partyId: org.vendorId, schemeCode: "GB_CIS", bandCode: "NET", verificationReference: "V1234567890", validFrom: "2026-05-01",
    }, actor);
    const row = (await db.execute<{ subsidiary_id: string }>(sql`select subsidiary_id from withholding_standings where org_id=${org.orgId} and id=${standing.id}`)).rows[0];
    assert.equal(row?.subsidiary_id, org.subsidiaryId);
    const inactive = randomUUID();
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active) values(${inactive},${org.orgId},${org.subsidiaryId},'Inactive payer','CAD','CA',false)`);
    await assert.rejects(() => validateWithholdingEnrollment(db, org.orgId, {
      subsidiaryId: inactive, schemeCode: "GB_CIS", liabilityAccountId: org.accounts.withholding,
      authorityPartyId: org.vendorId, thresholdBasis: null,
    }), /legal entity not found/);
  }); } finally { await dropScratchOrg(org.orgId); }
});

test("statutory-to-functional conversion captures the native exact quote and source without using future rates", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try { await withOrgContext(org.orgId, async () => {
    const quoteId = randomUUID();
    await db.execute(sql`insert into fx_rates(id,org_id,from_currency,to_currency,as_of,rate_type,rate,source)
      values(${quoteId},${org.orgId},'CAD','GBP','2026-05-01','spot','0.8','manual'),
            (${randomUUID()},${org.orgId},'GBP','CAD','2026-05-03','spot','9','manual')`);
    const inverse = await withholdingRemittanceFx(db, org.orgId, org.subsidiaryId, "GBP", "2026-05-02");
    assert.equal(inverse.rate, "1.2500000000");
    assert.equal(inverse.from, "GBP");
    assert.equal(inverse.to, "CAD");
    assert.equal(inverse.asOf, "2026-05-02");
    assert.deepEqual(inverse.observations.map(row => [row.id, row.asOf, row.source, row.direction]), [[quoteId, "2026-05-01", "manual", "inverse"]]);
    const directId = randomUUID();
    await db.execute(sql`insert into fx_rates(id,org_id,from_currency,to_currency,as_of,rate_type,rate,source)
      values(${directId},${org.orgId},'GBP','CAD','2026-05-01','spot','1.2345678901','manual')`);
    const direct = await withholdingRemittanceFx(db, org.orgId, org.subsidiaryId, "GBP", "2026-05-02");
    assert.equal(direct.rate, "1.2345678901");
    assert.equal(direct.observations[0]?.id, directId);
    assert.equal(direct.observations[0]?.direction, "direct");
    assert.notEqual(direct.digest, inverse.digest);
  }); } finally { await dropScratchOrg(org.orgId); }
});

test("missing conversion refuses explicitly while same-currency par requires no rate and entity isolation remains enforced", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const other = await createScratchOrg();
  try { await withOrgContext(org.orgId, async () => {
    await assert.rejects(() => withholdingRemittanceFx(db, org.orgId, org.subsidiaryId, "GBP", "2026-05-02"),
      (error: unknown) => /No stored GBP/.test(String(error)) && String((error as { remedy?: string }).remedy).includes("Setup → Exchange Rates"));
    const par = await withholdingRemittanceFx(db, org.orgId, org.subsidiaryId, "CAD", "2026-05-02");
    assert.equal(par.rate, "1");
    assert.equal(par.sameCurrencyPar, true);
    assert.deepEqual(par.observations, []);
    await assert.rejects(() => withholdingRemittanceFx(db, org.orgId, other.subsidiaryId, "CAD", "2026-05-02"), /legal entity must remain active/);
    const inactive = randomUUID();
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active) values(${inactive},${org.orgId},${org.subsidiaryId},'Inactive payer','CAD','CA',false)`);
    await assert.rejects(() => withholdingRemittanceFx(db, org.orgId, inactive, "CAD", "2026-05-02"), /legal entity must remain active/);
  }); } finally { await dropScratchOrg(org.orgId); await dropScratchOrg(other.orgId); }
});
