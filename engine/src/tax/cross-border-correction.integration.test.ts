import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { recordSupplyEvidence } from "./cross-border-records.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

// A credit memo naming the invoice it corrects must be a first-class
// document relationship, not a UUID string hidden in custom JSON: the
// OSS return attributes the correction to the original quarter from the
// relationship it can observe and enforce.

const DB = !!process.env.OPENBOOKS_DB_URL;

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

async function enableCrossBorderTax(org: Org): Promise<void> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', '{"crossBorderTax": true}'::jsonb)
     where id = ${org.orgId}`);
}

let journalSeq = 0;

async function seedDocument(
  org: Org,
  actorId: string,
  overrides: { kind: string; status: string; number: string; partyId?: string | null },
): Promise<string> {
  const id = randomUUID();
  const posted = overrides.status === "posted";
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, posting_date, currency, fx_rate, subtotal, tax_total, total, custom, created_by, updated_by)
    values (${id}, ${org.orgId}, ${overrides.kind}, 'draft', ${overrides.number}, ${org.subsidiaryId},
            ${overrides.partyId ?? org.customerId}, '2026-10-05', '2026-10-05', 'EUR', '1',
            '1000.0000', '190.0000', '1190.0000',
            '{"crossBorder": {"supplyKind": "digital_service", "customerKind": "consumer"}}'::jsonb,
            ${actorId}, ${actorId})`);
  if (posted) {
    const entryId = randomUUID();
    journalSeq += 1;
    await db.execute(sql`
      insert into journal_entries (id, org_id, book_id, entry_number, posting_date, period_id, subsidiary_id, source_document_id, created_by, updated_by)
      values (${entryId}, ${org.orgId}, ${org.bookId}, ${`JE-CORR-${journalSeq}-${overrides.number}`}, '2026-10-05',
              ${org.periodId}, ${org.subsidiaryId}, ${id}, ${actorId}, ${actorId})`);
    await db.execute(sql`
      update documents set status = 'posted', posted_entry_id = ${entryId}, posting_period_id = ${org.periodId}
       where id = ${id} and org_id = ${org.orgId}`);
  }
  return id;
}

async function correctionEdge(orgId: string, creditId: string): Promise<{ to: string; linkType: string }[]> {
  const rows = (await db.execute<{ to: string; linkType: string }>(sql`
    select to_document_id as "to", link_type as "linkType" from document_links
     where org_id = ${orgId} and from_document_id = ${creditId}`)).rows;
  return rows;
}

async function recordCorrection(
  org: Org,
  actorId: string,
  creditId: string,
  correctsDocumentId: string,
): Promise<void> {
  await recordSupplyEvidence(
    db,
    org.orgId,
    creditId,
    {
      election: { supplyKind: "digital_service", customerKind: "consumer", correctsDocumentId },
      evidence: [],
    },
    actorId,
  );
}

test("a credit names its corrected invoice through a document relationship", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "OSS Controller", "admin");
    await enableCrossBorderTax(org);
    const invoiceId = await seedDocument(org, actorId, { kind: "customer_invoice", status: "posted", number: "INV-CORR-1" });
    const creditId = await seedDocument(org, actorId, { kind: "customer_credit", status: "draft", number: "CR-CORR-1" });
    await recordCorrection(org, actorId, creditId, invoiceId);
    const edges = await correctionEdge(org.orgId, creditId);
    assert.equal(edges.length, 1);
    assert.equal(edges[0]!.to, invoiceId);
    assert.equal(edges[0]!.linkType, "corrects");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("re-pointing a correction replaces the relationship instead of adding one", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "OSS Controller", "admin");
    await enableCrossBorderTax(org);
    const first = await seedDocument(org, actorId, { kind: "customer_invoice", status: "posted", number: "INV-CORR-2A" });
    const second = await seedDocument(org, actorId, { kind: "customer_invoice", status: "posted", number: "INV-CORR-2B" });
    const creditId = await seedDocument(org, actorId, { kind: "customer_credit", status: "draft", number: "CR-CORR-2" });
    await recordCorrection(org, actorId, creditId, first);
    await recordCorrection(org, actorId, creditId, second);
    const edges = await correctionEdge(org.orgId, creditId);
    assert.equal(edges.length, 1);
    assert.equal(edges[0]!.to, second);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a correction names a posted customer invoice in this organization", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "OSS Controller", "admin");
    await enableCrossBorderTax(org);
    const creditId = await seedDocument(org, actorId, { kind: "customer_credit", status: "draft", number: "CR-CORR-3" });
    await assert.rejects(
      () => recordCorrection(org, actorId, creditId, "not-a-document"),
      /name the corrected invoice by choosing it/,
      "a free-text pointer must refuse with the remedy",
    );
    await assert.rejects(
      () => recordCorrection(org, actorId, creditId, randomUUID()),
      /belongs to another organization/,
      "an unknown document must refuse instead of attributing nowhere",
    );
    const draftInvoice = await seedDocument(org, actorId, { kind: "customer_invoice", status: "draft", number: "INV-CORR-3D" });
    await assert.rejects(
      () => recordCorrection(org, actorId, creditId, draftInvoice),
      /post the corrected invoice first/,
      "a draft target has no filed quarter to attribute to",
    );
    const otherCredit = await seedDocument(org, actorId, { kind: "customer_credit", status: "posted", number: "CR-CORR-3C" });
    await assert.rejects(
      () => recordCorrection(org, actorId, creditId, otherCredit),
      /only correct a customer invoice/,
      "a credit cannot correct another credit",
    );
    await assert.rejects(
      () => recordCorrection(org, actorId, creditId, creditId),
      /cannot correct itself/,
      "a credit cannot correct itself",
    );
    assert.deepEqual(await correctionEdge(org.orgId, creditId), [], "no refusal may leave a half-written relationship");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a correction stays with the corrected invoice's customer", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "OSS Controller", "admin");
    await enableCrossBorderTax(org);
    const otherParty = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${otherParty}, ${org.orgId}, 'customer', 'Far Customer', true, '{}'::jsonb)`);
    const invoiceId = await seedDocument(org, actorId, {
      kind: "customer_invoice",
      status: "posted",
      number: "INV-CORR-4",
      partyId: otherParty,
    });
    const creditId = await seedDocument(org, actorId, { kind: "customer_credit", status: "draft", number: "CR-CORR-4" });
    await assert.rejects(
      () => recordCorrection(org, actorId, creditId, invoiceId),
      /same customer/,
      "a credit must not correct another customer's invoice",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an invoice cannot name a corrected document", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "OSS Controller", "admin");
    await enableCrossBorderTax(org);
    const invoiceId = await seedDocument(org, actorId, { kind: "customer_invoice", status: "posted", number: "INV-CORR-5A" });
    const draftId = await seedDocument(org, actorId, { kind: "customer_invoice", status: "draft", number: "INV-CORR-5B" });
    await assert.rejects(
      () =>
        recordSupplyEvidence(
          db,
          org.orgId,
          draftId,
          {
            election: { supplyKind: "digital_service", customerKind: "consumer", correctsDocumentId: invoiceId },
            evidence: [],
          },
          actorId,
        ),
      /only a credit memo names a corrected document/,
      "corrections flow one way: credit memo to invoice",
    );
    assert.ok(!(await db.execute(sql`
      select 1 from documents
       where id = ${draftId} and custom -> 'crossBorder' ? 'correctsDocument'`)).rows.length);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("clearing a correction removes the relationship while re-saves preserve it", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "OSS Controller", "admin");
    await enableCrossBorderTax(org);
    const invoiceId = await seedDocument(org, actorId, { kind: "customer_invoice", status: "posted", number: "INV-CORR-6" });
    const creditId = await seedDocument(org, actorId, { kind: "customer_credit", status: "draft", number: "CR-CORR-6" });
    await recordCorrection(org, actorId, creditId, invoiceId);
    assert.equal((await correctionEdge(org.orgId, creditId)).length, 1);
    await recordSupplyEvidence(
      db,
      org.orgId,
      creditId,
      { election: { supplyKind: "digital_service", customerKind: "consumer" }, evidence: [] },
      actorId,
    );
    assert.equal(
      (await correctionEdge(org.orgId, creditId)).length,
      1,
      "an evidence re-save without the pointer leaves the relationship untouched",
    );
    await recordSupplyEvidence(
      db,
      org.orgId,
      creditId,
      { election: { supplyKind: "digital_service", customerKind: "consumer", correctsDocumentId: null }, evidence: [] },
      actorId,
    );
    assert.deepEqual(await correctionEdge(org.orgId, creditId), [], "clearing the pointer removes the relationship");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
