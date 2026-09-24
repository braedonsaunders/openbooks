import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  commitPostingPeriodAssignment,
  previewPostingPeriodAssignment,
} from "./posting-periods.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

// H-POSTPERIOD: a subsidiary-restricted close.run actor must never see or
// touch null-subsidiary documents (fail closed, the same as direct document
// access), and the commit must assign only documents still in scope inside
// the write transaction — a concurrent A→B rehome between the unlocked
// candidate read and the update assigns nothing.

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedDoc(
  orgId: string,
  subsidiaryId: string | null,
  date: string,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, subsidiary_id, kind, status, document_number, document_date,
       posting_date, currency, subtotal, tax_total, total)
    values (${id}, ${orgId}, ${subsidiaryId}, 'customer_invoice', 'approved', ${id},
            ${date}, ${date}, 'CAD', '10.0000', '0.0000', '10.0000')`);
  return id;
}

async function periodOf(orgId: string, id: string): Promise<string | null> {
  const rows = (await db.execute<{ posting_period_id: string | null }>(sql`
    select posting_period_id from documents where org_id = ${orgId} and id = ${id}`)).rows;
  return rows[0]?.posting_period_id ?? null;
}

test("restricted preview and commit see only in-scope documents, never null-subsidiary ones", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const second = (await db.execute<{ id: string }>(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      select ${randomUUID()}, ${org.orgId}, s.id, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb
        from subsidiaries s where s.org_id = ${org.orgId} and s.parent_id is null limit 1 returning id`)).rows[0]!.id;
    const inScope = await seedDoc(org.orgId, org.subsidiaryId, org.date);
    const otherEntity = await seedDoc(org.orgId, second, org.date);
    const unattributed = await seedDoc(org.orgId, null, org.date);

    const preview = await previewPostingPeriodAssignment(org.orgId, {
      bookId: org.bookId,
      subsidiaryIds: [org.subsidiaryId],
    });
    assert.deepEqual(
      preview.rows.map((row) => row.documentId),
      [inScope],
      "preview exposes only the in-scope document",
    );

    const result = await commitPostingPeriodAssignment(org.orgId, {
      bookId: org.bookId,
      subsidiaryIds: [org.subsidiaryId],
      actorId: actor,
    });
    assert.deepEqual(result.assigned.map((row) => row.documentId), [inScope]);
    assert.equal(await periodOf(org.orgId, inScope), org.periodId);
    assert.equal(await periodOf(org.orgId, otherEntity), null, "B's document untouched");
    assert.equal(await periodOf(org.orgId, unattributed), null, "null-subsidiary document untouched");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("unrestricted preview and commit still cover every subsidiary including null", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const second = (await db.execute<{ id: string }>(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      select ${randomUUID()}, ${org.orgId}, s.id, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb
        from subsidiaries s where s.org_id = ${org.orgId} and s.parent_id is null limit 1 returning id`)).rows[0]!.id;
    const ids = [
      await seedDoc(org.orgId, org.subsidiaryId, org.date),
      await seedDoc(org.orgId, second, org.date),
      await seedDoc(org.orgId, null, org.date),
    ];

    const preview = await previewPostingPeriodAssignment(org.orgId, { bookId: org.bookId });
    assert.equal(preview.rows.length, 3);
    const result = await commitPostingPeriodAssignment(org.orgId, { bookId: org.bookId, actorId: actor });
    assert.equal(result.assigned.length, 3);
    for (const id of ids) assert.equal(await periodOf(org.orgId, id), org.periodId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("restricted explicit ids naming an out-of-scope document refuse with no side effects", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const second = (await db.execute<{ id: string }>(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      select ${randomUUID()}, ${org.orgId}, s.id, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb
        from subsidiaries s where s.org_id = ${org.orgId} and s.parent_id is null limit 1 returning id`)).rows[0]!.id;
    const inScope = await seedDoc(org.orgId, org.subsidiaryId, org.date);
    const otherEntity = await seedDoc(org.orgId, second, org.date);

    await assert.rejects(
      commitPostingPeriodAssignment(org.orgId, {
        bookId: org.bookId,
        documentIds: [inScope, otherEntity],
        subsidiaryIds: [org.subsidiaryId],
        actorId: actor,
      }),
      /not assignable/,
    );
    assert.equal(await periodOf(org.orgId, inScope), null, "the refusal assigns nothing, not even the in-scope row");
    assert.equal(await periodOf(org.orgId, otherEntity), null);

    const ok = await commitPostingPeriodAssignment(org.orgId, {
      bookId: org.bookId,
      documentIds: [inScope],
      subsidiaryIds: [org.subsidiaryId],
      actorId: actor,
    });
    assert.deepEqual(ok.assigned.map((row) => row.documentId), [inScope]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a document rehomed out of scope between preview and commit is not assigned", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const second = (await db.execute<{ id: string }>(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      select ${randomUUID()}, ${org.orgId}, s.id, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb
        from subsidiaries s where s.org_id = ${org.orgId} and s.parent_id is null limit 1 returning id`)).rows[0]!.id;
    const moving = await seedDoc(org.orgId, org.subsidiaryId, org.date);

    const preview = await previewPostingPeriodAssignment(org.orgId, {
      bookId: org.bookId,
      subsidiaryIds: [org.subsidiaryId],
    });
    assert.ok(preview.rows.some((row) => row.documentId === moving), "preview sees the document before the rehome");

    // The concurrent A→B rehome lands before the commit starts.
    await db.execute(sql`
      update documents set subsidiary_id = ${second} where org_id = ${org.orgId} and id = ${moving}`);

    const result = await commitPostingPeriodAssignment(org.orgId, {
      bookId: org.bookId,
      subsidiaryIds: [org.subsidiaryId],
      actorId: actor,
    });
    assert.deepEqual(result.assigned, [], "nothing is assigned after the rehome");
    assert.equal(await periodOf(org.orgId, moving), null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
