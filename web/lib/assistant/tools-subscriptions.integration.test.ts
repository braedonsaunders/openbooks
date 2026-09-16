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
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts');
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

const SUB_PERMS = ['assistant.use', 'ar.read'];

async function enableSubscriptionBilling(orgId: string) {
  await db.execute(sql`
    update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',coalesce(settings->'features','{}'::jsonb)||'{"subscriptionBilling":true}'::jsonb)
    where id=${orgId}
  `);
}

const RECUR_PERMS = ['assistant.use', 'documents.manage'];

async function seedSubscriptions(orgId: string, rootSubsidiary: string, customerId: string) {
  const planMonthly = randomUUID();
  const planQuarterly = randomUUID();
  const hiddenSubsidiary = randomUUID();
  const hiddenParty = randomUUID();
  const activeSub = randomUUID();
  const pausedSub = randomUUID();
  const hiddenSub = randomUUID();
  const templateDoc = randomUUID();
  const schedule = randomUUID();
  await db.execute(sql`
    insert into subscription_plans(id,org_id,name,amount,currency_code,interval,interval_count,is_active)
    values (${planMonthly},${orgId},'Harbour Support','100','CAD','monthly',1,true),
           (${planQuarterly},${orgId},'Harbour Platform','300','CAD','quarterly',1,true)
  `);
  await db.execute(sql`
    insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active,is_elimination)
    values (${hiddenSubsidiary},${orgId},${rootSubsidiary},'Hidden billing entity','CAD','CA',true,false)
  `);
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom, subsidiary_id)
    values (${hiddenParty}, ${orgId}, 'customer', 'Hidden Subscriber', true, '{}'::jsonb, ${hiddenSubsidiary})
  `);
  await db.execute(sql`
    insert into subscriptions(id,org_id,customer_id,plan_id,quantity,status,start_on,next_bill_on,dunning_state)
    values (${activeSub},${orgId},${customerId},${planMonthly},'1','active','2026-01-01','2026-11-01','current'),
           (${pausedSub},${orgId},${customerId},${planQuarterly},'2','paused','2026-02-01','2026-12-01','current'),
           (${hiddenSub},${orgId},${hiddenParty},${planMonthly},'1','active','2026-03-01','2026-11-15','overdue')
  `);
  await db.execute(sql`
    insert into documents(id,org_id,kind,document_number,party_id,document_date,currency,total,status,subsidiary_id)
    values (${templateDoc},${orgId},'customer_invoice','TMPL-001',${customerId},'2026-01-01','CAD','100','draft',${rootSubsidiary})
  `);
  await db.execute(sql`
    insert into recurring_schedules(id,org_id,template_document_id,cadence,next_run_on,is_active)
    values (${schedule},${orgId},${templateDoc},'monthly','2026-11-01',true)
  `);
  return { planMonthly, planQuarterly, hiddenSubsidiary, hiddenParty, activeSub, pausedSub, hiddenSub, schedule };
}

test('subscription assistant reads: plans, list, detail, MRR, upcoming', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  await enableSubscriptionBilling(org.orgId);
  try {
    const seed = await seedSubscriptions(org.orgId, org.subsidiaryId, org.customerId);
    const restricted = {
      user: userFor(org.orgId, 'Billing scope reader'),
      permissions: new Set(SUB_PERMS),
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    };
    await withOrgContext(org.orgId, async () => {
      const plans = await executeAssistantTool(restricted, 'list_subscription_plans', {});
      assert.equal(plans.ok, true, JSON.stringify(plans));
      assert.ok(plans.ok);
      assert.equal((plans.data as { total: number }).total, 2);

      const list = await executeAssistantTool(restricted, 'list_subscriptions', {});
      assert.equal(list.ok, true, JSON.stringify(list));
      assert.ok(list.ok);
      const listData = list.data as {
        total: number; byStatus: { status: string; count: number }[];
        mrrByCurrency: { currency: string; mrr: number }[]; mrrOrgTotal: number;
      };
      // The hidden subsidiary's subscription is invisible to the restricted caller.
      assert.equal(listData.total, 2);
      assert.deepEqual(listData.byStatus, [
        { status: 'active', count: 1 },
        { status: 'paused', count: 1 },
      ]);
      assert.deepEqual(listData.mrrByCurrency, [{ currency: 'CAD', mrr: 100 }]);
      assert.equal(listData.mrrOrgTotal, 100);

      const detail = await executeAssistantTool(restricted, 'get_subscription', { subscriptionId: seed.activeSub });
      assert.equal(detail.ok, true, JSON.stringify(detail));
      assert.ok(detail.ok);
      const sub = (detail.data as { subscription: { planName: string; mrr: number; dunningState: string } }).subscription;
      assert.equal(sub.planName, 'Harbour Support');
      assert.equal(sub.mrr, 100);
      assert.equal(sub.dunningState, 'current');

      const hidden = await executeAssistantTool(restricted, 'get_subscription', { subscriptionId: seed.hiddenSub });
      assert.deepEqual(hidden, { ok: false, error: 'subscription_not_found' });

      const mrr = await executeAssistantTool(restricted, 'subscription_mrr', {});
      assert.equal(mrr.ok, true, JSON.stringify(mrr));
      assert.ok(mrr.ok);
      const mrrData = mrr.data as {
        activeCount: number; mrrOrgTotal: number;
        byDunningState: { dunningState: string; count: number }[];
        churnTrailing30Days: { canceledCount: number };
      };
      assert.equal(mrrData.activeCount, 1);
      assert.equal(mrrData.mrrOrgTotal, 100);
      assert.deepEqual(mrrData.byDunningState, [{ dunningState: 'current', count: 1 }]);

      const upcoming = await executeAssistantTool(restricted, 'subscription_upcoming_invoices', { withinDays: 365 });
      assert.equal(upcoming.ok, true, JSON.stringify(upcoming));
      assert.ok(upcoming.ok);
      const upcomingData = upcoming.data as {
        total: number; totalsByCurrency: { currency: string; count: number; expectedAmount: number }[];
      };
      // Only the visible active subscription bills inside the window.
      assert.equal(upcomingData.total, 1);
      assert.deepEqual(upcomingData.totalsByCurrency, [{ currency: 'CAD', count: 1, expectedAmount: 100 }]);

      const schedules = await executeAssistantTool(
        { ...restricted, permissions: new Set(RECUR_PERMS) },
        'list_recurring_schedules',
        {},
      );
      assert.equal(schedules.ok, true, JSON.stringify(schedules));
      assert.ok(schedules.ok);
      assert.equal((schedules.data as { returned: number }).returned, 1);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('subscription assistant reads isolate orgs and honor the feature flag', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgA = await createScratchOrg();
  const orgB = await createScratchOrg();
  await enableSubscriptionBilling(orgA.orgId);
  await enableSubscriptionBilling(orgB.orgId);
  try {
    const seedA = await seedSubscriptions(orgA.orgId, orgA.subsidiaryId, orgA.customerId);
    const authzA = {
      user: userFor(orgA.orgId, 'Billing org reader'),
      permissions: new Set(SUB_PERMS),
      allowedSubsidiaryIds: null as Set<string> | null,
    };
    await withOrgContext(orgA.orgId, async () => {
      const cross = await executeAssistantTool(
        { ...authzA, user: { ...authzA.user, orgId: orgB.orgId } },
        'get_subscription',
        { subscriptionId: seedA.activeSub },
      );
      assert.deepEqual(cross, { ok: false, error: 'subscription_not_found' });
    });
    await db.execute(sql`
      update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',coalesce(settings->'features','{}'::jsonb)||'{"subscriptionBilling":false}'::jsonb)
      where id=${orgA.orgId}
    `);
    await withOrgContext(orgA.orgId, async () => {
      const off = await executeAssistantTool(authzA, 'list_subscriptions', {});
      assert.deepEqual(off, { ok: false, error: 'subscription_billing_feature_disabled' });
      // Recurring reads carry no feature flag and keep working.
      const schedules = await executeAssistantTool(
        { ...authzA, permissions: new Set(RECUR_PERMS) },
        'list_recurring_schedules',
        {},
      );
      assert.equal(schedules.ok, true, JSON.stringify(schedules));
    });
  } finally {
    await dropScratchOrg(orgA.orgId);
    await dropScratchOrg(orgB.orgId);
  }
});
