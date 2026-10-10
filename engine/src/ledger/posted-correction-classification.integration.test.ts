import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { db, withBypassContext } from "../platform/db.ts";
import { documentRevisionCounterSql } from "../records/revision.ts";
import { setPeriodLockState } from "../periods/period-locks.ts";
import { postDocument } from "./posting-document.ts";
import { correctPostedDocument, PostedCorrectionError } from "./document-correction.ts";
import { applyDocumentEdit, createDocumentDraft } from "./document-write.ts";
import { resolveProjectFinancials } from "../projects/financials.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const fixedPrice = BUILTIN_PROJECT_TYPES.find((t) => t.key === "fixed_price")!.financialProfile;
const REASON = "Correct the project tagging on this posted invoice";

// A header project edit on a posted invoice must never void+reissue: project
// is a journal dimension, so an open period reclasses (balanced mirrors dated
// in the original period) while a locked period refuses with the controlled
// reopen remedy — never a reversal into another fiscal year.

async function seedClerk(org: ScratchOrg): Promise<string> {
  const actor = await withBypassContext(() => createScratchUser(org.orgId, "Amendment Clerk", "correction-clerk"));
  await withBypassContext(() => db.execute(sql`
    update app_roles set permissions = '["ar.read","ar.create","ar.post"]'::jsonb
     where org_id = ${org.orgId}
       and id in (select role_id from role_assignments where org_id = ${org.orgId} and user_id = ${actor})`));
  return actor;
}

async function seedProject(org: ScratchOrg, code: string): Promise<string> {
  const project = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into projects(id, org_id, subsidiary_id, code, name, customer_id, status, is_active)
    values (${project}, ${org.orgId}, ${org.subsidiaryId}, ${code}, ${code}, ${org.customerId}, 'active', true)`));
  return project;
}

async function seedPostedInvoice(
  org: ScratchOrg,
  actorId: string,
  projectId: string,
  documentNumber: string,
  amount: string,
): Promise<string> {
  const invoice = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, party_id, document_date, subsidiary_id,
       currency, subtotal, tax_total, total, project_id, created_by)
    values (${invoice}, ${org.orgId}, 'customer_invoice', 'draft', ${documentNumber},
            ${org.customerId}, ${org.date}, ${org.subsidiaryId},
            'CAD', ${amount}, '0', ${amount}, ${projectId}, ${actorId})`));
  await withBypassContext(() => db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${invoice}, 1, ${org.accounts.revenue}, '1', ${amount}, ${amount}, '0', ${amount})`));
  await withBypassContext(() => db.execute(sql`
    update documents set status = 'approved' where id = ${invoice} and org_id = ${org.orgId}`));
  await postDocument(invoice, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  });
  return invoice;
}

async function revision(orgId: string, id: string): Promise<string> {
  return (await withBypassContext(() => db.execute<{ revision: string }>(sql`
    select ${documentRevisionCounterSql(sql`revision_seq`)} as revision
      from documents where id = ${id} and org_id = ${orgId}`))).rows[0]!.revision;
}

function writerFor(orgId: string, actorId: string) {
  return {
    createDraft: (kind: string, options: {
      allowedSubsidiaryIds: ReadonlySet<string> | null;
      subsidiaryId: string | null;
      runFlows: false;
      source: "api";
    }) => createDocumentDraft(orgId, actorId, kind, options),
    applyEdit: applyDocumentEdit,
  };
}

async function closeAR(org: ScratchOrg, actorId: string): Promise<void> {
  await withBypassContext(() => setPeriodLockState({
    orgId: org.orgId,
    periodId: org.periodId,
    bookId: org.bookId,
    module: "ar",
    state: "closed",
    actorId,
    reason: "Probe: October AR closed with the invoice still posted",
  }));
}

async function docState(orgId: string, id: string) {
  return (await withBypassContext(() => db.execute<{
    status: string; projectId: string | null; memo: string | null; voidRequested: string | null;
  }>(sql`
    select status, project_id as "projectId", memo,
           void_requested_at::text as "voidRequested"
      from documents where id = ${id} and org_id = ${orgId}`))).rows[0]!;
}

async function entryCount(orgId: string, id: string): Promise<number> {
  return (await withBypassContext(() => db.execute<{ count: number }>(sql`
    select count(*)::int as count from journal_entries
     where org_id = ${orgId} and source_document_id = ${id}`))).rows[0]!.count;
}

async function correctionAudits(orgId: string, id: string) {
  return (await withBypassContext(() => db.execute<{ action: string; changes: unknown }>(sql`
    select action, changes from audit_log
     where org_id = ${orgId} and table_name = 'documents' and row_id = ${id}
       and changes->>'mode' like 'posted\\_%'
     order by id`))).rows;
}

test("a locked-period project amendment refuses with the reopen remedy and changes nothing", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await seedClerk(org);
    const projectA = await seedProject(org, "LOCK-A");
    const projectB = await seedProject(org, "LOCK-B");
    const invoice = await seedPostedInvoice(org, actor, projectA, "INV-LOCKED", "4200");
    const entriesBefore = await entryCount(org.orgId, invoice);
    await closeAR(org, actor);
    const token = await revision(org.orgId, invoice);
    await assert.rejects(
      correctPostedDocument(invoice, {
        projectId: projectB, expectedUpdatedAt: token, amendmentReason: REASON,
      }, { orgId: org.orgId, userId: actor, source: "api" }, writerFor(org.orgId, actor)),
      (error: unknown) => error instanceof PostedCorrectionError &&
        error.code === "closed-period" &&
        /closed/.test(error.message) &&
        /reopen/.test(error.remedy),
    );
    const kept = await docState(org.orgId, invoice);
    assert.equal(kept.status, "posted");
    assert.equal(kept.projectId, projectA);
    assert.equal(kept.voidRequested, null);
    assert.equal(await entryCount(org.orgId, invoice), entriesBefore);
    assert.deepEqual(await correctionAudits(org.orgId, invoice), []);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("an open-period project change reclasses without voiding and invoiced-to-date follows it", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await seedClerk(org);
    const projectA = await seedProject(org, "OPEN-A");
    const projectB = await seedProject(org, "OPEN-B");
    const invoice = await seedPostedInvoice(org, actor, projectA, "INV-OPEN", "4200");
    const token = await revision(org.orgId, invoice);
    const outcome = await correctPostedDocument(invoice, {
      projectId: projectB, expectedUpdatedAt: token, amendmentReason: REASON,
    }, { orgId: org.orgId, userId: actor, source: "api" }, writerFor(org.orgId, actor));
    assert.equal(outcome.kind, "reclass");
    assert.equal(outcome.voidResult, null);
    assert.equal(outcome.replacement.id, invoice);
    const kept = await docState(org.orgId, invoice);
    assert.equal(kept.status, "posted");
    assert.equal(kept.voidRequested, null);
    assert.equal(kept.projectId, projectB);
    assert.equal(outcome.reclassEntryIds.length, 1);
    const reclass = (await withBypassContext(() => db.execute<{
      postingDate: string; periodId: string; origin: string;
    }>(sql`
      select posting_date::text as "postingDate", period_id as "periodId", origin
        from journal_entries where id = ${outcome.reclassEntryIds[0]} and org_id = ${org.orgId}`))).rows[0]!;
    assert.equal(reclass.postingDate, org.date);
    assert.equal(reclass.periodId, org.periodId);
    assert.equal(reclass.origin, "correction");
    // Every leg that carried the old project nets to zero there and reappears
    // in full under the new one, per account — the entry stays balanced while
    // each dimension attribution moves exactly once.
    const dimensions = (await withBypassContext(() => db.execute<{
      project: string | null; account: string; total: string;
    }>(sql`
      select l.project_id as project, l.account_id as account, sum(l.amount)::text as total
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
       where e.org_id = ${org.orgId} and e.source_document_id = ${invoice}
       group by l.project_id, l.account_id`))).rows;
    const original = (await withBypassContext(() => db.execute<{
      account: string; total: string;
    }>(sql`
      select l.account_id as account, sum(l.amount)::text as total
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
       where e.org_id = ${org.orgId} and e.source_document_id = ${invoice}
         and e.id <> ${outcome.reclassEntryIds[0]}
       group by l.account_id`))).rows;
    const moved = new Map(original.map((row) => [row.account, row.total]));
    for (const row of dimensions) {
      if (row.project === projectA) assert.equal(row.total, "0.0000");
      if (row.project === projectB) assert.equal(row.total, moved.get(row.account));
    }
    assert.ok(dimensions.some((row) => row.project === projectB));
    const before = await resolveProjectFinancials(org.orgId, projectA, fixedPrice);
    const after = await resolveProjectFinancials(org.orgId, projectB, fixedPrice);
    assert.equal(before.measures.invoiced_to_date, "0.0000");
    assert.equal(after.measures.invoiced_to_date, "4200.0000");
    const audits = await correctionAudits(org.orgId, invoice);
    assert.equal(audits.length, 1);
    assert.match(JSON.stringify(audits[0]!.changes), /posted_dimension_reclass/);
    assert.match(JSON.stringify(audits[0]!.changes), new RegExp(projectB));
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("an open-period amount change voids with the reversal in the original period and reissues", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await seedClerk(org);
    const project = await seedProject(org, "AMT-A");
    const invoice = await seedPostedInvoice(org, actor, project, "INV-AMT", "4200");
    const originalEntry = (await withBypassContext(() => db.execute<{ entry: string }>(sql`
      select posted_entry_id as entry from documents where id = ${invoice} and org_id = ${org.orgId}`))).rows[0]!.entry;
    const token = await revision(org.orgId, invoice);
    const outcome = await correctPostedDocument(invoice, {
      documentDate: org.date,
      lines: [{
        accountId: org.accounts.revenue, quantity: "1", unitPrice: "5000",
        amount: "5000", taxInputAmount: "5000", taxAmount: "0",
      }],
      expectedUpdatedAt: token,
      amendmentReason: "Rebill the posted invoice at the agreed five thousand",
    }, { orgId: org.orgId, userId: actor, source: "api" }, writerFor(org.orgId, actor));
    assert.equal(outcome.kind, "void-and-reissue");
    assert.notEqual(outcome.voidResult, null);
    const kept = await docState(org.orgId, invoice);
    assert.equal(kept.status, "voided");
    const reversal = (await withBypassContext(() => db.execute<{ postingDate: string }>(sql`
      select posting_date::text as "postingDate" from journal_entries
       where org_id = ${org.orgId} and reverses_entry_id = ${originalEntry}`))).rows[0]!;
    assert.equal(reversal.postingDate, org.date);
    const replacement = (await withBypassContext(() => db.execute<{
      id: string; status: string; documentDate: string;
    }>(sql`
      select id, status, document_date::text as "documentDate" from documents
       where org_id = ${org.orgId} and custom->>'correctionOf' = ${invoice}`))).rows[0]!;
    assert.equal(replacement.status, "draft");
    assert.equal(replacement.documentDate, org.date);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a drawer-shaped memo edit resending unchanged lines stays a metadata correction", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await seedClerk(org);
    const project = await seedProject(org, "ROUND-A");
    const invoice = await seedPostedInvoice(org, actor, project, "INV-ROUND", "4200");
    const stored = (await withBypassContext(() => db.execute<{
      id: string; description: string | null;
    }>(sql`
      select id, description from document_lines
       where org_id = ${org.orgId} and document_id = ${invoice}`))).rows[0]!;
    const token = await revision(org.orgId, invoice);
    // The drawer always resends every row; an untouched row must round-trip
    // without tripping the financial path — otherwise every posted memo edit
    // would still void and reissue through the UI.
    const outcome = await correctPostedDocument(invoice, {
      memo: "Add the purchase order reference to the posted record",
      lines: [{
        lineId: stored.id,
        accountId: org.accounts.revenue,
        itemId: null,
        description: stored.description,
        quantity: "1",
        unit: null,
        unitPrice: "4200",
        amount: "4200",
        taxCodeId: null,
        taxGroupId: null,
        taxOverridden: false,
        taxAmount: null,
        partyId: null,
        departmentId: null,
        projectId: null,
        locationId: null,
        classId: null,
      }],
      expectedUpdatedAt: token,
      amendmentReason: "Record the buyer purchase order on the posted invoice",
    }, { orgId: org.orgId, userId: actor, source: "api" }, writerFor(org.orgId, actor));
    assert.equal(outcome.kind, "metadata-correction");
    const kept = await docState(org.orgId, invoice);
    assert.equal(kept.status, "posted");
    assert.equal(kept.memo, "Add the purchase order reference to the posted record");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a memo change corrects in place with audit, even in a locked period", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await seedClerk(org);
    const project = await seedProject(org, "MEMO-A");
    const invoice = await seedPostedInvoice(org, actor, project, "INV-MEMO", "4200");
    const entriesBefore = await entryCount(org.orgId, invoice);
    await closeAR(org, actor);
    const token = await revision(org.orgId, invoice);
    const outcome = await correctPostedDocument(invoice, {
      memo: "Add the purchase order reference to the posted record",
      expectedUpdatedAt: token,
      amendmentReason: "Record the buyer purchase order on the posted invoice",
    }, { orgId: org.orgId, userId: actor, source: "api" }, writerFor(org.orgId, actor));
    assert.equal(outcome.kind, "metadata-correction");
    const kept = await docState(org.orgId, invoice);
    assert.equal(kept.status, "posted");
    assert.equal(kept.voidRequested, null);
    assert.equal(kept.memo, "Add the purchase order reference to the posted record");
    assert.equal(await entryCount(org.orgId, invoice), entriesBefore);
    const audits = await correctionAudits(org.orgId, invoice);
    assert.equal(audits.length, 1);
    const changes = JSON.stringify(audits[0]!.changes);
    assert.match(changes, /posted_metadata_correction/);
    assert.match(changes, /Add the purchase order reference/);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
