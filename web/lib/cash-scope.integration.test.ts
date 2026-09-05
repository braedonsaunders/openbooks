import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import * as React from 'react';
import type { SessionUser } from './auth';
const root = pathToFileURL(process.cwd()+'/').href;
const state: { user: SessionUser | null; subIds: string[] } = { user: null, subIds: [] };
Object.assign(globalThis, { __cashScope: state, React });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__cashScope.user}' };
  if (context.parentURL?.endsWith('/page.tsx')) {
    if (specifier.endsWith('/lib/consolidation')) return { shortCircuit: true, url: 'data:text/javascript,export async function reportSubsidiaryView(){return {subsidiary:{ids:globalThis.__cashScope.subIds},picker:[],options:[],consolidated:false}}' };
    if (specifier.endsWith('/lib/page-layout')) return { shortCircuit: true, url: 'data:text/javascript,export async function userPageLayout(){return null}' };
    if (specifier.endsWith('/module-home/group-tabs')) return { shortCircuit: true, url: 'data:text/javascript,export async function groupTabs(){return []}' };
  }
  if (specifier.startsWith('@/')) {
    const path = root+'web/'+specifier.slice(2);
    for (const suffix of ['.ts','.tsx','/index.ts','/index.tsx']) if (existsSync(new URL(path+suffix))) return next(path+suffix,context);
    return next(path,context);
  }
  return next(specifier,context);
} });
const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { postDocument } = await import('@openbooks/engine/src/posting.ts');
const { getAuthz } = await import('./authz');
const { cashflowData } = await import('./analytics/cashflow-data');
const { cashPosition } = await import('./cash/cash-position');
const { apPosition } = await import('./cash/ap-position');
const { arPosition } = await import('./cash/ar-position');
const { orgVitals } = await import('./application/vitals');
const { executeAssistantTool } = await import('./assistant/registry');
const { default: CashflowPage } = await import('../app/(app)/analytics/cashflow/page');
const { default: CashPage } = await import('../app/(app)/banking/cash/page');
const { default: ApPage } = await import('../app/(app)/ap/page');
const { default: ArPage } = await import('../app/(app)/ar/page');
const settings = { weeklyCap: '0.0000', restrictToSafe: false };
const surfaces = ['cashflow','cash','ap','ar'] as const;
for (const boundary of ['service','assistant','page','vitals','selected view'] as const) {
  for (const surface of boundary === 'vitals' || boundary === 'selected view' ? ['cash'] as const : surfaces) {
    for (const mode of ['all','restricted','empty'] as const) {
      test(`Cash subsidiary access ${boundary}/${surface}: ${mode}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
        const org = await createScratchOrg();
        try {
          const actor = await createScratchUser(org.orgId,'Cash reviewer','cash_reviewer');
          const hidden = randomUUID(); const hiddenBank = randomUUID(); const hiddenParty = randomUUID();
          const restriction = mode === 'all' ? { mode:'all' } : { mode:'list', subsidiaryIds: mode === 'empty' ? [] : [org.subsidiaryId] };
          await db.execute(sql`update app_roles set permissions='["reports.read","banking.read","ap.read","ar.read","assistant.use"]'::jsonb,subsidiary_restriction=${JSON.stringify(restriction)}::jsonb where org_id=${org.orgId} and key='cash_reviewer'`);
          state.user = { id:actor,orgId:org.orgId,name:'Cash reviewer',email:'cash@scratch.test',roles:[],isSuperAdmin:false,envKind:'production',productionOrgId:org.orgId,homeOrgId:org.orgId,homeUserId:actor };
          state.subIds = mode === 'all' ? [org.subsidiaryId,hidden] : mode === 'empty' ? [] : [org.subsidiaryId];
          await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden','CAD','CA')`);
          await db.execute(sql`insert into accounts(id,org_id,number,name,type,subsidiary_id) values (${hiddenBank},${org.orgId},'1099','HIDDEN-CASH-EVIDENCE','asset_bank',${hidden})`);
          await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${hiddenParty},${org.orgId},'organization','HIDDEN-CASH-EVIDENCE',${hidden})`);
          for (const [sub,bank,amount,party] of [[org.subsidiaryId,org.accounts.bank,'100',org.customerId],[hidden,hiddenBank,'999',hiddenParty]]) {
            const entry = randomUUID();
            await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin) values (${entry},${org.orgId},${org.bookId},${sub},${entry},${org.date},${org.periodId},'draft','manual')`);
            await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
              values (${org.orgId},${entry},1,${bank},${sub},${amount},'CAD',${amount},1),(${org.orgId},${entry},2,${org.accounts.revenue},${sub},${'-'+amount},'CAD',${'-'+amount},1)`);
            await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
            for (const kind of ['customer_invoice','vendor_bill']) {
              const id = randomUUID();
              await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,fx_rate)
                values (${id},${org.orgId},${kind},'draft',${id},${sub},${party},${org.date},'CAD',1)`);
              await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,tax_input_amount)
                values (${org.orgId},${id},1,${kind === 'customer_invoice' ? org.accounts.revenue : org.accounts.adjustment},1,${amount},${amount},0,0)`);
              await db.execute(sql`update documents set status='approved' where id=${id}`);
              await postDocument(id,{control:{ar:org.accounts.ar,ap:org.accounts.ap,bank:org.accounts.bank}});
            }
          }
          await withOrgContext(org.orgId, async () => {
            const authz = await getAuthz(); assert.ok(authz);
            let data: unknown;
            if (boundary === 'selected view') data = await cashPosition(org.orgId,4,settings,org.date,[hidden],authz.allowedSubsidiaryIds);
            else if (boundary === 'service') {
              if (surface === 'cashflow') data = await cashflowData(org.orgId,4,org.date,authz.allowedSubsidiaryIds);
              if (surface === 'cash') data = await cashPosition(org.orgId,4,settings,org.date,undefined,authz.allowedSubsidiaryIds);
              if (surface === 'ap') data = await apPosition(org.orgId,4,settings,org.date,authz.allowedSubsidiaryIds);
              if (surface === 'ar') data = await arPosition(org.orgId,4,settings,org.date,authz.allowedSubsidiaryIds);
            } else if (boundary === 'assistant') {
              const name = {cashflow:'analytics_cashflow',cash:'cash_position',ap:'ap_position',ar:'ar_position'}[surface];
              const result = await executeAssistantTool(authz,name,{asOfDate:org.date});
              assert.equal(result.ok,true); assert.ok(result.ok); data=result.data;
            } else if (boundary === 'page') {
              const page = surface === 'cashflow' ? await CashflowPage({searchParams:Promise.resolve({})}) : surface === 'cash' ? await CashPage({searchParams:Promise.resolve({})}) : surface === 'ap' ? await ApPage() : await ArPage();
              const child = React.Children.toArray((page.props as {children:React.ReactNode}).children).find(React.isValidElement);
              assert.ok(child && React.isValidElement(child)); data=(child.props as {data:unknown}).data;
            } else data=await orgVitals({authz,source:'assistant',requestId:randomUUID(),apiKeyId:null});
            assert.ok(data && typeof data === 'object');
            const result = data as Record<string,unknown>;
            const expected=boundary === 'selected view' ? (mode === 'all' ? '999.0000' : '0.0000')
              : mode === 'all' ? '1099.0000' : mode === 'empty' ? '0.0000' : '100.0000';
            if (boundary === 'vitals') {
              assert.equal((result.cash as {bankCash:string}).bankCash,expected);
              assert.equal((result.arAging as {totals:{total:string}}).totals.total,expected);
              assert.equal((result.apAging as {totals:{total:string}}).totals.total,expected);
            } else assert.equal(surface === 'ap' || surface === 'ar' ? result.outstanding : result.startingCash,expected);
            if (boundary !== 'vitals') assert.equal(JSON.stringify(data).includes('HIDDEN-CASH-EVIDENCE'),mode === 'all');
          });
        } finally { state.user=null;state.subIds=[];await dropScratchOrg(org.orgId); }
      });
    }
  }
}
