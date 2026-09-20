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
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
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

const CRM_PERMS = [
  'assistant.use',
  'crm.opportunities.read',
  'crm.accounts.read',
  'crm.activities.read',
  'crm.forecasts.read',
];

/** One open + one hidden-subsidiary opportunity, a prospect profile, and an activity. */
async function seedCrm(orgId: string, rootSubsidiary: string, customerId: string) {
  const openStatus = randomUUID();
  const wonStatus = randomUUID();
  const hiddenSubsidiary = randomUUID();
  const hiddenParty = randomUUID();
  const openOpp = randomUUID();
  const hiddenOpp = randomUUID();
  const activity = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active,is_elimination)
      values (${hiddenSubsidiary},${orgId},${rootSubsidiary},'Hidden CRM entity','CAD','CA',true,false)
    `);
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom, subsidiary_id)
      values (${hiddenParty}, ${orgId}, 'customer', 'Hidden Customer', true, '{}'::jsonb, ${hiddenSubsidiary})
    `);
    await db.execute(sql`
      insert into crm_opportunity_statuses(id,org_id,key,name,sequence,probability,is_closed,is_won,is_active)
      values (${openStatus},${orgId},'negotiation','Negotiation',10,60,false,false,true),
             (${wonStatus},${orgId},'closed-won','Closed won',90,100,true,true,true)
    `);
    await db.execute(sql`
      insert into crm_opportunities(id,org_id,opportunity_number,title,party_id,status_id,forecast_category,
             probability,currency,projected_amount,weighted_amount,expected_close_date,is_active)
      values (${openOpp},${orgId},'OPP-1001','Harbourview Tower Fit-Out',${customerId},${openStatus},'most_likely',
             60,'CAD','10000','6000','2026-11-30',true),
             (${hiddenOpp},${orgId},'OPP-1002','Hidden Subsidiary Deal',${hiddenParty},${openStatus},'upside',
             20,'CAD','50000','10000','2026-12-15',true)
    `);
    // The hidden opportunity sits in the hidden legal entity so a restricted
    // caller must not see it even though its customer is hidden too.
    await db.execute(sql`
      update crm_opportunities set subsidiary_id = ${hiddenSubsidiary} where id = ${hiddenOpp}
    `);
    await db.execute(sql`
      insert into crm_account_profiles(id,org_id,party_id,lifecycle_stage,qualification_score,is_active)
      values (${randomUUID()},${orgId},${customerId},'prospect',72,true)
    `);
    await db.execute(sql`
      insert into crm_activities(id,org_id,kind,status,subject,priority)
      values (${activity},${orgId},'call','planned',' harbourview discovery call ', 'high')
    `);
  });
  return { openStatus, wonStatus, hiddenSubsidiary, hiddenParty, openOpp, hiddenOpp, activity };
}

test('CRM assistant reads: happy path, aggregates, and subsidiary scoping', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const seed = await seedCrm(org.orgId, org.subsidiaryId, org.customerId);
    const restricted = {
      user: userFor(org.orgId, 'CRM scope reader'),
      permissions: new Set(CRM_PERMS),
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    };
    const full = {
      user: userFor(org.orgId, 'CRM full reader'),
      permissions: new Set(CRM_PERMS),
      allowedSubsidiaryIds: null as Set<string> | null,
    };
    await withOrgContext(org.orgId, async () => {
      const search = await executeAssistantTool(restricted, 'search_opportunities', {});
      assert.equal(search.ok, true, JSON.stringify(search));
      assert.ok(search.ok);
      const data = search.data as {
        total: number; opportunities: { opportunityNumber: string }[];
        totalsByCurrency: { currency: string; projectedAmount: number }[];
        byStage: { statusName: string; count: number }[];
      };
      assert.equal(data.total, 1);
      assert.equal(data.opportunities[0]!.opportunityNumber, 'OPP-1001');
      assert.deepEqual(data.totalsByCurrency, [{ currency: 'CAD', count: 1, projectedAmount: 10000, weightedAmount: 6000 }]);
      assert.deepEqual(data.byStage, [{ statusName: 'Negotiation', isClosed: false, isWon: false, currency: 'CAD', count: 1, projectedAmount: 10000, weightedAmount: 6000 }]);

      const fullSearch = await executeAssistantTool(full, 'search_opportunities', {});
      assert.equal(fullSearch.ok, true, JSON.stringify(fullSearch));
      assert.ok(fullSearch.ok);
      assert.equal((fullSearch.data as { total: number }).total, 2);

      const open = await executeAssistantTool(restricted, 'get_opportunity', { opportunityId: seed.openOpp });
      assert.equal(open.ok, true, JSON.stringify(open));
      assert.ok(open.ok);
      assert.equal((open.data as { opportunity: { opportunityNumber: string } }).opportunity.opportunityNumber, 'OPP-1001');

      const hidden = await executeAssistantTool(restricted, 'get_opportunity', { opportunityId: seed.hiddenOpp });
      assert.deepEqual(hidden, { ok: false, error: 'opportunity_not_found' });

      const accounts = await executeAssistantTool(restricted, 'search_crm_accounts', { stage: 'prospect' });
      assert.equal(accounts.ok, true, JSON.stringify(accounts));
      assert.ok(accounts.ok);
      assert.equal((accounts.data as { total: number }).total, 1);

      const profile = await executeAssistantTool(restricted, 'get_crm_account', { partyId: org.customerId });
      assert.equal(profile.ok, true, JSON.stringify(profile));
      assert.ok(profile.ok);
      assert.equal((profile.data as { profile: { lifecycleStage: string } }).profile.lifecycleStage, 'prospect');

      const hiddenProfile = await executeAssistantTool(restricted, 'get_crm_account', { partyId: seed.hiddenParty });
      assert.deepEqual(hiddenProfile, { ok: false, error: 'crm_account_not_found' });

      const activities = await executeAssistantTool(restricted, 'search_crm_activities', {});
      assert.equal(activities.ok, true, JSON.stringify(activities));
      assert.ok(activities.ok);
      assert.equal((activities.data as { total: number }).total, 1);

      const activity = await executeAssistantTool(restricted, 'get_crm_activity', { activityId: seed.activity });
      assert.equal(activity.ok, true, JSON.stringify(activity));

      const forecast = await executeAssistantTool(restricted, 'crm_forecast', {
        periodStart: '2026-10-01',
        periodEnd: '2026-12-31',
      });
      assert.equal(forecast.ok, true, JSON.stringify(forecast));
      assert.ok(forecast.ok);
      const rows = (forecast.data as { forecast: { currency: string; pipelineAmount: number; weightedAmount: number }[] }).forecast;
      assert.deepEqual(rows, [{
        currency: 'CAD', pipelineAmount: 10000, weightedAmount: 6000,
        worstCaseAmount: 0, mostLikelyAmount: 10000, upsideAmount: 0, closedAmount: 0,
      }]);

      const badPeriod = await executeAssistantTool(restricted, 'crm_forecast', {
        periodStart: '2026-12-31',
        periodEnd: '2026-10-01',
      });
      assert.deepEqual(badPeriod, { ok: false, error: 'invalid_forecast_period' });
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('CRM assistant reads isolate orgs and honor the feature flag', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgA = await withBypassContext(() => createScratchOrg());
  const orgB = await withBypassContext(() => createScratchOrg());
  try {
    const seedA = await seedCrm(orgA.orgId, orgA.subsidiaryId, orgA.customerId);
    const authzA = {
      user: userFor(orgA.orgId, 'CRM org reader'),
      permissions: new Set(CRM_PERMS),
      allowedSubsidiaryIds: null as Set<string> | null,
    };
    await withOrgContext(orgA.orgId, async () => {
      const cross = await executeAssistantTool(
        { ...authzA, user: { ...authzA.user, orgId: orgB.orgId } },
        'get_opportunity',
        { opportunityId: seedA.openOpp },
      );
      assert.deepEqual(cross, { ok: false, error: 'opportunity_not_found' });
    });
    await withBypassContext(() => db.execute(sql`
      update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',coalesce(settings->'features','{}'::jsonb)||'{"crm":false}'::jsonb)
      where id=${orgA.orgId}
    `));
    await withOrgContext(orgA.orgId, async () => {
      const off = await executeAssistantTool(authzA, 'search_opportunities', {});
      assert.deepEqual(off, { ok: false, error: 'crm_feature_disabled' });
    });
  } finally {
    await dropScratchOrg(orgA.orgId);
    await dropScratchOrg(orgB.orgId);
  }
});
