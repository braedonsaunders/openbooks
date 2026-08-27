import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { isZero, sum } from "./money.ts";
import {
  IncomeTaxProvisionError,
  buildProvision,
  computeProvisionRun,
  consolidateEntityResults,
  detectProvisionSourceDrift,
  getProvisionRun,
  postProvisionRun,
  provisionEntryNumber,
  provisionReversalEntryNumber,
  stackEnactedRateComponents,
} from "./income-tax-provision.ts";
import type {
  EntityProvisionResult,
  ProvisionSourceSnapshot,
} from "./income-tax-provision.ts";
import { postDocument } from "./posting.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";
import {
  TaxFilingError,
  buildTaxFilingSnapshot,
  markTaxFilingFiled,
} from "./tax-filing.ts";
import { computeTaxReturn } from "./tax-return.ts";
import { BUILT_IN_ROLES, PERMISSION_CATALOGUE, permissionSetCovers } from "./permissions.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * End-to-end ASC 740: enacted rate + pretax income from the ledger → compute →
 * post through the kernel (origin tax_provision) → repost reverses and
 * supersedes cleanly.
 */
test(
  "income tax provision computes, posts, and reposts with reversal",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const userId = await createScratchUser(org.orgId, "Tax Tester", "admin");

      // Income-tax accounts + control mapping.
      const mk = async (number: string, name: string, type: string) => {
        const id = randomUUID();
        await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (${id}, ${org.orgId}, ${number}, ${name}, ${type}, false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
        return id;
      };
      const [expense, payable, dta, dtl, va] = await Promise.all([
        mk("6100", "Income Tax Expense", "expense"),
        mk("2110", "Income Tax Payable", "liability_current_other"),
        mk("1410", "Deferred Tax Assets", "asset_current_other"),
        mk("2410", "Deferred Tax Liabilities", "liability_long_term"),
        mk("1415", "Valuation Allowance", "asset_current_other"),
      ]);
      await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{controlAccounts}',
        coalesce(settings->'controlAccounts', '{}'::jsonb) ||
        ${JSON.stringify({
          incomeTaxExpense: expense,
          incomeTaxPayable: payable,
          deferredTaxAsset: dta,
          deferredTaxLiability: dtl,
          valuationAllowance: va,
        })}::jsonb)
      where id = ${org.orgId}`);

      // Enacted rate: 26.5% federal, org-wide.
      await db.execute(sql`
      insert into income_tax_rates (org_id, jurisdiction, rate_percent, effective_from, created_by, updated_by)
      values (${org.orgId}, 'Federal', '26.5', '2020-01-01', ${userId}, ${userId})`);

      // $1,000,000 of pretax income in FY2026: one posted invoice.
      const invoiceId = randomUUID();
      await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'approved', 'INV-TAX-1',
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
              '1000000', '0', '1000000', ${userId})`);
      await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '1000000', '1000000', '0', '0')`);
      await postDocument(invoiceId, {
        control: {
          ar: org.accounts.ar,
          ap: org.accounts.ap,
          bank: org.accounts.bank,
        },
      });

      // Compute: DTL 200,000 taxable diff, DTA −80,000 deductible diff, VA 10,000.
      const runId = await computeProvisionRun(
        org.orgId,
        2026,
        {
          permanentDifferences: [],
          valuationAllowance: "10000",
          additionalDifferences: [
            {
              category: "fixed_assets",
              description: "P&E book vs tax",
              difference: "200000",
              source: "manual",
            },
            {
              category: "provisions",
              description: "Accrued warranty",
              difference: "-80000",
              source: "manual",
            },
          ],
        },
        userId,
      );
      const run = await getProvisionRun(org.orgId, runId);
      assert.ok(run);
      const payload = run.payload as {
        pretaxBookIncome: string;
        currentTax: string;
        totalExpense: string;
        effectiveRatePercent: string;
      };
      assert.equal(payload.pretaxBookIncome, "1000000.0000");
      // Originating net taxable difference 120,000 → taxable profit 880,000,
      // current tax 233,200. Pure timing cancels in the total, so total =
      // statutory 265,000 + 10,000 valuation allowance = 275,000.
      assert.equal(payload.currentTax, "233200.0000");
      assert.equal(payload.totalExpense, "275000.0000");
      assert.equal(payload.effectiveRatePercent, "27.50");
      assert.equal(run.differences.length, 2);

      // Post through the kernel.
      const { entryId } = await postProvisionRun(org.orgId, runId, userId);
      const entry = (await db.execute<{ status: string; origin: string }>(sql`
      select status, origin from journal_entries where id = ${entryId}
    `));
      assert.equal(entry.rows[0]!.status, "posted");
      assert.equal(entry.rows[0]!.origin, "tax_provision");
      const lines = (await db.execute<{ account_id: string; amount: string }>(sql`
      select account_id, amount from journal_lines where entry_id = ${entryId} order by line_number
    `));
      const byAccount = new Map(
        lines.rows.map((l) => [l.account_id, l.amount]),
      );
      assert.equal(byAccount.get(payable), "-233200.0000");
      assert.equal(byAccount.get(dta), "21200.0000");
      assert.equal(byAccount.get(dtl), "-53000.0000");
      assert.equal(byAccount.get(va), "-10000.0000");
      assert.equal(byAccount.get(expense), "275000.0000");
      assert.equal(
        isZero(sum(lines.rows.map((line) => line.amount))),
        true,
        "provision journal balances",
      );
      const posted = await getProvisionRun(org.orgId, runId);
      assert.equal(posted?.status, "posted");

      // Repost the FY: reverse + supersede, exactly one live posted run remains.
      const runId2 = await computeProvisionRun(
        org.orgId,
        2026,
        {
          permanentDifferences: [],
          valuationAllowance: "10000",
          additionalDifferences: [
            {
              category: "fixed_assets",
              description: "P&E book vs tax",
              difference: "300000",
              source: "manual",
            },
            {
              category: "provisions",
              description: "Accrued warranty",
              difference: "-80000",
              source: "manual",
            },
          ],
        },
        userId,
      );
      const { entryId: entryId2 } = await postProvisionRun(
        org.orgId,
        runId2,
        userId,
      );
      const states = (await db.execute<{ status: string; n: number }>(sql`
      select status, count(*)::int as n from tax_provision_runs
       where org_id = ${org.orgId} and fiscal_year = 2026 group by status
    `));
      const byStatus = new Map(states.rows.map((r) => [r.status, r.n]));
      assert.equal(byStatus.get("posted"), 1);
      assert.equal(byStatus.get("superseded"), 1);
      const reversal = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries
       where org_id = ${org.orgId} and origin = 'tax_provision' and reverses_entry_id = ${entryId}
    `));
      assert.equal(
        reversal.rows[0]!.n,
        1,
        "repost reversed the superseded entry",
      );

      // The DTL movement between the two runs (53,000 → 79,500) shows in entry 2.
      const dtlLine = (await db.execute<{ amount: string }>(sql`
      select amount from journal_lines where entry_id = ${entryId2} and account_id = ${dtl}
    `));
      assert.equal(dtlLine.rows[0]!.amount, "-79500.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

// ---------------------------------------------------------------------------
// Shared fixtures for the defect-regression cases below.
// ---------------------------------------------------------------------------

type TaxControlAccounts = Record<"expense" | "payable" | "dta" | "dtl" | "va", string>;

async function seedTaxControlAccounts(orgId: string): Promise<TaxControlAccounts> {
  const mk = async (number: string, name: string, type: string) => {
    const id = randomUUID();
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${id}, ${orgId}, ${number}, ${name}, ${type}, false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
    return id;
  };
  const accounts: TaxControlAccounts = {
    expense: await mk("6100", "Income Tax Expense", "expense"),
    payable: await mk("2110", "Income Tax Payable", "liability_current_other"),
    dta: await mk("1410", "Deferred Tax Assets", "asset_current_other"),
    dtl: await mk("2410", "Deferred Tax Liabilities", "liability_long_term"),
    va: await mk("1415", "Valuation Allowance", "asset_current_other"),
  };
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{controlAccounts}',
      coalesce(settings->'controlAccounts', '{}'::jsonb) ||
      ${JSON.stringify({
        incomeTaxExpense: accounts.expense,
        incomeTaxPayable: accounts.payable,
        deferredTaxAsset: accounts.dta,
        deferredTaxLiability: accounts.dtl,
        valuationAllowance: accounts.va,
      })}::jsonb)
    where id = ${orgId}`);
  return accounts;
}

async function seedEnactedRate(
  orgId: string,
  jurisdiction: string,
  ratePercent: string,
  opts: { subsidiaryId?: string; effectiveFrom?: string; userId: string } ,
): Promise<void> {
  await db.execute(sql`
    insert into income_tax_rates (org_id, jurisdiction, rate_percent, effective_from, subsidiary_id, created_by, updated_by)
    values (${orgId}, ${jurisdiction}, ${ratePercent}, ${opts.effectiveFrom ?? "2020-01-01"}, ${opts.subsidiaryId ?? null}, ${opts.userId}, ${opts.userId})`);
}

async function createSubsidiary(
  orgId: string,
  name: string,
  baseCurrency: string,
  parentId: string | null,
): Promise<string> {
  // CI loads the schema without the product seed; mirror the fixture's
  // defensive currency registration before referencing the code.
  await db.execute(sql`
    insert into currencies (code, name, minor_units)
    values (${baseCurrency}, ${baseCurrency}, 2)
    on conflict (code) do nothing`);
  const id = randomUUID();
  // subsidiaries_org_root enforces exactly one parentless row per org; the
  // scratch org fixture already created that root, so every test entity is
  // parented under it (or the caller's chosen node).
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${orgId}, ${parentId}, ${name}, ${baseCurrency}, 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  // The scratch customer's party record defaults to the root entity only;
  // grant it the new child so invoices may transact there — the same
  // entity-record requirement the posting boundary enforces. The row is
  // org-scoped to satisfy the tenant-coherence foreign keys.
  await db.execute(sql`
    insert into party_subsidiaries (id, org_id, party_id, subsidiary_id)
    select gen_random_uuid(), ${orgId}, p.id, ${id}
      from parties p
     where p.org_id = ${orgId} and p.kind = 'customer'
    on conflict do nothing`);
  return id;
}

async function postInvoice(
  org: ScratchOrg,
  opts: { subsidiaryId: string; amount: string; currency?: string; number: string; userId: string },
): Promise<void> {
  const invoiceId = randomUUID();
  const currency = opts.currency ?? "CAD";
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'approved', ${opts.number},
            ${opts.subsidiaryId}, ${org.customerId}, ${org.date}, ${currency}, '1',
            ${opts.amount}, '0', ${opts.amount}, ${opts.userId})`);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', ${opts.amount}, ${opts.amount}, '0', '0')`);
  await postDocument(invoiceId, {
    control: {
      ar: org.accounts.ar,
      ap: org.accounts.ap,
      bank: org.accounts.bank,
    },
  });
}

interface RunPayload {
  pretaxBookIncome: string;
  currentTax: string;
  totalExpense: string;
  effectiveRatePercent: string | null;
  entities: EntityProvisionResult[];
}

function payloadOf(run: { payload: Record<string, unknown> }): RunPayload {
  return run.payload as unknown as RunPayload;
}

// ---------------------------------------------------------------------------
// Pure units — the staleness fence, rate stacking and translation math are
// decision logic that must hold without a database.
// ---------------------------------------------------------------------------

test("enacted rate stacking adds org-wide and subsidiary jurisdictions and fails closed on ambiguity", () => {
  const blended = stackEnactedRateComponents([
    { jurisdiction: "State", ratePercent: "5.0000", scope: "subsidiary" },
    { jurisdiction: "Federal", ratePercent: "21.0000", scope: "org" },
  ]);
  assert.equal(blended.ratePercent, "26.0000");
  assert.deepEqual(blended.jurisdictions, ["Federal", "State"]);

  // A genuine 0% combined rate stays distinct from missing coverage.
  const zero = stackEnactedRateComponents([
    { jurisdiction: "Federal", ratePercent: "0", scope: "org" },
  ]);
  assert.equal(zero.ratePercent, "0.0000");

  // The same jurisdiction at both scopes is ambiguous — never guessed.
  assert.throws(
    () =>
      stackEnactedRateComponents([
        { jurisdiction: "Federal", ratePercent: "21", scope: "org" },
        { jurisdiction: "Federal", ratePercent: "18", scope: "subsidiary" },
      ]),
    IncomeTaxProvisionError,
  );
  assert.throws(
    () =>
      stackEnactedRateComponents([
        { jurisdiction: "Federal", ratePercent: "-3", scope: "org" },
      ]),
    IncomeTaxProvisionError,
  );
});

function lineageSnapshot(
  over: Partial<ProvisionSourceSnapshot> = {},
): ProvisionSourceSnapshot {
  return {
    framework: "asc740",
    pretaxBySubsidiaryId: { a: "100.0000" },
    fixedAssetDifferences: [],
    rateRows: [
      { jurisdiction: "Federal", ratePercent: "21.0000", subsidiaryId: null },
    ],
    priorPostedRunId: null,
    priorPostedSnapshotHash: null,
    priorBalancesBySubsidiaryId: {},
    ...over,
  };
}

test("source-lineage drift names exactly the section that changed", () => {
  assert.deepEqual(detectProvisionSourceDrift(lineageSnapshot(), lineageSnapshot()), []);
  assert.deepEqual(
    detectProvisionSourceDrift(
      lineageSnapshot(),
      lineageSnapshot({ pretaxBySubsidiaryId: { a: "150.0000" } }),
    ),
    ["pretax book income"],
  );
  assert.deepEqual(
    detectProvisionSourceDrift(
      lineageSnapshot(),
      lineageSnapshot({
        rateRows: [
          { jurisdiction: "Federal", ratePercent: "22.0000", subsidiaryId: null },
        ],
      }),
    ),
    ["enacted income tax rates"],
  );
  // Canonical ordering: identical rows captured in a different order are NOT
  // drift, so byte-equivalent worlds never force a spurious recompute.
  assert.deepEqual(
    detectProvisionSourceDrift(
      lineageSnapshot({
        fixedAssetDifferences: [
          { category: "fixed_assets", description: "A", difference: "1", source: "auto" },
          { category: "fixed_assets", description: "B", difference: "2", source: "auto" },
        ],
      }),
      lineageSnapshot({
        fixedAssetDifferences: [
          { category: "fixed_assets", description: "B", difference: "2", source: "auto" },
          { category: "fixed_assets", description: "A", difference: "1", source: "auto" },
        ],
      }),
    ),
    [],
  );
});

test("consolidation translates each entity before summing — never a raw unit sum", () => {
  const root: EntityProvisionResult = {
    subsidiaryId: "root",
    name: "Root",
    currency: "CAD",
    fxRate: "1",
    enactedRatePercent: "26.0000",
    enactedRateJurisdictions: ["Federal"],
    permanentDifferences: [],
    lossCarryforwardUsed: "0",
    valuationAllowance: "0",
    pretaxBookIncome: "200000.0000",
    computation: buildProvision({
      pretaxBookIncome: "200000.00",
      enactedRatePercent: "26",
      permanentDifferences: [],
      lossCarryforwardUsed: "0",
      valuationAllowance: "0",
      differences: [],
    }),
  };
  const usOps: EntityProvisionResult = {
    ...root,
    subsidiaryId: "us-ops",
    name: "US Ops",
    currency: "USD",
    fxRate: "1.25",
    enactedRatePercent: "21.0000",
    pretaxBookIncome: "100000.0000",
    computation: buildProvision({
      pretaxBookIncome: "100000.00",
      enactedRatePercent: "21",
      permanentDifferences: [],
      lossCarryforwardUsed: "0",
      valuationAllowance: "0",
      differences: [],
    }),
  };

  const consolidated = consolidateEntityResults([usOps, root]);
  // Raw unit sum would be 73,000; translation gives 52,000 + 21,000×1.25.
  assert.equal(consolidated.totalExpense, "78250.0000");
  assert.notEqual(consolidated.totalExpense, "73000.0000");
  assert.equal(consolidated.pretaxBookIncome, "325000.0000");
  assert.equal(consolidated.effectiveRatePercent, "24.07");
  // With no timing differences the merged reconciliation still lands on total.
  const statutory = consolidated.rateReconciliation.find((s) => s.key === "statutory")!;
  const total = consolidated.rateReconciliation.find((s) => s.key === "total")!;
  assert.equal(statutory.amount, consolidated.totalExpense);
  assert.equal(total.amount, consolidated.totalExpense);

  // Single-entity control: consolidation is the identity at fxRate 1.
  const alone = consolidateEntityResults([root]);
  assert.equal(alone.totalExpense, root.computation.totalExpense);
});

test("provision journal numbering is deterministic and collision-free through repeated same-year reposts", () => {
  const sub = randomUUID();
  const otherSub = randomUUID();
  const mains = [1, 2, 3].map((v) => provisionEntryNumber(2026, v, sub));
  const reversals = [1, 2, 3].map((v) => provisionReversalEntryNumber(2026, v, sub));
  assert.equal(new Set([...mains, ...reversals]).size, 6, "all six numbers distinct");
  for (const number of [...mains, ...reversals]) {
    // Deterministic: recomputing yields the identical string.
    const version = Number(number.match(/-v(\d+)-/)![1]!);
    const expected = number.startsWith("ITX-REV-")
      ? provisionReversalEntryNumber(2026, version, sub)
      : provisionEntryNumber(2026, version, sub);
    assert.equal(number, expected);
  }
  assert.notEqual(provisionEntryNumber(2026, 1, sub), provisionEntryNumber(2026, 1, otherSub));
});

// ---------------------------------------------------------------------------
// DB-backed regression cases (one per defect, plus unchanged-input controls).
// ---------------------------------------------------------------------------

test("posting refuses a stale draft after ledger activity changes and zero rows are written", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Stale Tester", "admin");
    await seedTaxControlAccounts(org.orgId);
    await seedEnactedRate(org.orgId, "Federal", "26.5", { userId });
    await postInvoice(org, { subsidiaryId: org.subsidiaryId, amount: "1000000", number: "INV-STALE-1", userId });

    const draftId = await computeProvisionRun(org.orgId, 2026, {}, userId);

    // The ledger moves AFTER the draft was reviewed.
    await postInvoice(org, { subsidiaryId: org.subsidiaryId, amount: "500000", number: "INV-STALE-2", userId });

    await assert.rejects(
      () => postProvisionRun(org.orgId, draftId, userId),
      /stale.*pretax book income/s,
    );
    // Zero journal/status writes happened for the rejected post.
    const entries = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries
       where org_id = ${org.orgId} and origin = 'tax_provision'`));
    assert.equal(entries.rows[0]!.n, 0);
    const stillDraft = await getProvisionRun(org.orgId, draftId);
    assert.equal(stillDraft?.status, "draft");

    // Happy control: recompute against the live ledger posts cleanly.
    const freshId = await computeProvisionRun(org.orgId, 2026, {}, userId);
    assert.notEqual(freshId, draftId);
    const { entryId } = await postProvisionRun(org.orgId, freshId, userId);
    const posted = (await db.execute<{ status: string }>(sql`
      select status from journal_entries where id = ${entryId}`));
    assert.equal(posted.rows[0]!.status, "posted");
    const payload = payloadOf((await getProvisionRun(org.orgId, freshId))!);
    assert.equal(payload.pretaxBookIncome, "1500000.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("equal-aggregate drafts with different temporary-difference detail get distinct identities", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Detail Tester", "admin");
    await seedTaxControlAccounts(org.orgId);
    await seedEnactedRate(org.orgId, "Federal", "26.5", { userId });

    const diffsA = [
      { category: "fixed_assets" as const, description: "Fixture lease timing", difference: "100000", source: "manual" as const },
      { category: "provisions" as const, description: "Warranty accrual", difference: "-50000", source: "manual" as const },
    ];
    // Same amounts, same categories, same aggregates — ONLY descriptions and
    // composition differ. Under the aggregate-only hash this returned draft A.
    const diffsB = [
      { category: "fixed_assets" as const, description: "Tooling lease timing", difference: "100000", source: "manual" as const },
      { category: "provisions" as const, description: "Rebate accrual", difference: "-50000", source: "manual" as const },
    ];
    const runA = await computeProvisionRun(org.orgId, 2026, { additionalDifferences: diffsA }, userId);
    const runB = await computeProvisionRun(org.orgId, 2026, { additionalDifferences: diffsB }, userId);
    assert.notEqual(runB, runA, "materially different workpapers must not reuse the prior draft");

    const discarded = await getProvisionRun(org.orgId, runA);
    assert.equal(discarded?.status, "discarded");
    const detail = (await db.execute<{ description: string }>(sql`
      select description from temporary_differences where run_id = ${runB} order by description`));
    assert.deepEqual(
      detail.rows.map((r) => r.description),
      ["Rebate accrual", "Tooling lease timing"],
    );

    // Byte-equivalent retry remains idempotent.
    const retry = await computeProvisionRun(org.orgId, 2026, { additionalDifferences: diffsB }, userId);
    assert.equal(retry, runB);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("missing enacted-rate coverage fails closed while a genuine 0% rate computes", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Coverage Tester", "admin");
    await seedTaxControlAccounts(org.orgId);
    const usSub = await createSubsidiary(org.orgId, "US Ops", "USD", org.subsidiaryId);
    // Only the ROOT has coverage; the active USD entity has none.
    await seedEnactedRate(org.orgId, "CAD federal", "26", { subsidiaryId: org.subsidiaryId, userId });
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId}, 'USD', 'CAD', '2026-07-31', 'spot', '1.25', 'manual')`);
    await postInvoice(org, { subsidiaryId: usSub, amount: "100000", currency: "USD", number: "INV-COV-1", userId });

    await assert.rejects(
      () => computeProvisionRun(org.orgId, 2026, {}, userId),
      /no enacted income tax rate covers US Ops/,
    );

    // Control: an explicit 0% row IS coverage and computes silently fine.
    await seedEnactedRate(org.orgId, "US federal", "0", { subsidiaryId: usSub, userId });
    const runId = await computeProvisionRun(org.orgId, 2026, {}, userId);
    const payload = payloadOf((await getProvisionRun(org.orgId, runId))!);
    const usEntity = payload.entities.find((e) => e.subsidiaryId === usSub)!;
    assert.equal(usEntity.enactedRatePercent, "0.0000");
    assert.equal(usEntity.computation.currentTax, "0.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("multi-entity provisions calculate, post and translate per entity instead of posting to the root", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Entity Tester", "admin");
    const accounts = await seedTaxControlAccounts(org.orgId);
    const usSub = await createSubsidiary(org.orgId, "US Ops", "USD", org.subsidiaryId);
    await seedEnactedRate(org.orgId, "CA federal", "26", { subsidiaryId: org.subsidiaryId, userId });
    await seedEnactedRate(org.orgId, "US federal", "21", { subsidiaryId: usSub, userId });
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId}, 'USD', 'CAD', '2026-07-31', 'spot', '1.25', 'manual')`);

    await postInvoice(org, { subsidiaryId: org.subsidiaryId, amount: "200000", number: "INV-ENT-CA", userId });
    await postInvoice(org, { subsidiaryId: usSub, amount: "100000", currency: "USD", number: "INV-ENT-US", userId });

    const runId = await computeProvisionRun(org.orgId, 2026, {}, userId);
    const run = (await getProvisionRun(org.orgId, runId))!;
    const payload = payloadOf(run);
    assert.equal(payload.entities.length, 2);
    const ca = payload.entities.find((e) => e.subsidiaryId === org.subsidiaryId)!;
    const us = payload.entities.find((e) => e.subsidiaryId === usSub)!;
    assert.equal(ca.computation.currentTax, "52000.0000");
    assert.equal(us.computation.currentTax, "21000.0000");
    assert.equal(us.fxRate, "1.2500000000");
    // Consolidated view translates: 52,000 + 21,000 × 1.25 = 78,250 — never
    // the raw 73,000 unit sum.
    assert.equal(payload.currentTax, "78250.0000");

    await postProvisionRun(org.orgId, runId, userId);
    const journals = (await db.execute<{
      id: string;
      subsidiary_id: string;
      currency: string | null;
      n: number;
      balanced: string;
    }>(sql`
      select e.id, e.subsidiary_id,
             (select currency from journal_lines l where l.entry_id = e.id limit 1) as currency,
             count(*)::int as n,
             sum(l.amount)::text as balanced
        from journal_entries e
        join journal_lines l on l.entry_id = e.id and l.org_id = e.org_id
       where e.org_id = ${org.orgId} and e.origin = 'tax_provision' and e.status = 'posted'
       group by e.id, e.subsidiary_id`));
    assert.equal(journals.rows.length, 2, "one functional-currency journal per entity");
    const bySub = new Map(journals.rows.map((j) => [j.subsidiary_id, j]));
    const usJournal = bySub.get(usSub)!;
    const caJournal = bySub.get(org.subsidiaryId)!;
    assert.equal(usJournal.currency, "USD");
    assert.equal(caJournal.currency, "CAD");
    for (const journal of [usJournal, caJournal]) {
      assert.equal(journal.balanced, "0.0000", `entity ${journal.subsidiary_id} balances on its own`);
    }
    // The USD entity's expense line carries its functional amount.
    const usExpense = (await db.execute<{ amount: string }>(sql`
      select l.amount from journal_lines l
       join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
       where e.id = ${usJournal.id} and l.account_id = ${accounts.expense}
        and l.subsidiary_id = ${usSub}`));
    assert.equal(usExpense.rows[0]!.amount, "21000.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("subsidiary rates stack onto org-wide jurisdictions deterministically and ambiguity fails closed", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Stack Tester", "admin");
    await seedTaxControlAccounts(org.orgId);
    const otherSub = await createSubsidiary(org.orgId, "Other Co", "EUR", org.subsidiaryId);
    await seedEnactedRate(org.orgId, "Federal", "21", { userId });
    await seedEnactedRate(org.orgId, "State", "5", { subsidiaryId: org.subsidiaryId, userId });
    // Unrelated jurisdiction scoped to ANOTHER entity must not touch the root.
    await seedEnactedRate(org.orgId, "Other Province", "99", { subsidiaryId: otherSub, userId });
    await postInvoice(org, { subsidiaryId: org.subsidiaryId, amount: "100000", number: "INV-STACK-1", userId });

    const runId = await computeProvisionRun(org.orgId, 2026, {}, userId);
    const payload = payloadOf((await getProvisionRun(org.orgId, runId))!);
    const rootEntity = payload.entities.find((e) => e.subsidiaryId === org.subsidiaryId)!;
    assert.equal(rootEntity.enactedRatePercent, "26.0000", "org-wide 21% + subsidiary 5% stack");
    assert.deepEqual(rootEntity.enactedRateJurisdictions, ["Federal", "State"]);
    assert.equal(rootEntity.computation.currentTax, "26000.0000");

    // Ambiguity: the SAME jurisdiction now configured at both scopes.
    await seedEnactedRate(org.orgId, "State", "2", { userId });
    await assert.rejects(
      () => computeProvisionRun(org.orgId, 2026, {}, userId),
      /both org-wide and subsidiary-scoped/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("third same-year repost writes a third distinct reversal without number collisions", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Repost Tester", "admin");
    await seedTaxControlAccounts(org.orgId);
    await seedEnactedRate(org.orgId, "Federal", "26.5", { userId });
    await postInvoice(org, { subsidiaryId: org.subsidiaryId, amount: "1000000", number: "INV-REPOST-1", userId });

    const diff = (n: number) => [
      {
        category: "fixed_assets" as const,
        description: `P&E book vs tax v${n}`,
        difference: String(n * 100000),
        source: "manual" as const,
      },
    ];
    const mainNumbers: string[] = [];
    const reversalNumbers: string[] = [];
    let previousEntryId: string | null = null;
    for (const version of [1, 2, 3]) {
      const runId = await computeProvisionRun(
        org.orgId,
        2026,
        { additionalDifferences: diff(version) },
        userId,
      );
      const { entryId } = await postProvisionRun(org.orgId, runId, userId);
      const entryNumber = (await db.execute<{ entry_number: string }>(sql`
        select entry_number from journal_entries where id = ${entryId}`)).rows[0]!.entry_number;
      mainNumbers.push(entryNumber);
      if (previousEntryId) {
        const reversalRows: { entry_number: string }[] = (await db.execute<{ entry_number: string }>(sql`
          select entry_number from journal_entries
           where org_id = ${org.orgId} and origin = 'tax_provision' and reverses_entry_id = ${previousEntryId}`)).rows;
        assert.equal(reversalRows.length, 1, "each superseded entry reversed exactly once");
        reversalNumbers.push(reversalRows[0]!.entry_number);
      }
      previousEntryId = entryId;
    }

    // Three mains, two reversals — all six numbers distinct. The pre-fix code
    // reused one fixed ITX-REV-FY number, so the THIRD repost collided.
    assert.equal(new Set([...mainNumbers, ...reversalNumbers]).size, 5);
    assert.match(reversalNumbers[0]!, /^ITX-REV-FY2026-v1-/);
    assert.match(reversalNumbers[1]!, /^ITX-REV-FY2026-v2-/);

    const statuses = (await db.execute<{ status: string; n: number }>(sql`
      select status, count(*)::int as n from tax_provision_runs
       where org_id = ${org.orgId} and fiscal_year = 2026 group by status`));
    const byStatus = new Map(statuses.rows.map((r) => [r.status, r.n]));
    assert.equal(byStatus.get("posted"), 1);
    assert.equal(byStatus.get("superseded"), 2);

    // Idempotent retry of the live run returns its own entry.
    const liveRun = (await db.execute<{ id: string; journal_entry_id: string }>(sql`
      select id, journal_entry_id from tax_provision_runs
       where org_id = ${org.orgId} and fiscal_year = 2026 and status = 'posted'`)).rows[0]!;
    const retry = await postProvisionRun(org.orgId, liveRun.id, userId);
    assert.equal(retry.entryId, liveRun.journal_entry_id);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

// ---------------------------------------------------------------------------
// Tax filing segregation of duties (fnd_mt9844pt_0bwnsn)
// ---------------------------------------------------------------------------

const holds = (role: string, perm: string) =>
  permissionSetCovers(new Set(BUILT_IN_ROLES[role]!.permissions), perm);

test("tax filing prepare and mark-filed require compliance.file, not reports.create", () => {
  assert.ok(
    (PERMISSION_CATALOGUE as readonly string[]).includes("compliance.file"),
    "compliance.file must be seeded so a principal can hold it",
  );
  assert.ok(
    (PERMISSION_CATALOGUE as readonly string[]).includes("reports.create"),
    "reports.create must be seeded for report authorship",
  );

  // The two authorities are disjoint: report authorship must not grant filing.
  assert.equal(
    permissionSetCovers(new Set(["reports.create"]), "compliance.file"),
    false,
    "reports.create must not cover compliance.file — filing is a separate duty",
  );
  assert.equal(
    permissionSetCovers(new Set(["compliance.file"]), "reports.create"),
    false,
    "compliance.file must not cover reports.create — the split is one-way",
  );

  // The accountant designs/runs reports but cannot prepare or file a return.
  assert.equal(holds("accountant", "reports.create"), true);
  assert.equal(holds("accountant", "compliance.file"), false);

  // The controller holds both duties (senior enough for either).
  assert.equal(holds("controller", "compliance.file"), true);
  assert.equal(holds("controller", "reports.create"), true);

  // Viewer, approver, and sales roles hold neither authority.
  for (const role of ["approver", "viewer", "sales_manager", "sales_rep"]) {
    assert.equal(holds(role, "reports.create"), false, `${role} must not create reports`);
    assert.equal(holds(role, "compliance.file"), false, `${role} must not file returns`);
  }
});

// ---------------------------------------------------------------------------
// Tax filing mark-filed fences (fnd_mt9844xu_b1ncd4): a prepared filing may
// only be certified as filed while its fingerprint still reproduces from the
// live source ledger and its covered periods are closed.
// ---------------------------------------------------------------------------

/** One tax code (collected account = the fixture's tax payable) and a two-box
 *  return: GL-mapped line 101, computed line 102 = "101". */
async function seedFilingFingerprintFixture(org: ScratchOrg): Promise<string> {
  const taxCodeId = randomUUID();
  await db.execute(sql`
    insert into tax_codes (id, org_id, code, name, country, applies_to, collected_account_id, is_active)
    values (${taxCodeId}, ${org.orgId}, 'GST-FP', 'Fingerprint Test GST', 'CA', 'sales',
            ${org.accounts.taxOutput}, true)`);
  await db.execute(sql`
    insert into tax_return_forms (id, org_id, code, name, country, submission_channel, is_active)
    values (${randomUUID()}, ${org.orgId}, 'FP_GST', 'Fingerprint Test Return', 'CA', 'portal_manual', true)`);
  await db.execute(sql`
    insert into tax_report_lines (id, org_id, report_code, line_code, label, sign, sequence, tax_code_id, basis, formula, pdf_field)
    values
      (${randomUUID()}, ${org.orgId}, 'FP_GST', '101', 'GST collected', 1, 1, ${taxCodeId}, 'tax_collected', null, null),
      (${randomUUID()}, ${org.orgId}, 'FP_GST', '102', 'Net tax payable', 1, 2, null, null, '101', null)`);
  return taxCodeId;
}

/** A posted, balanced two-line journal carrying tax activity in the period. */
async function postTaxJournal(
  org: ScratchOrg,
  userId: string,
  taxCodeId: string,
  opts: { number: string; taxAmount: string; date?: string },
): Promise<void> {
  const entryId = randomUUID();
  const date = opts.date ?? org.date;
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
    values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${opts.number}, ${date},
            ${org.periodId}, 'test tax activity', 'draft', 'manual', ${userId}, ${userId})`);
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo, tax_code_id)
    values
      (${org.orgId}, ${entryId}, 1, ${org.accounts.taxOutput}, ${org.subsidiaryId}, ${opts.taxAmount},
       'CAD', ${opts.taxAmount}, 1, 'gst collected', ${taxCodeId}),
      (${org.orgId}, ${entryId}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, ${`-${opts.taxAmount}`},
       'CAD', ${`-${opts.taxAmount}`}, 1, 'gst collected offset', null)`);
  await db.execute(sql`
    update journal_entries set status = 'posted', posted_at = now(), posted_by = ${userId}
     where id = ${entryId} and org_id = ${org.orgId}`);
}

/** The prepare path: compute live, freeze the snapshot + fingerprint (route
 *  web/app/api/tax/filings/route.ts POST, through the shared engine builder). */
async function prepareFiling(org: ScratchOrg, userId: string): Promise<{ id: string; snapshotHash: string }> {
  const result = await computeTaxReturn(org.orgId, 'FP_GST', '2026-07-01', '2026-07-31', {});
  const { snapshot, snapshotHash } = buildTaxFilingSnapshot(result, {});
  const filingId = randomUUID();
  const versions = (await db.execute<{ version: number }>(sql`
    select coalesce(max(version), 0)::int + 1 as version from tax_filings
     where org_id = ${org.orgId} and form_code = ${result.formCode}
       and period_from = ${result.from} and period_to = ${result.to}`)).rows[0]!;
  await db.execute(sql`
    insert into tax_filings
      (id, org_id, form_code, form_name, country, period_from, period_to, version, status,
       submission_channel, boxes, adjustments, snapshot_hash, created_by, updated_by)
    values (${filingId}, ${org.orgId}, ${result.formCode}, ${result.formName}, 'CA',
            ${result.from}, ${result.to}, ${versions.version}, 'prepared', ${result.submissionChannel},
            ${JSON.stringify(snapshot.boxes)}::jsonb, '{}'::jsonb, ${snapshotHash}, ${userId}, ${userId})`);
  return { id: filingId, snapshotHash };
}

async function filingState(orgId: string, filingId: string) {
  return (await db.execute<{
    status: string;
    filed_at: Date | null;
    filing_reference: string | null;
    snapshot_hash: string;
  }>(sql`
    select status, filed_at, filing_reference, snapshot_hash
      from tax_filings where org_id = ${orgId} and id = ${filingId}`)).rows[0]!;
}

function filingAudits(orgId: string, filingId: string) {
  return db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log
     where org_id = ${orgId} and table_name = 'tax_filings' and row_id = ${filingId} and action = 'update'`);
}

function closeCoveredPeriod(org: ScratchOrg): Promise<void> {
  return db.transaction(async (tx) => {
    for (const module of ["gl", "tax"] as const) {
      await tx.execute(sql`
        insert into period_locks (id, org_id, period_id, book_id, subsidiary_id, module, state, locked_at, reason)
        values (${randomUUID()}, ${org.orgId}, ${org.periodId}, ${org.bookId}, null, ${module},
                'closed', now(), 'test: governed close')`);
    }
  });
}

test("mark-filed rejects a filing whose source ledger moved after preparation", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Filing Tester", "admin");
    const taxCodeId = await seedFilingFingerprintFixture(org);
    await postTaxJournal(org, userId, taxCodeId, { number: "JE-FP-1", taxAmount: "13.00" });
    const prepared = await prepareFiling(org, userId);

    // The covered period moves AFTER the snapshot was frozen, and the period
    // is then closed — a closed period alone must not certify stale numbers.
    await postTaxJournal(org, userId, taxCodeId, { number: "JE-FP-2", taxAmount: "7.00", date: "2026-07-20" });
    await closeCoveredPeriod(org);

    await assert.rejects(
      () => markTaxFilingFiled(org.orgId, prepared.id, userId, "GOV-001"),
      (error: unknown) => error instanceof TaxFilingError && error.code === "stale",
    );
    // Zero writes on rejection: still prepared, nothing filed, no audit trail.
    const row = await filingState(org.orgId, prepared.id);
    assert.equal(row.status, "prepared");
    assert.equal(row.filed_at, null);
    assert.equal(row.filing_reference, null);
    assert.equal((await filingAudits(org.orgId, prepared.id)).rows[0]!.n, 0);

    // The fence forces re-preparation, not lockout: a new version prepared
    // against the moved ledger carries a different fingerprint.
    const fresh = await prepareFiling(org, userId);
    assert.notEqual(fresh.id, prepared.id);
    assert.notEqual(fresh.snapshotHash, prepared.snapshotHash);
    assert.equal((await filingState(org.orgId, fresh.id)).status, "prepared");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("mark-filed refuses a filing while its covered period is not closed", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Filing Tester", "admin");
    const taxCodeId = await seedFilingFingerprintFixture(org);
    await postTaxJournal(org, userId, taxCodeId, { number: "JE-FP-3", taxAmount: "5.00" });
    const prepared = await prepareFiling(org, userId);

    await assert.rejects(
      () => markTaxFilingFiled(org.orgId, prepared.id, userId, null),
      (error: unknown) => error instanceof TaxFilingError && error.code === "period-not-closed",
    );
    assert.equal((await filingState(org.orgId, prepared.id)).status, "prepared");

    // Partial closure is not closure: gl closed, tax still open.
    await db.execute(sql`
      insert into period_locks (id, org_id, period_id, book_id, subsidiary_id, module, state, locked_at, reason)
      values (${randomUUID()}, ${org.orgId}, ${org.periodId}, ${org.bookId}, null, 'gl',
              'closed', now(), 'test: gl only')`);
    await assert.rejects(
      () => markTaxFilingFiled(org.orgId, prepared.id, userId, null),
      (error: unknown) => error instanceof TaxFilingError && error.code === "period-not-closed",
    );
    assert.equal((await filingState(org.orgId, prepared.id)).status, "prepared");
    assert.equal((await filingAudits(org.orgId, prepared.id)).rows[0]!.n, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("mark-filed refuses a filing whose covered period is closed only at subsidiary scope", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Filing Tester", "admin");
    const taxCodeId = await seedFilingFingerprintFixture(org);
    await postTaxJournal(org, userId, taxCodeId, { number: "JE-FP-3b", taxAmount: "5.00" });
    const prepared = await prepareFiling(org, userId);

    // Entity-scope closure only: gl and tax locked for one subsidiary, no
    // tenant-wide row. A filing certifies the whole organization, so an
    // entity's closed lock must never stand in for the org-wide close.
    await db.execute(sql`
      insert into period_locks (id, org_id, period_id, book_id, subsidiary_id, module, state, locked_at, reason)
      values (${randomUUID()}, ${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId}, 'gl',
              'closed', now(), 'test: subsidiary-scope close only'),
             (${randomUUID()}, ${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId}, 'tax',
              'closed', now(), 'test: subsidiary-scope close only')`);

    await assert.rejects(
      () => markTaxFilingFiled(org.orgId, prepared.id, userId, null),
      (error: unknown) => error instanceof TaxFilingError && error.code === "period-not-closed",
    );
    assert.equal((await filingState(org.orgId, prepared.id)).status, "prepared");
    assert.equal((await filingAudits(org.orgId, prepared.id)).rows[0]!.n, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("mark-filed requires an org-wide closed lock, not a subsidiary-scoped or lapsed-reopen stand-in", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Filing Tester", "admin");
    const taxCodeId = await seedFilingFingerprintFixture(org);
    await postTaxJournal(org, userId, taxCodeId, { number: "JE-FP-5", taxAmount: "11.00" });
    const prepared = await prepareFiling(org, userId);

    // No org-wide closed lock exists: the tenant-wide rows sit OPEN on lapsed
    // reopen windows and the only closed rows are subsidiary-scoped — exactly
    // the configuration the posting guard's shadowing order would read as
    // closed. The statutory fence must rest on the tenant-wide closed lock
    // itself, so this must refuse to file.
    await db.execute(sql`
      insert into period_locks (id, org_id, period_id, book_id, subsidiary_id, module, state, reopen_expires_at, locked_at, reason)
      values
        (${randomUUID()}, ${org.orgId}, ${org.periodId}, ${org.bookId}, null, 'gl',
         'open', now() - interval '1 hour', now(), 'test: lapsed reopen'),
        (${randomUUID()}, ${org.orgId}, ${org.periodId}, ${org.bookId}, null, 'tax',
         'open', now() - interval '1 hour', now(), 'test: lapsed reopen'),
        (${randomUUID()}, ${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId}, 'gl',
         'closed', null, now(), 'test: entity-scoped close'),
        (${randomUUID()}, ${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId}, 'tax',
         'closed', null, now(), 'test: entity-scoped close')`);

    await assert.rejects(
      () => markTaxFilingFiled(org.orgId, prepared.id, userId, "GOV-002"),
      (error: unknown) => error instanceof TaxFilingError && error.code === "period-not-closed",
    );
    assert.equal((await filingState(org.orgId, prepared.id)).status, "prepared");
    assert.equal((await filingAudits(org.orgId, prepared.id)).rows[0]!.n, 0);

    // Closing the tenant-wide rows themselves is what unlocks the filing —
    // the scoped rows and the reopen history were never the evidence.
    await db.execute(sql`
      update period_locks set state = 'closed', reopen_expires_at = null
       where org_id = ${org.orgId} and period_id = ${org.periodId} and book_id = ${org.bookId}
         and subsidiary_id is null`);
    const updated = await markTaxFilingFiled(org.orgId, prepared.id, userId, "GOV-002");
    assert.ok(updated.filedAt);
    assert.equal((await filingState(org.orgId, prepared.id)).status, "filed");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a fingerprint-matching filing marks filed once its covered period is closed", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Filing Tester", "admin");
    const taxCodeId = await seedFilingFingerprintFixture(org);
    await postTaxJournal(org, userId, taxCodeId, { number: "JE-FP-4", taxAmount: "13.00" });
    const prepared = await prepareFiling(org, userId);
    await closeCoveredPeriod(org);

    const updated = await markTaxFilingFiled(org.orgId, prepared.id, userId, "GOV-REF-1");
    assert.ok(updated.filedAt, "filed_at stamped");
    const row = await filingState(org.orgId, prepared.id);
    assert.equal(row.status, "filed");
    assert.equal(row.filing_reference, "GOV-REF-1");
    assert.ok(row.filed_at);

    // The certification is auditable: the audit row names the verified
    // fingerprint, so the filed lineage survives later re-preparation.
    const audits = (await db.execute<{ changes: Record<string, unknown> }>(sql`
      select changes from audit_log
       where org_id = ${org.orgId} and table_name = 'tax_filings' and row_id = ${prepared.id}
         and action = 'update'`)).rows[0]!;
    const after = audits.changes as { after: { status: string; snapshotHash: string; sourceVerified: boolean } };
    assert.equal(after.after.status, "filed");
    assert.equal(after.after.snapshotHash, prepared.snapshotHash);
    assert.equal(after.after.sourceVerified, true);

    // The transition stays one-way.
    await assert.rejects(
      () => markTaxFilingFiled(org.orgId, prepared.id, userId, "GOV-REF-2"),
      (error: unknown) => error instanceof TaxFilingError && error.code === "already-filed",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
