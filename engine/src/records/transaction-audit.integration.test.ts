import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
  transactionSnapshotsMatch,
} from "./transaction-audit.ts";

test(
  "transaction audit preserves exact native numeric JSON and distinguishes custom-field types",
  {
    skip: !process.env.OPENBOOKS_DB_URL,
  },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Transaction reviewer", "admin"),
      );
      await withOrgContext(org.orgId, async () => {
        const id = randomUUID();
        await db.execute(sql`insert into documents
        (id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,subtotal,tax_total,total,custom,created_by)
        values(${id},${org.orgId},'customer_invoice','draft',${`INV-${id}`},${org.subsidiaryId},${org.customerId},${org.date},'CAD',
          '999999999999998.99',0,'999999999999998.99','{"sourceOrdinal":9007199254740993,"approved":true}'::jsonb,${actorId})`);
        await db.execute(sql`insert into document_lines
        (org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount)
        values(${org.orgId},${id},1,${org.accounts.revenue},1,'999999999999998.99','999999999999998.99',0)`);

        await db.transaction(async (tx) => {
          const before = await captureTransactionAuditSnapshot(tx, id, org.orgId);
          assert.ok(before);
          assert.equal(before.document.total, "999999999999998.9900");
          assert.equal(before.lines[0]!.amount, "999999999999998.9900");
          assert.equal(
            (before.document.custom as { sourceOrdinal: string }).sourceOrdinal,
            "9007199254740993",
          );
          assert.ok(Object.isFrozen(before.document));
          assert.throws(() => {
            before.document.total = "0";
          }, TypeError);

          await tx.execute(sql`update documents set total='999999999999999.00',subtotal='999999999999999.00'
          where org_id=${org.orgId} and id=${id}`);
          await tx.execute(sql`update document_lines set amount='999999999999999.00',unit_price='999999999999999.00'
          where org_id=${org.orgId} and document_id=${id}`);
          const after = await captureTransactionAuditSnapshot(tx, id, org.orgId);
          assert.ok(after);
          assert.equal(
            transactionSnapshotsMatch(before, after),
            false,
            "a one-cent change above floating-point precision remains material",
          );
          await recordTransactionAudit(tx, {
            orgId: org.orgId,
            documentId: id,
            action: "update",
            actorId,
            source: "api",
            reason: "Correct the invoice amount",
            before,
            after,
          });
          const audit = await tx.execute<{
            before_total: string;
            after_total: string;
            line_amount: string;
            total_type: string;
            ordinal: string;
            ordinal_type: string;
          }>(
            sql`
          select changes #>> '{before,document,total}' as before_total,changes #>> '{after,document,total}' as after_total,
            changes #>> '{before,lines,0,amount}' as line_amount,
            jsonb_typeof(changes #> '{before,document,total}') as total_type,
            changes #>> '{before,document,custom,sourceOrdinal}' as ordinal,
            jsonb_typeof(changes #> '{before,document,custom,sourceOrdinal}') as ordinal_type
          from audit_log where org_id=${org.orgId} and table_name='documents' and row_id=${id} and request_id='api'
        `,
            "objects",
          );
          assert.equal(audit.length, 1);
          assert.deepEqual(audit[0], {
            before_total: "999999999999998.9900",
            after_total: "999999999999999.0000",
            line_amount: "999999999999998.9900",
            total_type: "number",
            ordinal: "9007199254740993",
            ordinal_type: "number",
          });

          await tx.execute(sql`update documents set updated_at=updated_at + interval '1 second',updated_by=${actorId}
          where org_id=${org.orgId} and id=${id}`);
          const stamped = await captureTransactionAuditSnapshot(tx, id, org.orgId);
          assert.ok(stamped);
          assert.equal(
            transactionSnapshotsMatch(after, stamped),
            true,
            "write stamps alone remain a no-op",
          );
          await tx.execute(sql`update documents set custom=jsonb_set(custom,'{sourceOrdinal}','"9007199254740993"'::jsonb)
          where org_id=${org.orgId} and id=${id}`);
          const stringOrdinal = await captureTransactionAuditSnapshot(tx, id, org.orgId);
          assert.ok(stringOrdinal);
          assert.equal(
            transactionSnapshotsMatch(stamped, stringOrdinal),
            false,
            "equal digits do not erase a change of JSON type",
          );
          assert.equal(
            await captureTransactionAuditSnapshot(tx, id, randomUUID()),
            null,
            "another organization cannot capture the snapshot",
          );
        });

        await assert.rejects(
          db.transaction(async (tx) => {
            const before = await captureTransactionAuditSnapshot(tx, id, org.orgId);
            assert.ok(before);
            await tx.execute(sql`update documents set memo='Must roll back with missing audit'
          where org_id=${org.orgId} and id=${id}`);
            const after = await captureTransactionAuditSnapshot(tx, id, org.orgId);
            assert.ok(after);
            const missingAuditWrite = {
              execute: async (_query: unknown, mode?: string) =>
                Promise.resolve({ rows: [] }).then(<T extends { rows: unknown }>(result: T) =>
                  mode === "objects" ? result.rows : result,
                ),
            } as unknown as Pick<typeof db, "execute">;
            await recordTransactionAudit(missingAuditWrite, {
              orgId: org.orgId,
              documentId: id,
              action: "update",
              actorId,
              source: "api",
              reason: "Retain the transaction change",
              before,
              after,
            });
          }),
          /transaction audit was not retained/,
        );
        const retained = (
          await db.execute<{ memo: string | null; audits: string }>(
            sql`
        select d.memo,(select count(*)::text from audit_log a
          where a.org_id=d.org_id and a.table_name='documents' and a.row_id=d.id and a.request_id='api') as audits
        from documents d where d.org_id=${org.orgId} and d.id=${id}
      `,
            "objects",
          )
        )[0];
        assert.equal(retained?.memo, null, "a missing audit write rolls back the business change");
        assert.equal(retained?.audits, "1");
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
