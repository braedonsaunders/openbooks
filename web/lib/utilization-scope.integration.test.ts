import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { resolveAppModule } from './test-module-hooks'
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import * as React from 'react';
import type { SessionUser } from './auth';
import { stubModules } from '../testing/stub-modules.ts'

const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
const period = { from: '2026-07-01', to: '2026-07-31', label: 'Scope review' };
Object.assign(globalThis, { __utilizationScope: state, React });
stubModules({ intl: true, navigation: false, authz: false, features: false });

registerHooks({ resolve(specifier, context, next) {
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__utilizationScope.user}' };
  if (specifier.endsWith('/lib/periods') && /analytics\/utilization\/(?:page\.tsx|view\.ts)$/.test(context.parentURL ?? '')) return { shortCircuit: true, url: 'data:text/javascript,export async function resolvePeriod(){return '+JSON.stringify(period)+'}' };
  if (specifier === '../money-server' && context.parentURL?.includes('/analytics/')) return { shortCircuit: true, url: 'data:text/javascript,export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}' };
  const app = resolveAppModule(specifier, context, next, root)
  if (app) return app
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { getAuthz } = await import('./authz');
const { utilizationData } = await import('./analytics/utilization-data');
// The page LOADER. This asks whether the page applies the reader's
// subsidiary scope, which the loader decides; the spec only names where the
// resolved data is drawn. Reading props off a rendered element stopped
// working when `ModuleView` became the single render path.
const { loadUtilization } = await import('../app/(app)/analytics/utilization/view');
const { executeAssistantTool } = await import('./assistant/registry');
import type { UtilizationData } from './analytics/utilization-data';

for (const boundary of ['service','page','assistant'] as const) {
  for (const mode of ['all','restricted','empty'] as const) {
    test(`Utilization subsidiary access ${boundary}: ${mode}`, {skip:!process.env.OPENBOOKS_DB_URL}, async()=>{
      const org=await withBypassContext(()=>createScratchOrg());
      try {
        const actor=await withBypassContext(()=>createScratchUser(org.orgId,'Time reviewer','time_reviewer'));
        const restriction=mode === 'all' ? {mode:'all'} : {mode:'list',subsidiaryIds:mode === 'empty' ? [] : [org.subsidiaryId]};
        await withBypassContext(()=>db.execute(sql`update app_roles set permissions='["reports.read","assistant.use"]'::jsonb,subsidiary_restriction=${JSON.stringify(restriction)}::jsonb where org_id=${org.orgId} and key='time_reviewer'`));
        state.user={id:actor,orgId:org.orgId,name:'Time reviewer',email:'time@scratch.test',roles:[],isSuperAdmin:false,envKind:'production',productionOrgId:org.orgId,homeOrgId:org.orgId,homeUserId:actor};
        const hidden=randomUUID(),visibleProject=randomUUID(),hiddenProject=randomUUID();
        await withBypassContext(()=>db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Private entity','CAD','CA')`));
        for(const [project,sub] of [[visibleProject,org.subsidiaryId],[hiddenProject,hidden]])await withBypassContext(()=>db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active) values (${project},${org.orgId},${sub},${project},'Time project',${org.customerId},'active',true)`));
        const cases=[
          [org.subsidiaryId,visibleProject,'1','Visible project worker'],
          [hidden,hiddenProject,'9','PRIVATE-UTIL-EVIDENCE'],
          [org.subsidiaryId,hiddenProject,'8','PRIVATE-UTIL-EVIDENCE'],
          [hidden,visibleProject,'2','Visible cross-company worker'],
          [org.subsidiaryId,null,'3','Visible internal worker'],
          [hidden,null,'7','PRIVATE-UTIL-EVIDENCE'],
        ] as const;
        for(const [sub,project,hours,name] of cases){
          const employee=randomUUID();
          await withBypassContext(()=>db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'person',${name},${sub})`));
          for(const date of ['2026-06-15',org.date])await withBypassContext(()=>db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,cost_rate,status) values (${org.orgId},${employee},${date},${hours},${project},${org.items.service},${project !== null},10,'approved')`));
        }
        await withOrgContext(org.orgId,async()=>{
          const authz=await getAuthz();assert.ok(authz);
          let data: Pick<UtilizationData,'company'|'history'>;
          if(boundary === 'service')data=await utilizationData(org.orgId,period,authz.allowedSubsidiaryIds);
          else if(boundary === 'page'){
            data=((await loadUtilization({})) as {data:UtilizationData}).data;
          }else{
            const result=await executeAssistantTool(authz,'analytics_utilization',{fromDate:period.from,toDate:period.to});
            assert.equal(result.ok,true);assert.ok(result.ok);data=result.data as UtilizationData;
          }
          const hours=mode === 'all' ? 30 : mode === 'empty' ? 0 : 6;
          assert.equal(data.company.range.hours,hours);
          assert.equal(data.company.prior.hours,hours);
          assert.equal(data.company.range.billableHours,mode === 'all' ? 20 : mode === 'empty' ? 0 : 3);
          assert.equal(data.company.range.nonBillableCost,mode === 'all' ? '100.0000' : mode === 'empty' ? '0' : '30.0000');
          const history = data.history.periods as UtilizationData['history']['periods'] | { items: UtilizationData['history']['periods'] };
          const june = (Array.isArray(history) ? history : history.items).find(row => row.start === '2026-06-01');
          assert.ok(june);
          assert.equal(june.companyPct,mode === 'all' ? 20 / 30 * 100 : mode === 'empty' ? 0 : 50);
          assert.equal(JSON.stringify(data).includes('PRIVATE-UTIL-EVIDENCE'),mode === 'all');
        });
      }finally{state.user=null;await dropScratchOrg(org.orgId);}
    });
  }
}
for(const feature of ['projects','timeTracking']){
  test(`Utilization service enforces ${feature} feature`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const org=await withBypassContext(()=>createScratchOrg());
    try{
      await withBypassContext(()=>db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||${JSON.stringify({[feature]:false})}::jsonb) where id=${org.orgId}`));
      await withOrgContext(org.orgId,async()=>{await assert.rejects(utilizationData(org.orgId,period,null),/time.tracking.*disabled/i);});
    }finally{await dropScratchOrg(org.orgId);}
  });
}


const consolidatedRows = [
  { label: "utilization approved status", register: async () => {
        /**
         * Utilization must read approved time only. Draft, submitted and rejected
         * hours are not worked reality yet (and rejected hours never will be) — every
         * sibling reader (project profitability hours, the time drill-down) requires
         * `status = 'approved'`, but the utilization rollup counted every status, so
         * unapproved hours inflated billable % and non-billable cost.
         */
        const root = pathToFileURL(process.cwd() + '/').href
        const { db, withBypassContext, withOrgContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
        const { createScratchOrg, dropScratchOrg } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
        const { utilizationData } = (await import(root + 'web/lib/analytics/utilization-data.ts')) as typeof import('./analytics/utilization-data')
        
        test('utilization counts approved time only', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            await withBypassContext(async () => {
              const employee = randomUUID()
              await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id)
                values (${employee}, ${org.orgId}, 'person', 'Util Worker', ${org.subsidiaryId})`)
              for (const [status, hours] of [['approved', '8'], ['draft', '8'], ['submitted', '4'], ['rejected', '2']] as const) {
                await db.execute(sql`insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id, item_id, is_billable, cost_rate, status)
                  values (${org.orgId}, ${employee}, ${org.date}, ${hours}, null, ${org.items.service}, true, '10', ${status})`)
              }
            })
            await withOrgContext(org.orgId, async () => {
              const data = await utilizationData(org.orgId, { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }, null)
              assert.equal(data.company.range.hours, 8, 'draft/submitted/rejected hours must not inflate utilization')
              assert.equal(data.company.range.billableHours, 8)
              assert.equal(data.employees.length, 1)
              assert.equal(data.employees[0]!.range.hours, 8)
            })
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId))
          }
        })
  } },
  { label: "utilization exactness", register: async () => {
        const root = pathToFileURL(process.cwd() + '/').href;
        const state: { user: SessionUser | null } = { user: null };
        Object.assign(globalThis, { __utilExactness: state, React });
        stubModules({ intl: true, navigation: false, authz: false, features: false });
        
        registerHooks({ resolve(specifier, context, next) {
          if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__utilExactness.user}' };
          if (specifier === '../money-server' && context.parentURL?.includes('/analytics/')) return { shortCircuit: true, url: 'data:text/javascript,export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}' };
          const app = resolveAppModule(specifier, context, next, root)
          if (app) return app
          return next(specifier, context);
        } });
        const { sql } = await import('drizzle-orm');
        const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
        const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
        const { utilizationData } = await import('./analytics/utilization-data');
        
        /**
         * Utilization money must stay exact until rendering. Three 0.1 legs — kept
         * as separate employee rows so they accumulate in JS, not in Postgres — sum
         * to 0.30000000000000004 in float arithmetic. That single binary-dust ulp
         * both corrupts the reported cost and fires a cost-spike alert whose
         * threshold sits at exactly the true delta.
         */
        test('utilization accumulates cost exactly and decides alerts on exact decimals', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          try {
            await withBypassContext(async () => {
              await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{analytics,utilization}',
                '{"targetBillablePct":70,"costSpikeThreshold":0.3,"minHours":0}') where id = ${org.orgId}`);
              for (let n = 0; n < 3; n++) {
                const employee = randomUUID();
                await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id)
                  values (${employee}, ${org.orgId}, 'person', ${`Exact Worker ${n}`}, ${org.subsidiaryId})`);
                await db.execute(sql`insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id, item_id, is_billable, cost_rate, cost_rate_currency, status)
                  values (${org.orgId}, ${employee}, ${org.date}, '1', null, ${org.items.service}, false, '0.1000', 'CAD', 'approved')`);
              }
            });
            await withOrgContext(org.orgId, async () => {
              const data = await utilizationData(org.orgId, { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }, null);
              assert.equal(data.company.range.nonBillableCost, '0.3000', 'fractional legs must sum exactly');
              assert.equal(data.employees.length, 3);
              assert.equal(data.company.deltas.costDelta, '0.3000');
              // 0% billed is below the 70% target (warning), but the 0.3 delta sits
              // exactly AT the spike threshold — an exact comparison raises no
              // danger alert, while float dust (0.30000000000000004) would.
              assert.ok(data.company.alerts.some((a) => a.type === 'warning'), 'below-target warning still fires');
              assert.ok(data.company.alerts.every((a) => a.type !== 'danger'), 'no cost-spike alert at exact threshold equality');
            });
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });
  } },
] as const;

for(const row of consolidatedRows) await row.register();
