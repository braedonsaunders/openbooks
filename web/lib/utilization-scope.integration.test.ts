import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import * as React from 'react';
import type { SessionUser } from './auth';

const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
const period = { from: '2026-07-01', to: '2026-07-31', label: 'Scope review' };
Object.assign(globalThis, { __utilizationScope: state, React });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__utilizationScope.user}' };
  if (specifier.endsWith('/lib/periods') && /analytics\/utilization\/page.tsx$/.test(context.parentURL ?? '')) return { shortCircuit: true, url: 'data:text/javascript,export async function resolvePeriod(){return '+JSON.stringify(period)+'}' };
  if (specifier === '../money-server' && context.parentURL?.includes('/analytics/')) return { shortCircuit: true, url: 'data:text/javascript,export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}' };
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2);
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(new URL(path + suffix))) return next(path + suffix, context);
    return next(path, context);
  }
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { getAuthz } = await import('./authz');
const { utilizationData } = await import('./analytics/utilization-data');
const { default: UtilizationPage } = await import('../app/(app)/analytics/utilization/page');
const { executeAssistantTool } = await import('./assistant/registry');
import type { UtilizationData } from './analytics/utilization-data';

for (const boundary of ['service','page','assistant'] as const) {
  for (const mode of ['all','restricted','empty'] as const) {
    test(`Utilization subsidiary access ${boundary}: ${mode}`, {skip:!process.env.OPENBOOKS_DB_URL}, async()=>{
      const org=await createScratchOrg();
      try {
        const actor=await createScratchUser(org.orgId,'Time reviewer','time_reviewer');
        const restriction=mode === 'all' ? {mode:'all'} : {mode:'list',subsidiaryIds:mode === 'empty' ? [] : [org.subsidiaryId]};
        await db.execute(sql`update app_roles set permissions='["reports.read","assistant.use"]'::jsonb,subsidiary_restriction=${JSON.stringify(restriction)}::jsonb where org_id=${org.orgId} and key='time_reviewer'`);
        state.user={id:actor,orgId:org.orgId,name:'Time reviewer',email:'time@scratch.test',roles:[],isSuperAdmin:false,envKind:'production',productionOrgId:org.orgId,homeOrgId:org.orgId,homeUserId:actor};
        const hidden=randomUUID(),visibleProject=randomUUID(),hiddenProject=randomUUID();
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Private entity','CAD','CA')`);
        for(const [project,sub] of [[visibleProject,org.subsidiaryId],[hiddenProject,hidden]])await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active) values (${project},${org.orgId},${sub},${project},'Time project',${org.customerId},'active',true)`);
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
          await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'person',${name},${sub})`);
          for(const date of ['2026-06-15',org.date])await db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,cost_rate,status) values (${org.orgId},${employee},${date},${hours},${project},${org.items.service},${project !== null},10,'approved')`);
        }
        await withOrgContext(org.orgId,async()=>{
          const authz=await getAuthz();assert.ok(authz);
          let data: Pick<UtilizationData,'company'|'history'>;
          if(boundary === 'service')data=await utilizationData(org.orgId,period,authz.allowedSubsidiaryIds);
          else if(boundary === 'page'){
            const output=await UtilizationPage({searchParams:Promise.resolve({})});
            const children=React.Children.toArray((output.props as {children:React.ReactNode}).children);
            const view=children.find(React.isValidElement);assert.ok(view && React.isValidElement(view));
            data=(view.props as {data:UtilizationData}).data;
          }else{
            const result=await executeAssistantTool(authz,'analytics_utilization',{fromDate:period.from,toDate:period.to});
            assert.equal(result.ok,true);assert.ok(result.ok);data=result.data as UtilizationData;
          }
          const hours=mode === 'all' ? 30 : mode === 'empty' ? 0 : 6;
          assert.equal(data.company.range.hours,hours);
          assert.equal(data.company.prior.hours,hours);
          assert.equal(data.company.range.billableHours,mode === 'all' ? 20 : mode === 'empty' ? 0 : 3);
          assert.equal(data.company.range.nonBillableCost,mode === 'all' ? 100 : mode === 'empty' ? 0 : 30);
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
    const org=await createScratchOrg();
    try{
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||${JSON.stringify({[feature]:false})}::jsonb) where id=${org.orgId}`);
      await withOrgContext(org.orgId,async()=>{await assert.rejects(utilizationData(org.orgId,period,null),/time.tracking.*disabled/i);});
    }finally{await dropScratchOrg(org.orgId);}
  });
}
