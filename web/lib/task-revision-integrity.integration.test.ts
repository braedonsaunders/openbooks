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
const { db, withOrg } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { createWorkBreakdownTask, loadWorkBreakdownTasks, updateWorkBreakdownTask } = await import('./project-work-breakdown');
const { parseExpectedTaskVersion } = await import('./project-work-breakdown-validation');
const { randomUUID } = await import('node:crypto');
for (const operation of ['read', 'stale', 'repeat']) {
  test(`project task revision ${operation}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId,'Project administrator','reviewer');
      const projectId = randomUUID();
      await db.execute(sql`insert into projects (id,org_id,subsidiary_id,name,code) values (${projectId},${org.orgId},${org.subsidiaryId},'Revision project',${projectId})`);
      const input = {code:null,name:'First',status:'open' as const,estimatedHours:'10',estimatedCost:'100'};
      const args = {orgId:org.orgId,projectId,actorId:actor,allowedSubsidiaryIds:null,input};
      await withOrg(org.orgId,async()=>{
        const task = await createWorkBreakdownTask(args);
        if(operation!=='repeat') await db.execute(sql`update project_tasks set updated_at=date_trunc('second',now()+interval '1 day')+interval '123450 microseconds' where id=${task.id}`);
        const listed = (await loadWorkBreakdownTasks(org.orgId,projectId,null))[0]!;
        const version = parseExpectedTaskVersion(listed.updatedAt);
        if(operation==='read') {assert.match(version,/\.\d{6}Z$/);return;}
        if(operation==='stale') {
          await db.execute(sql`update project_tasks set name='Concurrent task',updated_at=updated_at+interval '1 microsecond' where id=${task.id}`);
          await assert.rejects(updateWorkBreakdownTask({...args,taskId:task.id,expectedUpdatedAt:version,input:{...input,name:'Stale task'}}),/changed after you opened/);
        } else {
          const saved = await updateWorkBreakdownTask({...args,taskId:task.id,expectedUpdatedAt:version,input:{...input,name:'Second'}});
          assert.notEqual(saved.updatedAt,version,'each committed task edit needs a new token');
          await assert.rejects(updateWorkBreakdownTask({...args,taskId:task.id,expectedUpdatedAt:version}),/changed after you opened/);
        }
      });
    } finally { await dropScratchOrg(org.orgId); }
  });
}

test('independent task editors do not upgrade their shared project locks', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org=await createScratchOrg();
  let go=()=>{};
  let edits:Promise<unknown>[]=[];
  try {
    const actor=await createScratchUser(org.orgId,'Project administrator','reviewer');
    const projectId=randomUUID();
    await db.execute(sql`insert into projects (id,org_id,subsidiary_id,name,code) values (${projectId},${org.orgId},${org.subsidiaryId},'Revision project',${projectId})`);
    const input={code:null,name:'First',status:'open' as const,estimatedHours:'10',estimatedCost:'100'};
    const args={orgId:org.orgId,projectId,actorId:actor,allowedSubsidiaryIds:null,input};
    const tasks=[await createWorkBreakdownTask(args),await createWorkBreakdownTask(args)];
    let ready=()=>{},n=0;
    const both=new Promise<void>(r=>{ready=r});
    const start=new Promise<void>(r=>{go=r});
    edits=tasks.map(task=>withOrg(org.orgId,async()=>{
      await db.execute(sql`select id from projects where id=${projectId} for share`);
      if(++n===2)ready();
      await start;
      return updateWorkBreakdownTask({...args,taskId:task.id,expectedUpdatedAt:task.updatedAt,input:{...input,name:'Independent edit'}});
    }));
    await Promise.race([both,Promise.all(edits)]);go();
    const outcomes=await Promise.allSettled(edits);
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,2,JSON.stringify(outcomes));
  }finally{go();await Promise.allSettled(edits);await dropScratchOrg(org.orgId);}
});
