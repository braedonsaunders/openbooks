import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { createPaymentRun } from "./run-creation.ts";
import { createSandbox, deleteSandbox } from "../sandbox/lifecycle.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture(org: ScratchOrg, actor: string) {
  const formatId = randomUUID();
  const profileId = randomUUID();
  await db.execute(sql`insert into payment_formats (id, org_id, code, name, rail, direction, country, currency, created_by, updated_by)
    values (${formatId}, ${org.orgId}, ${`WIRE-${formatId}`}, 'Vendor wire', 'wire', 'credit', 'CA', 'CAD', ${actor}, ${actor})`);
  await db.execute(sql`insert into payment_bank_profiles
    (id, org_id, name, bank_account_id, subsidiary_id, payment_format_id, currency, country, settings, created_by, updated_by)
    values (${profileId}, ${org.orgId}, 'Vendor payments', ${org.accounts.bank}, ${org.subsidiaryId}, ${formatId}, 'CAD', 'CA',
      ${JSON.stringify({ discountAccountId: org.accounts.cogs })}::jsonb, ${actor}, ${actor})`);
  await db.execute(sql`insert into vendor_roles (org_id, party_id, ap_account_id, is_active)
    values (${org.orgId}, ${org.vendorId}, ${org.accounts.ap}, true)`);
  return profileId;
}

async function terms(org: ScratchOrg, percentage: string | null, discountDays: number | null = 10) {
  const id = randomUUID();
  await db.execute(sql`insert into payment_terms (id, org_id, name, net_days, discount_days, discount_percent)
    values (${id}, ${org.orgId}, 'Vendor terms', 30, ${discountDays}, ${percentage})`);
  return id;
}

async function bill(org: ScratchOrg, actor: string, migration = false) {
  const id = randomUUID();
  await db.execute(sql`insert into documents
    (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, subtotal, tax_total, total, created_by)
    values (${id}, ${org.orgId}, 'vendor_bill', 'draft', ${`BILL-${id}`}, ${org.subsidiaryId}, ${org.vendorId},
      ${org.date}, 'CAD', '100', '0', '100', ${actor})`);
  await db.execute(sql`insert into document_lines (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
    values (${org.orgId}, ${id}, 1, ${org.accounts.cogs}, '1', '100', '100', '0')`);
  await db.execute(
    sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${id}`,
  );
  await postDocument(
    id,
    { migration, control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } },
    { audit: { actorId: actor, source: "ui" } },
  );
  return id;
}

async function retained(org: ScratchOrg, id: string) {
  return (
    await db.execute<{ snapshot: unknown; entry: string; due_date: string }>(
      sql`
    select payment_terms_snapshot as snapshot, posted_entry_id as entry, due_date::text as due_date
      from documents where org_id = ${org.orgId} and id = ${id}`,
      "objects",
    )
  )[0]!;
}

async function run(
  org: ScratchOrg,
  actor: string,
  profileId: string,
  billId: string,
  captureDiscounts = true,
) {
  return createPaymentRun({
    orgId: org.orgId,
    createdBy: actor,
    allowedSubsidiaryIds: null,
    paymentBankProfileId: profileId,
    billDocumentIds: [billId],
    scheduledFor: org.date,
    selectionCriteria: { captureDiscounts },
  });
}

async function composition(org: ScratchOrg, id: string) {
  return await db.execute<{ discount: string; payment: string }>(
    sql`
    select discount_amount::text as discount, payment_amount::text as payment from payment_run_items
    where org_id = ${org.orgId} and payment_run_id = ${id}`,
    "objects",
  );
}

test(
  "posted vendor terms retain discount and audit authority after setup replacement",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Payables clerk", "admin");
      const profile = await fixture(org, actor);
      const originalTerms = await terms(org, "2");
      await db.execute(
        sql`update vendor_roles set payment_terms_id = ${originalTerms} where org_id = ${org.orgId} and party_id = ${org.vendorId}`,
      );
      const id = await bill(org, actor);
      const before = await retained(org, id);
      const snapshot = before.snapshot as {
        mode: string;
        source: string;
        terms: { id: string; discountPercent: string; revisionHash: string };
      };
      assert.equal(snapshot.mode, "discount");
      assert.equal(snapshot.source, "vendor");
      assert.equal(snapshot.terms.id, originalTerms);
      assert.equal(snapshot.terms.discountPercent, "2.0000");
      assert.match(snapshot.terms.revisionHash, /^[a-f0-9]{64}$/);
      const audit = await db.execute<{ retained: unknown }>(
        sql`
      select changes #> '{after,document,payment_terms_snapshot}' as retained from audit_log
      where org_id = ${org.orgId} and table_name = 'documents' and row_id = ${id} and action = 'post'`,
        "objects",
      );
      assert.equal(audit.length, 1);
      assert.deepEqual(audit[0]!.retained, before.snapshot);

      const replacementTerms = await terms(org, "9", 90);
      await db.execute(
        sql`update vendor_roles set payment_terms_id = ${replacementTerms} where org_id = ${org.orgId} and party_id = ${org.vendorId}`,
      );
      await db.execute(
        sql`update payment_terms set discount_percent = 7, discount_days = 1, is_active = false where org_id = ${org.orgId} and id = ${originalTerms}`,
      );
      const paymentRun = await run(org, actor, profile, id);
      assert.deepEqual(await composition(org, paymentRun.id), [
        { discount: "2.0000", payment: "98.0000" },
      ]);
      assert.deepEqual(
        await retained(org, id),
        before,
        "the original posted policy and journal identity remain unchanged",
      );
      await assert.rejects(
        db.execute(
          sql`update documents set payment_terms_snapshot = null where org_id = ${org.orgId} and id = ${id}`,
        ),
        (error) => errorChainMatches(error, /Posted payment terms are immutable/),
      );
      assert.deepEqual(await retained(org, id), before);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "explicit no-terms authority cannot acquire a discount from later vendor setup",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Payables clerk", "admin");
      const profile = await fixture(org, actor);
      const id = await bill(org, actor);
      const snapshot = (await retained(org, id)).snapshot as {
        source: string;
        mode: string;
        terms: unknown;
      };
      assert.deepEqual(
        [snapshot.source, snapshot.mode, snapshot.terms],
        ["none", "no_discount", null],
      );
      const replacement = await terms(org, "5");
      await db.execute(
        sql`update vendor_roles set payment_terms_id = ${replacement} where org_id = ${org.orgId} and party_id = ${org.vendorId}`,
      );
      const paymentRun = await run(org, actor, profile, id);
      assert.deepEqual(await composition(org, paymentRun.id), [
        { discount: "0.0000", payment: "100.0000" },
      ]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "company-default terms are retained with the same posting-time due-date basis",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Payables clerk", "admin");
      const profile = await fixture(org, actor);
      const defaultId = await terms(org, "3");
      await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{billing}',
      jsonb_build_object('defaultPaymentTermsId', ${defaultId}::text), true) where id = ${org.orgId}`);
      const id = await bill(org, actor);
      const snapshot = (await retained(org, id)).snapshot as {
        source: string;
        terms: { id: string };
      };
      assert.equal(snapshot.source, "company");
      assert.equal(snapshot.terms.id, defaultId);
      const paymentRun = await run(org, actor, profile, id);
      assert.deepEqual(await composition(org, paymentRun.id), [
        { discount: "3.0000", payment: "97.0000" },
      ]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "historical replay does not fabricate current terms and missing evidence refuses capture atomically",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Payables clerk", "admin");
      const profile = await fixture(org, actor);
      const currentTerms = await terms(org, "5");
      await db.execute(
        sql`update vendor_roles set payment_terms_id = ${currentTerms} where org_id = ${org.orgId} and party_id = ${org.vendorId}`,
      );
      const id = await bill(org, actor, true);
      const before = await retained(org, id);
      assert.equal(before.snapshot, null);
      await assert.rejects(
        run(org, actor, profile, id),
        /missing or invalid retained payment terms/,
      );
      const rows = (
        await db.execute<{ runs: string; items: string }>(
          sql`
      select (select count(*)::text from payment_runs where org_id = ${org.orgId}) as runs,
        (select count(*)::text from payment_run_items where org_id = ${org.orgId}) as items`,
          "objects",
        )
      )[0]!;
      assert.deepEqual(rows, { runs: "0", items: "0" });
      assert.deepEqual(await retained(org, id), before);
      const paymentRun = await run(org, actor, profile, id, false);
      assert.deepEqual(await composition(org, paymentRun.id), [
        { discount: "0.0000", payment: "100.0000" },
      ]);
      assert.deepEqual(await retained(org, id), before);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "financial-history cloning rebinds payment policy identities without changing its economics",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    let sandboxId: string | null = null;
    try {
      const actor = await createScratchUser(org.orgId, "Payables clerk", "admin");
      await fixture(org, actor);
      const termsId = await terms(org, "2");
      await db.execute(
        sql`update vendor_roles set payment_terms_id = ${termsId} where org_id = ${org.orgId} and party_id = ${org.vendorId}`,
      );
      const id = await bill(org, actor);
      const original = (await retained(org, id)).snapshot as {
        partyId: string;
        terms: { id: string; revisionHash: string };
      };
      const created = await createSandbox({
        productionOrgId: org.orgId,
        name: `Payment terms ${randomUUID()}`,
        tier: "full",
        masked: false,
      });
      sandboxId = created.sandboxId;
      const copies = await db.execute<{
        party_id: string;
        snapshot: typeof original;
        terms_id: string;
      }>(
        sql`
      select d.party_id, d.payment_terms_snapshot as snapshot, p.id as terms_id
      from documents d join payment_terms p on p.org_id = d.org_id and p.id = (d.payment_terms_snapshot #>> '{terms,id}')::uuid
      where d.org_id = ${created.sandboxOrgId} and d.kind = 'vendor_bill'`,
        "objects",
      );
      assert.equal(copies.length, 1);
      const copy = copies[0]!;
      assert.notEqual(copy.party_id, org.vendorId);
      assert.notEqual(copy.terms_id, termsId);
      assert.deepEqual(copy.snapshot, {
        ...original,
        partyId: copy.party_id,
        terms: { ...original.terms, id: copy.terms_id },
      });
      assert.deepEqual((await retained(org, id)).snapshot, original);
      await assert.rejects(
        db.execute(sql`select public.document_payment_terms_snapshot_for_clone(
      ${JSON.stringify({ ...original, terms: { ...original.terms, id: randomUUID() } })}::jsonb,
      ${org.orgId}, ${org.vendorId}, ${randomUUID()})`),
        (error) =>
          errorChainMatches(error, /policy identity is absent from the source organization/),
      );
    } finally {
      try {
        if (sandboxId) await deleteSandbox(sandboxId);
      } finally {
        await dropScratchOrg(org.orgId);
      }
    }
  },
);
