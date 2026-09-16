import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  commitPostingPeriodAssignment,
  previewPostingPeriodAssignment,
} from "./close-posting-periods.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

// Admin bulk assignment for the close-readiness `posting-period-missing`
// population (approved documents without a posting period): preview derives
// each document's period from its effective date, commit assigns it with
// audit evidence, closed periods refuse per document, re-runs assign nothing.

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedOrder(
  orgId: string,
  subsidiaryId: string,
  kind: "sales_order" | "purchase_order",
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

test("assign-posting-period previews, commits with audit, and is idempotent", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const sales = await seedOrder(org.orgId, org.subsidiaryId, "sales_order", org.date);
    const purchase = await seedOrder(org.orgId, org.subsidiaryId, "purchase_order", org.date);

    const preview = await previewPostingPeriodAssignment(org.orgId, { bookId: org.bookId });
    assert.equal(preview.rows.length, 2);
    for (const row of preview.rows) {
      assert.equal(row.blocked, false);
      assert.equal(row.periodId, org.periodId);
    }

    const first = await commitPostingPeriodAssignment(org.orgId, { bookId: org.bookId, actorId: actor });
    assert.equal(first.assigned.length, 2);
    assert.equal(first.refused.length, 0);
    assert.equal(first.skipped.length, 0);
    const stored = await db.execute<{ id: string; posting_period_id: string }>(sql`
      select id, posting_period_id from documents where org_id = ${org.orgId} and id in (${sales}, ${purchase})`);
    for (const row of stored.rows) assert.equal(row.posting_period_id, org.periodId);
    const audit = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from audit_log
       where org_id = ${org.orgId} and table_name = 'documents'
         and row_id in (${sales}, ${purchase}) and action = 'update'`);
    assert.equal(audit.rows[0]?.n, "2");

    const second = await commitPostingPeriodAssignment(org.orgId, { bookId: org.bookId, actorId: actor });
    assert.deepEqual(second, { assigned: [], skipped: [], refused: [] });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("assign-posting-period refuses closed periods and dateless calendars per document", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const sales = await seedOrder(org.orgId, org.subsidiaryId, "sales_order", org.date);
    const purchase = await seedOrder(org.orgId, org.subsidiaryId, "purchase_order", org.date);
    const dateless = await seedOrder(org.orgId, org.subsidiaryId, "sales_order", "2020-01-01");
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

    const result = await commitPostingPeriodAssignment(org.orgId, { bookId: org.bookId, actorId: actor });
    assert.equal(result.assigned.length, 1);
    assert.equal(result.assigned[0]?.documentId, purchase);
    assert.equal(result.refused.length, 2);
    const stillNull = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from documents
       where org_id = ${org.orgId} and id in (${sales}, ${dateless}) and posting_period_id is null`);
    assert.equal(stillNull.rows[0]?.n, "2");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("assign-posting-period fails closed on unknown documents and books", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    await assert.rejects(
      previewPostingPeriodAssignment(org.orgId, { bookId: org.bookId, documentIds: [randomUUID()] }),
      /not assignable/,
    );
    await assert.rejects(
      previewPostingPeriodAssignment(org.orgId, { bookId: randomUUID() }),
      /accounting book not found/,
    );
    await assert.rejects(
      commitPostingPeriodAssignment(org.orgId, { bookId: org.bookId, documentIds: [randomUUID()], actorId: actor }),
      /not assignable/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
