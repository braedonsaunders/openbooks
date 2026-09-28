import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { REPORT_ENTITY_MAP } from "@openbooks/reports";
import { installEngineSeams } from "../composition/install.ts";
import { clearBalancingLegProviders } from "../journal/balancing-hooks.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { postEntry } from "../journal/post-entry.ts";
import { db, withBypass, withBypassContext, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { installTaxReturnPacks } from "../tax/seed-tax-forms.ts";
import { ensureReportDefinitions } from "../reports/ensure-report-definitions.ts";
import { createFund, setFundPair } from "./funds.ts";
import { createGift, postGift, receiptGift } from "./gifts.ts";
import { createFundRelease, submitFundRelease } from "./releases.ts";
import { setFunctionalMapping } from "./functional.ts";
import { setFramework } from "./frameworks.ts";
import { provisionFundAccounting } from "./provision.ts";
import { activateGrant, awardGrant, createGrant, createGrantDrawdown, type GrantPostingAccounts } from "./grants.ts";
import { createPledge, runPledgeDiscountAmortization } from "./pledges.ts";
import { budgetaryControlWarnings, createEncumbrance } from "./encumbrances.ts";
import { computeForm990Workpaper } from "./form990.ts";
import { filterTaxReturnFormsByFeatures } from "../tax-returns/return.ts";
import { loadNonprofitStatements } from "./statements.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("nonprofit feature switches preserve saved records and statements", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Feature Controller", "admin"));
    installEngineSeams();
    await withOrgContext(org.orgId, async () => {
      const saved = await db.execute<{ id: string }>(sql`update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',coalesce(settings->'features','{}'::jsonb)||'{"nonprofit":true,"fundAccounting":true,"grantManagement":true,"pledges":true,"encumbrances":true,"budgets":true,"functionalExpenses":true,"form990":true}'::jsonb,true) where id=${org.orgId} returning id`);
      assert.equal(saved.rows.length, 1);
    });
    const funds = await provisionFundAccounting({ orgId: org.orgId, defaultFund: { code: "OPERATING", name: "Operating" }, classifications: { OPERATING: { kind: "operating", restrictionClass: "without_donor_restrictions" } }, actorId });
    const restricted = await createFund({ orgId: org.orgId, code: "RESTRICTED", name: "Restricted", kind: "restricted", restrictionClass: "with_donor_restrictions", actorId });
    await setFundPair({ orgId: org.orgId, fromFundId: funds.defaultFundId, toFundId: restricted.id, dueFromAccountId: org.accounts.ar, dueToAccountId: org.accounts.ap, actorId, reason: "Settle interfund balances for feature-fence postings" });
    await setFramework({ orgId: org.orgId, framework: "us_asc958", actorId, reason: "Prepare nonprofit statements" });
    const departmentId = randomUUID();
    await withOrgContext(org.orgId, () => db.execute(sql`insert into departments (id,org_id,name,is_active,custom) values (${departmentId},${org.orgId},'Programs',true,'{}'::jsonb)`));
    await setFunctionalMapping({ orgId: org.orgId, departmentId, functionKey: "program", effectiveFrom: org.date, actorId, reason: "Classify program expense" });
    const gift = await createGift({ orgId: org.orgId, subsidiaryId: org.subsidiaryId, donorPartyId: org.customerId, fundId: restricted.id, amount: "100.0000", kind: "cash", receivedOn: org.date, reason: "Record restricted support", actorId });
    await receiptGift({ orgId: org.orgId, giftId: gift.id, actorId, reason: "Issue contribution receipt" });
    const giftPost = await postGift({ orgId: org.orgId, giftId: gift.id, postingDate: org.date, debitAccountId: org.accounts.bank, contributionsAccountId: org.accounts.revenue, actorId, reason: "Post restricted contribution" });
    const release = await createFundRelease({ orgId: org.orgId, fromFundId: restricted.id, toFundId: funds.defaultFundId, releaseAccountId: org.accounts.revenue, releaseDate: org.date, amount: "10.0000", purpose: "Meet program costs", satisfactionRef: "Program costs incurred", actorId });
    await submitFundRelease({ orgId: org.orgId, releaseId: release.id, actorId });
    const group = await withOrgContext(org.orgId, async () => {
      const row = await db.execute<{ id: string }>(sql`insert into account_groups (org_id,dimension,key,name,match,is_catch_all,is_active,created_by,updated_by) values (${org.orgId},'grant_allowable_costs','costs','Allowable costs','{}'::jsonb,false,true,${actorId},${actorId}) returning id`);
      assert.equal(row.rows.length, 1);
      await db.execute(sql`insert into account_group_members (org_id,group_id,account_id,dimension,created_by,updated_by) values (${org.orgId},${row.rows[0]!.id},${org.accounts.cogs},'grant_allowable_costs',${actorId},${actorId})`);
      return row.rows[0]!.id;
    });
    const grant = await createGrant({ orgId: org.orgId, code: "AWARD", name: "Program award", sponsorPartyId: org.customerId, sponsorKind: "foundation", determination: "contribution_unconditional", awardAmount: "40.0000", periodFrom: "2026-01-01", periodTo: "2026-12-31", fundId: restricted.id, allowableAccountGroupId: group, actorId });
    const grantAccounts: GrantPostingAccounts = { bankAccountId: org.accounts.bank, grantsReceivableAccountId: org.accounts.ar, refundableAdvanceAccountId: org.accounts.ap, grantRevenueAccountId: org.accounts.revenue, exchangeReceivableAccountId: org.accounts.ar, exchangeRevenueAccountId: org.accounts.revenue };
    const award = await awardGrant({ orgId: org.orgId, grantId: grant.id, accounts: grantAccounts, postingDate: org.date, actorId });
    await activateGrant({ orgId: org.orgId, grantId: grant.id, actorId });
    await createGrantDrawdown({ orgId: org.orgId, grantId: grant.id, amount: "10.0000", kind: "advance", actorId });
    const pledge = await createPledge({ orgId: org.orgId, subsidiaryId: org.subsidiaryId, donorPartyId: org.customerId, fundId: restricted.id, totalAmount: "20.0000", discountRate: "0", installments: [{ dueOn: "2027-01-01", amount: "20.0000" }], reason: "Record promised support", actorId });
    const commitment = await createEncumbrance({ orgId: org.orgId, accountId: org.accounts.cogs, subsidiaryId: org.subsidiaryId, sourceKind: "manual", amount: "5.0000", extraDims: { fund: funds.defaultFundId }, actorId });
    await withOrgTransaction(org.orgId, () => postEntry(db, { orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId, entryNumber: `COST-${randomUUID()}`, postingDate: org.date, periodId: org.periodId, currency: "CAD", actorId, origin: "journal", lines: [{ accountId: org.accounts.cogs, amount: "3.0000", departmentId, extraDims: { fund: funds.defaultFundId } }, { accountId: org.accounts.bank, amount: "-3.0000", extraDims: { fund: funds.defaultFundId } }] }));
    await withBypassContext(() => installTaxReturnPacks(org.orgId, ["US_990"], actorId));
    await ensureReportDefinitions(org.orgId);
    const forms = await withOrgContext(org.orgId, async () => (await db.execute<{ code: string }>(sql`select code from tax_return_forms where org_id=${org.orgId} and is_active order by code`)).rows);
    const statements = () => loadNonprofitStatements({ orgId: org.orgId, asOf: org.date, periodFrom: "2026-01-01", periodTo: org.date });
    const snapshot = async () => withOrgContext(org.orgId, async () => (await db.execute<{ data: unknown }>(sql`
      select jsonb_build_object(
        'funds',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from (select * from funds where org_id=${org.orgId}) x),
        'gifts',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from (select * from gifts where org_id=${org.orgId}) x),
        'releases',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from (select * from fund_releases where org_id=${org.orgId}) x),
        'grants',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from (select * from grants where org_id=${org.orgId}) x),
        'drawdowns',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from (select * from grant_drawdowns where org_id=${org.orgId}) x),
        'pledges',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from (select * from pledges where org_id=${org.orgId}) x),
        'installments',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from (select * from pledge_installments where org_id=${org.orgId}) x),
        'encumbrances',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from (select * from encumbrances where org_id=${org.orgId}) x),
        'entries',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from (select * from journal_entries where org_id=${org.orgId}) x),
        'lines',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from (select * from journal_lines where org_id=${org.orgId}) x),
        'reports',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from (select * from report_definitions where org_id=${org.orgId} and slug in ('statement-of-financial-position','statement-of-activities','functional-expense-matrix','cash-flow-reconciliation','grant-pipeline')) x),
        'frameworks',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from (select * from nonprofit_frameworks where org_id=${org.orgId}) x),
        'pairs',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from (select * from fund_pairs where org_id=${org.orgId}) x),
        'mappings',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from (select * from functional_mappings where org_id=${org.orgId}) x)
      ) as data`)).rows[0]?.data);
    const before = await snapshot();
    const beforeStatements = await statements();
    const refusal = (key: string) => (error: unknown) => error instanceof Error &&
      (error as Error & { code?: string; remedy?: string }).code === "feature_off" &&
      error.message.includes(key) && Boolean((error as Error & { remedy?: string }).remedy?.includes("Company Settings → Features"));
    const cases = [
      ["fundAccounting", () => createFund({ orgId: org.orgId, code: "OFF", name: "Off", kind: "operating", restrictionClass: "without_donor_restrictions", actorId })],
      ["fundAccounting", () => setFramework({ orgId: org.orgId, framework: "us_asc958", actorId, reason: "Confirm restriction framework" })],
      ["fundAccounting", () => setFundPair({ orgId: org.orgId, fromFundId: funds.defaultFundId, toFundId: restricted.id, dueFromAccountId: org.accounts.ar, dueToAccountId: org.accounts.ap, actorId, reason: "Configure interfund settlement accounts" })],
      ["grantManagement", () => createGrant({ orgId: org.orgId, code: "OFF", name: "Off", sponsorPartyId: org.customerId, sponsorKind: "foundation", determination: "contribution_unconditional", awardAmount: "1.0000", periodFrom: "2026-01-01", periodTo: "2026-12-31", fundId: restricted.id, allowableAccountGroupId: group, actorId })],
      ["pledges", () => createPledge({ orgId: org.orgId, subsidiaryId: org.subsidiaryId, donorPartyId: org.customerId, fundId: restricted.id, totalAmount: "1.0000", discountRate: "0", installments: [{ dueOn: "2027-01-01", amount: "1.0000" }], reason: "Record promised support", actorId })],
      ["encumbrances", () => createEncumbrance({ orgId: org.orgId, accountId: org.accounts.cogs, subsidiaryId: org.subsidiaryId, sourceKind: "manual", amount: "1.0000", actorId })],
      ["functionalExpenses", async () => loadNonprofitStatements({ orgId: org.orgId, asOf: org.date, periodFrom: "2026-01-01", periodTo: org.date })],
      ["functionalExpenses", () => setFunctionalMapping({ orgId: org.orgId, departmentId, functionKey: "program", effectiveFrom: org.date, actorId, reason: "Classify program expense" })],
      ["form990", () => computeForm990Workpaper(org.orgId, org.date, org.date)],
    ] as const;
    for (const [key, attempt] of cases) {
      const changed = await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`update orgs set settings=jsonb_set(settings,'{features}',settings->'features'||jsonb_build_object(${key}::text,false),true) where id=${org.orgId} returning id`));
      assert.equal(changed.rows.length, 1);
      await assert.rejects(attempt(), refusal(key));
      if (key === "form990") assert.deepEqual(await withOrgContext(org.orgId, () => filterTaxReturnFormsByFeatures(org.orgId, forms, db)), []);
      if (key === "fundAccounting" || key === "functionalExpenses" || key === "grantManagement") {
        const definitions = await withOrgContext(org.orgId, () => db.execute<{ query: { entity?: string } | null }>(sql`select query from report_definitions where org_id=${org.orgId} and slug in ('statement-of-financial-position','statement-of-activities','functional-expense-matrix','cash-flow-reconciliation','grant-pipeline') order by slug`));
        const gated = definitions.rows.map((row) => REPORT_ENTITY_MAP[row.query?.entity ?? ""]?.featureKey).filter((feature) => feature === key);
        assert.ok(gated.length, `${key} must hide its nonprofit built-ins`);
        for (const feature of gated) assert.equal(await orgFeatureEnabled(org.orgId, feature!), false);
      }
      if (key === "pledges") {
        const duty = await runPledgeDiscountAmortization({ orgId: org.orgId, periodEnd: org.date, discountAccountId: org.accounts.adjustment, contributionsAccountId: org.accounts.revenue, actorId });
        assert.equal(duty.posted, 0); assert.match(duty.reason ?? "", /pledges.*Company Settings → Features/);
      }
      if (key === "fundAccounting") await assert.rejects(withOrgTransaction(org.orgId, () => postEntry(db, { orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId, entryNumber: `OFF-${randomUUID()}`, postingDate: org.date, periodId: org.periodId, currency: "CAD", actorId, origin: "journal", lines: [{ accountId: org.accounts.bank, amount: "1.0000", extraDims: { fund: restricted.id } }, { accountId: org.accounts.revenue, amount: "-1.0000", extraDims: { fund: restricted.id } }] })), refusal("fundAccounting"));
      if (key === "encumbrances") assert.deepEqual(await withOrgContext(org.orgId, () => budgetaryControlWarnings(db, org.orgId, giftPost.entryId)), []);
      const restored = await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`update orgs set settings=jsonb_set(settings,'{features}',settings->'features'||jsonb_build_object(${key}::text,true),true) where id=${org.orgId} returning id`));
      assert.equal(restored.rows.length, 1);
      assert.deepEqual(await snapshot(), before, `${key} changed stored nonprofit or journal data`);
      assert.deepEqual(await statements(), beforeStatements, `${key} changed nonprofit statement figures`);
    }
    const parentDisabled = await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`update orgs set settings=jsonb_set(settings,'{features}',settings->'features'||'{"nonprofit":false,"form990":true,"pledges":true}'::jsonb,true) where id=${org.orgId} returning id`));
    assert.equal(parentDisabled.rows.length, 1);
    assert.equal(await orgFeatureEnabled(org.orgId, "form990"), false);
    assert.equal(await orgFeatureEnabled(org.orgId, "pledges"), false);
    await assert.rejects(computeForm990Workpaper(org.orgId, org.date, org.date), refusal("form990"));
    assert.ok(award.entryId && pledge.id && commitment.id);
  } finally {
    clearBalancingLegProviders();
    await dropScratchOrg(org.orgId);
  }
});
