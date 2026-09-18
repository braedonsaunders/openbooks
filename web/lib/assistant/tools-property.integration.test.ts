import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../auth';

const root = pathToFileURL(process.cwd() + '/').href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' };
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2);
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
      if (existsSync(new URL(path + suffix))) return nextResolve(path + suffix, context);
    }
    return nextResolve(path, context);
  }
  return nextResolve(specifier, context);
} });

const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { executeAssistantTool } = await import('./registry');

function userFor(orgId: string, name: string): SessionUser {
  const userId = randomUUID();
  return {
    id: userId,
    orgId,
    name,
    email: `${name.replaceAll(' ', '.').toLowerCase()}@scratch.test`,
    roles: [{ key: 'ordinary-role', name: 'Ordinary role' }],
    isSuperAdmin: false,
    envKind: 'production',
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: userId,
  };
}

const PROPERTY_PERMS = ['assistant.use', 'ar.read'];

// File-local seed helpers: always fixture writes, so they carry their own
// bypass. The subsidiaries parent guard reads the parent row through the
// ambient scope, so unscoped seeds misfire it even for same-org parents.
async function enablePropertyManagement(orgId: string) {
  await withBypassContext(() => db.execute(sql`
    update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',coalesce(settings->'features','{}'::jsonb)||'{"propertyManagement":true}'::jsonb)
    where id=${orgId}
  `));
}

/** One visible property/lease (monthly rent + past-due invoice) and one hidden pair. */
async function seedProperty(org: {
  orgId: string; subsidiaryId: string; customerId: string; bookId: string; periodId: string; date: string;
  accounts: Record<"ar" | "revenue", string>;
}) {
  const { orgId, customerId } = org;
  const rootSubsidiary = org.subsidiaryId;
  const property = randomUUID();
  const unit = randomUUID();
  const lease = randomUUID();
  const charge = randomUUID();
  const invoice = randomUUID();
  const entry = randomUUID();
  const hiddenSubsidiary = randomUUID();
  const hiddenProperty = randomUUID();
  const hiddenLease = randomUUID();
  const hiddenParty = randomUUID();
  await db.execute(sql`
    insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active,is_elimination)
    values (${hiddenSubsidiary},${orgId},${rootSubsidiary},'Hidden property entity','CAD','CA',true,false)
  `);
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom, subsidiary_id)
    values (${hiddenParty}, ${orgId}, 'customer', 'Hidden Tenant', true, '{}'::jsonb, ${hiddenSubsidiary})
  `);
  await db.execute(sql`
    insert into managed_properties(id,org_id,subsidiary_id,code,name,property_type,currency,status)
    values (${property},${orgId},${rootSubsidiary},'HARBOUR','Harbourview Tower','commercial','CAD','active'),
           (${hiddenProperty},${orgId},${hiddenSubsidiary},'HIDDEN','Hidden Block','commercial','CAD','active')
  `);
  await db.execute(sql`
    insert into property_units(id,org_id,property_id,code,name,status)
    values (${unit},${orgId},${property},'U-101','Suite 101','occupied')
  `);
  await db.execute(sql`
    insert into property_leases(id,org_id,property_id,unit_id,tenant_id,lease_number,status,starts_on,ends_on)
    values (${lease},${orgId},${property},${unit},${customerId},'L-1001','active','2026-01-01','2026-12-31'),
           (${hiddenLease},${orgId},${hiddenProperty},null,${hiddenParty},'L-1002','active','2026-01-01','2026-12-31')
  `);
  await db.execute(sql`
    insert into lease_charges(id,org_id,lease_id,charge_type,description,amount,frequency,effective_from)
    values (${charge},${orgId},${lease},'base_rent','Monthly base rent','2000','monthly','2026-01-01')
  `);
  // Posted rent invoice through a real journal entry, following the
  // payment-scope fixture pattern (draft doc + balanced entry, then post).
  await db.execute(sql`
    insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,due_date,currency,subtotal,tax_total,total,open_balance)
    values (${invoice},${orgId},'customer_invoice','draft','INV-1001',${rootSubsidiary},${customerId},'2026-08-01','2026-08-01','CAD','2000','0','2000','2000')
  `);
  await db.execute(sql`
    insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,source_document_id)
    values (${entry},${orgId},${org.bookId},${rootSubsidiary},${entry},'2026-08-01',${org.periodId},'draft',${invoice})
  `);
  await db.execute(sql`
    insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,party_id,is_open_item)
    values (${randomUUID()},${orgId},${entry},1,${org.accounts.ar},${rootSubsidiary},'2000','CAD','2000','1',${customerId},true),
           (${randomUUID()},${orgId},${entry},2,${org.accounts.revenue},${rootSubsidiary},'-2000','CAD','-2000','1',null,false)
  `);
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`);
  await db.execute(sql`update documents set status = 'approved' where id = ${invoice}`);
  await db.execute(sql`
    update documents set status = 'posted', posted_entry_id = ${entry}, posting_period_id = ${org.periodId} where id = ${invoice}
  `);
  await db.execute(sql`
    insert into lease_schedule_lines(id,org_id,lease_id,charge_id,period_starts_on,period_ends_on,due_on,amount,status,invoice_document_id)
    values (${randomUUID()},${orgId},${lease},${charge},'2026-08-01','2026-08-31','2026-08-05','2000','invoiced',${invoice})
  `);
  return { property, unit, lease, hiddenProperty, hiddenLease };
}

test('property assistant reads: register, lease detail, rent roll, arrears, deposits', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  await enablePropertyManagement(org.orgId);
  try {
    const seed = await withBypassContext(() => seedProperty(org));
    const restricted = {
      user: userFor(org.orgId, 'Property scope reader'),
      permissions: new Set(PROPERTY_PERMS),
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    };
    await withOrgContext(org.orgId, async () => {
      const properties = await executeAssistantTool(restricted, 'list_properties', {});
      assert.equal(properties.ok, true, JSON.stringify(properties));
      assert.ok(properties.ok);
      assert.equal((properties.data as { total: number }).total, 1);

      const leases = await executeAssistantTool(restricted, 'list_leases', {});
      assert.equal(leases.ok, true, JSON.stringify(leases));
      assert.ok(leases.ok);
      const leaseData = leases.data as { total: number; leases: { leaseNumber: string; baseRent: number }[] };
      assert.equal(leaseData.total, 1);
      assert.equal(leaseData.leases[0]!.leaseNumber, 'L-1001');
      assert.equal(leaseData.leases[0]!.baseRent, 2000);

      const hidden = await executeAssistantTool(restricted, 'get_lease', { leaseId: seed.hiddenLease });
      assert.deepEqual(hidden, { ok: false, error: 'lease_not_found' });

      const detail = await executeAssistantTool(restricted, 'get_lease', { leaseId: seed.lease });
      assert.equal(detail.ok, true, JSON.stringify(detail));
      assert.ok(detail.ok);
      const lease = (detail.data as { lease: { monthlyCharges: number; pastDue: number } }).lease;
      assert.equal(lease.monthlyCharges, 2000);
      assert.equal(lease.pastDue, 2000);

      const roll = await executeAssistantTool(restricted, 'rent_roll', {});
      assert.equal(roll.ok, true, JSON.stringify(roll));
      assert.ok(roll.ok);
      const rollData = roll.data as {
        total: number;
        monthlyChargesByCurrency: { currency: string; amount: number }[];
        pastDueByCurrency: { currency: string; amount: number }[];
        occupancy: { totalUnits: number; occupiedUnits: number };
      };
      assert.equal(rollData.total, 1);
      assert.deepEqual(rollData.monthlyChargesByCurrency, [{ currency: 'CAD', amount: 2000 }]);
      assert.deepEqual(rollData.pastDueByCurrency, [{ currency: 'CAD', amount: 2000 }]);
      assert.deepEqual(rollData.occupancy, { totalUnits: 1, occupiedUnits: 1 });

      const arrears = await executeAssistantTool(restricted, 'lease_arrears', {});
      assert.equal(arrears.ok, true, JSON.stringify(arrears));
      assert.ok(arrears.ok);
      const arrearsData = arrears.data as {
        total: number; totalsByCurrency: { currency: string; amount: number }[];
      };
      assert.equal(arrearsData.total, 1);
      assert.deepEqual(arrearsData.totalsByCurrency, [{ currency: 'CAD', amount: 2000 }]);

      const deposits = await executeAssistantTool(restricted, 'property_deposits', {});
      assert.equal(deposits.ok, true, JSON.stringify(deposits));
      assert.ok(deposits.ok);
      assert.equal((deposits.data as { returned: number }).returned, 1);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('property assistant reads isolate orgs and honor the feature flag', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgA = await withBypassContext(() => createScratchOrg());
  const orgB = await withBypassContext(() => createScratchOrg());
  await enablePropertyManagement(orgA.orgId);
  await enablePropertyManagement(orgB.orgId);
  try {
    const seedA = await withBypassContext(() => seedProperty(orgA));
    const authzA = {
      user: userFor(orgA.orgId, 'Property org reader'),
      permissions: new Set(PROPERTY_PERMS),
      allowedSubsidiaryIds: null as Set<string> | null,
    };
    await withOrgContext(orgA.orgId, async () => {
      const cross = await executeAssistantTool(
        { ...authzA, user: { ...authzA.user, orgId: orgB.orgId } },
        'get_lease',
        { leaseId: seedA.lease },
      );
      assert.deepEqual(cross, { ok: false, error: 'lease_not_found' });
    });
    // Same fixture-write class as enablePropertyManagement above: unscoped,
    // the constrained role updates zero orgs rows and the flag stays on.
    await withBypassContext(() => db.execute(sql`
      update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',coalesce(settings->'features','{}'::jsonb)||'{"propertyManagement":false}'::jsonb)
      where id=${orgA.orgId}
    `));
    await withOrgContext(orgA.orgId, async () => {
      const off = await executeAssistantTool(authzA, 'list_properties', {});
      assert.deepEqual(off, { ok: false, error: 'propertyManagement_feature_disabled' });
    });
  } finally {
    await dropScratchOrg(orgA.orgId);
    await dropScratchOrg(orgB.orgId);
  }
});
