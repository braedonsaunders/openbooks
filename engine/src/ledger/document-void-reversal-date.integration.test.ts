import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { setPeriodLockState } from "../periods/period-locks.ts";
import { db } from "../platform/db.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { postDocument } from "./posting-document.ts";
import {
  DocumentVoidError,
  requestDocumentVoid,
  suggestVoidReversalDate,
} from "./document-void.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

// A void reversal belongs to the entry's own period: defaulting to today
// once pushed a prior-year void into the wrong fiscal year on both sides.
// These tests pin the default (entry date), the closed-period fallback to
// the first open period, the honored explicit date, and the closed-period
// refusal — each reversal balanced through the ledger kernel and audited.

async function seedPostedJournal(
  org: ScratchOrg,
  actorId: string,
  documentNumber: string,
  documentDate: string,
  postingDate = documentDate,
): Promise<{ documentId: string; entryId: string }> {
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, subsidiary_id, document_date,
       posting_date, currency, status, subtotal, tax_total, total, created_by)
    values (
      ${documentId}, ${org.orgId}, 'journal', ${documentNumber},
      ${org.subsidiaryId}, ${documentDate}, ${postingDate}, 'CAD', 'draft',
      '25', '0', '25', ${actorId}
    )
  `);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, subsidiary_id,
       amount, quantity, unit_price, tax_amount, tax_input_amount, created_by)
    values
      (${org.orgId}, ${documentId}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, '25', '1', '25', '0', '25', ${actorId}),
      (${org.orgId}, ${documentId}, 2, ${org.accounts.cogs}, ${org.subsidiaryId}, '-25', '1', '-25', '0', '-25', ${actorId})
  `);
  await submitAndReleaseIfUngated("journal", documentId, actorId);
  const entryId = await postDocument(
    documentId,
    {
      control: {
        ar: org.accounts.ar,
        ap: org.accounts.ap,
        bank: org.accounts.bank,
      },
    },
    { audit: { actorId, source: "test" } },
  );
  return { documentId, entryId };
}

async function reversalSum(
  documentId: string,
  orgId: string,
  reversalEntryId: string,
): Promise<string> {
  void documentId;
  const rows = await db.execute<{ total: string }>(
    sql`
    select coalesce(sum(amount), 0)::text as total from journal_lines
     where org_id = ${orgId} and entry_id = ${reversalEntryId}
  `,
    "objects",
  );
  return rows[0]?.total ?? "missing";
}

async function voidRequestAudit(
  orgId: string,
  documentId: string,
): Promise<{ reversalDate: string }[]> {
  return await db.execute<{ reversalDate: string }>(
    sql`
    select changes->>'reversalDate' as "reversalDate" from audit_log
     where org_id = ${orgId} and table_name = 'documents' and row_id = ${documentId}
       and action = 'update' and changes->>'mode' = 'void_request'
  `,
    "objects",
  );
}

test(
  "a void without a reversal date reverses in the entry's own period",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Void Date Controller", "admin");
      const { documentId } = await seedPostedJournal(
        org,
        actorId,
        "JE-VOID-SAME-PERIOD-1",
        org.date,
      );

      const outcome = await requestDocumentVoid({
        documentId,
        orgId: org.orgId,
        actorId,
        reason: "Same-period reversal default control",
        source: "api",
      });
      assert.equal(outcome.status, "voided");
      assert.ok(outcome.reversalEntryId, "the open entry period admits the reversal");

      const stored = (
        await db.execute<{ reversalDate: string; postingDate: string }>(
          sql`
      select d.void_reversal_date::text as "reversalDate", e.posting_date::text as "postingDate"
        from documents d
        join journal_entries e on e.id = ${outcome.reversalEntryId} and e.org_id = d.org_id
       where d.id = ${documentId} and d.org_id = ${org.orgId}
    `,
          "objects",
        )
      )[0];
      assert.equal(
        stored?.reversalDate,
        null,
        "completion clears the void-request staging date (documents_void_request_evidence); the reversal entry below is the durable record",
      );
      assert.equal(stored?.postingDate, org.date, "the reversal posts in the entry's own period");
      assert.equal(
        Number(await reversalSum(documentId, org.orgId, outcome.reversalEntryId!)),
        0,
        "the reversal balances exactly (numeric text carries scale, e.g. 0.0000)",
      );
      const audits = await voidRequestAudit(org.orgId, documentId);
      assert.equal(audits.length, 1, "the void request is audited once");
      assert.equal(audits[0]?.reversalDate, org.date, "the audit carries the defaulted date");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("a void suggestion starts from the effective posting date", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Void Posting Date Controller", "admin");
    const documentDate = "2026-06-30";
    const postingDate = "2026-07-15";
    const { documentId } = await seedPostedJournal(
      org,
      actorId,
      "JE-VOID-POSTING-DATE-1",
      documentDate,
      postingDate,
    );

    const suggestion = await suggestVoidReversalDate(db, org.orgId, {
      id: documentId,
      kind: "journal",
      documentDate,
      postingDate,
      subsidiaryId: org.subsidiaryId,
    });
    assert.equal(suggestion.originalDate, postingDate);
    assert.equal(suggestion.suggestedDate, postingDate);
    assert.equal(suggestion.suggestedOpen, true);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "adjustment-period voids accept dates in the fiscal posting window",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Void Adjustment Controller", "admin");
      const calendarId = randomUUID();
      const regularPeriodId = randomUUID();
      const adjustmentPeriodId = randomUUID();
      await db.execute(sql`
      insert into fiscal_calendars (id, org_id, name, is_active, is_default)
      values (${calendarId}, ${org.orgId}, 'Entity void calendar', true, false)
    `);
      await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment)
      select ${regularPeriodId}, org_id, ${calendarId}, fiscal_year, period_number,
             'Entity July 2026', starts_on, ends_on, false
        from accounting_periods where org_id = ${org.orgId} and id = ${org.periodId}
    `);
      await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment)
      select ${adjustmentPeriodId}, org_id, ${calendarId}, fiscal_year, 13,
             'Entity FY2026 adjustment', ends_on, ends_on, true
        from accounting_periods where org_id = ${org.orgId} and id = ${regularPeriodId}
    `);
      await db.execute(sql`
      insert into subsidiary_accounting_preferences
        (org_id, subsidiary_id, effective_from, fiscal_calendar_id, reason, created_by)
      select ${org.orgId}, ${org.subsidiaryId}, starts_on, ${calendarId}, 'Entity void calendar assignment', ${actorId}
        from accounting_periods where org_id = ${org.orgId} and id = ${regularPeriodId}
    `);
      const { documentId } = await seedPostedJournal(
        org,
        actorId,
        "JE-VOID-ADJUSTMENT-1",
        org.date,
      );

      const outcome = await requestDocumentVoid({
        documentId,
        orgId: org.orgId,
        actorId,
        reason: "Post the void in the fiscal adjustment window",
        reversalDate: "2026-07-15",
        reversalPeriodId: adjustmentPeriodId,
        source: "api",
      });
      assert.equal(outcome.status, "voided");
      const reversal = (
        await db.execute<{ periodId: string; postingDate: string }>(
          sql`
      select period_id as "periodId", posting_date::text as "postingDate"
        from journal_entries where org_id = ${org.orgId} and id = ${outcome.reversalEntryId}
    `,
          "objects",
        )
      )[0];
      assert.deepEqual(reversal, { periodId: adjustmentPeriodId, postingDate: "2026-07-15" });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a closed entry period moves the default to the first open period",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Void Fallback Controller", "admin");
      const calendarId = randomUUID();
      const julyPeriodId = randomUUID();
      const augustPeriodId = randomUUID();
      await db.execute(sql`
      insert into fiscal_calendars (id, org_id, name, is_active, is_default)
      values (${calendarId}, ${org.orgId}, 'Entity void fallback calendar', true, false)
    `);
      await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
         starts_on, ends_on, is_adjustment, custom)
      select ${julyPeriodId}, ${org.orgId}, ${calendarId},
             fiscal_year, period_number, 'Entity July 2026', starts_on, ends_on, false, '{}'::jsonb
        from accounting_periods
       where org_id = ${org.orgId} and id = ${org.periodId}
    `);
      await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
         starts_on, ends_on, is_adjustment, custom)
      values (${augustPeriodId}, ${org.orgId}, ${calendarId}, 2026, 8, 'Entity August 2026',
              '2026-08-01', '2026-08-31', false, '{}'::jsonb)
    `);
      await db.execute(sql`
      insert into subsidiary_accounting_preferences
        (org_id, subsidiary_id, effective_from, fiscal_calendar_id, reason, created_by)
      select ${org.orgId}, ${org.subsidiaryId}, starts_on, ${calendarId}, 'Entity void fallback calendar', ${actorId}
        from accounting_periods where org_id = ${org.orgId} and id = ${julyPeriodId}
    `);
      const { documentId } = await seedPostedJournal(org, actorId, "JE-VOID-FALLBACK-1", org.date);
      await setPeriodLockState({
        orgId: org.orgId,
        periodId: julyPeriodId,
        bookId: org.bookId,
        module: "gl",
        state: "closed",
        actorId,
        reason: "void fallback period-lock regression",
      });

      const suggestion = await suggestVoidReversalDate(db, org.orgId, {
        id: documentId,
        kind: "journal",
        documentDate: org.date,
        subsidiaryId: org.subsidiaryId,
      });
      assert.equal(suggestion.originalDate, org.date);
      assert.equal(
        suggestion.suggestedDate,
        "2026-08-01",
        "the default moves to the first open period",
      );
      assert.equal(suggestion.fallbackToOpenPeriod, true, "the move is flagged for its notice");
      assert.equal(suggestion.suggestedOpen, true);
      assert.equal(
        suggestion.originalPeriodName,
        "P07 FY2026",
        "periods are named by their fiscal label",
      );
      assert.equal(suggestion.suggestedPeriodName, "P08 FY2026");

      const outcome = await requestDocumentVoid({
        documentId,
        orgId: org.orgId,
        actorId,
        reason: "Closed-period reversal fallback control",
        source: "api",
      });
      assert.equal(outcome.status, "voided");
      const stored = (
        await db.execute<{ reversalDate: string; postingDate: string; periodId: string }>(
          sql`
      select d.void_reversal_date::text as "reversalDate", e.posting_date::text as "postingDate",
             e.period_id as "periodId"
        from documents d
        join journal_entries e on e.id = ${outcome.reversalEntryId} and e.org_id = d.org_id
       where d.id = ${documentId} and d.org_id = ${org.orgId}
    `,
          "objects",
        )
      )[0];
      assert.equal(
        stored?.reversalDate,
        null,
        "completion clears the void-request staging date (documents_void_request_evidence); the reversal entry below is the durable record",
      );
      assert.equal(
        stored?.postingDate,
        "2026-08-01",
        "the reversal posts in the first open period",
      );
      assert.equal(
        stored?.periodId,
        augustPeriodId,
        "the fallback stays on the subsidiary's fiscal calendar",
      );
      assert.equal(
        Number(await reversalSum(documentId, org.orgId, outcome.reversalEntryId!)),
        0,
        "the fallback reversal balances exactly (numeric text carries scale, e.g. 0.0000)",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("an explicit reversal date is honored in an open period", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Void Explicit Controller", "admin");
    const { documentId } = await seedPostedJournal(org, actorId, "JE-VOID-EXPLICIT-1", org.date);

    const outcome = await requestDocumentVoid({
      documentId,
      orgId: org.orgId,
      actorId,
      reason: "Explicit reversal date control",
      reversalDate: org.date,
      source: "api",
    });
    assert.equal(outcome.status, "voided");
    assert.ok(outcome.reversalEntryId, "the open entry period admits the reversal");
    const stored = (
      await db.execute<{ reversalDate: string | null; postingDate: string }>(
        sql`
      select d.void_reversal_date::text as "reversalDate", e.posting_date::text as "postingDate"
        from documents d
        join journal_entries e on e.id = ${outcome.reversalEntryId} and e.org_id = d.org_id
       where d.id = ${documentId} and d.org_id = ${org.orgId}
    `,
        "objects",
      )
    )[0];
    assert.equal(
      stored?.reversalDate,
      null,
      "completion clears the void-request staging date (documents_void_request_evidence); the reversal entry below is the durable record",
    );
    assert.equal(
      stored?.postingDate,
      org.date,
      "the named date reaches the reversal entry unchanged",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a reversal naming a closed period is refused with its remedy", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Void Refusal Controller", "admin");
    const { documentId } = await seedPostedJournal(org, actorId, "JE-VOID-REFUSED-1", org.date);
    await setPeriodLockState({
      orgId: org.orgId,
      periodId: org.periodId,
      bookId: org.bookId,
      module: "gl",
      state: "closed",
      actorId,
      reason: "void refusal period-lock regression",
    });

    await assert.rejects(
      requestDocumentVoid({
        documentId,
        orgId: org.orgId,
        actorId,
        reason: "Closed-period explicit reversal must refuse",
        reversalDate: org.date,
        source: "api",
      }),
      (error: unknown) =>
        error instanceof DocumentVoidError &&
        /reversal period for .* is closed/.test(error.message),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
