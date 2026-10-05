import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgContext } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'
import { createPlanVersion, publishPlanVersion } from '@openbooks/engine/src/billing/advanced-subscriptions.ts'
import { createSaasFeature, savePlanVersionEntitlements } from '@openbooks/engine/src/billing/entitlements.ts'
import type { ApplicationContext } from './context'
import { ApplicationError } from './errors'
const { getV1Entitlements } = await import('./entitlements')

/**
 * Public entitlement reads refuse unknown customers by name: the miss
 * names the value the caller sent and the remedy that fixes it, instead
 * of resolving to an empty grant. Proofs read the refusal the API
 * serializes — code, message and remedy.
 */

function context(orgId: string, permissions: string[]): ApplicationContext {
  return {
    authz: { user: { orgId } as ApplicationContext['authz']['user'], permissions: new Set(permissions), allowedSubsidiaryIds: null },
    source: 'api', requestId: randomUUID(), apiKeyId: null,
  }
}

async function seedCustomerWithGrant(org: ScratchOrg, actor: string, customerId: string): Promise<string> {
  const orgId = org.orgId;
  const planId = randomUUID();
  await db.execute(sql`
    insert into subscription_plans
      (id, org_id, name, amount, currency_code, interval, interval_count,
       income_account_id, is_active, created_by)
    values (${planId}, ${orgId}, 'SaaS Plan', '0', 'CAD', 'monthly', 1,
            ${org.accounts.revenue}, true, ${actor})
  `);
  const versionId = await createPlanVersion(orgId, actor, {
    planId,
    effectiveFrom: '2026-05-01',
    components: [
      {
        componentKey: 'platform', name: 'Platform fee', quantity: '1', unitPrice: '100.00',
        incomeAccountId: org.accounts.revenue,
      },
    ],
  }, null);
  await createSaasFeature(orgId, actor, { key: 'seats_included', name: 'Seats', type: 'quantity', unit: 'seats' });
  await savePlanVersionEntitlements(orgId, actor, {
    planVersionId: versionId,
    effectiveFrom: '2026-05-01',
    rows: [{ featureKey: 'seats_included', limit: '100', overagePolicy: 'block' }],
  });
  await publishPlanVersion(orgId, actor, versionId, null);
  const subscriptionId = randomUUID();
  await db.execute(sql`
    insert into subscriptions
      (id, org_id, customer_id, plan_id, quantity, status, start_on, next_bill_on, auto_post, created_by)
    values (${subscriptionId}, ${orgId}, ${customerId}, ${planId}, '1', 'active',
            '2026-05-15', '2026-05-15', false, ${actor})
  `);
  return subscriptionId;
}

async function seedOrg(): Promise<{ org: ScratchOrg; actor: string }> {
  const org = await withBypassContext(() => (createScratchOrg()));
  const actor = await withBypassContext(() => (createScratchUser(org.orgId, 'Entitlement Owner', 'entitlement_owner')));
  await withBypassContext(() => db.execute(sql`update users set is_super_admin = true where id = ${actor} and org_id = ${org.orgId}`));
  await withBypassContext(() => db.execute(sql`
    update orgs
       set settings = settings || '{"features":{"subscriptionBilling":true,"advancedSubscriptions":true,"usageBilling":true,"apiAccess":true}}'::jsonb
     where id = ${org.orgId}
  `));
  return { org, actor };
}

test('an unknown customer name refuses with its remedy', async () => {
  const { org } = await seedOrg();
  const orgId = org.orgId;
  try {
    await withOrgContext(orgId, async () => {
      await assert.rejects(
        getV1Entitlements(context(orgId, ['ar.read']), { customer: 'Nobody Here' }),
        (error: unknown) => error instanceof ApplicationError
          && error.code === 'not_found'
          && error.status === 404
          && error.message === 'No customer is named Nobody Here in this organization.'
          && typeof error.details?.remedy === 'string',
      );
    });
  } finally { await dropScratchOrg(orgId); }
});

test('an unknown customer id refuses with its remedy', async () => {
  const { org } = await seedOrg();
  const orgId = org.orgId;
  const missing = randomUUID();
  try {
    await withOrgContext(orgId, async () => {
      await assert.rejects(
        getV1Entitlements(context(orgId, ['ar.read']), { customer: missing }),
        (error: unknown) => error instanceof ApplicationError
          && error.code === 'not_found'
          && error.status === 404
          && error.message === `No customer has id ${missing} in this organization.`,
      );
    });
  } finally { await dropScratchOrg(orgId); }
});

test('an unknown external reference refuses with its remedy', async () => {
  const { org } = await seedOrg();
  const orgId = org.orgId;
  try {
    await withOrgContext(orgId, async () => {
      await assert.rejects(
        getV1Entitlements(context(orgId, ['ar.read']), { externalRef: 'stripe:cus_missing' }),
        (error: unknown) => error instanceof ApplicationError
          && error.code === 'not_found'
          && error.status === 404
          && error.message === 'No customer is linked to external reference stripe:cus_missing.',
      );
      await assert.rejects(
        getV1Entitlements(context(orgId, ['ar.read']), { externalRef: 'no-separator' }),
        (error: unknown) => error instanceof ApplicationError
          && error.code === 'invalid_input'
          && error.status === 422,
      );
    });
  } finally { await dropScratchOrg(orgId); }
});

test('a customer name resolves to its effective entitlements', async () => {
  const { org, actor } = await seedOrg();
  const orgId = org.orgId;
  const customerId = org.customerId;
  try {
    await withOrgContext(orgId, async () => {
      const name = (await db.execute<{ display_name: string }>(sql`
        select display_name from parties where org_id = ${orgId} and id = ${customerId}`)).rows[0]!.display_name;
      await seedCustomerWithGrant(org, actor, customerId);
      const result = await getV1Entitlements(context(orgId, ['ar.read']), { customer: name, at: '2026-07-01' });
      assert.equal(result.customer.id, customerId);
      assert.equal(result.subscriptions.length, 1);
      assert.equal(result.subscriptions[0]?.features.find((f) => f.featureKey === 'seats_included')?.limit, '100');
      assert.equal(result.check, null);
    });
  } finally { await dropScratchOrg(orgId); }
});

test('a usage check refuses over the block limit with the limit attached', async () => {
  const { org, actor } = await seedOrg();
  const orgId = org.orgId;
  const customerId = org.customerId;
  try {
    await withOrgContext(orgId, async () => {
      await seedCustomerWithGrant(org, actor, customerId);
      const result = await getV1Entitlements(context(orgId, ['ar.read', 'usage.bill']), {
        customer: customerId, at: '2026-07-01', feature: 'seats_included', used: '130',
      });
      assert.equal(result.check?.allowed, false);
      assert.equal(result.check?.limit, '100');
      assert.equal(result.check?.overage, '30');
    });
  } finally { await dropScratchOrg(orgId); }
});
