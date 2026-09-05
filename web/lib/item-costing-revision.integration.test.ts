import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { SessionUser } from './auth';
const root = pathToFileURL(process.cwd() + "/").href;
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __costingRevisionSession: session });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__costingRevisionSession.user}' };
  if (specifier.startsWith('@/')) return next(root+'web/'+specifier.slice(2)+'.ts',context);
  return next(specifier,context);
}});
const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { GET, PUT } = await import("../app/api/items/[id]/costing/route");
for (const operation of ['read', 'stale', 'current', 'missing', 'null-existing', 'create-race', 'invalid-basis', 'invalid-boolean', 'invalid-account', 'scope-empty', 'scope-visible', 'scope-all']) {
  test(`item costing revision: ${operation}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, 'Inventory controller', 'reviewer');
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`);
      session.user = {id:actor,orgId:org.orgId,name:'Inventory controller',email:'costing@scratch.test',roles:[],isSuperAdmin:false,envKind:'production',productionOrgId:org.orgId,homeOrgId:org.orgId,homeUserId:actor};
      const scoped = operation.startsWith('scope-');
      const id = scoped ? org.items.standard : org.items.fifo;
      if (scoped) {
        const { receiveInventory } = await import('@openbooks/engine/src/inventory.ts');
        await receiveInventory(org.orgId,actor,{itemId:id,stockLocationId:org.stockLocationId,quantity:'5',unitCost:'2',subsidiaryId:org.subsidiaryId,offsetAccountId:org.accounts.clearing,date:org.date});
        if(operation!=='scope-all') await db.execute(sql`update app_roles set subsidiary_restriction=${JSON.stringify({mode:'list',subsidiaryIds:operation==='scope-visible'?[org.subsidiaryId]:[]})}::jsonb where org_id=${org.orgId} and key='reviewer'`);
      }
      const params = {params:Promise.resolve({id})};
      const url = 'http://audit.local/api/items/'+id+'/costing';
      await db.execute(sql`update item_inventory_profiles set updated_at=date_trunc('second',now()+interval '1 day')+interval '123450 microseconds' where item_id=${id}`);
      const response = await withOrgContext(org.orgId,()=>GET(new Request(url),params));
      assert.equal(response.status,200);
      const {profile} = await response.json();
      if (operation==='read') { assert.match(profile.updated_at,/\.\d{6}Z$/); return; }
      const body: Record<string,unknown> = {
        costingMethod:'fifo',tracking:'none',assetAccountId:org.accounts.invAsset,
        cogsAccountId:org.accounts.cogs,adjustmentAccountId:org.accounts.adjustment,
        varianceAccountId:org.accounts.adjustment,receivedNotBilledAccountId:org.accounts.clearing,
        baseUnit:'ea',allowNegativeInventory:false,negativeCostBasis:'last_receipt',
        expectedUpdatedAt:profile.updated_at,
      };
      if(operation==='stale') await db.execute(sql`update item_inventory_profiles set base_unit='case',updated_at=updated_at+interval '1 microsecond' where item_id=${id}`);
      if(operation==='missing') delete body.expectedUpdatedAt;
      if(operation==='null-existing'||operation==='create-race') body.expectedUpdatedAt=null;
      if(operation==='invalid-basis') body.negativeCostBasis='typo';
      if(operation==='invalid-boolean') body.allowNegativeInventory='true';
      if(operation==='invalid-account') body.adjustmentAccountId='not-an-account';
      if(scoped) { body.costingMethod='standard'; body.standardCost='3'; }
      const { withSimClock } = await import('@openbooks/engine/src/clock.ts');
      const put=()=>withSimClock(org.date,()=>withOrgContext(org.orgId,()=>PUT(new Request(url,{method:'PUT',body:JSON.stringify(body)}),params)));
      if(operation==='create-race') {
        await db.execute(sql`delete from item_inventory_profiles where item_id=${id}`);
        const responses=await Promise.all([put(),put()]);
        assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
      } else {
        const saved=await put();
        const result=await saved.json();
        assert.equal(saved.status,['current','scope-visible','scope-all'].includes(operation)?200:operation.startsWith('invalid')||operation==='scope-empty'?422:409,JSON.stringify(result));
        if(operation==='current') {
          assert.match(result.updatedAt,/\.\d{6}Z$/);
          assert.ok(result.updatedAt>profile.updated_at,'revision must advance even if transaction time precedes stored revision');
          assert.equal((await put()).status,409,'accepted token cannot be reused');
        }
      }
      const audits=(await db.execute<{n:number}>(sql`select count(*)::int as n from audit_log where org_id=${org.orgId} and table_name='item_inventory_profiles' and row_id=${id}`)).rows[0]!.n;
      assert.equal(audits,['current','create-race','scope-visible','scope-all'].includes(operation)?1:0);
      if(scoped) assert.deepEqual((await db.execute(sql`select unit_cost from cost_layers where item_id=${id}`)).rows.map(row=>row.unit_cost),[operation==='scope-empty'?'2.0000':'3.0000']);
      if(operation==='stale') assert.equal((await db.execute(sql`select base_unit from item_inventory_profiles where item_id=${id}`)).rows[0]?.base_unit,'case');
    } finally { session.user=null; await dropScratchOrg(org.orgId); }
  });
}
