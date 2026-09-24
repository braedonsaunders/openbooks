import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { postDocument } from "../ledger/posting-document.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import {
  mirrorSourceDeletion,
  resolveSourceDeletion,
} from "./source-deletions.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "source deletion atomically reverses posted accounting and preserves complete evidence",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const connectionId = randomUUID();
      const documentId = randomUUID();
      const sourceRef = `posted-${randomUUID()}`;
      await db.execute(sql`
        insert into connections
          (id, org_id, source, display_name, status)
        values (
          ${connectionId}, ${org.orgId}, 'netsuite',
          'NetSuite posted source-deletion test', 'active'
        )`);
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, currency, fx_rate, subtotal, tax_total, total, custom)
        values (
          ${documentId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-SOURCE-DELETE',
          ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
          '100', '0', '100', ${JSON.stringify({ nsId: sourceRef, connectionId })}::jsonb
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
           set status = 'approved', updated_at = now()
         where id = ${documentId} and org_id = ${org.orgId}
      `);
      await postDocument(documentId, {
        control: {
          ar: org.accounts.ar,
          ap: org.accounts.ap,
          bank: org.accounts.bank,
        },
      });

      const result = await mirrorSourceDeletion({
        orgId: org.orgId,
        source: "netsuite",
        sourceRef,
        connectionId,
      });
      assert.deepEqual(result, { documentId, deleted: true });

      const evidence = (await db.execute<{
          document_status: string;
          open_balance: string | null;
          original_status: string;
          reversal_in_original_period: boolean;
          reversal_count: number;
          reversal_total: string;
          void_evidence_complete: boolean;
          audited_reversal_count: number;
        }>(sql`
        select d.status as document_status, d.open_balance::text,
               original.status as original_status,
               bool_and(reversal.period_id = original.period_id) as reversal_in_original_period,
               count(distinct reversal.id)::int as reversal_count,
               coalesce(sum(reversal_line.amount), 0)::text as reversal_total,
               bool_and(
                 d.voided_by is not null
                 and length(btrim(d.void_reason)) >= 5
                 and d.reversal_entry_id = reversal.id
               ) as void_evidence_complete,
               (
                 select jsonb_array_length(a.changes #> '{after,glImpact,reversals}')
                   from audit_log a
                  where a.org_id = ${org.orgId}
                    and a.table_name = 'documents'
                    and a.row_id = ${documentId}
                    and a.request_id = 'mirror'
                  order by a.at desc
                  limit 1
               ) as audited_reversal_count
          from documents d
          join journal_entries original on original.id = d.posted_entry_id
          left join journal_entries reversal
            on reversal.reverses_entry_id = original.id
          left join journal_lines reversal_line
            on reversal_line.entry_id = reversal.id
         where d.id = ${documentId}
         group by d.status, d.open_balance, original.status
      `));
      assert.deepEqual(evidence.rows[0], {
        document_status: "voided",
        open_balance: null,
        original_status: "reversed",
        reversal_in_original_period: true,
        reversal_count: 1,
        reversal_total: "0.0000",
        void_evidence_complete: true,
        audited_reversal_count: 1,
      });

      const repeat = await mirrorSourceDeletion({
        orgId: org.orgId,
        source: "netsuite",
        sourceRef,
        connectionId,
      });
      assert.deepEqual(repeat, { documentId, deleted: false });
      const reversalCount = (await db.execute<{ count: number }>(sql`
        select count(*)::int as count
          from journal_entries
         where reverses_entry_id = (
           select posted_entry_id from documents where id = ${documentId}
         )
      `));
      assert.equal(reversalCount.rows[0]?.count, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "unposted automatic and controller source deletions are voided and audited without a journal",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Source Deletion Controller", "admin");
      const connectionId = randomUUID();
      await db.execute(sql`
        insert into connections
          (id, org_id, source, display_name, status)
        values (
          ${connectionId}, ${org.orgId}, 'netsuite',
          'NetSuite source-deletion test', 'active'
        )`);

      const automaticDocumentId = randomUUID();
      const automaticRef = `automatic-${randomUUID()}`;
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, document_date, currency,
           subtotal, tax_total, total, custom)
        values (
          ${automaticDocumentId}, ${org.orgId}, 'sales_order', 'approved',
          'SO-SOURCE-DELETE', ${org.date}, 'CAD', '25', '0', '25',
          ${JSON.stringify({ nsId: automaticRef, connectionId })}::jsonb
        )`);
      await mirrorSourceDeletion({
        orgId: org.orgId,
        source: "netsuite",
        sourceRef: automaticRef,
        connectionId,
      });

      const controlledDocumentId = randomUUID();
      const controlledRef = `controlled-${randomUUID()}`;
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, document_date, currency,
           subtotal, tax_total, total, custom)
        values (
          ${controlledDocumentId}, ${org.orgId}, 'sales_order', 'approved',
          'SO-CONTROLLER-DELETE', ${org.date}, 'CAD', '30', '0', '30',
          ${JSON.stringify({ nsId: controlledRef, connectionId })}::jsonb
        )`);
      const controlled = await resolveSourceDeletion({
        orgId: org.orgId,
        connectionId,
        sourceRef: controlledRef,
        action: "void",
        actorId,
        note: "Source order removed",
      });
      assert.deepEqual(controlled, {
        documentId: controlledDocumentId,
        action: "void",
        reversalEntryId: null,
      });

      const evidence = (await db.execute<{
          document_audits: number;
          resolution_audits: number;
          voided_documents: number;
        }>(sql`
        select
          count(*) filter (
            where a.table_name = 'documents'
              and a.row_id in (${automaticDocumentId}, ${controlledDocumentId})
          )::int as document_audits,
          count(*) filter (
            where a.table_name = 'source_deletion_resolutions'
          )::int as resolution_audits,
          (
            select count(*)::int
              from documents d
             where d.id in (${automaticDocumentId}, ${controlledDocumentId})
               and d.status = 'voided'
               and d.open_balance is null
               and d.posted_entry_id is null
               and d.voided_by is not null
               and length(btrim(d.void_reason)) >= 5
          ) as voided_documents
          from audit_log a
         where a.org_id = ${org.orgId}
      `));
      assert.deepEqual(evidence.rows[0], {
        document_audits: 2,
        resolution_audits: 1,
        voided_documents: 2,
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "source-deletion void and retain touch only the document imported by the named connection",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(
        org.orgId,
        "Same-source connection isolation controller",
        "admin",
      );
      const connectionA = randomUUID();
      const connectionB = randomUUID();
      const documentA = randomUUID();
      const documentB = randomUUID();
      const sharedRef = `shared-${randomUUID()}`;
      await db.execute(sql`
        insert into connections
          (id, org_id, source, display_name, status)
        values
          (${connectionA}, ${org.orgId}, 'qbo', 'QBO company A', 'active'),
          (${connectionB}, ${org.orgId}, 'qbo', 'QBO company B', 'active')`);
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, document_date, currency,
           subtotal, tax_total, total, custom)
        values
          (
            ${documentA}, ${org.orgId}, 'sales_order', 'approved',
            'SO-CONN-A', ${org.date}, 'CAD', '25', '0', '25',
            ${JSON.stringify({ qboId: sharedRef, connectionId: connectionA })}::jsonb
          ),
          (
            ${documentB}, ${org.orgId}, 'sales_order', 'approved',
            'SO-CONN-B', ${org.date}, 'CAD', '30', '0', '30',
            ${JSON.stringify({ qboId: sharedRef, connectionId: connectionB })}::jsonb
          )`);

      const mirrored = await mirrorSourceDeletion({
        orgId: org.orgId,
        source: "qbo",
        sourceRef: sharedRef,
        connectionId: connectionA,
      });
      assert.deepEqual(mirrored, { documentId: documentA, deleted: true });

      const retained = await resolveSourceDeletion({
        orgId: org.orgId,
        connectionId: connectionB,
        sourceRef: sharedRef,
        action: "retain",
        actorId,
      });
      assert.deepEqual(retained, {
        documentId: documentB,
        action: "retain",
        reversalEntryId: null,
      });

      const otherRef = `other-${randomUUID()}`;
      await assert.rejects(
        () =>
          resolveSourceDeletion({
            orgId: org.orgId,
            connectionId: connectionA,
            sourceRef: otherRef,
            action: "void",
            actorId,
          }),
        (error: unknown) =>
          error instanceof Error &&
          /the imported document no longer exists/.test(error.message),
      );

      const statuses = (
        await db.execute<{ id: string; status: string }>(sql`
          select id, status
            from documents
           where org_id = ${org.orgId}
             and id in (${documentA}, ${documentB})
           order by document_number
        `)
      ).rows;
      assert.deepEqual(statuses, [
        { id: documentA, status: "voided" },
        { id: documentB, status: "approved" },
      ]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "re-resolving a source deletion updates its own tenant row and no other",
  { skip: !DB },
  async () => {
    // The resolution upsert keys on (connection_id, source_ref) and pins
    // the tenant on the conflict write: a bare org_id there is ambiguous
    // (42702) and every repeat resolution fails. Resolving twice in one
    // org must update the single row through the conflict branch, while
    // the other org's resolution keeps its own action note.
    const orgA = await createScratchOrg();
    const orgB = await createScratchOrg();
    const sharedRef = `shared-${randomUUID()}`;
    try {
      const actorA = await createScratchUser(orgA.orgId, "Deletion Controller A", "admin");
      const actorB = await createScratchUser(orgB.orgId, "Deletion Controller B", "admin");
      const connectionByOrg = new Map<string, string>();
      for (const [org, _actor, docNumber] of [
        [orgA, actorA, "SO-RE-RESOLVE-A"],
        [orgB, actorB, "SO-RE-RESOLVE-B"],
      ] as const) {
        const connectionId = randomUUID();
        const documentId = randomUUID();
        await db.execute(sql`
          insert into connections (id, org_id, source, display_name, status)
          values (${connectionId}, ${org.orgId}, 'netsuite', ${`NetSuite ${docNumber}`}, 'active')`);
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, status, document_number, document_date, currency,
             subtotal, tax_total, total, custom)
          values (${documentId}, ${org.orgId}, 'sales_order', 'approved',
                  ${docNumber}, ${org.date}, 'CAD', '25', '0', '25',
                  ${JSON.stringify({ nsId: sharedRef, connectionId })}::jsonb)`);
        connectionByOrg.set(org.orgId, connectionId);
      }
      const resolve = (org: typeof orgA, actor: string, note: string) =>
        resolveSourceDeletion({
          orgId: org.orgId,
          connectionId: connectionByOrg.get(org.orgId)!,
          sourceRef: sharedRef,
          action: "void",
          actorId: actor,
          note,
        });
      await resolve(orgA, actorA, "first look");
      await resolve(orgA, actorA, "second look");
      await resolve(orgB, actorB, "other tenant");

      const rows = await db.execute<{ orgId: string; note: string | null; n: number }>(sql`
        select org_id as "orgId", note, count(*)::int as n
          from source_deletion_resolutions
         where source_ref = ${sharedRef}
         group by org_id, note`);
      assert.deepEqual(
        rows.rows.sort((a, b) => a.orgId.localeCompare(b.orgId)),
        [
          { orgId: orgA.orgId, note: "second look", n: 1 },
          { orgId: orgB.orgId, note: "other tenant", n: 1 },
        ].sort((a, b) => a.orgId.localeCompare(b.orgId)),
      );
    } finally {
      await dropScratchOrg(orgB.orgId);
      await dropScratchOrg(orgA.orgId);
    }
  },
);
