import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from './db.ts';
import { createScratchOrg, seedFlowActors, dropScratchOrg } from './test-fixtures.ts';
import { activateLifecycle, applyAmendment, createPlanVersion, publishPlanVersion, AdvancedSubscriptionError } from './advanced-subscriptions.ts';

for (const scenario of ['invalid dates', 'backdated replacement', 'overlapping addition', 'unknown amendment'] as const) {
  test(`subscription contract integrity: ${scenario}`, {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"subscriptionBilling":true,"advancedSubscriptions":true}'::jsonb) where id=${org.orgId}`);
      const planId = randomUUID();
      await db.execute(sql`insert into subscription_plans(id,org_id,name,amount,currency_code,interval,interval_count,income_account_id,is_active,created_by) values (${planId},${org.orgId},'Window plan','0','CAD','monthly',1,${org.accounts.revenue},true,${actor})`);
      const input = {planId,effectiveFrom:'2026-01-01',components:[{componentKey:'fee',name:'Fee',unitPrice:'10',incomeAccountId:org.accounts.revenue}]};
      if (scenario === 'invalid dates') {
        for (const effectiveFrom of ['2026-02-30','2026-04-31','', 'not-a-date']) {
          await assert.rejects(createPlanVersion(org.orgId,actor,{...input,effectiveFrom}), AdvancedSubscriptionError);
        }
        assert.equal((await db.execute<{n:number}>(sql`select count(*)::int as n from subscription_plan_versions where org_id=${org.orgId}`)).rows[0]!.n,0);
        await createPlanVersion(org.orgId,actor,{...input,effectiveFrom:'2028-02-29'});
        return;
      }
      const version = await createPlanVersion(org.orgId,actor,input);
      await publishPlanVersion(org.orgId,actor,version);
      const subscriptionId = randomUUID();
      await db.execute(sql`insert into subscriptions(id,org_id,customer_id,plan_id,quantity,status,start_on,next_bill_on,auto_post,created_by) values (${subscriptionId},${org.orgId},${org.customerId},${planId},'1','active','2026-01-01','2026-01-01',false,${actor})`);
      await activateLifecycle(org.orgId,actor,{subscriptionId,planVersionId:version,termStartsOn:'2026-01-01',termEndsOn:'2027-01-01',renewalPolicy:'none'});
      const amendment = {subscriptionId,type:'change_component' as const,componentKey:'fee',effectiveOn:'2026-03-01',unitPrice:'30',idempotencyKey:randomUUID()};
      if (scenario === 'unknown amendment') {
        const invalid = {...amendment,type:'typo'} as unknown as Parameters<typeof applyAmendment>[2];
        await assert.rejects(applyAmendment(org.orgId,actor,invalid),AdvancedSubscriptionError);
        assert.equal((await db.execute<{n:number}>(sql`select count(*)::int as n from subscription_amendments where org_id=${org.orgId}`)).rows[0]!.n,0);
        return;
      }
      await applyAmendment(org.orgId,actor,amendment);
      if (scenario === 'backdated replacement') {
        const earlier = {...amendment,effectiveOn:'2026-02-01',unitPrice:'20',idempotencyKey:randomUUID()};
        await applyAmendment(org.orgId,actor,earlier);
        assert.equal((await applyAmendment(org.orgId,actor,earlier)).replayed,true);
        const rows=(await db.execute(sql`select effective_from::text,effective_to::text,unit_price::text from subscription_components where org_id=${org.orgId} and subscription_id=${subscriptionId} order by effective_from`)).rows;
        assert.deepEqual(rows,[
          {effective_from:'2026-01-01',effective_to:'2026-01-31',unit_price:'10.0000'},
          {effective_from:'2026-02-01',effective_to:'2026-02-28',unit_price:'20.0000'},
          {effective_from:'2026-03-01',effective_to:null,unit_price:'30.0000'},
        ]);
      } else {
        await assert.rejects(applyAmendment(org.orgId,actor,{...amendment,type:'add_component',name:'Overlap',effectiveOn:'2025-12-01',idempotencyKey:randomUUID()}),AdvancedSubscriptionError);
        assert.equal((await db.execute<{n:number}>(sql`select count(*)::int as n from subscription_components where org_id=${org.orgId} and subscription_id=${subscriptionId}`)).rows[0]!.n,2);
      }
    } finally { await dropScratchOrg(org.orgId); }
  });
}
