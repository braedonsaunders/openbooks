import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { requestDocumentVoid } from "../ledger/document-void.ts";
import { utcDateFromParts } from "../platform/business-date.ts";
import { runScenario } from "./scenario.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * A governed void must not break the AR/AP `subledger-gl-tieout`.
 *
 * Voiding posts a reversal entry that negates the voided legs (all
 * non-open-item) and flips the original entry to 'reversed': the pair nets to
 * zero in GL, but the voided document leaves the open-item subledger while
 * its mirror leg reads as an independent direct JE. The endurance run
 * general-business/upgrade-edge-1 halted on exactly this geometry at the
 * 2027-12-05 day-end (a void/recreate probe bill of 222.22 posted 2027-11-07
 * broke the AP tie by precisely 222.2200) with no money actually missing.
 *
 * The fixture below reproduces both void timings against one cutoff:
 *  - bill A posted and voided inside the cut-off window (pair must hide
 *    from every bucket together);
 *  - bill B posted inside the window but voided after it (the bill must
 *    read as still open as-of the cutoff — the same rule as the product's
 *    own open-items projection in web/lib/cash/open-items.ts).
 * An October decoy pins the harness cutoff to 2026-09-30 (no closed period:
 * cutoff falls back to the end of the month before the latest posting).
 */

async function seedPostedBill(
  org: ScratchOrg,
  actorId: string,
  documentNumber: string,
  documentDate: string,
  amount: string,
): Promise<string> {
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, currency, fx_rate, status,
       subtotal, tax_total, total, created_by)
    values (
      ${documentId}, ${org.orgId}, 'vendor_bill', ${documentNumber},
      ${org.vendorId}, ${org.subsidiaryId}, ${documentDate}, ${documentDate},
      'CAD', '1', 'draft', ${amount}, '0', ${amount}, ${actorId}
    )
  `);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity,
       unit_price, amount, tax_amount, created_by)
    values (
      ${org.orgId}, ${documentId}, 1, ${org.accounts.cogs}, '1',
      ${amount}, ${amount}, '0', ${actorId}
    )
  `);
  await db.execute(sql`
    update documents
       set status = 'approved', updated_at = now()
     where id = ${documentId} and org_id = ${org.orgId}
  `);
  await postDocument(
    documentId,
    { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } },
    { audit: { actorId, source: "test" } },
  );
  return documentId;
}

async function seedPeriod(
  org: ScratchOrg,
  year: number,
  month: number,
): Promise<string> {
  const cal = await db.execute<{ id: string }>(sql`
    select fiscal_calendar_id as id from accounting_periods where id = ${org.periodId}`);
  const periodId = randomUUID();
  const mm = String(month).padStart(2, "0");
  const lastDay = utcDateFromParts(year, month, 0).getUTCDate();
  await db.execute(sql`
    insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    values (${periodId}, ${org.orgId}, ${year}, ${month}, ${`${year}-${mm}`}, ${`${year}-${mm}-01`}, ${`${year}-${mm}-${lastDay}`}, false, ${cal.rows[0]!.id})`);
  return periodId;
}

async function seedDecoy(org: ScratchOrg, periodId: string, postingDate: string): Promise<void> {
  const decoyId = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, custom)
    values (${decoyId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`TIE-VOID-DECOY-${decoyId.slice(0, 8)}`},
            ${postingDate}, ${periodId}, 'cutoff decoy', 'draft', 'manual', '{}'::jsonb)`);
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
    values (${org.orgId}, ${decoyId}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, '5.0000', 'CAD', '5.0000', 1, 'decoy'),
           (${org.orgId}, ${decoyId}, 2, ${org.accounts.clearing}, ${org.subsidiaryId}, '-5.0000', 'CAD', '-5.0000', 1, 'decoy')`);
  await db.execute(sql`
    update journal_entries set status = 'posted', posted_at = now() where id = ${decoyId}`);
}

function check(cp: Awaited<ReturnType<typeof runScenario>>, name: string) {
  const c = cp.checks.find((c) => c.name === name);
  assert.ok(c, `checkpoint must carry the ${name} check`);
  return c;
}

test("subledger-gl-tieout holds across governed voids on both sides of the cutoff", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Void Tieout Controller", "admin");
    await seedPeriod(org, 2026, 8);
    await seedPeriod(org, 2026, 9);
    const octPeriodId = await seedPeriod(org, 2026, 10);

    // Bill A: posted and voided inside the coming cutoff window.
    const billA = await seedPostedBill(org, actorId, "BILL-VOID-TIE-A", "2026-07-15", "222.22");
    const voidA = await requestDocumentVoid({
      documentId: billA,
      orgId: org.orgId,
      actorId,
      reason: "Void/recreate tie-out regression: bill A",
      reversalDate: "2026-07-20",
      source: "api",
    });
    assert.equal(voidA.status, "voided");
    assert.ok(voidA.reversalEntryId, "bill A void must post its mirror entry");

    // Bill B: posted inside the window, voided after it — still open as-of it.
    const billB = await seedPostedBill(org, actorId, "BILL-VOID-TIE-B", "2026-07-15", "222.22");
    const voidB = await requestDocumentVoid({
      documentId: billB,
      orgId: org.orgId,
      actorId,
      reason: "Void/recreate tie-out regression: bill B",
      reversalDate: "2026-10-03",
      source: "api",
    });
    assert.equal(voidB.status, "voided");
    assert.ok(voidB.reversalEntryId, "bill B void must post its mirror entry");

    // October decoy pins the cutoff to 2026-09-30.
    await seedDecoy(org, octPeriodId, "2026-10-20");

    const cp = await runScenario(org.orgId, { at: org.date });
    assert.equal(cp.cutoff.slice(0, 10), "2026-09-30", "decoy must pin the cutoff past both voids' business dates");
    const tie = check(cp, "subledger-gl-tieout");
    assert.equal(tie.ok, true, `void mirrors must not break the tie: ${tie.detail}`);
    assert.match(tie.detail, /worst \|GL − subledger − directJE\| = 0\.0000/, "residual must be exactly zero");
    for (const other of cp.checks.filter((c) => c.name !== "subledger-gl-tieout")) {
      assert.equal(other.ok, true, `${other.name} must stay green here — only the tie-out is under test`);
    }

    // Red-proof for the void-mirror backstop: hiding the pair must not hide a
    // mis-posted reversal. Shift 100 from bill A's mirror AP leg onto its
    // expense leg: the reversal entry still balances (every balance guard
    // stays green) but the hidden pair no longer nets to zero on AP, so only
    // the backstop can see it. Posted lines are immutable except through the
    // engine's amend flag, so the corruption rides that same path.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local openbooks.amend = on`);
      await tx.execute(sql`
        update journal_lines
           set amount = amount + 100, txn_amount = txn_amount + 100
         where org_id = ${org.orgId}
           and entry_id = ${voidA.reversalEntryId}
           and account_id = ${org.accounts.ap}
      `);
      await tx.execute(sql`
        update journal_lines
           set amount = amount - 100, txn_amount = txn_amount - 100
         where org_id = ${org.orgId}
           and entry_id = ${voidA.reversalEntryId}
           and account_id = ${org.accounts.cogs}
      `);
    });
    const corrupt = await runScenario(org.orgId, { at: org.date });
    const corruptTie = check(corrupt, "subledger-gl-tieout");
    assert.equal(corruptTie.ok, false, `a mis-posted void mirror must fail the tie-out: ${corruptTie.detail}`);
    assert.match(corruptTie.detail, /void mirrors net 100\.0000/, "failure must name the void-mirror residual");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
