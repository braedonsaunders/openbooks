import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  commitPostingPeriodAssignment,
  previewPostingPeriodAssignment,
} from "./posting-periods.ts";
import { assertPeriodModulesOpen } from "../periods/period-policy.ts";
import { setPeriodLockState } from "../periods/period-locks.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

// Admin bulk assignment for the close-readiness `posting-period-missing`
// population (approved documents without a posting period): preview derives
// each document's effective date and entity calendar, commit assigns it with
// audit evidence, closed periods refuse per document, reruns assign nothing.

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedOrder(
  orgId: string,
  subsidiaryId: string,
  kind:
    | "sales_order"
    | "purchase_order"
    | "vendor_bill"
    | "customer_invoice"
    | "purchase_receipt"
    | "journal",
  date: string,
  status = "approved",
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, subsidiary_id, kind, status, document_number, document_date,
       posting_date, currency, subtotal, tax_total, total)
    values (${id}, ${orgId}, ${subsidiaryId}, ${kind}, ${status}, ${id},
            ${date}, ${date}, 'CAD', '10.0000', '0.0000', '10.0000')`);
  return id;
}

test(
  "assign-posting-period previews, commits with audit, and is idempotent",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const sales = await seedOrder(org.orgId, org.subsidiaryId, "customer_invoice", org.date);
      const purchase = await seedOrder(org.orgId, org.subsidiaryId, "vendor_bill", org.date);
      // Orders never post: they are not candidates for a posting period.
      await seedOrder(org.orgId, org.subsidiaryId, "sales_order", org.date);

      const preview = await previewPostingPeriodAssignment(org.orgId, { bookId: org.bookId });
      assert.equal(preview.rows.length, 2);
      for (const row of preview.rows) {
        assert.equal(row.blocked, false);
        assert.equal(row.periodId, org.periodId);
      }

      const first = await commitPostingPeriodAssignment(org.orgId, {
        bookId: org.bookId,
        actorId: actor,
      });
      assert.equal(first.assigned.length, 2);
      assert.equal(first.refused.length, 0);
      assert.equal(first.skipped.length, 0);
      const stored = await db.execute<{ id: string; posting_period_id: string }>(
        sql`
      select id, posting_period_id from documents where org_id = ${org.orgId} and id in (${sales}, ${purchase})`,
        "objects",
      );
      // Both seeded documents round-trip: the per-row period check below
      // cannot pass over an empty set.
      assert.equal(stored.length, 2);
      for (const row of stored) assert.equal(row.posting_period_id, org.periodId);
      const audit = await db.execute<{ n: string }>(
        sql`
      select count(*)::text as n from audit_log
       where org_id = ${org.orgId} and table_name = 'documents'
         and row_id in (${sales}, ${purchase}) and action = 'update'`,
        "objects",
      );
      assert.equal(audit[0]?.n, "2");

      const second = await commitPostingPeriodAssignment(org.orgId, {
        bookId: org.bookId,
        actorId: actor,
      });
      assert.deepEqual(second, { assigned: [], skipped: [], refused: [] });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "assign-posting-period resolves the document's effective subsidiary calendar",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const calendarId = randomUUID();
      const entityPeriodId = randomUUID();
      await db.execute(sql`insert into fiscal_calendars (id,org_id,name,is_active,is_default)
      values (${calendarId},${org.orgId},'Entity posting calendar',true,false)`);
      await db.execute(sql`insert into accounting_periods
      (id,org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on)
      select ${entityPeriodId},org_id,${calendarId},fiscal_year,period_number,'Entity period',starts_on,ends_on
        from accounting_periods where org_id=${org.orgId} and id=${org.periodId}`);
      await db.execute(sql`insert into subsidiary_accounting_preferences
      (org_id,subsidiary_id,effective_from,fiscal_calendar_id,reason)
      values (${org.orgId},${org.subsidiaryId},'2026-07-01',${calendarId},'Use entity posting calendar')`);
      const documentId = await seedOrder(org.orgId, org.subsidiaryId, "vendor_bill", org.date);

      const preview = await previewPostingPeriodAssignment(org.orgId, {
        bookId: org.bookId,
        documentIds: [documentId],
      });
      assert.equal(preview.rows[0]?.blocked, false);
      assert.equal(preview.rows[0]?.periodId, entityPeriodId);
      const committed = await commitPostingPeriodAssignment(org.orgId, {
        bookId: org.bookId,
        documentIds: [documentId],
        actorId: (await seedFlowActors(org.orgId)).adminId,
      });
      assert.deepEqual(committed.assigned, [{ documentId, periodId: entityPeriodId }]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "assign-posting-period refuses closed periods and dateless calendars per document",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const sales = await seedOrder(org.orgId, org.subsidiaryId, "customer_invoice", org.date);
      const purchase = await seedOrder(org.orgId, org.subsidiaryId, "vendor_bill", org.date);
      const dateless = await seedOrder(
        org.orgId,
        org.subsidiaryId,
        "customer_invoice",
        "2020-01-01",
      );
      await db.execute(sql`
      insert into period_locks (org_id, period_id, book_id, module, state, locked_by)
      values (${org.orgId}, ${org.periodId}, ${org.bookId}, 'ar', 'closed', ${actor})`);

      const preview = await previewPostingPeriodAssignment(org.orgId, { bookId: org.bookId });
      const byId = new Map(preview.rows.map((row) => [row.documentId, row]));
      assert.equal(byId.get(sales)?.blocked, true);
      assert.match(byId.get(sales)?.blockReason ?? "", /closed for AR/);
      assert.equal(byId.get(purchase)?.blocked, false);
      assert.equal(byId.get(dateless)?.blocked, true);
      assert.match(byId.get(dateless)?.blockReason ?? "", /no accounting period covers/);

      const result = await commitPostingPeriodAssignment(org.orgId, {
        bookId: org.bookId,
        actorId: actor,
      });
      assert.equal(result.assigned.length, 1);
      assert.equal(result.assigned[0]?.documentId, purchase);
      assert.equal(result.refused.length, 2);
      const stillNull = await db.execute<{ n: string }>(
        sql`
      select count(*)::text as n from documents
       where org_id = ${org.orgId} and id in (${sales}, ${dateless}) and posting_period_id is null`,
        "objects",
      );
      assert.equal(stillNull[0]?.n, "2");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "assign-posting-period assigns decided inventory kinds and blocks undecided kinds with operator copy",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const receipt = await seedOrder(org.orgId, org.subsidiaryId, "purchase_receipt", org.date);
      const bogusId = randomUUID();
      await db.execute(sql`
      insert into documents
        (id, org_id, subsidiary_id, kind, status, document_number, document_date,
         posting_date, currency, subtotal, tax_total, total)
      values (${bogusId}, ${org.orgId}, ${org.subsidiaryId}, 'not_a_mapped_kind', 'approved', ${bogusId},
              ${org.date}, ${org.date}, 'CAD', '10.0000', '0.0000', '10.0000')`);

      const preview = await previewPostingPeriodAssignment(org.orgId, { bookId: org.bookId });
      const byId = new Map(preview.rows.map((row) => [row.documentId, row]));
      // A decided inventory kind resolves exactly like the drawer kinds.
      assert.equal(byId.get(receipt)?.blocked, false);
      assert.equal(byId.get(receipt)?.periodId, org.periodId);
      // An undecided kind stays blocked, and the reason names the remedy for
      // the operator — never the engineering registry name.
      assert.equal(byId.get(bogusId)?.blocked, true);
      assert.match(byId.get(bogusId)?.blockReason ?? "", /not configured for period close/);
      assert.doesNotMatch(byId.get(bogusId)?.blockReason ?? "", /DOCUMENT_CLOSE_MODULES/);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "assign-posting-period offers the open adjustment period when the regular period is closed",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      await setPeriodLockState({
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        module: "gl",
        state: "closed",
        actorId: actors.adminId,
        reason: "year-end close",
      });
      const regular = (
        await db.execute<{ fiscal_calendar_id: string; fiscal_year: number; ends_on: string }>(
          sql`
      select fiscal_calendar_id, fiscal_year, ends_on::text as ends_on from accounting_periods
       where id = ${org.periodId} and org_id = ${org.orgId}`,
          "objects",
        )
      )[0]!;
      const adjustmentId = randomUUID();
      await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment)
      values (${adjustmentId}, ${org.orgId}, ${regular.fiscal_calendar_id}, ${regular.fiscal_year},
              13, 'ADJ', ${regular.ends_on}, ${regular.ends_on}, true)`);
      const journal = await seedOrder(org.orgId, org.subsidiaryId, "journal", org.date);

      // Without the opt-in the row stays blocked but names the alternative.
      const blocked = await previewPostingPeriodAssignment(org.orgId, { bookId: org.bookId });
      const blockedRow = new Map(blocked.rows.map((row) => [row.documentId, row])).get(journal)!;
      assert.equal(blockedRow.blocked, true);
      assert.equal(blockedRow.adjustmentPeriod?.id, adjustmentId);
      // Periods are named by their fiscal position, never the free-text stored name.
      const adjustmentLabel = `FY${regular.fiscal_year} adjustment`;
      assert.equal(blockedRow.adjustmentPeriod?.name, adjustmentLabel);
      assert.equal(blockedRow.adjustmentPeriod?.periodRef.adjustment, true);
      assert.match(blockedRow.periodName ?? "", /^P\d{2} FY\d{4}$/);
      assert.ok(
        blockedRow.blockReason?.includes(
          `adjustment period "${adjustmentLabel}" can take it instead`,
        ),
      );

      // The opt-in assigns into the adjustment period with an audited reason.
      const committed = await commitPostingPeriodAssignment(org.orgId, {
        bookId: org.bookId,
        documentIds: [journal],
        adjustmentPeriodId: adjustmentId,
        actorId: actors.adminId,
      });
      assert.deepEqual(committed.assigned, [{ documentId: journal, periodId: adjustmentId }]);
      const audit = (
        await db.execute<{ reason: string }>(
          sql`
      select changes->>'reason' as reason from audit_log
       where org_id = ${org.orgId} and table_name = 'documents' and row_id = ${journal}
       order by at desc, id desc limit 1`,
          "objects",
        )
      )[0];
      assert.equal(
        audit?.reason,
        `bulk posting-period assignment to adjustment period ${adjustmentLabel}`,
      );

      // A bogus adjustment id refuses instead of silently assigning nothing.
      await assert.rejects(
        previewPostingPeriodAssignment(org.orgId, {
          bookId: org.bookId,
          adjustmentPeriodId: randomUUID(),
        }),
        /adjustment period not found/,
      );

      // The closed-period refusal names the controlled route.
      await assert.rejects(
        assertPeriodModulesOpen(db, {
          orgId: org.orgId,
          periodId: org.periodId,
          bookId: org.bookId,
          subsidiaryIds: [],
          modules: ["gl"],
        }),
        (error: Error) =>
          error.message.includes(
            `controlled reopen, or post this entry into the open adjustment period "${adjustmentLabel}"`,
          ),
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "assign-posting-period fails closed on unknown documents and books",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      await assert.rejects(
        previewPostingPeriodAssignment(org.orgId, {
          bookId: org.bookId,
          documentIds: [randomUUID()],
        }),
        /not assignable/,
      );
      await assert.rejects(
        previewPostingPeriodAssignment(org.orgId, { bookId: randomUUID() }),
        /accounting book not found/,
      );
      await assert.rejects(
        commitPostingPeriodAssignment(org.orgId, {
          bookId: org.bookId,
          documentIds: [randomUUID()],
          actorId: actor,
        }),
        /not assignable/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
