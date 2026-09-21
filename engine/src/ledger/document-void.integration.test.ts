import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { setPeriodLockState } from "../close/period-locks.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
import { deleteDocument } from "./document-delete.ts";
import { DocumentVoidError, requestDocumentVoid } from "./document-void.ts";
import { submitForApproval } from "../flows/submit.ts";
import { postDocument } from "./posting-document.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedApprovalFlow,
  seedDraftDocument,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";

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
  // before_void probes that call ob.query (pg_sleep) need the same gates
  // as /api/query. scripts alone is not enough — queryConsole is default-off.
  const enabled = await db.execute<{ id: string }>(sql`
    update orgs
       set settings = jsonb_set(
         jsonb_set(coalesce(settings, '{}'::jsonb), '{features,scripts}', 'true'::jsonb, true),
         '{features,queryConsole}', 'true'::jsonb, true)
     where id = ${org.orgId}
     returning id
  `);
  if (!enabled.rows[0]) {
    throw new Error(`scripts/queryConsole feature write matched 0 rows for org ${org.orgId}`);
  }
  // The probe calls ob.query AND ob.journal.create, and those are separate
  // grants: sql.execute for the query, gl.post for the write. The journal
  // grant is not decoration -- a script that posts to the ledger is held to
  // the same permission a human posting one is, so a fixture that omits it
  // gets the refusal rather than the behaviour it means to exercise.
  const granted = await db.execute<{ id: string }>(sql`
    update app_roles
       set permissions = coalesce(permissions, '[]'::jsonb) || '["sql.execute", "gl.post"]'::jsonb
     where org_id = ${org.orgId}
       and id in (select role_id from role_assignments where org_id = ${org.orgId} and user_id = ${actorId})
     returning id
  `);
  if (!granted.rows[0]) {
    throw new Error(`sql.execute/gl.post grant matched 0 roles for actor ${actorId}`);
  }
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

/** Poll until the expected number of document lifecycle commands waits on a row lock. */
async function waitForDocumentLockWaiters(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const waiting = await db.execute<{ count: number }>(sql`
      select count(*)::int as count
        from pg_stat_activity
       where datname = current_database()
         and state = 'active'
         and wait_event_type = 'Lock'
         and query ilike '%documents%'
         and query ilike '%for update%'`);
    if (Number(waiting.rows[0]?.count ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${expected} document lock waiter(s)`);
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
      ${org.subsidiaryId}, ${org.date}, ${org.date}, 'CAD', 'draft',
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
  await db.execute(sql`
    update documents
       set status = 'approved', updated_at = now()
     where id = ${documentId} and org_id = ${org.orgId}
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
        'CAD', '1', 'draft', '125', '0', '125', ${actorId}
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
    await db.execute(sql`
      update documents
         set status = 'approved', updated_at = now()
       where id = ${documentId} and org_id = ${org.orgId}
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

test("delete and submit serialize on the document row before approval gates commit", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  let releaseHolder = () => {};
  let holder: Promise<void> | undefined;
  try {
    const actors = await seedFlowActors(org.orgId);
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    const documentId = await seedDraftDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: actors.submitterId,
    });

    let rowLocked!: () => void;
    const lockReady = new Promise<void>((resolve) => {
      rowLocked = resolve;
    });
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    holder = withOrgTransaction(org.orgId, async () => {
      await db.execute(sql`
        select id
          from documents
         where id = ${documentId} and org_id = ${org.orgId}
         for update`);
      rowLocked();
      await holderReleased;
    });
    await lockReady;

    // Queue submission first, then deletion, behind the same held row lock.
    // Releasing the holder lets PostgreSQL grant the lock in queue order.
    const submitting = submitForApproval("vendor_bill", documentId, actors.submitterId);
    await waitForDocumentLockWaiters(1);
    const deleting = deleteDocument(documentId, actors.submitterId, org.orgId, { source: "test" });
    await waitForDocumentLockWaiters(2);
    releaseHolder();

    const [submitted, deleted] = await Promise.allSettled([submitting, deleting]);
    if (submitted.status !== "fulfilled") throw submitted.reason;
    assert.equal(submitted.value.gated, true, "submission creates the approval gate");
    if (deleted.status !== "rejected") {
      assert.fail("deletion unexpectedly committed after submission acquired the row lock");
    }
    assert.match(String(deleted.reason), /cannot be deleted.*controlled void/i);
    assert.equal(
      await countRows(sql`
        select count(*)::int as count
          from documents
         where id = ${documentId}
           and org_id = ${org.orgId}
           and status = 'pending_approval'`),
      1,
      "the submitted document remains as immutable approval evidence",
    );
    assert.equal(
      await countRows(sql`
        select count(*)::int as count
          from flow_gates
         where subject_id = ${documentId}
           and org_id = ${org.orgId}
           and status = 'pending'`),
      1,
      "the approval gate is not orphaned by the rejected deletion",
    );
    assert.equal(
      await countRows(sql`
        select count(*)::int as count
          from audit_log
         where org_id = ${org.orgId}
           and table_name = 'documents'
           and row_id = ${documentId}
           and action = 'delete'`),
      0,
      "the rejected deletion leaves no physical-delete audit record",
    );
  } finally {
    releaseHolder();
    await holder?.catch(() => {});
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
      await db.execute<{ updated_at: string }>(sql`
        select (revision_seq)::text as updated_at
          from documents
         where id = ${documentId} and org_id = ${org.orgId}
      `)
    ).rows[0]!.updated_at;
    const exactToken = storedUpdatedAt;
    // A counter token goes stale by advancing one revision past it.
    const staleToken = String(Number(exactToken) + 1);
    assert.notEqual(staleToken, exactToken);

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

test("voiding a quote with a live sales order is fenced without mutation", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Order Void Controller", "admin");
    const quoteId = await seedApprovedQuote(org, actorId, "QUOTE-VOID-FENCE-1");
    const salesOrderId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, subsidiary_id,
         document_date, currency, status, created_by)
      values (
        ${salesOrderId}, ${org.orgId}, 'sales_order', 'SO-VOID-FENCE-1',
        ${org.customerId}, ${org.subsidiaryId}, ${org.date}, 'CAD',
        'approved', ${actorId}
      )
    `);
    await db.execute(sql`
      insert into document_links
        (org_id, from_document_id, to_document_id, link_type, created_by)
      values (${org.orgId}, ${quoteId}, ${salesOrderId}, 'created_from', ${actorId})
    `);

    await assert.rejects(
      requestDocumentVoid({
        documentId: quoteId,
        orgId: org.orgId,
        actorId,
        reason: "Probe void fenced quote",
        reversalDate: org.date,
        source: "api",
      }),
      (error: unknown) =>
        error instanceof DocumentVoidError
        && /feeds .* reverse the downstream transaction first/.test(error.message),
    );
    const fenced = await db.execute<{
      status: string;
      void_requested_at: Date | null;
    }>(sql`
      select status, void_requested_at from documents
       where id = ${quoteId} and org_id = ${org.orgId}
    `);
    assert.equal(fenced.rows[0]!.status, "approved");
    assert.equal(fenced.rows[0]!.void_requested_at, null);

    // With the downstream order voided, the quote itself voids cleanly.
    const orderVoided = await requestDocumentVoid({
      documentId: salesOrderId,
      orgId: org.orgId,
      actorId,
      reason: "Downstream order cancelled",
      reversalDate: org.date,
      source: "api",
    });
    assert.equal(orderVoided.status, "voided");
    const quoteVoided = await requestDocumentVoid({
      documentId: quoteId,
      orgId: org.orgId,
      actorId,
      reason: "Quote cancelled after order void",
      reversalDate: org.date,
      source: "api",
    });
    assert.equal(quoteVoided.status, "voided");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a void refuses cleanly when an application writer holds the entry's lines", { skip: !DB }, async () => {
  // The void's live-application and reconciliation guards are only truthful
  // if no application writer can commit between those reads and the reversal
  // writes, so the void takes the same endpoint row locks every application
  // insert takes — with NOWAIT. A blocking lock would deadlock against those
  // writers (their open-balance trigger locks the document row this void
  // already holds), so contention fails fast with a retryable refusal and
  // the retry after the writer commits sees the settled state.
  const org = await createScratchOrg();
  let releaseHolder: (() => void) | undefined;
  try {
    const actorId = await createScratchUser(org.orgId, "Void Race Controller", "admin");
    const { documentId, entryId } = await seedPostedCheck(org, actorId, "CHECK-VOID-ENDPOINT-RACE-1");
    const voidInput = {
      documentId,
      orgId: org.orgId,
      actorId,
      reason: "Void refuses while endpoints are written",
      reversalDate: org.date,
      source: "api" as const,
    };

    let endpointsHeld!: () => void;
    const endpointsReady = new Promise<void>((resolve) => {
      endpointsHeld = resolve;
    });
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = withOrgTransaction(org.orgId, async () => {
      await db.execute(sql`
        select id from journal_lines where entry_id = ${entryId} order by id for update`);
      endpointsHeld();
      await holderReleased;
    });
    holder.catch(() => {});
    await endpointsReady;

    // A blocking pre-lock would park here until the holder releases; the
    // NOWAIT pre-lock must refuse within the timeout instead.
    const contended = await Promise.race([
      requestDocumentVoid(voidInput).then(
        () => ({ settled: true as const }),
        (error: unknown) => ({ settled: true as const, error }),
      ),
      new Promise<{ settled: false }>((resolve) => setTimeout(() => resolve({ settled: false }), 2500)),
    ]);
    assert.ok(contended.settled, "the void must not wait on the in-flight endpoint writer");
    assert.ok("error" in contended, "the void must refuse while the endpoints are written");
    assert.ok(contended.error instanceof DocumentVoidError, String(contended.error));
    assert.match(String(contended.error), /in flight/);
    assert.equal((contended.error as DocumentVoidError).status, 409);
    releaseHolder?.();
    await holder;

    // The retry once the writer commits voids normally.
    const retried = await requestDocumentVoid({ ...voidInput, reason: "Void retry after writer commits" });
    assert.equal(retried.status, "voided");
  } finally {
    releaseHolder?.();
    await dropScratchOrg(org.orgId);
  }
});
