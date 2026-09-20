import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier.startsWith('@/')) return next(root+'web/'+specifier.slice(2)+'.ts',context);
  return next(specifier,context);
}});
const { sql } = await import('drizzle-orm');
const { randomUUID } = await import('node:crypto');
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { loadParty } = await import("../app/api/parties/_lib");
const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

// F-t02-005: document open balances are stored unsigned per document (the
// recompute sums abs() line amounts minus applications); the KIND carries the
// sign. The party directory summary must net unapplied credits against the
// customer's invoices instead of adding them with abs().
async function fixture(action: (org: Awaited<ReturnType<typeof createScratchOrg>>) => Promise<void>) {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withBypassContext(async () => {
      const invoice = randomUUID();
      await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,document_date,party_id,currency,subtotal,tax_total,total,open_balance)
        values (${invoice},${org.orgId},'customer_invoice','draft','INV-BAL-1','2026-07-15',${org.customerId},'CAD',12000,0,12000,7000)`);
      const credit = randomUUID();
      await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,document_date,party_id,currency,subtotal,tax_total,total,open_balance)
        values (${credit},${org.orgId},'customer_credit','draft','CM-BAL-1','2026-07-15',${org.customerId},'CAD',1000,0,1000,1000)`);
    });
    await withOrgContext(org.orgId, () => action(org));
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
}

test('party open balance nets an unapplied credit against its invoices', enabled, async () => fixture(async (org) => {
  const payload = await loadParty(org.customerId, org.orgId, null);
  assert.ok(payload, 'party must load');
  assert.equal(payload.transactionSummary.openCount, 2);
  const cad = payload.transactionSummary.currencies.find((c) => c.currency === 'CAD');
  assert.ok(cad, 'CAD summary must exist');
  assert.equal(cad.openBalance, '6000.0000');
}));

test('vendor open balance nets an unapplied credit against its bills', enabled, async () => fixture(async (org) => {
  const vendorId = org.vendorId;
  await withBypassContext(async () => {
    const bill = randomUUID();
    await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,document_date,party_id,currency,subtotal,tax_total,total,open_balance)
      values (${bill},${org.orgId},'vendor_bill','draft','BILL-BAL-1','2026-07-15',${vendorId},'CAD',5000,0,5000,5000)`);
    const credit = randomUUID();
    await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,document_date,party_id,currency,subtotal,tax_total,total,open_balance)
      values (${credit},${org.orgId},'vendor_credit','draft','VCRED-BAL-1','2026-07-15',${vendorId},'CAD',1000,0,1000,1000)`);
  });
  const payload = await loadParty(org.vendorId, org.orgId, null);
  assert.ok(payload, 'vendor must load');
  const cad = payload!.transactionSummary.currencies.find((c) => c.currency === 'CAD');
  assert.ok(cad, 'CAD summary must exist');
  assert.equal(cad.openBalance, '4000.0000');
}));
