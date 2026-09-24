import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { postDocument } from "../ledger/posting-document.ts";
import {
  cancelRevenueRecognitionForInvoice,
  runRevenueRecognition,
} from "./recognition.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";

/**
 * Recognition cancellation locks the invoice and rechecks the caller scope
 * under that lock: the route's unlocked pre-read can authorize entity A
 * while a concurrent A→B rehome lands before the cancel (or the void)
 * commits. Out-of-scope answers exactly like missing and reverses nothing.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

/** Provision every month covered by the service item's 12-month term. */
async function seedRecognitionTermPeriods(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
): Promise<void> {
  const calendar = await db.execute<{ fiscal_calendar_id: string }>(sql`
    select fiscal_calendar_id
      from accounting_periods
     where id = ${org.periodId} and org_id = ${org.orgId}`);
  const fiscalCalendarId = calendar.rows[0]?.fiscal_calendar_id;
  assert.ok(fiscalCalendarId);
  const periods = [
    [2026, 8, "2026-08-01", "2026-08-31"],
    [2026, 9, "2026-09-01", "2026-09-30"],
    [2026, 10, "2026-10-01", "2026-10-31"],
    [2026, 11, "2026-11-01", "2026-11-30"],
    [2026, 12, "2026-12-01", "2026-12-31"],
    [2027, 1, "2027-01-01", "2027-01-31"],
    [2027, 2, "2027-02-01", "2027-02-28"],
    [2027, 3, "2027-03-01", "2027-03-31"],
    [2027, 4, "2027-04-01", "2027-04-30"],
    [2027, 5, "2027-05-01", "2027-05-31"],
    [2027, 6, "2027-06-01", "2027-06-30"],
  ] as const;
  for (const [fiscalYear, periodNumber, startsOn, endsOn] of periods) {
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
         starts_on, ends_on, is_adjustment, custom)
      values (${randomUUID()}, ${org.orgId}, ${fiscalCalendarId}, ${fiscalYear},
              ${periodNumber}, ${startsOn.slice(0, 7)}, ${startsOn}, ${endsOn},
              false, '{}'::jsonb)`);
  }
}

async function seedScopedRecognition(org: Awaited<ReturnType<typeof createScratchOrg>>) {
  const actors = await seedFlowActors(org.orgId);
  const hidden = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${hidden}, ${org.orgId}, ${org.subsidiaryId}, 'Hidden entity', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into party_subsidiaries (id, org_id, party_id, subsidiary_id)
    values (${randomUUID()}, ${org.orgId}, ${org.customerId}, ${hidden})`);
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, due_date, currency, fx_rate, status,
       subtotal, tax_total, total, is_final_invoice, custom, extra_dims,
       created_by, updated_by)
    values
      (${documentId}, ${org.orgId}, 'customer_invoice', 'REV-SCOPE-001',
       ${org.customerId}, ${hidden}, ${org.date}, ${org.date},
       ${org.date}, 'CAD', 1, 'draft', 1200, 0, 1200, false,
       '{}'::jsonb, '{}'::jsonb, ${actors.adminId}, ${actors.adminId})`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id,
       quantity, unit_price, amount, tax_amount, is_billable,
       quantity_fulfilled, quantity_billed, custom, tax_overridden,
       extra_dims, created_by, updated_by)
    values
      (${randomUUID()}, ${org.orgId}, ${documentId}, 1,
       ${org.items.service}, ${org.accounts.revenue}, 1, 1200, 1200, 0,
       false, 0, 0, '{}'::jsonb, false, '{}'::jsonb,
       ${actors.adminId}, ${actors.adminId})`);
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now()
     where id = ${documentId} and org_id = ${org.orgId}`);
  await postDocument(
    documentId,
    { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } },
    { audit: { actorId: actors.adminId, source: "test" } },
  );
  const recognized = await runRevenueRecognition(org.orgId, "2026-07-31", actors.adminId);
  assert.equal(recognized.posted, 1, "the fixture must recognize one entry");
  return { actors, documentId };
}

async function invoiceStatus(orgId: string, documentId: string): Promise<string> {
  return (await db.execute<{ status: string }>(sql`
    select status from documents where org_id = ${orgId} and id = ${documentId}`)).rows[0]!.status;
}

test(
  "recognition cancellation refuses an out-of-scope invoice and reverses nothing",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await seedRecognitionTermPeriods(org);
      const { actors, documentId } = await seedScopedRecognition(org);
      const scopeA = new Set([org.subsidiaryId]);
      await assert.rejects(
        cancelRevenueRecognitionForInvoice({
          documentId,
          orgId: org.orgId,
          actorId: actors.adminId,
          reason: "Out-of-scope cancel attempt",
          reversalDate: "2026-07-31",
          allowedSubsidiaryIds: scopeA,
        }),
        (error: unknown) => error instanceof ScopeNotFoundError,
      );
      assert.equal(await invoiceStatus(org.orgId, documentId), "posted", "a refused cancel leaves the invoice posted");
      const done = await cancelRevenueRecognitionForInvoice({
        documentId,
        orgId: org.orgId,
        actorId: actors.adminId,
        reason: "Customer contract terminated before the remaining service term",
        reversalDate: "2026-07-31",
        allowedSubsidiaryIds: null,
      });
      assert.equal(done.status, "cancelled");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
