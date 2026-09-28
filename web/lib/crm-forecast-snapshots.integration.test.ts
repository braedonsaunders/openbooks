import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { resolveAppModule } from './test-module-hooks'
import { pathToFileURL } from 'node:url';
import type { SessionUser } from './auth';
import * as React from 'react';
import { stubModules } from '../testing/stub-modules.ts'
Object.assign(globalThis, { React });
const root = pathToFileURL(process.cwd() + "/").href;
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __forecastSnapshotSession: session });
stubModules({ navigation: false, intl: 'export async function getTranslations(){return key=>key};export async function getLocale(){return \'en\'};export async function getFormatter(){return {dateTime:date=>date.toISOString()}}', authz: false, features: false });

registerHooks({ resolve(specifier, context, next) {
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__forecastSnapshotSession.user}' };
  const app = resolveAppModule(specifier, context, next, root);
  if (app) return app;
  return next(specifier,context);
}});
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");

const {randomUUID}=await import('node:crypto');
const {ensureCrmDefaults}=await import('@openbooks/engine/src/crm/crm.ts');
const {POST,GET}=await import('../app/api/crm/forecasts/route');
const {NextRequest}=await import('next/server');
const enabled={skip:!process.env.OPENBOOKS_DB_URL};
const period={periodStart:'2026-07-01',periodEnd:'2026-07-31'};
const request=(body:Record<string,unknown>)=>new NextRequest('http://audit.local',{method:'POST',body:JSON.stringify({...period,...body})});
async function fixture(action:(org:Awaited<ReturnType<typeof createScratchOrg>>,actor:string)=>Promise<void>){
 const org=await withBypassContext(()=>createScratchOrg());
 try {
  const actor=await withBypassContext(()=>createScratchUser(org.orgId,'Forecast reviewer','reviewer'));
  await withBypassContext(async()=>{
   await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`);
   await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"crm":true}'::jsonb) where id=${org.orgId}`);
  });
  session.user={id:actor,orgId:org.orgId,name:'Reviewer',email:'reviewer@example.test',roles:[],isSuperAdmin:false,envKind:'production',productionOrgId:org.orgId,homeOrgId:org.orgId,homeUserId:actor};
  await withOrgContext(org.orgId,()=>ensureCrmDefaults(org.orgId,actor));
  await withOrgContext(org.orgId,()=>action(org,actor));
 }finally{session.user=null;await dropScratchOrg(org.orgId);}
}
async function pipeline(org:Awaited<ReturnType<typeof createScratchOrg>>,actor:string,currencies:string[]){
 for(const currency of currencies){
  const id=randomUUID();
  await withBypassContext(() => (db.execute(sql`insert into crm_opportunities(id,org_id,opportunity_number,title,party_id,owner_user_id,status_id,currency,is_active,projected_amount,weighted_amount,expected_close_date)
   select ${id},${org.orgId},${id},'Currency-specific work',${org.customerId},${actor},id,${currency},true,100,50,'2026-07-15'
   from crm_opportunity_statuses where org_id=${org.orgId} and is_default and not is_closed limit 1`)));
 }
}

test('an empty forecast saves explicit zero evidence in the organization reporting currency',enabled,async()=>fixture(async(org)=>{
 const response=await POST(request({}));
 assert.equal(response.status,201);
 const body=await response.json();
 assert.equal(body.ids.length,1);
 const rows=(await db.execute<{currency:string;pipeline_amount:string;weighted_amount:string;detail:Record<string,unknown>}>(sql`select currency,pipeline_amount::text,weighted_amount::text,detail from crm_forecast_snapshots where org_id=${org.orgId}`)).rows;
 assert.equal(rows.length,1);
 assert.equal(rows[0]!.currency,'CAD');
 assert.equal(rows[0]!.pipeline_amount,'0.0000');
 assert.equal(rows[0]!.weighted_amount,'0.0000');
 assert.equal(rows[0]!.detail.emptyPipeline,true);
 assert.equal(rows[0]!.detail.currencySource,'organization_base_currency');
}));

test('forecast routes reject impossible dates before any snapshot write',enabled,async()=>fixture(async(org)=>{
 for(const day of ['2026-02-30','2026-13-01','2026-00-15']){
  const posted=await POST(request({periodStart:day,periodEnd:'2027-01-01'}));
  assert.equal(posted.status,422);
  const read=await GET(new NextRequest('http://audit.local?periodStart='+day+'&periodEnd=2027-01-01'));
  assert.equal(read.status,422);
 }
 assert.equal((await db.execute(sql`select id from crm_forecast_snapshots where org_id=${org.orgId}`)).rows.length,0);
}));

test('multi-currency overrides require one currency and never duplicate money across currencies',enabled,async()=>fixture(async(org,actor)=>{
 await pipeline(org,actor,['CAD','USD']);
 const ambiguous=await POST(request({overrideAmount:'250'}));
 assert.equal(ambiguous.status,422,await ambiguous.clone().text());
 assert.equal((await db.execute(sql`select id from crm_forecast_snapshots where org_id=${org.orgId}`)).rows.length,0);
 const selected=await POST(request({overrideAmount:'250',currency:'usd'}));
 assert.equal(selected.status,201,await selected.clone().text());
 assert.equal((await selected.json()).ids.length,1);
 const rows=(await db.execute<{currency:string;override_amount:string}>(sql`select currency,override_amount::text from crm_forecast_snapshots where org_id=${org.orgId}`)).rows;
 assert.deepEqual(rows,[{currency:'USD',override_amount:'250.0000'}]);
 const calculated=await POST(request({}));
 assert.equal(calculated.status,201);
 assert.equal((await calculated.json()).ids.length,2,'calculated snapshots preserve every original currency');
}));

test('a single-currency override retains its unambiguous currency and snapshot kinds cannot contradict their amounts',enabled,async()=>fixture(async(org,actor)=>{
 await pipeline(org,actor,['USD']);
 const accepted=await POST(request({overrideAmount:'250'}));
 assert.equal(accepted.status,201);
 const rows=(await db.execute<{currency:string;override_amount:string}>(sql`select currency,override_amount::text from crm_forecast_snapshots where org_id=${org.orgId}`)).rows;
 assert.deepEqual(rows,[{currency:'USD',override_amount:'250.0000'}]);
 for(const body of [{snapshotKind:'calculated',overrideAmount:'250'},{snapshotKind:'rep_override'},{snapshotKind:'manager_override'},{currency:'invalid'}]){
  const refused=await POST(request(body));
  assert.equal(refused.status,422,JSON.stringify(body));
 }
 assert.equal((await db.execute(sql`select id from crm_forecast_snapshots where org_id=${org.orgId}`)).rows.length,1);
}));

test('an override for an empty pipeline requires an explicit currency',enabled,async()=>fixture(async(org)=>{
 const ambiguous=await POST(request({overrideAmount:'250'}));
 assert.equal(ambiguous.status,422);
 const accepted=await POST(request({overrideAmount:'250',currency:'USD'}));
 assert.equal(accepted.status,201,await accepted.clone().text());
 const rows=(await db.execute<{currency:string;override_amount:string;pipeline_amount:string}>(sql`select currency,override_amount::text,pipeline_amount::text from crm_forecast_snapshots where org_id=${org.orgId}`)).rows;
 assert.deepEqual(rows,[{currency:'USD',override_amount:'250.0000',pipeline_amount:'0.0000'}]);
}));

test('the forecast page clamps impossible dates before issuing its report queries',enabled,async()=>fixture(async()=>{
 const {default:Page}=await import('../app/(app)/crm/forecasts/page');
 await assert.doesNotReject(Page({searchParams:Promise.resolve({periodStart:'2026-02-30',periodEnd:'2026-03-31'})}));
}));


const crmForecastCases = [
  { label: "crm forecast closed", register: async () => {
        const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
        const test = (await import('node:test')).default;
        const { randomUUID } = await import('node:crypto');
        const { registerHooks } = await import('node:module');
        const { resolveAppModule } = await import('./test-module-hooks');
        const { pathToFileURL } = await import('node:url');
        // C6: Closed summed posted customer_invoice documents.total (tax included)
        // and ignored credits, so a $100 sale with $13 tax showed as $113 closed
        // and a later $100 credit never reduced it. Closed is now the net revenue
        // basis — invoice subtotals minus posted customer credits attributable to
        // the same revenue. Real calculation, real database; only module resolution
        // is scripted.
        const root = pathToFileURL(process.cwd() + "/").href;
        registerHooks({ resolve(specifier, context, next) {
          const app = resolveAppModule(specifier, context, next, root);
          if (app) return app;
          return next(specifier,context);
        }});
        const { sql } = await import('drizzle-orm');
        const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
        const { calculateForecast } = await import('./crm');
        const { voidReportDocument } = await import('../testing/document-void.ts')

        const DB = !!process.env.OPENBOOKS_DB_URL;
        const PERIOD = { periodStart: '2026-07-01', periodEnd: '2026-07-31' } as const;

        // Posted documents must carry their posting references
        // (documents_posted_requires_posting_refs), so fixtures post through real
        // balanced journal entries: draft document, draft entry plus lines, entry
        // marked posted, document flipped to posted with its refs.
        async function postDocument(org: { orgId: string; bookId: string; subsidiaryId: string; periodId: string; accounts: { revenue: string; ar: string } }, opts: {
          kind: 'customer_invoice' | 'customer_credit'; number: string; date: string;
          partyId: string; subtotal: string; taxTotal: string; total: string;
        }) {
          const doc = randomUUID(), entry = randomUUID();
          await withBypassContext(async () => {
            await db.execute(sql`insert into documents (id, org_id, kind, document_number, document_date, posting_date, due_date, party_id, subsidiary_id, currency, subtotal, tax_total, total)
              values (${doc}, ${org.orgId}, ${opts.kind}, ${opts.number}, ${opts.date}, ${opts.date}, ${opts.date}, ${opts.partyId}, ${org.subsidiaryId}, 'CAD', ${opts.subtotal}, ${opts.taxTotal}, ${opts.total})`);
            // Invoices credit revenue and debit AR; credits mirror the entry.
            const revenueSigned = opts.kind === 'customer_invoice' ? `-${opts.subtotal}` : opts.subtotal;
            await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, source_document_id)
              values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${entry}, ${opts.date}, ${org.periodId}, 'draft', 'manual', ${doc})`);
            await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, party_id, amount, currency, txn_amount, fx_rate)
              values (${org.orgId}, ${entry}, 1, ${org.accounts.revenue}, ${org.subsidiaryId}, ${opts.partyId}, ${revenueSigned}, 'CAD', ${revenueSigned}, 1),
                     (${org.orgId}, ${entry}, 2, ${org.accounts.ar}, ${org.subsidiaryId}, ${opts.partyId}, -${revenueSigned}::numeric, 'CAD', -${revenueSigned}::numeric, 1)`);
            await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`);
            await db.execute(sql`update documents set status='posted', posted_entry_id=${entry}, posting_period_id=${org.periodId} where id=${doc}`);
          });
          return doc;
        }
        async function fixture() {
          const org = await withBypassContext(() => createScratchOrg());
          const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Seller', 'owner'));
          await withBypassContext(async () => {
            await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"crm":true}'::jsonb) where id=${org.orgId}`);
            await db.execute(sql`insert into crm_account_profiles (org_id, party_id, owner_user_id) values (${org.orgId}, ${org.customerId}, ${actor})`);
          });
          const invoiceId = await postDocument(org, { kind: 'customer_invoice', number: 'INV-C6', date: '2026-07-15', partyId: org.customerId, subtotal: '100.0000', taxTotal: '13.0000', total: '113.0000' });
          return { org, actor, invoiceId };
        }
        async function postCredit(org: { orgId: string; bookId: string; subsidiaryId: string; periodId: string; accounts: { revenue: string; ar: string } }, partyId: string, number: string, subtotal: string) {
          await postDocument(org, { kind: 'customer_credit', number, date: '2026-07-20', partyId, subtotal, taxTotal: '0.0000', total: subtotal });
        }
        async function closed(orgId: string, ownerUserId?: string, period: { periodStart: string; periodEnd: string } = PERIOD) {
          const rows = await calculateForecast({ orgId, ...period, ownerUserId }) as { currency: string; closed_amount: string }[];
          return rows.find((row) => row.currency === 'CAD')?.closed_amount;
        }

        test('a taxed invoice closes at its net subtotal, not its total', { skip: !DB }, async () => {
          const { org } = await fixture();
          try {
            assert.equal(await closed(org.orgId), '100.0000');
          } finally {
            await dropScratchOrg(org.orgId);
          }
        });

        test('a voided invoice remains in its posting period and offsets its void period', { skip: !DB }, async () => {
          const { org, invoiceId } = await fixture();
          try {
            assert.equal(await closed(org.orgId), '100.0000', 'closed revenue uses the invoice subtotal, not tax')
            await voidReportDocument(org.orgId, invoiceId, '2026-08-05')
            assert.equal(await closed(org.orgId), '100.0000');
            assert.equal(await closed(org.orgId, undefined, { periodStart: '2026-08-01', periodEnd: '2026-08-31' }), '-100.0000')
          } finally {
            await dropScratchOrg(org.orgId);
          }
        });

        test('a full credit against the sale closes it to zero', { skip: !DB }, async () => {
          const { org } = await fixture();
          try {
            await postCredit(org, org.customerId, 'CR-C6', '100.0000');
            assert.equal(await closed(org.orgId), '0.0000');
          } finally {
            await dropScratchOrg(org.orgId);
          }
        });

        test('a partial credit nets against the sale instead of zeroing or ignoring it', { skip: !DB }, async () => {
          const { org } = await fixture();
          try {
            await postCredit(org, org.customerId, 'CR-C6-P', '30.0000');
            assert.equal(await closed(org.orgId), '70.0000');
          } finally {
            await dropScratchOrg(org.orgId);
          }
        });

        test("an unrelated credit does not move the owner's closed figure", { skip: !DB }, async () => {
          const { org, actor } = await fixture();
          try {
            const stranger = await withBypassContext(() => db.execute<{ id: string }>(sql`
              insert into parties (org_id, kind, display_name, is_active, custom)
              values (${org.orgId}, 'customer', 'Stranger Co', true, '{}'::jsonb) returning id`)).then((r) => r.rows[0]!.id);
            await postCredit(org, stranger, 'CR-C6-X', '50.0000');
            assert.equal(await closed(org.orgId, actor), '100.0000');
          } finally {
            await dropScratchOrg(org.orgId);
          }
        });
  } },
  { label: "crm forecast exclusions", register: async () => {
        const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
        const { randomUUID } = await import('node:crypto');
        const { registerHooks } = await import('node:module');
        const test = (await import('node:test')).default;
        registerHooks({
          resolve(specifier, _context, next) {
            return next(specifier)
          },
        })

        const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { ensureCrmDefaults } = await import('@openbooks/engine/src/crm/crm.ts')
        const { countUndatedForecastExcluded } = await import('./crm.ts')

        test('forecast exclusion count includes only active, open, dated-eligible opportunities', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Forecast reader', 'crm_reader'))
            await withBypassContext(async () => {
              await ensureCrmDefaults(org.orgId, actor)
              const statuses = (await db.execute<{ id: string; is_closed: boolean; forecast_category?: string }>(sql`
                select id, is_closed from crm_opportunity_statuses
                 where org_id=${org.orgId} and is_active order by is_closed, sequence`)).rows
              const open = statuses.find((status) => !status.is_closed)
              const closed = statuses.find((status) => status.is_closed)
              assert.ok(open, 'CRM defaults provide an open status')
              assert.ok(closed, 'CRM defaults provide a closed status')
              const rows = [
                { title: 'eligible-undated', status: open.id, forecast: 'most_likely', active: true, closeDate: null },
                { title: 'second-eligible-undated', status: open.id, forecast: 'worst_case', active: true, closeDate: null },
                { title: 'dated', status: open.id, forecast: 'most_likely', active: true, closeDate: org.date },
                { title: 'omitted', status: open.id, forecast: 'omitted', active: true, closeDate: null },
                { title: 'closed', status: closed.id, forecast: 'most_likely', active: true, closeDate: null },
                { title: 'inactive', status: open.id, forecast: 'most_likely', active: false, closeDate: null },
              ]
              for (const row of rows) {
                const id = randomUUID()
                await db.execute(sql`insert into crm_opportunities
                  (id,org_id,opportunity_number,title,status_id,probability,currency,projected_amount,weighted_amount,
                   expected_close_date,forecast_category,is_active,created_by,updated_by)
                  values(${id},${org.orgId},${id},${row.title},${row.status},50,'USD','100','50',
                    ${row.closeDate},${row.forecast},${row.active},${actor},${actor})`)
              }
            })

            const count = await withOrgContext(org.orgId, () => countUndatedForecastExcluded({ orgId: org.orgId }))
            assert.equal(count, 2, 'the count includes both active, open, forecast-eligible undated opportunities')
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId))
          }
        })
  } },
] as const;

for (const row of crmForecastCases) await row.register();
