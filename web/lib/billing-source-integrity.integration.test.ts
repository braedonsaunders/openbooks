import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import type { SessionUser } from './auth';
import { stubModules } from '../testing/stub-modules.ts'
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __billingSourceSession: session });
stubModules({ intl: true, navigation: false, authz: false, features: false });

registerHooks({ resolve(specifier, context, next) {
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__billingSourceSession.user}' };
  return next(specifier,context);
}});
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { randomUUID }=await import('node:crypto');
const {createBillingRequest}=await import('./billing-requests');
const {generateInvoiceFromBillingRequest}=await import('./billing');
for(const scenario of ['hidden cost','concurrent time','project move']) {
 test(`billing sources: ${scenario}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await withBypassContext(()=>createScratchOrg());
  let release=()=>{};let holder:Promise<unknown>|undefined;let runs:Promise<unknown>[]=[];
  try{
   // Fixture seeds under explicit bypass: importing ./billing-requests above
   // pulls in the web request-org resolver, which denies every unscoped query
   // under pooled RLS (bare setup dies with 42501).
   const {actor,project}=await withBypassContext(async ()=>{
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{controlAccounts,projectRevenue}', to_jsonb(${org.accounts.revenue}::text), true) where id = ${org.orgId}`);
    const actor=await createScratchUser(org.orgId,'Billing controller','reviewer');
    const project=randomUUID();
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active) values (${project},${org.orgId},${org.subsidiaryId},'SOURCE','Source controls',${org.customerId},'active',true)`);
    return {actor,project};
   });
   const make=()=>createBillingRequest(org.orgId,actor,{projectId:project,basis:'date_range',cutoffDate:org.date,backupRequired:false});
   const first=await withOrgContext(org.orgId,()=>make());
   // The billing calls issue bare queries with explicit org predicates, so the
   // scenario runs in the scratch org's scope (reads see zero rows outside it).
   // Seed inserts stay under bypass; the pg_stat_activity polls read a system
   // view with no RLS.
   await withOrgContext(org.orgId,async ()=>{
   if(scenario==='project move') {
    const other=randomUUID();
    await withBypassContext(async ()=>{
     await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${other},${org.orgId},${org.subsidiaryId},'Moved project','CAD','CA')`);
    });
    let ready=()=>{};const locked=new Promise<void>(r=>{ready=r});const finish=new Promise<void>(r=>{release=r});
    holder=db.transaction(async tx=>{await tx.execute(sql`update projects set subsidiary_id=${other} where id=${project}`);ready();await finish;});
    await Promise.race([locked,holder]);
    runs=[generateInvoiceFromBillingRequest(org.orgId,actor,first.id,new Set([org.subsidiaryId]))];
    const outcomes=Promise.allSettled(runs);let blocked=0;const deadline=Date.now()+10000;
    while(Date.now()<deadline){
      blocked=await withBypassContext(async ()=>(await db.execute<{n:number}>(sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and query ilike '%from billing_requests br%'`)).rows[0]!.n);
      if(blocked)break;await new Promise(r=>setTimeout(r,25));
    }
    assert.ok(blocked,'invoice generation waits for the concurrent project reassignment');
    release();await holder;
    const [result]=await outcomes;
    assert.equal(result?.status,'rejected');
    if(result?.status==='rejected') assert.match(String(result.reason),/Billing request not found/);
    assert.equal((await db.execute(sql`select status from billing_requests where id=${first.id}`)).rows[0]?.status,'open');
   }else if(scenario==='hidden cost') {
    const other=randomUUID(),source=randomUUID(),line=randomUUID();
    await withBypassContext(async ()=>{
     await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${other},${org.orgId},${org.subsidiaryId},'Hidden costs','CAD','CA')`);
     await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,subsidiary_id,party_id,project_id,currency) values (${source},${org.orgId},'vendor_bill',${source},${org.date},${other},${org.vendorId},${project},'CAD')`);
     await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,account_id,quantity,unit_price,amount,is_billable) values (${line},${org.orgId},${source},1,${org.accounts.cogs},1,100,100,true)`);
     await db.execute(sql`update documents set status='approved' where id=${source}`);
    });
    await assert.rejects(generateInvoiceFromBillingRequest(org.orgId,actor,first.id,new Set([org.subsidiaryId])),/outside.*access/i);
    assert.equal((await db.execute(sql`select billed_by_line_id from document_lines where id=${line}`)).rows[0]?.billed_by_line_id,null);
    assert.equal((await db.execute(sql`select status from billing_requests where id=${first.id}`)).rows[0]?.status,'open');
   }else{
    const employee=randomUUID(),entry=randomUUID();
    const second=await make();
    await withBypassContext(async ()=>{
     await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'employee','Billable worker',${org.subsidiaryId})`);
     await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,status,bill_rate) values (${entry},${org.orgId},${employee},${org.date},1,${project},${org.items.service},true,'approved',100)`);
    });
    let ready=()=>{};const locked=new Promise<void>(r=>{ready=r});const finish=new Promise<void>(r=>{release=r});
    holder=db.transaction(async tx=>{await tx.execute(sql`select id from time_entries where id=${entry} for update`);ready();await finish;});
    await Promise.race([locked,holder]);
    runs=[first,second].map(request=>generateInvoiceFromBillingRequest(org.orgId,actor,request.id,null));
    const outcomes=Promise.allSettled(runs);
    const deadline=Date.now()+10000;let blocked=0;
    while(Date.now()<deadline){
     blocked=await withBypassContext(async ()=>(await db.execute<{n:number}>(sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and (query ilike '%time_entries%' or query ilike '%from billing_requests br%' or query ilike '%pg_advisory_xact_lock%' or query ilike '%insert into document_lines%')`)).rows[0]!.n);
     if(blocked>=2)break;await new Promise(r=>setTimeout(r,25));
    }
    assert.ok(blocked>=2,'both generators reached the controlled contention point');
    release();await holder;
    const results=await outcomes;
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1,'one source must produce only one committed invoice');
    assert.equal((await db.execute<{n:number}>(sql`select count(*)::int as n from documents where org_id=${org.orgId} and kind='customer_invoice'`)).rows[0]!.n,1);
    assert.equal((await db.execute<{n:number}>(sql`select count(*)::int as n from billing_requests where org_id=${org.orgId} and status='open'`)).rows[0]!.n,1);
   }
   });
  }finally{release();await Promise.allSettled([...(holder?[holder]:[]),...runs]);await withBypassContext(()=>dropScratchOrg(org.orgId));}
 });
}


const consolidatedRows = [
  { label: "billing milestone provenance", register: async () => {
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
        const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { generateInvoiceFromBillingRequest } = await import('./billing')
        const { createBillingRequest } = await import('./billing-requests')
        
        /**
         * A milestone invoice may claim only the schedule rows it actually billed.
         * Zero-amount (not yet priced) milestones are skipped as invoice lines, so
         * stamping them with the request id would consume them without ever billing
         * them — and provenance release only unwinds on void/delete, so they would be
         * stranded for good.
         */
        test('milestone billing stamps provenance only on the schedule rows it billed', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const unbilledReceivable = randomUUID()
              await db.execute(sql`insert into accounts(id,org_id,number,name,type,is_summary,is_active) values (${unbilledReceivable},${org.orgId},'1150','Unbilled Receivable','asset_current_other',false,true)`)
              await db.execute(sql`update orgs set settings = jsonb_set(settings, '{controlAccounts,unbilledReceivable}', to_jsonb(${unbilledReceivable}::text), true) where id = ${org.orgId}`)
              const actor = (await seedFlowActors(org.orgId)).adminId
              const fixed = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'fixed_price')!
              const typeId = randomUUID(), project = randomUUID()
              await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
                values (${typeId},${org.orgId},'fixed_price','Fixed Price','fixed_price',${JSON.stringify(fixed.invoicingProfile)}::jsonb,${JSON.stringify(fixed.backupProfile)}::jsonb)`)
              await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
                values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(fixed.financialProfile)}::jsonb,'scratch fixture baseline')`)
              await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,custom)
                values (${project},${org.orgId},${org.subsidiaryId},'MILESTONE','Milestone provenance',${org.customerId},${typeId},'active',true,'{}'::jsonb)`)
              const billed = randomUUID(), unpricedA = randomUUID(), unpricedB = randomUUID()
              await db.execute(sql`insert into billing_schedules(id,org_id,project_id,name,amount_billed,sort_order)
                values (${billed},${org.orgId},${project},'Mobilization','2500.0000',1),
                       (${unpricedA},${org.orgId},${project},'Framing','0',2),
                       (${unpricedB},${org.orgId},${project},'Closeout',null,3)`)
        
              const first = await createBillingRequest(org.orgId, actor, {projectId: project, basis: 'milestone', cutoffDate: org.date, backupRequired: false})
              const invoice = await generateInvoiceFromBillingRequest(org.orgId, actor, first.id)
              assert.equal((await db.execute<{total:string}>(sql`select total::text from documents where org_id=${org.orgId} and id=${invoice.id}`)).rows[0]!.total, '2500.0000')
        
              const rows = (await db.execute<{id:string; billing_request_id:string|null}>(sql`
                select id, billing_request_id from billing_schedules where org_id=${org.orgId} and project_id=${project} order by sort_order`)).rows
              assert.deepEqual(rows, [
                {id: billed, billing_request_id: first.id},
                {id: unpricedA, billing_request_id: null},
                {id: unpricedB, billing_request_id: null},
              ])
        
              // The skipped milestones are still open: once priced, the next request bills them.
              await db.execute(sql`update billing_schedules set amount_billed='4000.0000' where org_id=${org.orgId} and id=${unpricedA}`)
              const second = await createBillingRequest(org.orgId, actor, {projectId: project, basis: 'milestone', cutoffDate: org.date, backupRequired: false})
              const secondInvoice = await generateInvoiceFromBillingRequest(org.orgId, actor, second.id)
              assert.equal((await db.execute<{total:string}>(sql`select total::text from documents where org_id=${org.orgId} and id=${secondInvoice.id}`)).rows[0]!.total, '4000.0000')
              const after = (await db.execute<{id:string; billing_request_id:string|null}>(sql`
                select id, billing_request_id from billing_schedules where org_id=${org.orgId} and project_id=${project} order by sort_order`)).rows
              assert.deepEqual(after.map((r) => r.billing_request_id), [first.id, second.id, null])
            } finally { await dropScratchOrg(org.orgId) }
          })
        })
  } },
  { label: "billing request backup type", register: async () => {
        // An explicit backup type names one of the configured packet recipes. A
        // misspelled type must refuse — silently persisting the default (or none)
        // would issue the customer a packet nobody asked for, or no packet where
        // the approver required one.
        const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { createBillingRequest } = await import('./billing-requests')
        const DB = !!process.env.OPENBOOKS_DB_URL
        
        async function setup() {
          const org = await withBypassContext(() => createScratchOrg())
          const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Billing requester', 'reviewer'))
          await withBypassContext(() => db.execute(sql`
            update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`))
          const project = randomUUID()
          await withBypassContext(() => db.execute(sql`
            insert into projects(id, org_id, subsidiary_id, code, name, customer_id, status, is_active)
            values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'BACKUP-TYPE', 'Backup type probe', ${org.customerId}, 'active', true)`))
          return { org, actor, project }
        }
        
        test('createBillingRequest refuses an unknown backup type', { skip: !DB }, async () => {
          const { org, actor, project } = await setup()
          try {
            await assert.rejects(
              withOrgContext(org.orgId, () => createBillingRequest(org.orgId, actor, {
                projectId: project,
                basis: 'draw_amount',
                drawAmount: '100',
                backupRequired: true,
                backupType: 'carrier_pigeon',
              })),
              /Unknown backup type "carrier_pigeon"/,
            )
          } finally {
            await dropScratchOrg(org.orgId)
          }
        })
        
        test('createBillingRequest persists a known backup type', { skip: !DB }, async () => {
          const { org, actor, project } = await setup()
          try {
            const created = await withOrgContext(org.orgId, () => createBillingRequest(org.orgId, actor, {
              projectId: project,
              basis: 'draw_amount',
              drawAmount: '100',
              backupRequired: true,
              backupType: 'costed_timesheets',
            }))
            const row = (await withBypassContext(() => db.execute<{ backup_type: string }>(sql`
              select backup_type from billing_requests where id = ${created.id}`))).rows[0]
            assert.equal(row?.backup_type, 'costed_timesheets')
          } finally {
            await dropScratchOrg(org.orgId)
          }
        })
  } },
  { label: "billing not to exceed", register: async () => {
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
        const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { generateInvoiceFromBillingRequest } = await import('./billing')
        const { createBillingRequest } = await import('./billing-requests')
        
        const total = async (orgId: string, id: string) =>
          (await db.execute<{total:string}>(sql`select total::text from documents where org_id=${orgId} and id=${id}`)).rows[0]!.total
        
        /**
         * The not-to-exceed cap bounds the CUMULATIVE amount invoiced on the project.
         * A draft invoice already reserves the amount it will bill, so two open
         * requests cannot each draw the full remaining capacity; credits restore it.
         */
        test('not-to-exceed counts draft invoices and nets credits under the cap', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              await db.execute(sql`update orgs set settings = jsonb_set(settings, '{controlAccounts,projectRevenue}', to_jsonb(${org.accounts.revenue}::text), true) where id = ${org.orgId}`)
              const actor = (await seedFlowActors(org.orgId)).adminId
              const tm = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'time_and_materials')!
              const typeId = randomUUID(), project = randomUUID()
              await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
                values (${typeId},${org.orgId},'capped_tm','Capped T&M','time_and_materials',
                        ${JSON.stringify({ ...tm.invoicingProfile, notToExceed: true })}::jsonb,${JSON.stringify(tm.backupProfile)}::jsonb)`)
              await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
                values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(tm.financialProfile)}::jsonb,'scratch fixture baseline')`)
              await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,contract_value,status,is_active,custom)
                values (${project},${org.orgId},${org.subsidiaryId},'NTE','Not to exceed',${org.customerId},${typeId},'100000.0000','active',true,'{}'::jsonb)`)
              const request = (drawAmount: string) =>
                createBillingRequest(org.orgId, actor, {projectId: project, basis: 'draw_amount', drawAmount, cutoffDate: org.date, backupRequired: false})
        
              const first = await generateInvoiceFromBillingRequest(org.orgId, actor, (await request('90000')).id)
              assert.equal(await total(org.orgId, first.id), '90000.0000')
              // Second draft while the first is still a draft: only 10,000 of capacity remains.
              const second = await generateInvoiceFromBillingRequest(org.orgId, actor, (await request('90000')).id)
              assert.equal(await total(org.orgId, second.id), '10000.0000')
              await assert.rejects(generateInvoiceFromBillingRequest(org.orgId, actor, (await request('1')).id), /fully invoiced/)
        
              // A credit on the project restores capacity.
              const credit = randomUUID()
              await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,subsidiary_id,project_id,document_date,currency,status,subtotal,tax_total,total)
                values (${credit},${org.orgId},'customer_credit','CR-NTE',${org.customerId},${org.subsidiaryId},${project},${org.date},'CAD','draft','30000','0','30000')`)
              await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,description,quantity,unit_price,amount)
                values (${org.orgId},${credit},1,${org.accounts.revenue},'Credit',1,'30000','30000')`)
              await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${credit}`)
              const third = await generateInvoiceFromBillingRequest(org.orgId, actor, (await request('50000')).id)
              assert.equal(await total(org.orgId, third.id), '30000.0000')
        
              // A voided invoice releases its reservation; nothing else does.
              await db.execute(sql`update documents set status='voided', voided_at=now(), voided_by=${actor}, void_reason='regression: release reservation' where org_id=${org.orgId} and id=${second.id}`)
              const fourth = await generateInvoiceFromBillingRequest(org.orgId, actor, (await request('50000')).id)
              assert.equal(await total(org.orgId, fourth.id), '10000.0000')
            } finally { await dropScratchOrg(org.orgId) }
          })
        })
  } },
  { label: "billing currency", register: async () => {
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { generateInvoiceFromBillingRequest } = await import('./billing')
        const { createBillingRequest } = await import('./billing-requests')
        
        for (const [currency, amount, expected] of [['JPY','100.5000','101.0000'],['JPY','-100.5000','-101.0000'],['CAD','100.5550','100.5600']] as const) {
          test(`project billing rounds ${currency} ${amount} to payable precision`, {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
            await withBypassContext(async () => {
              const org = await createScratchOrg()
              try {
                await db.execute(sql`update orgs set settings = jsonb_set(settings, '{controlAccounts,projectRevenue}', to_jsonb(${org.accounts.revenue}::text), true) where id = ${org.orgId}`)
                const actors = await seedFlowActors(org.orgId)
                const project = randomUUID()
                await db.execute(sql`update subsidiaries set base_currency=${currency} where id=${org.subsidiaryId} and org_id=${org.orgId}`)
                await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom) values (${project},${org.orgId},${org.subsidiaryId},'ROUND','Currency precision',${org.customerId},'active',true,'{}'::jsonb)`)
                const req = await createBillingRequest(org.orgId,actors.adminId,{projectId:project,basis:'draw_amount',drawAmount:amount,cutoffDate:org.date,backupRequired:false})
                const invoice = await generateInvoiceFromBillingRequest(org.orgId,actors.adminId,req.id)
                const row = (await db.execute<{currency:string,total:string,amount:string,unit_price:string}>(sql`select d.currency,d.total::text,l.amount::text,l.unit_price::text from documents d join document_lines l on l.document_id=d.id and l.org_id=d.org_id where d.org_id=${org.orgId} and d.id=${invoice.id}`)).rows[0]!
                assert.deepEqual(row,{currency,total:expected,amount:expected,unit_price:expected+'0000'})
                await assert.rejects(generateInvoiceFromBillingRequest(org.orgId,actors.adminId,req.id),/already been invoiced/)
              } finally { await dropScratchOrg(org.orgId) }
            })
          })
        }
        
        for (const [markupPercent, expected] of [['1.2345','101234.5000'],['-10','90000.0000'],['invalid',null]] as const) {
          test(`project billing preserves markup ${markupPercent} or refuses invalid configuration`, {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
            await withBypassContext(async () => {
              const org = await createScratchOrg()
              try {
                if (expected !== null) await db.execute(sql`update orgs set settings = jsonb_set(settings, '{controlAccounts,projectRevenue}', to_jsonb(${org.accounts.revenue}::text), true) where id = ${org.orgId}`)
                const actor = (await seedFlowActors(org.orgId)).adminId
                const project = randomUUID(), cost = randomUUID(), line = randomUUID()
                await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom) values (${project},${org.orgId},${org.subsidiaryId},'MARKUP','Exact markup',${org.customerId},'active',true,${JSON.stringify({markupPercent})}::jsonb)`)
                await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,subsidiary_id,project_id,document_date,posting_date,currency,fx_rate,status,subtotal,tax_total,total) values (${cost},${org.orgId},'vendor_bill','MARKUP-COST',${org.vendorId},${org.subsidiaryId},${project},${org.date},${org.date},'CAD',1,'draft','100000','0','100000')`)
                await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,account_id,description,quantity,unit_price,amount,is_billable) values (${line},${org.orgId},${cost},1,${org.accounts.cogs},'Billable expense',1,'100000','100000',true)`)
                await db.execute(sql`update documents set status='approved' where id=${cost} and org_id=${org.orgId}`)
                const req = await createBillingRequest(org.orgId,actor,{projectId:project,basis:'date_range',cutoffDate:org.date,backupRequired:false})
                if (expected === null) {
                  await assert.rejects(generateInvoiceFromBillingRequest(org.orgId,actor,req.id),/markup/i)
                  const row=(await db.execute<{status:string,billed_by_line_id:string|null}>(sql`select r.status,l.billed_by_line_id from billing_requests r join document_lines l on l.org_id=r.org_id and l.id=${line} where r.org_id=${org.orgId} and r.id=${req.id}`)).rows[0]!
                  assert.deepEqual(row,{status:'open',billed_by_line_id:null})
                } else {
                  const invoice = await generateInvoiceFromBillingRequest(org.orgId,actor,req.id)
                  assert.equal((await db.execute<{total:string}>(sql`select total::text from documents where org_id=${org.orgId} and id=${invoice.id}`)).rows[0]!.total,expected)
                }
              } finally { await dropScratchOrg(org.orgId) }
            })
          })
        }
  } },
  { label: "billing per item provenance", register: async () => {
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { generateInvoiceFromBillingRequest } = await import('./billing')
        const { createBillingRequest } = await import('./billing-requests')
        
        // Per-item grouping merges every source cost line into one presented line
        // and stamps each source with its invoice line, so a retry (or a second
        // request over the same project) can never charge either source again.
        test('per-item grouping bills every source cost line exactly once across runs', async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              await db.execute(sql`update orgs set settings = jsonb_set(settings, '{controlAccounts,projectRevenue}', to_jsonb(${org.accounts.revenue}::text), true) where id = ${org.orgId}`)
              const actor = (await seedFlowActors(org.orgId)).adminId
              const project = randomUUID(), cost = randomUUID(), line1 = randomUUID(), line2 = randomUUID()
              await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom,invoicing_profile) values (${project},${org.orgId},${org.subsidiaryId},'PERITEM','Per-item provenance',${org.customerId},'active',true,'{}'::jsonb,'{"lineGrouping":"per_item"}'::jsonb)`)
              await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,subsidiary_id,project_id,document_date,posting_date,currency,fx_rate,status,subtotal,tax_total,total) values (${cost},${org.orgId},'vendor_bill','PERITEM-COST',${org.vendorId},${org.subsidiaryId},${project},${org.date},${org.date},'CAD',1,'draft','20','0','20')`)
              await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,item_id,account_id,description,quantity,unit_price,amount,is_billable) values (${line1},${org.orgId},${cost},1,${org.items.service},${org.accounts.cogs},'First cost',1,'10','10',true),(${line2},${org.orgId},${cost},2,${org.items.service},${org.accounts.cogs},'Second cost',1,'10','10',true)`)
              await db.execute(sql`update documents set status='approved' where id=${cost} and org_id=${org.orgId}`)
        
              const req1 = await createBillingRequest(org.orgId,actor,{projectId:project,basis:'date_range',cutoffDate:org.date,backupRequired:false})
              const invoice1 = await generateInvoiceFromBillingRequest(org.orgId,actor,req1.id)
              const lines1 = (await db.execute<{amount:string}>(sql`select amount::text from document_lines where org_id=${org.orgId} and document_id=${invoice1.id} order by line_number`)).rows
              assert.deepEqual(lines1.map((l) => l.amount), ['20.0000'], 'matching item costs combine into one invoice line with the full source amount')
              const stamped = (await db.execute<{count:string}>(sql`select count(*)::text as count from document_lines where org_id=${org.orgId} and id in (${line1},${line2}) and billed_by_line_id is not null`)).rows[0]!
              assert.equal(stamped.count, '2', 'both sources carry their invoice line')
        
              const req2 = await createBillingRequest(org.orgId,actor,{projectId:project,basis:'date_range',cutoffDate:org.date,backupRequired:false})
              await assert.rejects(
                generateInvoiceFromBillingRequest(org.orgId,actor,req2.id),
                /Nothing available to bill/,
                'a second run over stamped sources refuses instead of billing anything new',
              )
              const billed = (await db.execute<{total:string}>(sql`select coalesce(sum(total),0)::text as total from documents where org_id=${org.orgId} and kind='customer_invoice'`)).rows[0]!
              assert.equal(billed.total, '20.0000', 'both runs together bill the sources exactly once')
            } finally { await dropScratchOrg(org.orgId) }
          })
        })
  } },
] as const;

for (const row of consolidatedRows) await row.register();
