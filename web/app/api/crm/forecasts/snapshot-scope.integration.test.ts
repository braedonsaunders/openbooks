import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { resolveAppModule } from '../../../../lib/test-module-hooks'
import { pathToFileURL } from 'node:url';
import type { SessionUser } from '../../../../lib/auth';
import * as React from 'react';
Object.assign(globalThis, { React });

// F-t02-002: a snapshot must preserve the scope of the summary it was taken
// from. Saving from the unfiltered (org-wide) forecasts page stored a personal
// snapshot instead, so Closed disagreed with the summary by the whole book of
// other owners' invoices. Both surfaces read calculateForecast; the snapshot
// has to file the same scope the summary displayed.
const root = pathToFileURL(process.cwd() + "/").href;
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __forecastScopeSession: session });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__forecastScopeSession.user}' };
  const app = resolveAppModule(specifier, context, next, root);
  if (app) return app;
  return next(specifier,context);
}});
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");

const {randomUUID}=await import('node:crypto');
const {ensureCrmDefaults}=await import('@openbooks/engine/src/crm/crm.ts');
const {POST,GET}=await import('./route');
const {NextRequest}=await import('next/server');
const enabled={skip:!process.env.OPENBOOKS_DB_URL};
const period={periodStart:'2026-07-01',periodEnd:'2026-07-31'};

async function fixture(action:(org:Awaited<ReturnType<typeof createScratchOrg>>,actor:string)=>Promise<void>){
 const org=await withBypassContext(()=>createScratchOrg());
 try {
  const actor=await withBypassContext(()=>createScratchUser(org.orgId,'Scope reviewer','reviewer'));
  await withBypassContext(async()=>{
   await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`);
   await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"crm":true}'::jsonb) where id=${org.orgId}`);
   await ensureCrmDefaults(org.orgId,actor);
   // One open opportunity owned by the reviewer, one posted invoice owned by
   // nobody: the org-wide summary books both, the reviewer's personal scope
   // books only the opportunity.
   const status=(await db.execute<{id:string}>(sql`select id from crm_opportunity_statuses where org_id=${org.orgId} and is_default and not is_closed limit 1`)).rows[0]!.id;
   const opp=randomUUID();
   await db.execute(sql`insert into crm_opportunities(id,org_id,opportunity_number,title,party_id,owner_user_id,status_id,forecast_category,currency,is_active,projected_amount,weighted_amount,expected_close_date)
    values (${opp},${org.orgId},${opp},'Scoped work',${org.customerId},${actor},${status},'upside','CAD',true,12000,1200,'2026-07-15')`);
   const invoice=randomUUID();
   await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,document_date,currency,subtotal,tax_total,total,created_by)
    values (${invoice},${org.orgId},'customer_invoice','draft','INV-SCOPE-1','2026-07-15','CAD',5000,0,5000,${actor})`);
   const entry=randomUUID();
   await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,source_document_id)
    values (${entry},${org.orgId},${org.bookId},${org.subsidiaryId},${entry},'2026-07-15',${org.periodId},'draft',${invoice})`);
   await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,party_id,is_open_item)
    values (${randomUUID()},${org.orgId},${entry},1,${org.accounts.ar},${org.subsidiaryId},'5000','CAD','5000','1',${org.customerId},true),
           (${randomUUID()},${org.orgId},${entry},2,${org.accounts.revenue},${org.subsidiaryId},'-5000','CAD','-5000','1',null,false)`);
   await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
   await db.execute(sql`update documents set status='posted',posted_entry_id=${entry},posting_period_id=${org.periodId} where id=${invoice}`);
  });
  session.user={id:actor,orgId:org.orgId,name:'Reviewer',email:'reviewer@example.test',roles:[],isSuperAdmin:false,envKind:'production',productionOrgId:org.orgId,homeOrgId:org.orgId,homeUserId:actor};
  await withOrgContext(org.orgId,()=>action(org,actor));
 }finally{session.user=null;await dropScratchOrg(org.orgId);}
}

async function snapshots(orgId:string){
 return (await withBypassContext(()=>db.execute<{owner_user_id:string|null;sales_team_id:string|null;pipeline_amount:string;closed_amount:string}>(sql`
  select owner_user_id,sales_team_id,pipeline_amount::text,closed_amount::text from crm_forecast_snapshots where org_id=${orgId}`))).rows;
}

test('an unfiltered snapshot preserves the org-wide summary scope',enabled,async()=>fixture(async(org)=>{
 const saved=await POST(new NextRequest('http://audit.local',{method:'POST',body:JSON.stringify({...period,ownerUserId:null,salesTeamId:null})}));
 assert.equal(saved.status,201,await saved.clone().text());
 const rows=await snapshots(org.orgId);
 assert.equal(rows.length,1);
 assert.equal(rows[0]!.owner_user_id,null);
 assert.equal(rows[0]!.sales_team_id,null);
 assert.equal(rows[0]!.pipeline_amount,'12000.0000');
 assert.equal(rows[0]!.closed_amount,'5000.0000');
 const summary=await GET(new NextRequest('http://audit.local?periodStart=2026-07-01&periodEnd=2026-07-31'));
 assert.equal(summary.status,200,await summary.clone().text());
 const forecast=(await summary.json() as {forecast:{pipeline_amount:string;closed_amount:string}[]}).forecast;
 assert.equal(forecast.length,1);
 assert.equal(forecast[0]!.pipeline_amount,rows[0]!.pipeline_amount);
 assert.equal(forecast[0]!.closed_amount,rows[0]!.closed_amount);
}));

test('a snapshot without scope keys still files the convenient personal default',enabled,async()=>fixture(async(org,actor)=>{
 const saved=await POST(new NextRequest('http://audit.local',{method:'POST',body:JSON.stringify({...period})}));
 assert.equal(saved.status,201,await saved.clone().text());
 const rows=await snapshots(org.orgId);
 assert.equal(rows.length,1);
 assert.equal(rows[0]!.owner_user_id,actor);
 assert.equal(rows[0]!.pipeline_amount,'12000.0000');
 assert.equal(rows[0]!.closed_amount,'0.0000');
}));

test('a snapshot naming both an owner and a team is still refused',enabled,async()=>fixture(async(org,actor)=>{
 const refused=await POST(new NextRequest('http://audit.local',{method:'POST',body:JSON.stringify({...period,ownerUserId:actor,salesTeamId:randomUUID()})}));
 assert.equal(refused.status,422,await refused.clone().text());
 assert.equal((await snapshots(org.orgId)).length,0);
}));
