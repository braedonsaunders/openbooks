import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "./db.ts";
import { billSubscriptionNow, createSubscriptionInvoice, SubscriptionError, type InvoiceSpec } from "./subscription-billing.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting, type ScratchOrg } from "./test-fixtures.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
type Fixture = { org: ScratchOrg; actor: string; planId: string; subscriptionId: string };
async function fixture(run: (f: Fixture) => Promise<void>) {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Subscription account controller", "admin");
    const planId = randomUUID(), subscriptionId = randomUUID();
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"subscriptionBilling":true}'::jsonb) where id=${org.orgId}`);
    await db.execute(sql`insert into subscription_plans(id,org_id,name,amount,interval,interval_count,income_account_id,created_by)
      values(${planId},${org.orgId},'Account policy plan','100.1234','monthly',1,${org.accounts.revenue},${actor})`);
    await db.execute(sql`insert into subscriptions(id,org_id,customer_id,plan_id,quantity,status,start_on,next_bill_on,auto_post,created_by)
      values(${subscriptionId},${org.orgId},${org.customerId},${planId},'1','active',${org.date},${org.date},false,${actor})`);
    await run({ org, actor, planId, subscriptionId });
  } finally { await dropScratchOrgReporting(org.orgId); }
}
async function snapshot(f: Fixture) {
  return (await db.execute(sql`select
    (select jsonb_agg(to_jsonb(s) order by id) from subscriptions s where org_id=${f.org.orgId}) as subscriptions,
    (select jsonb_agg(to_jsonb(p) order by id) from subscription_period_invoices p where org_id=${f.org.orgId}) as periods,
    (select jsonb_agg(to_jsonb(d) order by id) from documents d where org_id=${f.org.orgId}) as documents,
    (select jsonb_agg(to_jsonb(l) order by id) from document_lines l where org_id=${f.org.orgId}) as lines,
    (select jsonb_agg(to_jsonb(n) order by id) from number_sequences n where org_id=${f.org.orgId}) as numbers,
    (select jsonb_agg(to_jsonb(a) order by id) from audit_log a where org_id=${f.org.orgId}) as audit,
    (select jsonb_agg(to_jsonb(j) order by id) from journal_entries j where org_id=${f.org.orgId}) as journal`)).rows[0];
}
function spec(f: Fixture, changes: Partial<InvoiceSpec> = {}): InvoiceSpec {
  return { orgId: f.org.orgId, actorId: f.actor, customerId: f.org.customerId, subsidiaryId: f.org.subsidiaryId,
    currency: 'CAD', incomeAccountId: f.org.accounts.revenue, itemId: null, taxCodeId: null, description: 'Account policy charge',
    quantity: '1', unitPrice: '100.1234', memo: 'Account policy', invoiceDate: f.org.date, autoPost: false, ...changes };
}
async function refused(f: Fixture, generate: () => Promise<unknown>) {
  const before = await snapshot(f);
  await assert.rejects(generate, (e: unknown) => e instanceof SubscriptionError && /income account/i.test(e.message));
  assert.deepEqual(await snapshot(f), before, 'failed account validation preserves source, numbering, documents, journal, and audit');
}

test('subscription requires plan income account despite available chart revenue', enabled, () => fixture(async f => {
  await db.execute(sql`update subscription_plans set income_account_id=null where id=${f.planId}`);
  await refused(f, () => billSubscriptionNow(f.subscriptionId, f.org.date, { actorId: f.actor }));
}));
for (const state of ['inactive', 'summary'] as const) {
  test(`subscription rejects ${state} plan income account atomically`, enabled, () => fixture(async f => {
    await db.execute(sql`update accounts set is_active=${state !== 'inactive'},is_summary=${state === 'summary'} where id=${f.org.accounts.revenue}`);
    await refused(f, () => billSubscriptionNow(f.subscriptionId, f.org.date, { actorId: f.actor }));
  }));
}
test('subscription invoice rejects nonexistent and other-organization accounts before writes', enabled, () => fixture(async f => {
  const other = await createScratchOrg();
  try {
    for (const incomeAccountId of [randomUUID(), other.accounts.revenue]) {
      await refused(f, () => createSubscriptionInvoice(spec(f, { incomeAccountId })));
    }
  } finally { await dropScratchOrgReporting(other.orgId); }
}));
test('component account validation does not fall back to the scalar plan account', enabled, () => fixture(async f => {
  await refused(f, () => createSubscriptionInvoice(spec(f, { lines: [
    { description: 'Configured component', quantity: '1', unitPrice: '20', incomeAccountId: f.org.accounts.revenue, itemId: null, taxCodeId: null },
    { description: 'Unconfigured component', quantity: '1', unitPrice: '30', incomeAccountId: null, itemId: null, taxCodeId: null },
  ] })));
}));
test('configured subscription preserves precise amount and period provenance', enabled, () => fixture(async f => {
  const generated = await billSubscriptionNow(f.subscriptionId, f.org.date, { actorId: f.actor });
  assert.deepEqual((await db.execute(sql`select account_id,amount::text from document_lines where document_id=${generated.invoiceId}`)).rows,
    [{ account_id: f.org.accounts.revenue, amount: '100.1234' }]);
  assert.equal((await db.execute(sql`select invoice_id from subscription_period_invoices where subscription_id=${f.subscriptionId}`)).rows[0]?.invoice_id, generated.invoiceId);
}));
test('explicit non-income account, native credit, and configured zero component retain their values', enabled, () => fixture(async f => {
  const generated = await createSubscriptionInvoice(spec(f, { documentKind: 'customer_credit', incomeAccountId: f.org.accounts.deferred,
    lines: [
      { description: 'Deferred credit', quantity: '1', unitPrice: '100.1234', incomeAccountId: f.org.accounts.deferred, itemId: null, taxCodeId: null },
      { description: 'Included service', quantity: '1', unitPrice: '0', incomeAccountId: f.org.accounts.revenue, itemId: null, taxCodeId: null },
    ] }));
  assert.equal(generated.total, '100.1234');
  assert.equal((await db.execute(sql`select kind from documents where id=${generated.invoiceId}`)).rows[0]?.kind, 'customer_credit');
  assert.deepEqual((await db.execute(sql`select account_id,amount::text from document_lines where document_id=${generated.invoiceId} order by line_number`)).rows,
    [{ account_id: f.org.accounts.deferred, amount: '100.1234' }, { account_id: f.org.accounts.revenue, amount: '0.0000' }]);
}));
test('zero charge requires configuration instead of generating an unpostable null-account row', enabled, () => fixture(async f => {
  await refused(f, () => createSubscriptionInvoice(spec(f, { unitPrice: '0', incomeAccountId: null })));
}));
test('direct generator rolls numbering and inserts back when later tax/document writes fail', enabled, () => fixture(async f => {
  const before = await snapshot(f);
  await assert.rejects(createSubscriptionInvoice(spec(f, { customerId: randomUUID() })));
  assert.deepEqual(await snapshot(f), before);
}));
test('generator reuses the caller transaction and cannot escape its tenant scope', enabled, () => fixture(async f => {
  const before = await snapshot(f);
  await assert.rejects(withOrg(f.org.orgId, async () => {
    await createSubscriptionInvoice(spec(f));
    throw new Error('outer transaction rollback');
  }), /outer transaction rollback/);
  assert.deepEqual(await snapshot(f), before);
  await assert.rejects(withOrg(randomUUID(), () => createSubscriptionInvoice(spec(f))), /cannot change organization/);
  assert.deepEqual(await snapshot(f), before);
}));
