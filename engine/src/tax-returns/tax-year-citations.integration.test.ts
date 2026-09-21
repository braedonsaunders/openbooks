import assert from "node:assert/strict";
import { inspect } from "node:util";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";

/**
 * A database refusal raised by a trigger arrives wrapped: Drizzle's
 * `Failed query: ...` is the message, and the trigger's own text -- the thing
 * worth asserting -- sits on the cause. assert.rejects(fn, /re/) only ever
 * reads the top message, so it fails precisely when the guard WORKED. Match
 * against the whole error object instead.
 */
const rejectsWith = (pattern: RegExp) => (error: unknown): boolean =>
  pattern.test(inspect(error, { depth: 6, breakLength: Infinity }));
import { db, withBypassContext, withOrg, withOrgContext } from "../platform/db.ts";
import { completeFinancialChange, proposeFinancialChange } from "../platform/financial-changes.ts";
import { submitFinancialChange } from "../flows/financial-changes-adapter.ts";
import { decideGate } from "../flows/gates.ts";
import { lockAssetTaxLifecycle } from "../organization/asset-tax-fence.ts";
import { createScratchOrg, dropScratchOrg, seedApprovalFlow, seedFlowActors, type ScratchOrg } from "../testing/fixtures.ts";
import {
  citeTaxYearWindows, insertTaxYearWindow, lockTaxYearWindowWrite,
  taxYearWindowDeleteProblem, taxYearWindowEvidence, taxYearWindowWriteProblem,
  type TaxYearWindowEvidence,
} from "./macrs-calendar.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
type Fixture = {
  org: ScratchOrg; actorId: string; assetId: string; sourceEventId: string;
  changeId: string; evidence: TaxYearWindowEvidence[];
  facts: Record<string, unknown>; computed: Record<string, unknown>;
};
const assessment = "Freeze the independently approved statutory calendar read set";

/** Storage contract fixture, not an arithmetic proof. Approval uses real Flows;
 * no status is forged and no production validator or database guard is mocked. */
async function fixture(work: (fixture: Fixture) => Promise<void>) {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withOrgContext(org.orgId, async () => {
      const actors = await seedFlowActors(org.orgId);
      await seedApprovalFlow(org.orgId, {
        subjectKind: "financial_change", assignees: [{ type: "user", userId: actors.approver1Id }],
        mode: "any", preventSelfApproval: true,
      });
      const categoryId = randomUUID(), assetId = randomUUID(), sourceEventId = randomUUID();
      await db.execute(sql`
        insert into asset_categories(id,org_id,name,asset_account_id,
          accumulated_depreciation_account_id,depreciation_expense_account_id,default_method)
        values(${categoryId},${org.orgId},'Citation fixture',${org.accounts.invAsset},
          ${org.accounts.clearing},${org.accounts.adjustment},'straight_line')`);
      await db.execute(sql`
        insert into fixed_assets(id,org_id,subsidiary_id,category_id,asset_number,name,status,
          acquired_on,in_service_on,acquisition_cost,created_by,updated_by)
        values(${assetId},${org.orgId},${org.subsidiaryId},${categoryId},${`CITE-${assetId}`},
          'Citation fixture','disposed','2026-01-01','2026-01-01',3000,${actors.submitterId},${actors.submitterId})`);
      await db.execute(sql`
        insert into asset_events(id,org_id,asset_id,kind,occurred_on,amount,created_by,updated_by)
        values(${sourceEventId},${org.orgId},${assetId},'disposed','2026-07-01',600,
          ${actors.submitterId},${actors.submitterId})`);
      const evidence: TaxYearWindowEvidence[] = [];
      for (const [yearStart, yearEnd] of [["2026-01-01", "2026-06-30"], ["2026-07-01", "2026-12-31"]]) {
        evidence.push(taxYearWindowEvidence(await insertTaxYearWindow(db, org.orgId, actors.submitterId, {
          subsidiaryId: org.subsidiaryId, regime: "us_macrs", yearStart, yearEnd,
          filingYear: 2026, reason: "Approved statutory short-year calendar",
        })));
      }
      const facts = { regime: "us_macrs", statutoryProceeds: "600.00" };
      const computed = { amountRealized: "600.00", remainingUnadjustedBasis: "0.00", taxYearWindows: evidence };
      const changeId = await withOrg(org.orgId, () => proposeFinancialChange(db, {
        orgId: org.orgId, subsidiaryId: org.subsidiaryId, domain: "asset", subjectId: assetId,
        operation: "tax_basis", effectiveOn: "2026-07-01", reason: assessment,
        actorId: actors.submitterId, idempotencyKey: randomUUID(),
        payload: {
          assessment, sourceOperation: "partial_disposal", effectiveOn: "2026-07-01",
          sourceChangeId: null, sourceEventId, receivingAssetId: null, sellerAssetId: assetId,
          requiredSubsidiaryIds: [org.subsidiaryId], applicable: { us_macrs: "seller" },
          regimes: [facts], computed: { us_macrs: computed },
        },
        beforeState: { preview: { regimes: { us_macrs: computed } } },
      }));
      await submitFinancialChange(org.orgId, changeId, actors.submitterId);
      const gate = (await db.execute<{ id: string }>(sql`
        select id from flow_gates where org_id=${org.orgId} and subject_id=${changeId} and status='pending'`)).rows[0];
      assert.ok(gate, "the real approval flow must create a gate");
      await decideGate({ gateId: gate.id, userId: actors.approver1Id, decision: "approved" });
      await work({ org, actorId: actors.submitterId, assetId, sourceEventId, changeId, evidence, facts, computed });
    });
  } finally { await dropScratchOrg(org.orgId); }
}

async function insertPaper(f: Fixture): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into tax_asset_basis_workpapers(id,org_id,asset_id,change_id,source_event_id,
      effective_on,source_operation,applicable,regime,assessment,facts,computed,created_by)
    values(${id},${f.org.orgId},${f.assetId},${f.changeId},${f.sourceEventId},'2026-07-01',
      'partial_disposal','seller','us_macrs',${assessment},${JSON.stringify(f.facts)}::jsonb,
      ${JSON.stringify(f.computed)}::jsonb,${f.actorId})`);
  return id;
}

async function rawCitation(f: Fixture, paperId: string, evidence: TaxYearWindowEvidence) {
  await db.execute(sql`
    insert into tax_basis_window_citations(org_id,workpaper_id,tax_year_window_id,subsidiary_id,
      regime,year_start,year_end,filing_year,created_by)
    values(${f.org.orgId},${paperId},${evidence.id},${evidence.subsidiaryId},${evidence.regime},
      ${evidence.yearStart},${evidence.yearEnd},${evidence.filingYear},${f.actorId})`);
}

test("approved workpaper citations are exact, durable, and freeze dates without a pool result", { skip: !DB }, () => fixture(async (f) => {
  const paperId = await withOrg(f.org.orgId, async () => {
    await lockAssetTaxLifecycle(db, f.org.orgId, [f.org.subsidiaryId]);
    const id = await insertPaper(f);
    await citeTaxYearWindows(db, f.org.orgId, id, f.evidence);
    await completeFinancialChange(db, f.org.orgId, f.changeId, f.actorId, { workpaperId: id });
    return id;
  });
  const citations = (await db.execute<{ id: string }>(sql`
    select tax_year_window_id as id from tax_basis_window_citations
     where org_id=${f.org.orgId} and workpaper_id=${paperId} order by year_start`)).rows;
  assert.deepEqual(citations.map((row) => row.id), f.evidence.map((row) => row.id));
  assert.equal((await db.execute(sql`select id from tax_pool_periods where org_id=${f.org.orgId}`)).rows.length, 0);
  await withOrg(f.org.orgId, () => citeTaxYearWindows(db, f.org.orgId, paperId, [...f.evidence, f.evidence[0]!]));
  assert.equal((await db.execute(sql`
    select id from tax_basis_window_citations where org_id=${f.org.orgId} and workpaper_id=${paperId}`)).rows.length, 2);
  const first = f.evidence[0]!;
  assert.match(await taxYearWindowWriteProblem(db, f.org.orgId, {
    id: first.id, yearEnd: "2026-06-29", reason: "Attempt to reinterpret approved history",
  }) ?? "", /applied tax workpaper.*dates are frozen/);
  assert.match(await taxYearWindowDeleteProblem(db, f.org.orgId, first.id) ?? "", /cannot be deleted/);
  await assert.rejects(async () => { await db.execute(sql`
    update tax_year_windows set filing_year=2025 where org_id=${f.org.orgId} and id=${first.id}`); }, rejectsWith(/filing label.*frozen/));
  await assert.rejects(async () => { await db.execute(sql`
    delete from tax_year_windows where org_id=${f.org.orgId} and id=${first.id}`); }, rejectsWith(/cannot be deleted/));
  await assert.rejects(async () => { await db.execute(sql`
    update tax_basis_window_citations set filing_year=2025 where org_id=${f.org.orgId} and workpaper_id=${paperId}`); }, rejectsWith(/cannot be rewritten/));
  await assert.rejects(async () => { await db.execute(sql`
    delete from tax_basis_window_citations where org_id=${f.org.orgId} and workpaper_id=${paperId}`); }, rejectsWith(/cannot be deleted/));
  await withOrgContext(randomUUID(), async () => {
    assert.equal((await db.execute(sql`select id from tax_basis_window_citations where workpaper_id=${paperId}`)).rows.length, 0);
  });
}));

test("omitted or partial citation sets abort the entire applying transaction at commit", { skip: !DB }, () => fixture(async (f) => {
  for (const partial of [false, true]) {
    await assert.rejects(withOrg(f.org.orgId, async () => {
      const id = await insertPaper(f);
      if (partial) await rawCitation(f, id, f.evidence[0]!);
      await completeFinancialChange(db, f.org.orgId, f.changeId, f.actorId, { workpaperId: id });
    }), rejectsWith(/missing its approved tax-year citations/));
    assert.equal((await db.execute(sql`
      select id from tax_asset_basis_workpapers where org_id=${f.org.orgId} and change_id=${f.changeId}`)).rows.length, 0);
    assert.equal((await db.execute<{ status: string }>(sql`
      select status from financial_changes where org_id=${f.org.orgId} and id=${f.changeId}`)).rows[0]!.status, "approved");
  }
}));

test("a citation cannot substitute live dates or a different approved read set", { skip: !DB }, () => fixture(async (f) => {
  await assert.rejects(withOrg(f.org.orgId, async () => {
    const id = await insertPaper(f);
    await rawCitation(f, id, { ...f.evidence[0]!, yearEnd: "2026-06-29" });
  }), rejectsWith(/does not match the registered identity and dates/));
  await assert.rejects(withOrg(f.org.orgId, async () => {
    const id = await insertPaper(f);
    await citeTaxYearWindows(db, f.org.orgId, id, [f.evidence[0]!]);
  }), rejectsWith(/do not match the independently approved workpaper/));
  await assert.rejects(withOrg(f.org.orgId, async () => {
    const id = await insertPaper(f);
    await db.execute(sql`update tax_year_windows set year_end='2026-06-29'
      where org_id=${f.org.orgId} and id=${f.evidence[0]!.id}`);
    await citeTaxYearWindows(db, f.org.orgId, id, f.evidence);
  }), rejectsWith(/changed after workpaper approval/));
}));

test("setup publication takes the same legal-entity fence as workpaper application", { skip: !DB }, () => fixture(async (f) => {
  await withOrg(f.org.orgId, async () => {
    await lockTaxYearWindowWrite(db, f.org.orgId, { id: f.evidence[0]!.id });
    // A separate scoped connection must observe the SAME lock as unavailable.
    // No timer or raced assertion is needed to prove the shared fence identity.
    await withOrgContext(f.org.orgId, () => withOrg(f.org.orgId, async () => {
      const row = (await db.execute<{ acquired: boolean }>(sql`
        select pg_try_advisory_xact_lock(hashtextextended(
          ${`asset-tax-lifecycle:${f.org.orgId}:${f.org.subsidiaryId}`},0)) as acquired`)).rows[0];
      assert.equal(row?.acquired, false);
    }));
  });
}));
