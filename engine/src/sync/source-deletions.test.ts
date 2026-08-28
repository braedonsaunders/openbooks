import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { postDocument } from "../posting.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../test-fixtures.ts";
import { resolveSourceDeletion } from "./source-deletions.ts";

const source = readFileSync("engine/src/sync/source-deletions.ts", "utf8");
const DB = !!process.env.OPENBOOKS_DB_URL;

test("automatic source deletions preserve settlement evidence", () => {
  const automatic = source.slice(
    source.indexOf("export async function mirrorSourceDeletion"),
    source.indexOf("export async function resolveSourceDeletion"),
  );
  assert.match(automatic, /update applications a[\s\S]*unapplied_at = now\(\)/);
  assert.doesNotMatch(automatic, /delete from applications/i);
  assert.match(automatic, /captureTransactionAuditSnapshot\(tx, document\.id, input\.orgId\)/);
  assert.doesNotMatch(automatic, /captureTransactionAuditSnapshot\(tx, document\.id\)/);
  assert.match(automatic, /recordTransactionAudit\(tx,/);
  assert.doesNotMatch(automatic, /delete from documents/i);
});

test("automatic source deletions reverse in the original accounting period", () => {
  const automatic = source.slice(
    source.indexOf("export async function mirrorSourceDeletion"),
    source.indexOf("export async function resolveSourceDeletion"),
  );
  assert.match(automatic, /postingDate: entry\.postingDate/);
  assert.match(automatic, /periodId: entry\.periodId/);
  assert.match(automatic, /status: "reversed"/);
  assert.match(automatic, /status = 'voided'/);
  assert.match(automatic, /open_balance = null/);
});

test("unposted source deletions are preserved as audited voids", () => {
  const automatic = source.slice(
    source.indexOf("export async function mirrorSourceDeletion"),
    source.indexOf("export async function resolveSourceDeletion"),
  );
  assert.match(
    automatic,
    /if \(!document\.posted_entry_id\)[\s\S]*status = 'voided'[\s\S]*recordTransactionAudit/,
  );
});

test("controller resolutions validate the actor and audit both decision and document", () => {
  const controlled = source.slice(
    source.indexOf("export async function resolveSourceDeletion"),
  );
  assert.match(controlled, /resolution actor is not an active organization user/);
  assert.match(controlled, /'source_deletion_resolutions'/);
  assert.match(controlled, /previousResolution/);
  assert.match(controlled, /currentResolution/);
});

test("controller source-deletion reversals run every write in one transaction", () => {
  const controlled = source.slice(
    source.indexOf("export async function resolveSourceDeletion"),
  );
  assert.match(
    controlled,
    /return withOrg\(input\.orgId, async \(\) => db\.transaction\(async \(tx\) => \{/,
  );
  assert.doesNotMatch(controlled, /\bdb\.(?:execute|select|insert|update)\b/);
  assert.match(controlled, /recordTransactionAudit\(tx,/);
});

test(
  "failed source-deletion resolution rolls back reversal, status, applications, and audit before an exactly-once retry",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const suffix = org.orgId.replaceAll("-", "").slice(0, 12);
    const functionName = `openbooks_test_fail_source_delete_${suffix}`;
    const triggerName = `openbooks_test_fail_source_delete_${suffix}`;
    const removeFailure = async (): Promise<void> => {
      await db.execute(
        sql.raw(
          `drop trigger if exists ${triggerName} on public.audit_log`,
        ),
      );
      await db.execute(
        sql.raw(`drop function if exists public.${functionName}()`),
      );
    };

    try {
      const actorId = await createScratchUser(
        org.orgId,
        "Source Deletion Rollback Controller",
        "admin",
      );
      const connectionId = randomUUID();
      const documentId = randomUUID();
      const sourceRef = `rollback-${randomUUID()}`;
      await db.execute(sql`
        insert into connections
          (id, org_id, source, display_name, status)
        values (
          ${connectionId}, ${org.orgId}, 'netsuite',
          'Source-deletion rollback test', 'active'
        )`);
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, currency, fx_rate, subtotal, tax_total, total, custom)
        values (
          ${documentId}, ${org.orgId}, 'customer_invoice', 'draft',
          'INV-SOURCE-DELETE-ROLLBACK', ${org.subsidiaryId}, ${org.customerId},
          ${org.date}, 'CAD', '1', '100', '0', '100',
          ${JSON.stringify({ nsId: sourceRef })}::jsonb
        )`);
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price,
           amount, tax_amount, tax_input_amount)
        values (
          ${org.orgId}, ${documentId}, 1, ${org.accounts.revenue}, '1', '100',
          '100', '0', '0'
        )`);
      await db.execute(sql`
        update documents
           set status = 'approved'
         where id = ${documentId} and org_id = ${org.orgId}
      `);
      await postDocument(documentId, {
        control: {
          ar: org.accounts.ar,
          ap: org.accounts.ap,
          bank: org.accounts.bank,
        },
      });

      await db.execute(
        sql.raw(`
          create function public.${functionName}() returns trigger
          language plpgsql as $$
          begin
            if new.org_id = '${org.orgId}'::uuid
               and new.table_name = 'source_deletion_resolutions'
               and new.request_id = 'source-deletion-resolution' then
              raise exception 'forced source-deletion resolution audit failure';
            end if;
            return new;
          end
          $$
        `),
      );
      await db.execute(
        sql.raw(`
          create trigger ${triggerName}
          before insert on public.audit_log
          for each row
          execute function public.${functionName}()
        `),
      );

      await assert.rejects(
        () =>
          resolveSourceDeletion({
            orgId: org.orgId,
            connectionId,
            sourceRef,
            action: "void",
            actorId,
            note: "Force rollback after reversal and audit work",
        }),
        (error: unknown) =>
          /forced source-deletion resolution audit failure/.test(
            `${String((error as Error)?.message ?? error)} ${String((error as Error & { cause?: unknown })?.cause ?? "")}`,
          ),
      );

      const afterFailure = (
        await db.execute<{
          document_status: string;
          document_reversal_entry_id: string | null;
          original_status: string;
          reversal_count: number;
          application_count: number;
          resolution_count: number;
          document_audit_count: number;
          resolution_audit_count: number;
        }>(sql`
          select d.status as document_status,
                 d.reversal_entry_id as document_reversal_entry_id,
                 original.status as original_status,
                 (
                   select count(*)::int
                     from journal_entries reversal
                    where reversal.org_id = ${org.orgId}
                      and reversal.reverses_entry_id = original.id
                 ) as reversal_count,
                 (
                   select count(*)::int
                     from applications a
                    where a.org_id = ${org.orgId}
                      and (
                        a.from_line_id in (
                          select id from journal_lines
                           where entry_id = original.id and org_id = ${org.orgId}
                        )
                        or a.to_line_id in (
                          select id from journal_lines
                           where entry_id = original.id and org_id = ${org.orgId}
                        )
                      )
                 ) as application_count,
                 (
                   select count(*)::int
                     from source_deletion_resolutions r
                    where r.org_id = ${org.orgId}
                      and r.connection_id = ${connectionId}
                      and r.source_ref = ${sourceRef}
                 ) as resolution_count,
                 (
                   select count(*)::int
                     from audit_log a
                    where a.org_id = ${org.orgId}
                      and a.table_name = 'documents'
                      and a.row_id = ${documentId}
                      and a.request_id = 'source-deletion-resolution'
                 ) as document_audit_count,
                 (
                   select count(*)::int
                     from audit_log a
                    where a.org_id = ${org.orgId}
                      and a.table_name = 'source_deletion_resolutions'
                      and a.request_id = 'source-deletion-resolution'
                 ) as resolution_audit_count
            from documents d
            join journal_entries original
              on original.id = d.posted_entry_id and original.org_id = d.org_id
           where d.id = ${documentId} and d.org_id = ${org.orgId}
        `)
      ).rows[0];
      assert.deepEqual(afterFailure, {
        document_status: "posted",
        document_reversal_entry_id: null,
        original_status: "posted",
        reversal_count: 0,
        application_count: 0,
        resolution_count: 0,
        document_audit_count: 0,
        resolution_audit_count: 0,
      });

      await removeFailure();
      const retry = await resolveSourceDeletion({
        orgId: org.orgId,
        connectionId,
        sourceRef,
        action: "void",
        actorId,
        note: "Retry after rollback",
      });
      assert.equal(retry.documentId, documentId);
      assert.equal(retry.action, "void");
      assert.ok(retry.reversalEntryId);

      const afterRetry = (
        await db.execute<{
          document_status: string;
          original_status: string;
          reversal_count: number;
          resolution_count: number;
          document_audit_count: number;
          resolution_audit_count: number;
        }>(sql`
          select d.status as document_status,
                 original.status as original_status,
                 (
                   select count(*)::int
                     from journal_entries reversal
                    where reversal.org_id = ${org.orgId}
                      and reversal.reverses_entry_id = original.id
                 ) as reversal_count,
                 (
                   select count(*)::int
                     from source_deletion_resolutions r
                    where r.org_id = ${org.orgId}
                      and r.connection_id = ${connectionId}
                      and r.source_ref = ${sourceRef}
                 ) as resolution_count,
                 (
                   select count(*)::int
                     from audit_log a
                    where a.org_id = ${org.orgId}
                      and a.table_name = 'documents'
                      and a.row_id = ${documentId}
                      and a.request_id = 'source-deletion-resolution'
                 ) as document_audit_count,
                 (
                   select count(*)::int
                     from audit_log a
                    where a.org_id = ${org.orgId}
                      and a.table_name = 'source_deletion_resolutions'
                      and a.request_id = 'source-deletion-resolution'
                 ) as resolution_audit_count
            from documents d
            join journal_entries original
              on original.id = d.posted_entry_id and original.org_id = d.org_id
           where d.id = ${documentId} and d.org_id = ${org.orgId}
        `)
      ).rows[0];
      assert.deepEqual(afterRetry, {
        document_status: "voided",
        original_status: "reversed",
        reversal_count: 1,
        resolution_count: 1,
        document_audit_count: 1,
        resolution_audit_count: 1,
      });
    } finally {
      await removeFailure();
      await dropScratchOrg(org.orgId);
    }
  },
);

test("resolution upserts pin the known tenant on the connection_id/source_ref conflict write", () => {
  const controlled = source.slice(
    source.indexOf("export async function resolveSourceDeletion"),
  );
  assert.match(
    controlled,
    /on conflict \(connection_id, source_ref\) do update set[\s\S]*?where source_deletion_resolutions\.org_id = \$\{input\.orgId\}/,
  );
});
