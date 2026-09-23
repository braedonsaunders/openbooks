import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { setPeriodLockState } from "../close/period-locks.ts";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";
import {
  createSampleCompany,
  promoteExistingSampleTemplate,
} from "../sample-companies/service.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

async function postCustomerInvoice(org: Org, actor: string, number: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into documents
    (id, org_id, kind, status, document_number, subsidiary_id, party_id,
     document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${org.orgId}, 'customer_invoice', 'draft', ${number},
            ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date},
            'CAD', '1', '100', '0', '100', ${actor})`);
  await db.execute(sql`insert into document_lines
    (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${id}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')`);
  await db.execute(sql`update documents set status='approved' where id=${id} and org_id=${org.orgId}`);
  await postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
  return id;
}

async function closeGl(orgId: string, periodId: string, bookId: string, actor: string, reason: string): Promise<void> {
  await setPeriodLockState({
    orgId, periodId, bookId, module: "gl", state: "closed", actorId: actor, reason,
  });
}

async function ledgerCounts(orgId: string) {
  return (await db.execute<{ documents: number; lines: number; entries: number }>(sql`
    select (select count(*)::int from documents where org_id = ${orgId}) as documents,
           (select count(*)::int from document_lines where org_id = ${orgId}) as lines,
           (select count(*)::int from journal_entries where org_id = ${orgId}) as entries
  `)).rows[0]!;
}

async function deleteSandboxesFor(productionOrgId: string): Promise<void> {
  const rows = (await db.execute<{ id: string }>(sql`
    select id from sandboxes where production_org_id = ${productionOrgId}`)).rows;
  for (const row of rows) await deleteSandbox(row.id).catch(() => undefined);
}

async function deleteSandboxForOrg(orgId: string): Promise<void> {
  const rows = (await db.execute<{ id: string }>(sql`
    select id from sandboxes where org_id = ${orgId}`)).rows;
  for (const row of rows) await deleteSandbox(row.id).catch(() => undefined);
}

/**
 * OM-13: a template whose posted history sits in an already-closed period
 * could not be cloned — every sample-company and sandbox cut rolled back on
 * "period is closed for GL posting" from jl_guard's amend path. The clone
 * authority (openbooks.clone, asserted solely inside runClone's maintenance
 * transaction) admits INSERTs of posted/reversed history into closed target
 * periods; updates, deletes and ordinary writes stay refused.
 */
test("a full sandbox clones posted history sitting in a closed GL period", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  let sandboxId: string | null = null;
  try {
    const actor = await createScratchUser(org.orgId, `ClosedClone ${randomUUID()}`, "accountant");
    await postCustomerInvoice(org, actor, `CLOSED-${randomUUID()}`);
    await closeGl(org.orgId, org.periodId, org.bookId, actor, "OM-13: close GL holding posted lines");
    const before = await ledgerCounts(org.orgId);
    assert.equal(before.entries, 1);

    const created = await createSandbox({
      productionOrgId: org.orgId, name: `ClosedClone ${randomUUID()}`, tier: "full", masked: false,
    });
    sandboxId = created.sandboxId;
    assert.deepEqual(await ledgerCounts(created.sandboxOrgId), before);

    // The closed lock itself is part of history: the clone carries it, and
    // every cloned line still belongs to a cloned entry.
    const locks = (await db.execute<{ states: string[] }>(sql`
      select array_agg(distinct state) as states from period_locks
       where org_id = ${created.sandboxOrgId} and module = 'gl'`)).rows[0]!;
    assert.ok(locks.states?.includes("closed"), "the clone carries the closed GL lock");
    const orphaned = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_lines l
       where l.org_id = ${created.sandboxOrgId}
         and not exists (select 1 from journal_entries e where e.id = l.entry_id and e.org_id = l.org_id)`)).rows[0]!;
    assert.equal(orphaned.n, 0);

    // The clone's existing audit evidence records the authority it ran under.
    const evidence = (await db.execute<{ production: string; authority: string; scope: string }>(sql`
      select changes->>'productionOrgId' as production, changes->>'authority' as authority, changes->>'scope' as scope
        from audit_log
       where org_id = ${created.sandboxOrgId} and changes->>'mode' = 'sandbox_clone_authority'`)).rows;
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]!.production, org.orgId);
    assert.equal(evidence[0]!.authority, "openbooks.clone");
    assert.match(evidence[0]!.scope, /INSERT.*only/i);
  } finally {
    if (sandboxId) await deleteSandbox(sandboxId).catch(() => undefined);
    else await deleteSandboxesFor(org.orgId);
    await dropScratchOrg(org.orgId);
  }
});

test("a clone carries recognized reporting-book history across a closed assets period", { skip: !DB }, async () => {
  // The depreciation sibling of the jl_guard refusal: with the assets module
  // closed (GL open, so the journal-line copy passes), the copy of a
  // recognized reporting-book line raises "closed for depreciation" without
  // the authority's INSERT exception.
  const org = await createScratchOrg();
  let sandboxId: string | null = null;
  try {
    const actor = await createScratchUser(org.orgId, `ClosedDepr ${randomUUID()}`, "admin");
    const bookId = randomUUID();
    await db.execute(sql`
      insert into accounting_books (id, org_id, code, name, is_primary, posts_gl, is_active, created_by, updated_by)
      values (${bookId}, ${org.orgId}, 'RPT', 'Reporting only', false, false, true, ${actor}, ${actor})`);
    const categoryId = randomUUID();
    await db.execute(sql`
      insert into asset_categories
        (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
         depreciation_expense_account_id, default_method, default_convention, tax_attributes, is_active)
      values (${categoryId}, ${org.orgId}, 'Equipment', ${org.accounts.invAsset}, ${org.accounts.clearing},
              ${org.accounts.adjustment}, 'straight_line', 'full_month', '{}'::jsonb, true)`);
    const assetId = randomUUID();
    await db.execute(sql`
      insert into fixed_assets
        (id, org_id, subsidiary_id, category_id, asset_number, name, status, acquired_on, in_service_on,
         acquisition_cost, salvage_value, depreciation_method, useful_life_months, custom)
      values (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, 'RPT-1',
              'Reporting asset', 'in_service', ${org.date}, ${org.date},
              '1200.0000', '0', 'straight_line', 12, '{}'::jsonb)`);
    const scheduleId = randomUUID();
    await db.execute(sql`
      insert into depreciation_schedules (id, org_id, asset_id, book_id, method, life_months, created_by, updated_by)
      values (${scheduleId}, ${org.orgId}, ${assetId}, ${bookId}, 'straight_line', 12, ${actor}, ${actor})`);
    const lineId = randomUUID();
    await db.execute(sql`
      insert into depreciation_schedule_lines (id, org_id, schedule_id, period_id, sequence, planned_amount, created_by, updated_by)
      values (${lineId}, ${org.orgId}, ${scheduleId}, ${org.periodId}, 1, '100.0000', ${actor}, ${actor})`);
    await db.execute(sql`
      update depreciation_schedule_lines
         set posted_amount = planned_amount, non_gl_recognized_at = now(), updated_by = ${actor}
       where org_id = ${org.orgId} and id = ${lineId}`);
    await setPeriodLockState({
      orgId: org.orgId, periodId: org.periodId, bookId, module: "assets",
      state: "closed", actorId: actor, reason: "OM-13: close reporting book holding recognized lines",
    });

    const sourceStamp = (await db.execute<{ stamp: string }>(sql`
      select non_gl_recognized_at::text as stamp
        from depreciation_schedule_lines where org_id = ${org.orgId} and id = ${lineId}`)).rows[0]!.stamp;

    const created = await createSandbox({
      productionOrgId: org.orgId, name: `ClosedDepr ${randomUUID()}`, tier: "full", masked: false,
    });
    sandboxId = created.sandboxId;
    const carried = (await db.execute<{ posted: string; recorded: boolean; stamp: string }>(sql`
      select posted_amount::text as posted, non_gl_recognized_at is not null as recorded,
             non_gl_recognized_at::text as stamp
        from depreciation_schedule_lines where org_id = ${created.sandboxOrgId}`)).rows;
    assert.equal(carried.length, 1);
    assert.equal(carried[0]!.posted, "100.0000");
    assert.equal(carried[0]!.recorded, true);
    assert.equal(carried[0]!.stamp, sourceStamp, "the clone replays the recognition instant verbatim");
  } finally {
    if (sandboxId) await deleteSandbox(sandboxId).catch(() => undefined);
    else await deleteSandboxesFor(org.orgId);
    await dropScratchOrg(org.orgId);
  }
});

test("cloned posted history stays immutable and the closed period stays closed", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  let sandboxId: string | null = null;
  try {
    const actor = await createScratchUser(org.orgId, `ClosedFence ${randomUUID()}`, "accountant");
    await postCustomerInvoice(org, actor, `FENCE-${randomUUID()}`);
    // One open period besides the closed one, so the control posting below
    // has somewhere legal to land inside the clone.
    const calendar = (await db.execute<{ id: string }>(sql`
      select fiscal_calendar_id as id from accounting_periods where id = ${org.periodId}`)).rows[0]!.id;
    const openPeriodId = randomUUID();
    await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${openPeriodId}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, ${calendar})`);
    await closeGl(org.orgId, org.periodId, org.bookId, actor, "OM-13: fence probe on cloned history");

    const created = await createSandbox({
      productionOrgId: org.orgId, name: `ClosedFence ${randomUUID()}`, tier: "full", masked: false,
    });
    sandboxId = created.sandboxId;
    const clone = created.sandboxOrgId;
    const cloneActor = await createScratchUser(clone, `CloneWriter ${randomUUID()}`, "accountant");
    const line = (await db.execute<{ id: string; entry_id: string }>(sql`
      select id, entry_id from journal_lines where org_id = ${clone} limit 1`)).rows[0]!;

    // UPDATE of a cloned posted line stays refused even though the clone ran
    // under the authority: the flag is transaction-local to the copy.
    await assert.rejects(
      db.execute(sql`update journal_lines set amount = '999.0000' where id = ${line.id} and org_id = ${clone}`),
      (error: unknown) => errorChainMatches(error, /lines of a posted journal entry are immutable/),
      "updating cloned posted history must stay refused",
    );
    await assert.rejects(
      db.execute(sql`delete from journal_lines where id = ${line.id} and org_id = ${clone}`),
      (error: unknown) => errorChainMatches(error, /lines of a posted journal entry are immutable/),
      "deleting cloned posted history must stay refused",
    );

    // A normal posting into the carried closed period stays refused.
    const draftId = randomUUID();
    const clonePeriod = (await db.execute<{ id: string }>(sql`
      select id from accounting_periods where org_id = ${clone} and fiscal_year = 2026 and period_number = 7`)).rows[0]!.id;
    const cloneBook = (await db.execute<{ id: string }>(sql`
      select id from accounting_books where org_id = ${clone} and is_primary`)).rows[0]!.id;
    const cloneSub = (await db.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id = ${clone} limit 1`)).rows[0]!.id;
    const cloneBank = (await db.execute<{ id: string }>(sql`
      select id from accounts where org_id = ${clone} and number = '1000'`)).rows[0]!.id;
    const cloneRevenue = (await db.execute<{ id: string }>(sql`
      select id from accounts where org_id = ${clone} and number = '4000'`)).rows[0]!.id;
    await db.execute(sql`
      insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${draftId}, ${clone}, ${cloneBook}, ${cloneSub}, 'FENCE-DRAFT', '2026-07-15', ${clonePeriod}, 'draft', 'manual')`);
    await db.execute(sql`
      insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
      values (${clone}, ${draftId}, 1, ${cloneBank}, ${cloneSub}, '50.0000', 'CAD', '50.0000', '1', ''),
             (${clone}, ${draftId}, 2, ${cloneRevenue}, ${cloneSub}, '-50.0000', 'CAD', '-50.0000', '1', '')`);
    await assert.rejects(
      db.execute(sql`update journal_entries set status = 'posted', posted_by = ${cloneActor} where id = ${draftId}`),
      (error: unknown) => errorChainMatches(error, /period is closed for GL posting/),
      "posting into the carried closed period must stay refused",
    );

    // Control: the clone is an ordinary working org — an open-period posting
    // succeeds, proving the authority did not leak past the copy.
    const livePeriod = (await db.execute<{ id: string }>(sql`
      select id from accounting_periods where org_id = ${clone} and fiscal_year = 2026 and period_number = 8`)).rows[0]!.id;
    const liveId = randomUUID();
    await db.execute(sql`
      insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${liveId}, ${clone}, ${cloneBook}, ${cloneSub}, 'FENCE-LIVE', '2026-08-15', ${livePeriod}, 'draft', 'manual')`);
    await db.execute(sql`
      insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
      values (${clone}, ${liveId}, 1, ${cloneBank}, ${cloneSub}, '50.0000', 'CAD', '50.0000', '1', ''),
             (${clone}, ${liveId}, 2, ${cloneRevenue}, ${cloneSub}, '-50.0000', 'CAD', '-50.0000', '1', '')`);
    await db.execute(sql`update journal_entries set status = 'posted', posted_by = ${cloneActor} where id = ${liveId}`);
    assert.equal(
      (await db.execute<{ status: string }>(sql`select status from journal_entries where id = ${liveId}`)).rows[0]!.status,
      "posted",
    );
  } finally {
    if (sandboxId) await deleteSandbox(sandboxId).catch(() => undefined);
    else await deleteSandboxesFor(org.orgId);
    await dropScratchOrg(org.orgId);
  }
});

test("the clone flag outside a clone transaction unlocks nothing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, `FlagScope ${randomUUID()}`, "accountant");
    await postCustomerInvoice(org, actor, `SCOPE-${randomUUID()}`);
    await closeGl(org.orgId, org.periodId, org.bookId, actor, "OM-13: flag-scope probe");
    const entry = (await db.execute<{ id: string }>(sql`
      select id from journal_entries where org_id = ${org.orgId} and status = 'posted' limit 1`)).rows[0]!.id;

    // All three flags asserted in a normal tenant transaction: the authority
    // additionally requires RLS bypass, which a tenant transaction never
    // holds, so the closed-period raise still fires.
    await assert.rejects(
      withOrgTransaction(org.orgId, async () => {
        await db.execute(sql`select set_config('openbooks.clone', 'on', true)`);
        await db.execute(sql`select set_config('openbooks.migration', 'on', true)`);
        await db.execute(sql`select set_config('openbooks.amend', 'on', true)`);
        await db.execute(sql`
          insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
          values (${org.orgId}, ${entry}, 99, ${org.accounts.bank}, ${org.subsidiaryId}, '1.0000', 'CAD', '1.0000', '1', '')`);
      }),
      (error: unknown) => errorChainMatches(error, /period is closed for GL posting/),
      "the clone flag in a tenant transaction must not open a closed period",
    );

    // Maintenance bypass with migration+amend but WITHOUT the clone flag:
    // bypass alone is not the authority either.
    await assert.rejects(
      withOrg(null, async () => {
        await db.execute(sql`select set_config('openbooks.migration', 'on', true)`);
        await db.execute(sql`select set_config('openbooks.amend', 'on', true)`);
        await db.execute(sql`
          insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
          values (${org.orgId}, ${entry}, 99, ${org.accounts.bank}, ${org.subsidiaryId}, '1.0000', 'CAD', '1.0000', '1', '')`);
      }),
      (error: unknown) => errorChainMatches(error, /period is closed for GL posting/),
      "bypass without the clone flag must not open a closed period",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a sample company cuts from a closed-period template and numbering continues (OM-01)", { skip: !DB }, async () => {
  // End to end through the product path: a synthetic template whose posted
  // sample invoices sit in a closed GL period promotes, clones via
  // createSampleCompany, and the first live invoice continues past the
  // highest sample number instead of restarting at INV-00001.
  const source = await createScratchOrg();
  const memberOrg = await createScratchOrg();
  let previewOrgId: string | null = null;
  try {
    const actor = await createScratchUser(source.orgId, `SampleSeed ${randomUUID()}`, "admin");
    for (const n of ["INV-000001", "INV-000002", "INV-000003", "INV-000004"]) {
      await postCustomerInvoice(source, actor, n);
    }
    for (const n of ["DRAFT-A", "DRAFT-B", "DRAFT-C", "DRAFT-D"]) {
      await db.execute(sql`
        insert into documents (id, org_id, kind, status, document_number, document_date, currency, subtotal, tax_total, total)
        values (${randomUUID()}, ${source.orgId}, 'customer_invoice', 'draft', ${n}, '2026-07-15', 'CAD', '0', '0', '0')`);
    }
    for (const name of ["Sample Extra A", "Sample Extra B", "Sample Extra C", "Sample Extra D"]) {
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${randomUUID()}, ${source.orgId}, 'customer', ${name}, true, '{}'::jsonb)`);
    }
    const calendar = (await db.execute<{ id: string }>(sql`
      select fiscal_calendar_id as id from accounting_periods where id = ${source.periodId}`)).rows[0]!.id;
    for (const [year, num, name, start, end] of [
      [2026, 6, "2026-06", "2026-06-01", "2026-06-30"],
      [2026, 8, "2026-08", "2026-08-01", "2026-08-31"],
    ] as const) {
      await db.execute(sql`
        insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${randomUUID()}, ${source.orgId}, ${year}, ${num}, ${name}, ${start}, ${end}, false, ${calendar})`);
    }
    await closeGl(source.orgId, source.periodId, source.bookId, actor, "OM-13: closed-period sample template");

    const promoted = await promoteExistingSampleTemplate({
      industryKey: "general_business",
      sourceOrgId: source.orgId,
      confirmedSampleData: true,
      masked: false,
      confirmedSynthetic: true,
    });

    const memberUserId = await createScratchUser(memberOrg.orgId, "Sample requester", "admin");
    const created = await createSampleCompany({
      industryKey: "general_business",
      memberUserId,
      sourceOrgId: memberOrg.orgId,
      memberName: "Sample requester",
      features: {},
    });
    assert.equal(created.created, true);
    previewOrgId = created.orgId;
    assert.equal(promoted.coverage.postedEntries, 4);

    const posted = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries where org_id = ${created.orgId} and status = 'posted'`)).rows[0]!.n;
    assert.equal(posted, 4);
    const closedLocks = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from period_locks where org_id = ${created.orgId} and module = 'gl' and state = 'closed'`)).rows[0]!.n;
    assert.ok(closedLocks >= 1, "the sample carries the template's closed period");

    // OM-01 follow-through: the next live invoice continues the sample run.
    assert.equal(
      await allocateDocumentNumber(db, created.orgId, "customer_invoice", "INV-"),
      "INV-00005",
    );
  } finally {
    if (previewOrgId) await deleteSandboxForOrg(previewOrgId).catch(() => undefined);
    await deleteSandboxesFor(source.orgId).catch(() => undefined);
    await dropScratchOrg(memberOrg.orgId).catch(() => undefined);
    await dropScratchOrg(source.orgId).catch(() => undefined);
  }
});
