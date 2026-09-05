import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from './db.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors } from './test-fixtures.ts';
import { CloseError, decidePeriodReopen, requestPeriodReopen, setPeriodLockState } from './close.ts';

for (const order of ['global first','entity first','race','separate entities'] as const) {
  test(`reopen approvals refuse intersecting global/entity scopes: ${order}`, {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
    const org=await createScratchOrg();
    try {
      const actors=await seedFlowActors(org.orgId);
      const target={orgId:org.orgId,periodId:org.periodId,bookId:org.bookId};
      await setPeriodLockState({...target,module:'gl',state:'closed',actorId:actors.adminId,reason:'Close for review'});
      const other = randomUUID();
      if (order === 'separate entities') await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${other},${org.orgId},${org.subsidiaryId},'Second entity','CAD','CA')`);
      const ids=[];
      const scopes = order === 'separate entities' ? [org.subsidiaryId,other] : order === 'entity first' ? [org.subsidiaryId,undefined] : [undefined,org.subsidiaryId];
      for (const subsidiaryId of scopes) {
        ids.push(await requestPeriodReopen({...target,subsidiaryId,modules:['gl'],actorId:actors.adminId,reason:'Approved correction work'}));
      }
      const approve = (id:string) => decidePeriodReopen({orgId:org.orgId,requestId:id,actorId:actors.approver1Id,approve:true,hours:2});
      if (order === 'race' || order === 'separate entities') {
        const results = await Promise.allSettled(ids.map(approve));
        assert.equal(results.filter(r=>r.status==='fulfilled').length,order === 'race' ? 1 : 2);
        if (order === 'race') assert.ok(results.some(r=>r.status==='rejected' && r.reason instanceof CloseError));
      } else {
        await approve(ids[0]!);
        await assert.rejects(approve(ids[1]!),CloseError);
      }
      const statuses=(await db.execute<{status:string}>(sql`select status from close_reopen_requests where org_id=${org.orgId} order by created_at,id`)).rows.map(r=>r.status).sort();
      assert.deepEqual(statuses,order === 'separate entities' ? ['approved','approved'] : ['approved','requested']);
    } finally { await dropScratchOrg(org.orgId); }
  });
}


test('subledger reopening respects the inherited global GL close', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  const org=await createScratchOrg();
  try {
    const actors=await seedFlowActors(org.orgId);
    const target={orgId:org.orgId,periodId:org.periodId,bookId:org.bookId};
    await setPeriodLockState({...target,module:'gl',state:'closed',actorId:actors.adminId,reason:'Close for review'});
    const requestId=await requestPeriodReopen({...target,subsidiaryId:org.subsidiaryId,modules:['ap'],actorId:actors.adminId,reason:'AP correction without GL'});
    await assert.rejects(decidePeriodReopen({orgId:org.orgId,requestId,actorId:actors.approver1Id,approve:true,hours:2}),/GL must be included/);
    assert.equal((await db.execute<{status:string}>(sql`select status from close_reopen_requests where org_id=${org.orgId} and id=${requestId}`)).rows[0]!.status,'requested');
  } finally { await dropScratchOrg(org.orgId); }
});
