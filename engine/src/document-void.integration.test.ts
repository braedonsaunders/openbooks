import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { setPeriodLockState } from "./close.ts";
import { db } from "./db.ts";
import { deleteDocument } from "./document-delete.ts";
import { DocumentVoidError, requestDocumentVoid } from "./document-void.ts";
import { postDocument } from "./posting.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedApprovedQuote(
  org: ScratchOrg,
  actorId: string,
  documentNumber: string,
): Promise<string> {
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, currency, status, created_by)
    values (
      ${documentId}, ${org.orgId}, 'quote', ${documentNumber},
      ${org.customerId}, ${org.subsidiaryId}, ${org.date}, 'CAD',
      'approved', ${actorId}
    )
  `);
  return documentId;
}

function journalScriptSource(
  org: ScratchOrg,
  marker: string,
  opts: { pause?: boolean; abortAfterCreate?: boolean } = {},
): string {
  const input = JSON.stringify({
    documentDate: org.date,
    memo: `before_void artifact ${marker}`,
    referenceNumber: marker,
    lines: [
      { accountId: org.accounts.cogs, amount: "1" },
      { accountId: org.accounts.bank, amount: "-1" },
    ],
  });
  return `
    function main() {
      ${opts.pause ? `ob.query("select pg_sleep(0.25)::text as waited");` : ""}
      ob.journal.create(${input});
      ${opts.abortAfterCreate ? `ob.abort("forced failure after journal creation");` : ""}
    }
  `;
}

async function seedBeforeVoidScript(
  org: ScratchOrg,
  actorId: string,
  source: string,
): Promise<string> {
  const scriptId = randomUUID();
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(settings, '{features,scripts}', 'true'::jsonb, true)
     where id = ${org.orgId}
  `);
  await db.execute(sql`
    insert into user_scripts
      (id, org_id, name, trigger_point, document_kind, source,
       timeout_ms, sort_order, is_active, created_by)
    values (
      ${scriptId}, ${org.orgId}, 'Void journal probe', 'before_void',
      'quote', ${source}, 5000, 1, true, ${actorId}
    )
  `);
  return scriptId;
}

async function countRows(query: ReturnType<typeof sql>): Promise<number> {
  const result = await db.execute<{ count: number }>(query);
  return Number(result.rows[0]!.count);
}

async function seedPostedCheck(
  org: ScratchOrg,
  actorId: string,
  documentNumber: string,
): Promise<{ documentId: string; entryId: string }> {
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, subsidiary_id, document_date,
       posting_date, currency, status, subtotal, tax_total, total, created_by)
    values (
      ${documentId}, ${org.orgId}, 'check', ${documentNumber},
      ${org.subsidiaryId}, ${org.date}, ${org.date}, 'CAD', 'approved',
      '25', '0', '25', ${actorId}
    )
  `);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, subsidiary_id,
       quantity, unit_price, amount, tax_amount, created_by)
    values (
      ${org.orgId}, ${documentId}, 1, ${org.accounts.cogs},
      ${org.subsidiaryId}, '1', '25', '25', '0', ${actorId}
    )
  `);
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

test("a check void shares the source AP lock and leaves no effects when it is closed", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Cash Void Controller", "admin");
    const openCheck = await seedPostedCheck(org, actorId, "CHECK-VOID-OPEN-1");
    const lockedCheck = await seedPostedCheck(org, actorId, "CHECK-VOID-LOCKED-1");

    const control = await requestDocumentVoid({
      documentId: openCheck.documentId,
      orgId: org.orgId,
      actorId,
      reason: "Open-period check void control",
      reversalDate: org.date,
      source: "api",
    });
    assert.equal(control.status, "voided");
    assert.ok(control.reversalEntryId, "the open AP period admits the check reversal");

    await setPeriodLockState({
      orgId: org.orgId,
      periodId: org.periodId,
      bookId: org.bookId,
      module: "ap",
      state: "closed",
      actorId,
      reason: "cash void period-lock regression",
    });

    await assert.rejects(
      requestDocumentVoid({
        documentId: lockedCheck.documentId,
        orgId: org.orgId,
        actorId,
        reason: "Closed AP period must refuse this check void",
        reversalDate: org.date,
        source: "api",
      }),
      (error: unknown) =>
        error instanceof DocumentVoidError && /AP is closed/.test(error.message),
    );

    const refused = await db.execute<{
      document_status: string;
      void_requested_at: Date | null;
      reversal_entry_id: string | null;
      source_entry_status: string;
      reversal_count: number;
      void_audit_count: number;
    }>(sql`
      select document.status as document_status,
             document.void_requested_at,
             document.reversal_entry_id,
             source_entry.status as source_entry_status,
             (select count(*)::int
                from journal_entries reversal
               where reversal.org_id = ${org.orgId}
                 and reversal.reverses_entry_id = ${lockedCheck.entryId}) as reversal_count,
             (select count(*)::int
                from audit_log audit
               where audit.org_id = ${org.orgId}
                 and audit.table_name = 'documents'
                 and audit.row_id = ${lockedCheck.documentId}
                 and (audit.action = 'void'
                      or audit.changes->>'mode' = 'void_request')) as void_audit_count
        from documents document
        join journal_entries source_entry
          on source_entry.id = document.posted_entry_id
         and source_entry.org_id = document.org_id
       where document.id = ${lockedCheck.documentId}
         and document.org_id = ${org.orgId}
    `);
    assert.deepEqual(refused.rows[0], {
      document_status: "posted",
      void_requested_at: null,
      reversal_entry_id: null,
      source_entry_status: "posted",
      reversal_count: 0,
      void_audit_count: 0,
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("controlled void preserves the source and posts an exact open-period reversal", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Void Controller", "admin");
    const documentId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, subsidiary_id,
         document_date, posting_date, currency, fx_rate, status,
         subtotal, tax_total, total, created_by)
      values (
        ${documentId}, ${org.orgId}, 'vendor_bill', 'BILL-VOID-1',
        ${org.vendorId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
        'CAD', '1', 'approved', '125', '0', '125', ${actorId}
      )
    `);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity,
         unit_price, amount, tax_amount, created_by)
      values (
        ${org.orgId}, ${documentId}, 1, ${org.accounts.cogs}, '1',
        '125', '125', '0', ${actorId}
      )
    `);
    const sourceEntryId = await postDocument(
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
    await assert.rejects(
      deleteDocument(documentId, actorId, org.orgId),
      /cannot be deleted.*controlled void/i,
    );

    const result = await requestDocumentVoid({
      documentId,
      orgId: org.orgId,
      actorId,
      reason: "Duplicate vendor invoice entered in error",
      reversalDate: org.date,
      source: "api",
    });
    assert.equal(result.status, "voided");
    assert.ok(result.reversalEntryId);

    const document = (await db.execute<{
        status: string;
        posted_entry_id: string;
        reversal_entry_id: string;
        voided_by: string;
        void_reason: string;
        void_requested_at: Date | null;
      }>(sql`
      select status, posted_entry_id, reversal_entry_id, voided_by,
             void_reason, void_requested_at
        from documents
       where id = ${documentId}
    `));
    assert.deepEqual(document.rows[0], {
      status: "voided",
      posted_entry_id: sourceEntryId,
      reversal_entry_id: result.reversalEntryId,
      voided_by: actorId,
      void_reason: "Duplicate vendor invoice entered in error",
      void_requested_at: null,
    });

    const accounting = (await db.execute<{
        source_status: string;
        reversal_status: string;
        reverses_entry_id: string;
        source_balance: string;
        reversal_balance: string;
        exact_mirror: boolean;
      }>(sql`
      select
        source.status as source_status,
        reversal.status as reversal_status,
        reversal.reverses_entry_id,
        coalesce((
          select sum(amount) from journal_lines where entry_id = source.id
        ), 0) as source_balance,
        coalesce((
          select sum(amount) from journal_lines where entry_id = reversal.id
        ), 0) as reversal_balance,
        not exists (
          select 1
            from journal_lines source_line
            left join journal_lines reversal_line
              on reversal_line.entry_id = reversal.id
             and reversal_line.line_number = source_line.line_number
           where source_line.entry_id = source.id
             and (
               reversal_line.id is null
               or source_line.amount <> -reversal_line.amount
             )
        )
        and (
          select count(*) from journal_lines where entry_id = source.id
        ) = (
          select count(*) from journal_lines where entry_id = reversal.id
        ) as exact_mirror
      from journal_entries source
      join journal_entries reversal on reversal.id = ${result.reversalEntryId}
     where source.id = ${sourceEntryId}
    `));
    assert.deepEqual(accounting.rows[0], {
      source_status: "reversed",
      reversal_status: "posted",
      reverses_entry_id: sourceEntryId,
      source_balance: "0.0000",
      reversal_balance: "0.0000",
      exact_mirror: true,
    });

    const audit = (await db.execute<{ mode: string; reason: string }>(sql`
      select changes->>'mode' as mode,
             changes->>'reason' as reason
        from audit_log
       where org_id = ${org.orgId}
         and table_name = 'documents'
         and row_id = ${documentId}
         and action = 'void'
       order by at desc
       limit 1
    `));
    assert.deepEqual(audit.rows[0], {
      mode: "transaction_void",
      reason: "Duplicate vendor invoice entered in error",
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("concurrent void contenders commit one before_void journal from the claimed request", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Concurrent Void Controller", "admin");
    const documentId = await seedApprovedQuote(org, actorId, "QUOTE-VOID-RACE-1");
    const marker = `void-race-${randomUUID()}`;
    const scriptId = await seedBeforeVoidScript(
      org,
      actorId,
      journalScriptSource(org, marker, { pause: true }),
    );

    const settled = await Promise.allSettled(
      Array.from({ length: 2 }, (_, index) => requestDocumentVoid({
        documentId,
        orgId: org.orgId,
        actorId,
        reason: `Concurrent void request ${index + 1}`,
        reversalDate: org.date,
        source: "api",
      })),
    );

    const fulfilled = settled.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof requestDocumentVoid>>> =>
        result.status === "fulfilled",
    );
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.equal(fulfilled.length, 1, "one request owns the void claim");
    assert.equal(rejected.length, 1, "the duplicate request loses before scripts run");
    assert.equal(fulfilled[0]!.value.status, "voided");
    assert.ok(rejected[0]!.reason instanceof DocumentVoidError);

    const source = await db.execute<{
      status: string;
      void_requested_at: Date | null;
    }>(sql`
      select status, void_requested_at
        from documents
       where id = ${documentId} and org_id = ${org.orgId}
    `);
    assert.deepEqual(source.rows[0], { status: "voided", void_requested_at: null });
    assert.equal(
      await countRows(sql`
        select count(*)::int as count
          from script_runs
         where org_id = ${org.orgId}
           and script_id = ${scriptId}
           and target_id = ${documentId}
           and status = 'ok'
      `),
      1,
      "only the claimed request executes before_void",
    );
    assert.equal(
      await countRows(sql`
        select count(*)::int as count
          from documents
         where org_id = ${org.orgId}
           and kind = 'journal'
           and reference_number = ${marker}
           and status = 'draft'
      `),
      1,
      "one claimed request commits one draft journal",
    );
    assert.equal(
      await countRows(sql`
        select count(*)::int as count
          from document_lines line
          join documents journal
            on journal.id = line.document_id and journal.org_id = line.org_id
         where journal.org_id = ${org.orgId}
           and journal.kind = 'journal'
           and journal.reference_number = ${marker}
      `),
      2,
      "the sole journal artifact is complete and balanced",
    );
    assert.equal(
      await countRows(sql`
        select count(*)::int as count
          from audit_log
         where org_id = ${org.orgId}
           and table_name = 'documents'
           and row_id = ${documentId}
           and action = 'update'
           and changes->>'mode' = 'void_request'
      `),
      1,
      "the winning claim has one durable request audit",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a stale exact-revision token refuses the void before any before_void effect", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Fenced Void Controller", "admin");
    const documentId = await seedApprovedQuote(org, actorId, "QUOTE-VOID-FENCE-1");
    await seedBeforeVoidScript(org, actorId, journalScriptSource(org, `void-fence-${randomUUID()}`));

    const storedUpdatedAt = (
      await db.execute<{ updated_at: Date | string }>(sql`
        select updated_at
          from documents
         where id = ${documentId} and org_id = ${org.orgId}
      `)
    ).rows[0]!.updated_at;
    // The client echoes documents.updated_at as an ISO string truncated to
    // milliseconds; both sides of the fence compare at that precision.
    const exactToken = new Date(new Date(storedUpdatedAt as string).getTime()).toISOString();
    const staleToken = new Date(new Date(exactToken).getTime() - 3_600_000).toISOString();

    await assert.rejects(
      requestDocumentVoid({
        documentId,
        orgId: org.orgId,
        actorId,
        reason: "Stale view must not cancel this document",
        reversalDate: org.date,
        source: "api",
        expectedUpdatedAt: staleToken,
      }),
      /changed after you opened it/,
    );

    // The refusal leaves the issued document exactly as it was: no claim, no
    // request audit, and not one before_void effect.
    const refused = (await db.execute<{
      status: string;
      void_requested_at: Date | null;
    }>(sql`
      select status, void_requested_at
        from documents
       where id = ${documentId} and org_id = ${org.orgId}
    `));
    assert.deepEqual(refused.rows[0], { status: "approved", void_requested_at: null });
    assert.equal(
      await countRows(sql`
        select count(*)::int as count
          from audit_log
         where org_id = ${org.orgId}
           and table_name = 'documents'
           and row_id = ${documentId}
           and changes->>'mode' = 'void_request'
      `),
      0,
      "the stale request wrote no void-request audit",
    );
    assert.equal(
      await countRows(sql`
        select count(*)::int as count
          from script_runs
         where org_id = ${org.orgId} and target_id = ${documentId}
      `),
      0,
      "no before_void script ran against the stale view",
    );

    // The stored revision admits the very same void.
    const result = await requestDocumentVoid({
      documentId,
      orgId: org.orgId,
      actorId,
      reason: "Current revision completes normally",
      reversalDate: org.date,
      source: "api",
      expectedUpdatedAt: exactToken,
    });
    assert.equal(result.status, "voided");
    assert.equal(
      await countRows(sql`
        select count(*)::int as count
          from script_runs
         where org_id = ${org.orgId}
           and target_id = ${documentId}
           and status = 'ok'
      `),
      1,
      "the fenced retry from the current revision runs before_void once",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a failed before_void effect rolls back its claim and journal before a safe retry", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Retrying Void Controller", "admin");
    const documentId = await seedApprovedQuote(org, actorId, "QUOTE-VOID-RETRY-1");
    const marker = `void-retry-${randomUUID()}`;
    const scriptId = await seedBeforeVoidScript(
      org,
      actorId,
      journalScriptSource(org, marker, { abortAfterCreate: true }),
    );

    await assert.rejects(
      requestDocumentVoid({
        documentId,
        orgId: org.orgId,
        actorId,
        reason: "Test rollback after a script veto",
        reversalDate: org.date,
        source: "api",
      }),
      (error: unknown) =>
        error instanceof DocumentVoidError
        && /forced failure after journal creation/.test(error.message),
    );

    const afterFailure = await db.execute<{
      status: string;
      void_requested_at: Date | null;
      void_requested_by: string | null;
      void_reversal_date: string | null;
    }>(sql`
      select status, void_requested_at, void_requested_by,
             void_reversal_date::text as void_reversal_date
        from documents
       where id = ${documentId} and org_id = ${org.orgId}
    `);
    assert.deepEqual(afterFailure.rows[0], {
      status: "approved",
      void_requested_at: null,
      void_requested_by: null,
      void_reversal_date: null,
    });
    assert.equal(
      await countRows(sql`
        select count(*)::int as count
          from documents
         where org_id = ${org.orgId}
           and kind = 'journal'
           and reference_number = ${marker}
      `),
      0,
      "the veto rolls the material script effect back",
    );
    assert.equal(
      await countRows(sql`
        select count(*)::int as count
          from script_runs
         where org_id = ${org.orgId}
           and script_id = ${scriptId}
           and target_id = ${documentId}
      `),
      0,
      "the failed command leaves no committed script-attempt state",
    );

    await db.execute(sql`
      update user_scripts
         set source = ${journalScriptSource(org, marker)}, updated_at = now()
       where id = ${scriptId} and org_id = ${org.orgId}
    `);
    const retry = await requestDocumentVoid({
      documentId,
      orgId: org.orgId,
      actorId,
      reason: "Retry after the script was corrected",
      reversalDate: org.date,
      source: "api",
    });
    assert.equal(retry.status, "voided");
    assert.equal(
      await countRows(sql`
        select count(*)::int as count
          from documents
         where org_id = ${org.orgId}
           and kind = 'journal'
           and reference_number = ${marker}
           and status = 'draft'
      `),
      1,
      "the clean retry commits exactly one journal",
    );
    assert.equal(
      await countRows(sql`
        select count(*)::int as count
          from script_runs
         where org_id = ${org.orgId}
           and script_id = ${scriptId}
           and target_id = ${documentId}
           and status = 'ok'
      `),
      1,
      "the successful retry has one committed script audit",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
