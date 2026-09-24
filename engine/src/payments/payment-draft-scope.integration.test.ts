import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import { createPaymentDocument } from "./payment-documents.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function setup() {
  const org = await createScratchOrg();
  const actor = await createScratchUser(org.orgId, "Payment drafter", "reviewer");
  const other = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${other}, ${org.orgId}, ${org.subsidiaryId}, 'Entity B', 'CAD', 'CA')
  `);
  const foreignParty = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, created_by)
    values (${foreignParty}, ${org.orgId}, 'vendor', 'Foreign payee', ${other}, ${actor})
  `);
  const third = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${third}, ${org.orgId}, ${org.subsidiaryId}, 'Entity C', 'CAD', 'CA')
  `);
  return { org, actor, other, third, foreignParty };
}

async function paymentDrafts(orgId: string) {
  return (await db.execute<{ id: string; subsidiary_id: string | null }>(sql`
    select id, subsidiary_id from documents
     where org_id = ${orgId} and kind in ('vendor_payment', 'customer_payment')
  `)).rows;
}

test("a restricted payment draft lands in their own subsidiary, never the root", async () => {
  if (!DB) return;
  const { org, actor } = await setup();
  try {
    const doc = await createPaymentDocument({
      orgId: org.orgId,
      kind: "vendor_payment",
      createdBy: actor,
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    });
    const drafts = await paymentDrafts(org.orgId);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]!.id, doc.id);
    assert.equal(drafts[0]!.subsidiary_id, org.subsidiaryId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a payment draft with no assignable subsidiary refuses by name and stores nothing", async () => {
  if (!DB) return;
  // The derived root sits outside this scope: the factory must refuse by
  // name instead of minting a root-owned document the caller cannot observe.
  const { org, actor, other, third } = await setup();
  try {
    await assert.rejects(
      createPaymentDocument({
        orgId: org.orgId,
        kind: "vendor_payment",
        createdBy: actor,
        allowedSubsidiaryIds: new Set([other, third]),
      }),
      /subsidiary_out_of_scope/,
    );
    assert.deepEqual(await paymentDrafts(org.orgId), []);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a payment draft derived from an out-of-scope party refuses by name", async () => {
  if (!DB) return;
  const { org, actor, foreignParty } = await setup();
  try {
    await assert.rejects(
      createPaymentDocument({
        orgId: org.orgId,
        kind: "vendor_payment",
        createdBy: actor,
        allowedSubsidiaryIds: new Set([org.subsidiaryId]),
        partyId: foreignParty,
      }),
      /subsidiary_out_of_scope/,
    );
    assert.deepEqual(await paymentDrafts(org.orgId), []);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
