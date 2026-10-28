import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withMaintenanceTransaction } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { postDocument } from "../ledger/posting-document.ts";
import {
  canSuspendTriggers,
  resumeTriggersForTransaction,
  suspendTriggersForTransaction,
  verifyBulkLoadedClone,
} from "./clone-bulk-load.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const ROLLBACK = new Error("roll back the planted reference");

test(
  "bulk-load verification passes an intact organization and refuses a dangling reference",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const tables = [
        { name: "departments", hasOrgId: true },
        { name: "journal_lines", hasOrgId: true },
      ];
      await withMaintenanceTransaction(null, async () => {
        assert.equal(
          await canSuspendTriggers(),
          true,
          "the test database role may suspend triggers",
        );
        await verifyBulkLoadedClone({ sandboxOrgId: org.orgId, tables, parentFilter: {} });
      });
      await assert.rejects(
        withMaintenanceTransaction(null, async () => {
          await suspendTriggersForTransaction();
          await db.execute(sql`insert into departments (org_id, name, parent_id)
            values (${org.orgId}, 'Orphaned department', ${randomUUID()})`);
          await resumeTriggersForTransaction();
          await assert.rejects(
            verifyBulkLoadedClone({ sandboxOrgId: org.orgId, tables, parentFilter: {} }),
            /references unresolved \(departments\./,
          );
          throw ROLLBACK;
        }),
        (err: unknown) => err === ROLLBACK,
      );
      const orphans = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from departments where org_id = ${org.orgId} and name = 'Orphaned department'`,
        "objects",
      );
      assert.equal(orphans[0]!.n, 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("a bulk-loaded clone holds the same ledger as a row-by-row clone", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const previous = process.env.OPENBOOKS_SANDBOX_CLONE_BULK_LOAD;
  const sandboxes: string[] = [];
  try {
    const userId = await createScratchUser(org.orgId, "Bulk poster", "accountant");
    for (let n = 1; n <= 3; n += 1) {
      const invoiceId = randomUUID();
      await db.execute(sql`insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
          values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${`BULK-${n}`},
                  ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date},
                  'CAD', '1', '100', '0', '100', ${userId})`);
      await db.execute(sql`insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
          values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')`);
      await db.execute(
        sql`update documents set status='approved' where id=${invoiceId} and org_id=${org.orgId}`,
      );
      await postDocument(invoiceId, {
        control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
      });
    }
    const ledger = async (orgId: string) =>
      (
        await db.execute<{ lines: number; debits: string; documents: number; activity: number }>(
          sql`
          select (select count(*)::int from journal_lines where org_id = ${orgId}) as lines,
                 (select coalesce(sum(amount) filter (where amount > 0), 0)::text
                    from journal_lines where org_id = ${orgId}) as debits,
                 (select count(*)::int from documents where org_id = ${orgId}) as documents,
                 (select count(*)::int from gl_month_activity where org_id = ${orgId}) as activity`,
          "objects",
        )
      )[0]!;
    const results = [];
    for (const mode of ["on", "off"] as const) {
      process.env.OPENBOOKS_SANDBOX_CLONE_BULK_LOAD = mode;
      const created = await createSandbox({
        productionOrgId: org.orgId,
        name: `Bulk ${mode} ${randomUUID()}`,
        tier: "full",
        masked: false,
      });
      sandboxes.push(created.sandboxId);
      results.push(await ledger(created.sandboxOrgId));
    }
    const source = await ledger(org.orgId);
    assert.ok(source.lines > 0);
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0]!.lines, source.lines);
    assert.equal(results[0]!.debits, source.debits);
  } finally {
    if (previous === undefined) delete process.env.OPENBOOKS_SANDBOX_CLONE_BULK_LOAD;
    else process.env.OPENBOOKS_SANDBOX_CLONE_BULK_LOAD = previous;
    for (const id of sandboxes) await deleteSandbox(id);
    await dropScratchOrg(org.orgId);
  }
});
