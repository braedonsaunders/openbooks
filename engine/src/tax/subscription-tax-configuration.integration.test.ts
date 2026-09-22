import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createSubscriptionInvoice,
  SubscriptionError,
  type InvoiceSpec,
} from "../billing/subscription-billing.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting, type ScratchOrg } from "../testing/fixtures.ts";

/**
 * Subscription generation must never price a non-null tax code as 0% when the
 * code cannot be resolved: an inactive or missing code refuses by name before
 * any document/line/evidence write, while a configured statutory zero still
 * generates at zero and a live rate still writes calculation evidence. A live
 * code whose rate has lapsed before the invoice date keeps its existing
 * effective-rate refusal.
 */
const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

type Fixture = { org: ScratchOrg; actor: string; taxCodeId: string; zeroCodeId: string };
async function fixture(run: (f: Fixture) => Promise<void>) {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Subscription tax controller", "admin");
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"subscriptionBilling":true}'::jsonb) where id=${org.orgId}`);
    const taxCodeId = randomUUID();
    await db.execute(sql`insert into tax_codes (id,org_id,code,name,collected_account_id,paid_account_id)
      values (${taxCodeId},${org.orgId},'SUB-TAXED','Subscription configured rate',${org.accounts.taxOutput},${org.accounts.taxInput})`);
    await db.execute(sql`insert into tax_rates (org_id,tax_code_id,rate_percent,effective_from)
      values (${org.orgId},${taxCodeId},'13','2026-01-01')`);
    const zeroCodeId = randomUUID();
    await db.execute(sql`insert into tax_codes (id,org_id,code,name,collected_account_id,paid_account_id)
      values (${zeroCodeId},${org.orgId},'SUB-ZERO','Subscription statutory zero',${org.accounts.taxOutput},${org.accounts.taxInput})`);
    await db.execute(sql`insert into tax_rates (org_id,tax_code_id,rate_percent,effective_from)
      values (${org.orgId},${zeroCodeId},'0','2026-01-01')`);
    await run({ org, actor, taxCodeId, zeroCodeId });
  } finally { await dropScratchOrgReporting(org.orgId); }
}

function spec(f: Fixture, changes: Partial<InvoiceSpec> = {}): InvoiceSpec {
  return { orgId: f.org.orgId, actorId: f.actor, customerId: f.org.customerId, subsidiaryId: f.org.subsidiaryId,
    currency: "CAD", incomeAccountId: f.org.accounts.revenue, itemId: null, taxCodeId: f.taxCodeId,
    description: "Configured-rate charge", quantity: "1", unitPrice: "100.0000", memo: "Tax configuration",
    invoiceDate: f.org.date, autoPost: false, ...changes };
}

async function snapshot(orgId: string) {
  return (await db.execute(sql`select
    (select count(*)::int from documents where org_id=${orgId}) as documents,
    (select count(*)::int from document_lines where org_id=${orgId}) as lines,
    (select count(*)::int from document_line_tax_components where org_id=${orgId}) as evidence,
    (select jsonb_agg(to_jsonb(n) order by id) from number_sequences n where org_id=${orgId}) as numbers`)).rows[0];
}

test("inactive subscription tax code refuses by code and date before any write", enabled, () => fixture(async (f) => {
  await db.execute(sql`update tax_codes set is_active=false where id=${f.taxCodeId}`);
  const before = await snapshot(f.org.orgId);
  await assert.rejects(createSubscriptionInvoice(spec(f)),
    (e: unknown) => e instanceof SubscriptionError
      && /SUB-TAXED/.test(e.message)
      && new RegExp(f.org.date).test(e.message)
      && /reactivate/i.test(e.message)
      && /billing plan\/charge/i.test(e.message));
  assert.deepEqual(await snapshot(f.org.orgId), before, "an inactive tax code refuses before document, line, evidence, and numbering writes");
}));

test("missing subscription tax code refuses by reference and date before any write", enabled, () => fixture(async (f) => {
  const missing = randomUUID();
  const before = await snapshot(f.org.orgId);
  await assert.rejects(createSubscriptionInvoice(spec(f, { taxCodeId: missing })),
    (e: unknown) => e instanceof SubscriptionError
      && (e.message as string).includes(missing)
      && new RegExp(f.org.date).test(e.message)
      && /billing plan\/charge/i.test(e.message));
  assert.deepEqual(await snapshot(f.org.orgId), before, "a missing tax code refuses before document, line, evidence, and numbering writes");
}));

test("lapsed subscription tax rate keeps its effective-rate refusal", enabled, () => fixture(async (f) => {
  await db.execute(sql`update tax_rates set effective_to='2026-07-14'
    where org_id=${f.org.orgId} and tax_code_id=${f.taxCodeId}`);
  const before = await snapshot(f.org.orgId);
  await assert.rejects(createSubscriptionInvoice(spec(f)), /no rate effective/);
  assert.deepEqual(await snapshot(f.org.orgId), before, "a lapsed rate refuses before document, line, evidence, and numbering writes");
}));

test("configured statutory zero still generates at zero tax", enabled, () => fixture(async (f) => {
  const generated = await createSubscriptionInvoice(spec(f, { taxCodeId: f.zeroCodeId }));
  const doc = (await db.execute<{ tax_total: string; total: string }>(
    sql`select tax_total::text as tax_total, total::text as total from documents where id=${generated.invoiceId}`,
  )).rows[0]!;
  assert.equal(doc.tax_total, "0.0000", "a matched 0% rate is legitimate zero, not a refusal");
  assert.equal(doc.total, "100.0000");
}));

test("live subscription tax rate still writes positive evidence", enabled, () => fixture(async (f) => {
  const generated = await createSubscriptionInvoice(spec(f));
  const doc = (await db.execute<{ tax_total: string }>(
    sql`select tax_total::text as tax_total from documents where id=${generated.invoiceId}`,
  )).rows[0]!;
  assert.notEqual(doc.tax_total, "0.0000", "the 13% code must produce tax");
  const evidence = (await db.execute<{ n: number }>(
    sql`select count(*)::int as n from document_line_tax_components c
         join document_lines l on l.id = c.document_line_id
        where l.document_id=${generated.invoiceId} and l.org_id=${f.org.orgId}`,
  )).rows[0]!.n;
  assert.ok(evidence > 0, "a taxed subscription line carries calculation evidence");
}));

test("untaxed subscription generation is unchanged", enabled, () => fixture(async (f) => {
  const plain = await createSubscriptionInvoice(spec(f, { taxCodeId: null }));
  const skipped = await createSubscriptionInvoice(spec(f, { applyTax: false }));
  for (const generated of [plain, skipped]) {
    const doc = (await db.execute<{ tax_total: string; total: string }>(
      sql`select tax_total::text as tax_total, total::text as total from documents where id=${generated.invoiceId}`,
    )).rows[0]!;
    assert.equal(doc.tax_total, "0.0000");
    assert.equal(doc.total, "100.0000");
  }
}));
