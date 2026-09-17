import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// F-u1-P5.1 — an outstanding out-of-pocket expense report is money the
// company owes a person. The tile/cockpit population (openItems) always
// counted it, but the formal aging's document leg did not: the money reached
// the aging TOTAL only through the control residual (parked in Current,
// unattributed), the per-item detail omitted the row entirely, and
// dimension-filtered reads (which skip the residual) dropped it altogether.
// Both aging readers now share the open-item kinds const, so the report ages
// as a document like every other payable.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    // Worktree node_modules is a symlink to the main checkout's install, so
    // bare @openbooks self-imports would resolve to MAIN-checkout code (a
    // second db pool without the test bypass). Pin them to this checkout —
    // the same modules a real install resolves — process-wide, so the
    // readers under test and their transitive engine imports agree.
    if (specifier.startsWith("@openbooks/engine/")) {
      return nextResolve(
        new URL(`../../../engine/${specifier.slice("@openbooks/engine/".length)}`, import.meta.url).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
// Fixture writes cross the maintenance boundary (withBypass); the readers
// under test run tenant-scoped through withOrgContext — the same RLS
// posture as a production request via setRequestOrg.
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { toUnits } = await import("@openbooks/engine/src/money.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { agingByParty, agingDetail } = await import("./aging.ts");
const { openItems } = await import("../cash/open-items.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;
// No due dates anywhere: natively posted expense control lines carry none
// (the kernel stamps dueDate on bill/credit lines only) and expense flows
// never set the document due date. The aging therefore falls back to the
// posting date — the dateless-bill rule (P5.3, out of scope) — while the
// tile keeps the item Current. This test pins the kind-membership tie
// (detail row + buckets + filtered-shape attribution), not the overdue split.
const AS_OF = "2026-07-15";
const POSTED = "2026-05-10"; // 66 days before the as-of: the 61–90 bucket.

test("AP aging attributes an outstanding expense report as a document", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const employee = randomUUID();
    const doc = randomUUID();
    const entry = randomUUID();
    await withBypass(async () => {
      const cal = (await db.execute<{ fiscal_calendar_id: string }>(sql`
        select fiscal_calendar_id from accounting_periods where org_id = ${org.orgId} and starts_on = '2026-07-01'`)).rows[0]!.fiscal_calendar_id;
      const may = randomUUID();
      await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${may}, ${org.orgId}, 2026, 5, '2026-05', '2026-05-01', '2026-05-31', false, ${cal})`);
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id)
        values (${employee}, ${org.orgId}, 'person', 'Out Of Pocket Employee', ${org.subsidiaryId})`);
      await db.execute(sql`insert into documents (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, due_date, currency, fx_rate, subtotal, tax_total, total, open_balance)
        values (${doc}, ${org.orgId}, 'expense_report', 'draft', 'EXP-500', ${org.subsidiaryId}, ${employee}, ${POSTED}, null, 'CAD', '1', '500', 0, '500', '500')`);
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, source_document_id)
        values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`EXP-${entry.slice(0, 8)}`}, ${POSTED}, ${may}, 'draft', 'manual', ${doc})`);
      await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, party_id, due_date, is_open_item)
        values (${randomUUID()}, ${org.orgId}, ${entry}, 1, ${org.accounts.ap}, ${org.subsidiaryId}, '-500.0000', 'CAD', '-500.0000', '1', ${employee}, null, true),
               (${randomUUID()}, ${org.orgId}, ${entry}, 2, ${org.accounts.cogs}, ${org.subsidiaryId}, '500.0000', 'CAD', '500.0000', '1', null, null, false)`);
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`);
      await db.execute(sql`update documents set status = 'posted', posted_entry_id = ${entry}, posting_period_id = ${may} where id = ${doc}`);
    });
    await withOrgContext(org.orgId, async () => {
      const items = await openItems(org.orgId, "ap", AS_OF, undefined);
      assert.equal(items.length, 1, "tile population counts the expense report");
      assert.equal(items[0]?.docKind, "expense_report");
      assert.equal(toUnits(items[0]!.remaining), toUnits("500"), "tile-side open is the full 500");

      const detail = await agingDetail("ap", AS_OF, undefined, org.orgId);
      assert.equal(detail.rows.length, 1, "aging detail carries the expense row (pre-fix: missing)");
      assert.equal(detail.rows[0]?.docKind, "expense_report");
      assert.equal(detail.rows[0]?.bucket, "b3", "dateless report ages by posting date (66 days)");
      assert.equal(toUnits(detail.rows[0]!.open), toUnits("500"));

      const summary = await agingByParty("ap", AS_OF, undefined, org.orgId);
      assert.equal(toUnits(summary.totals.total), toUnits("500"));
      assert.equal(toUnits(summary.totals.b3), toUnits("500"), "report leaves Current for its posting-date bucket (pre-fix: 500 in current)");
      assert.equal(toUnits(summary.totals.current), toUnits("0"));
      const row = summary.rows.find((r) => r.partyId === employee);
      assert.ok(row, "employee keeps a party row");
      assert.equal(toUnits(row.total), toUnits("500"));

      // The disclosure, pinned: the unfiltered headline tied even before the
      // fix (the residual absorbed the report into Current), so this change
      // moves attribution — detail rows, buckets, filtered reads — not the
      // total an org reconciles against the control.
      assert.equal(
        toUnits(summary.totals.total),
        toUnits(items[0]!.remaining),
        "AP aging total ties the tile-side open",
      );
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
