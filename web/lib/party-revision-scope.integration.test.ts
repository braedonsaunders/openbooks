import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { SessionUser } from './auth';
const root = pathToFileURL(process.cwd() + "/").href;
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __emailRevisionSession: session });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__emailRevisionSession.user}' };
  if (specifier.startsWith('@/')) return next(root+'web/'+specifier.slice(2)+'.ts',context);
  return next(specifier,context);
}});
const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { PATCH, GET } = await import("../app/api/parties/[id]/route");
const { loadParty } = await import("../app/api/parties/_lib");
for (const operation of ['read', 'save', 'stale']) {
  test(`party exact revision ${operation}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, 'Party administrator', 'reviewer');
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`);
      session.user = { id:actor, orgId:org.orgId, name:'Party administrator', email:'party@scratch.test', roles:[], isSuperAdmin:false, envKind:'production', productionOrgId:org.orgId, homeOrgId:org.orgId, homeUserId:actor };
      await db.execute(sql`update parties set updated_at=date_trunc('second',now()+interval '1 day')+interval '123450 microseconds' where id=${org.customerId}`);
      const exact = (await db.execute<{revision:string}>(sql`select to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as revision from parties where id=${org.customerId}`)).rows[0]!.revision;
      const params = {params:Promise.resolve({id:org.customerId})};
      await withOrgContext(org.orgId,async()=>{
        const before = await GET(new Request('http://audit.local/api/parties'),params);
        const payload = await before.json();
        assert.equal(before.status,200,JSON.stringify(payload));
        if (operation === 'read') { assert.equal(payload.party.updated_at,exact); return; }
        if (operation === 'stale') await db.execute(sql`update parties set display_name='Concurrent edit',updated_at=updated_at+interval '1 microsecond' where id=${org.customerId}`);
        const response = await PATCH(new Request('http://audit.local/api/parties',{method:'PATCH',body:JSON.stringify({displayName:'Accepted edit',expectedUpdatedAt:payload.party.updated_at})}),params);
        assert.equal(response.status,operation === 'stale' ? 409 : 200,JSON.stringify(await response.json()));
      });
    } finally { session.user=null; await dropScratchOrg(org.orgId); }
  });
}

test('party summary excludes invoices from hidden entities', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org=await createScratchOrg();
  try {
    const {randomUUID}=await import('node:crypto');
    const actor=await createScratchUser(org.orgId,'Scoped party reader','reviewer');
    const other=randomUUID();
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${other},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA')`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"multiSubsidiary":true}'::jsonb) where id=${org.orgId}`);
    await db.execute(sql`update app_roles set permissions='["parties.read","parties.manage"]'::jsonb,subsidiary_restriction=${JSON.stringify({mode:'list',subsidiaryIds:[org.subsidiaryId]})}::jsonb where org_id=${org.orgId} and key='reviewer'`);
    session.user={id:actor,orgId:org.orgId,name:'Scoped reader',email:'reader@scratch.test',roles:[],isSuperAdmin:false,envKind:'production',productionOrgId:org.orgId,homeOrgId:org.orgId,homeUserId:actor};
    for(const [subsidiary,amount] of [[org.subsidiaryId,'100'],[other,'900']]){
      const id=randomUUID();
      await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,party_id,subsidiary_id,currency) values (${id},${org.orgId},'customer_invoice',${id},${org.date},${org.customerId},${subsidiary},'CAD')`);
      await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount) values (${org.orgId},${id},1,${org.accounts.revenue},1,${amount},${amount})`);
    }
    const response=await withOrgContext(org.orgId,()=>GET(new Request('http://audit.local/api/parties'),{params:Promise.resolve({id:org.customerId})}));
    const body=await response.json();
    assert.equal(response.status,200,JSON.stringify(body));
    assert.equal(body.transactionSummary.count,1);
    assert.equal(body.transactionSummary.currencies[0].total,'100.0000');
    // Both relation visibility and replacement preserve entities the editor
    // cannot inspect. A full replacement only owns the visible portion.
    await db.execute(sql`insert into party_subsidiaries(org_id,party_id,subsidiary_id) values
      (${org.orgId},${org.customerId},${org.subsidiaryId}),(${org.orgId},${org.customerId},${other})`);
    const visible = await loadParty(org.customerId,org.orgId,new Set([org.subsidiaryId]));
    assert.deepEqual(visible?.additionalSubsidiaryIds,[org.subsidiaryId]);
    const replaced = await withOrgContext(org.orgId,()=>PATCH(new Request('http://audit.local/api/parties',{
      method:'PATCH',body:JSON.stringify({expectedUpdatedAt:visible!.party.updated_at,additionalSubsidiaryIds:[]}),
    }),{params:Promise.resolve({id:org.customerId})}));
    assert.equal(replaced.status,200,JSON.stringify(await replaced.json()));
    assert.deepEqual((await db.execute<{subsidiary_id:string}>(sql`select subsidiary_id from party_subsidiaries where party_id=${org.customerId}`)).rows.map(row=>row.subsidiary_id),[other]);
    const none=await loadParty(org.customerId,org.orgId,new Set());
    assert.equal(none?.transactionSummary.count,0);
    assert.deepEqual(none?.transactionSummary.currencies,[]);
    const unrestricted=await loadParty(org.customerId,org.orgId,null);
    assert.equal(unrestricted?.transactionSummary.count,2);
    assert.equal(unrestricted?.transactionSummary.currencies[0]?.total,'1000.0000');
    await db.execute(sql`update parties set subsidiary_id=${other} where id=${org.customerId}`);
    assert.equal(await loadParty(org.customerId,org.orgId,new Set([org.subsidiaryId])),null);

  }finally{session.user=null;await dropScratchOrg(org.orgId);}
});
