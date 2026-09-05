import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors } from '@openbooks/engine/src/test-fixtures.ts';
registerHooks({resolve(specifier,context,next) {
  if (specifier==='server-only') return {shortCircuit:true,url:'data:text/javascript,export {}'};
  return next(specifier,context);
}});
const {setupResource}=await import('./setup-resources');
const {SETUP_ENTITY_BY_KEY}=await import('../setup/registry');

for (const mode of ['insert','upsert'] as const) {
  test(`setup preview ${mode} sees prior rows in the same batch without persisting them`,
    {skip:!process.env.OPENBOOKS_DB_URL},async()=>{
      const org=await createScratchOrg();
      try {
        const actorId=(await seedFlowActors(org.orgId)).adminId;
        const resource=setupResource(SETUP_ENTITY_BY_KEY.get('departments')!,org.orgId);
        const ctx={orgId:org.orgId,actorId,dryRun:true};
        const rows=[{code:'SAME',name:'First'},{code:'SAME',name:'Second'}];
        const preview=await resource.write(rows,mode,ctx);
        assert.equal(preview.created,1);
        assert.equal(preview.updated,mode==='upsert'?1:0);
        assert.equal(preview.failed,mode==='insert'?1:0);
        assert.equal((await db.execute(sql`select id from departments where org_id=${org.orgId}`)).rows.length,0);
        assert.equal((await db.execute(sql`select id from audit_log where org_id=${org.orgId} and table_name='departments'`)).rows.length,0);
        assert.deepEqual(await resource.write(rows,mode,ctx),preview,'preview can be repeated without accumulating state');
        assert.deepEqual(await resource.write(rows,mode,{...ctx,dryRun:false}),preview);
      } finally {await dropScratchOrg(org.orgId);}
    });
}

test('setup preview evaluates storage checks and keeps successful mixed rows temporary',
  {skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const org=await createScratchOrg();
    try {
      const actorId=(await seedFlowActors(org.orgId)).adminId;
      const resource=setupResource(SETUP_ENTITY_BY_KEY.get('pay-components')!,org.orgId);
      const rows=[{code:'GOOD',name:'Good earning',kind:'earning'},
        {code:'INVALID',name:'Invalid protected earning',kind:'earning',protectionBase:'net_pay',protectionMaxPercent:'10'}];
      const preview=await resource.write(rows,'insert',{orgId:org.orgId,actorId,dryRun:true});
      assert.equal(preview.created,1);assert.equal(preview.failed,1);
      assert.equal((await db.execute(sql`select id from pay_components where org_id=${org.orgId}`)).rows.length,0);
      assert.equal((await db.execute(sql`select id from audit_log where org_id=${org.orgId} and table_name='pay_components'`)).rows.length,0);
      assert.deepEqual(await resource.write(rows,'insert',{orgId:org.orgId,actorId,dryRun:false}),preview);
    } finally {await dropScratchOrg(org.orgId);}
  });

test('setup preview rolls back only its savepoint inside the caller transaction',
  {skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const org=await createScratchOrg();
    try {
      const actorId=(await seedFlowActors(org.orgId)).adminId;
      const resource=setupResource(SETUP_ENTITY_BY_KEY.get('departments')!,org.orgId);
      await withOrgTransaction(org.orgId,async()=>{
        await db.execute(sql`insert into departments(org_id,code,name) values(${org.orgId},'BEFORE','Before preview')`);
        const outcome=await resource.write([{code:'TEMP',name:'Temporary'}],'insert',{orgId:org.orgId,actorId,dryRun:true});
        assert.equal(outcome.created,1);
        await db.execute(sql`insert into departments(org_id,code,name) values(${org.orgId},'AFTER','After preview')`);
      });
      assert.deepEqual((await db.execute(sql`select code from departments where org_id=${org.orgId} order by code`)).rows,[{code:'AFTER'},{code:'BEFORE'}]);
      assert.equal((await db.execute(sql`select id from audit_log where org_id=${org.orgId} and table_name='departments'`)).rows.length,0);
    } finally {await dropScratchOrg(org.orgId);}
  });

test('setup preview refuses unavailable audit evidence and leaves the outer transaction usable',
  {skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const org=await createScratchOrg();const name='preview_audit_'+randomUUID().replaceAll('-','');
    try {
      const actorId=(await seedFlowActors(org.orgId)).adminId;
      await db.execute(sql.raw(`create function ${name}() returns trigger language plpgsql as $$ begin if NEW.org_id='${org.orgId}'::uuid and NEW.table_name='departments' then raise exception 'preview audit unavailable'; end if; return NEW; end $$`));
      await db.execute(sql.raw(`create trigger ${name} before insert on audit_log for each row execute function ${name}()`));
      await withOrgTransaction(org.orgId,async()=>{
        const outcome=await setupResource(SETUP_ENTITY_BY_KEY.get('departments')!,org.orgId)
          .write([{code:'VETO',name:'Vetoed'}],'insert',{orgId:org.orgId,actorId,dryRun:true});
        assert.equal(outcome.created,0);assert.equal(outcome.failed,1);
        assert.match(outcome.errors[0]!.message,/preview audit unavailable/);
        await db.execute(sql`insert into departments(org_id,code,name) values(${org.orgId},'AFTER','Outer transaction remains valid')`);
      });
      assert.deepEqual((await db.execute(sql`select code from departments where org_id=${org.orgId}`)).rows,[{code:'AFTER'}]);
    } finally {
      await db.execute(sql.raw(`drop trigger if exists ${name} on audit_log`));
      await db.execute(sql.raw(`drop function if exists ${name}()`));await dropScratchOrg(org.orgId);
    }
  });
