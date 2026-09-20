import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../platform/db.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors } from '../testing/fixtures.ts';
import { assertPeriodModulesOpen, CloseError, decidePeriodReopen, recloseApprovedReopen, requestPeriodReopen, setPeriodLockState } from './close.ts';

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


test('reopen approval refuses a scope with no closed locks', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  const org=await createScratchOrg();
  try {
    const actors=await seedFlowActors(org.orgId);
    const target={orgId:org.orgId,periodId:org.periodId,bookId:org.bookId};
    // The period is fully open: a window here would arm a lock row that
    // blocks posting once its expiry passes, then re-closes an open period.
    const mistakenId=await requestPeriodReopen({...target,modules:['gl'],actorId:actors.adminId,reason:'Mistaken window on an open period'});
    await assert.rejects(
      decidePeriodReopen({orgId:org.orgId,requestId:mistakenId,actorId:actors.approver1Id,approve:true,hours:2}),
      /nothing to reopen/,
    );
    const locks=(await db.execute<{n:number}>(sql`select count(*)::int as n from period_locks where org_id=${org.orgId}`));
    assert.equal(locks.rows[0]!.n,0,'a refused reopen must arm no lock row');
    assert.equal((await db.execute<{status:string}>(sql`select status from close_reopen_requests where id=${mistakenId}`)).rows[0]!.status,'requested');

    // A request that mixes a closed module with an open one is refused the
    // same way: the open module's window would be pure time bomb. Narrowing
    // the request to the closed module still approves.
    await setPeriodLockState({...target,module:'ap',state:'closed',actorId:actors.adminId,reason:'AP closed'});
    const mixedId=await requestPeriodReopen({...target,modules:['ap','gl'],actorId:actors.adminId,reason:'AP correction plus unneeded GL'});
    await assert.rejects(
      decidePeriodReopen({orgId:org.orgId,requestId:mixedId,actorId:actors.approver1Id,approve:true,hours:2}),
      /nothing to reopen/,
    );
    const narrowId=await requestPeriodReopen({...target,modules:['ap'],actorId:actors.adminId,reason:'AP correction only'});
    await decidePeriodReopen({orgId:org.orgId,requestId:narrowId,actorId:actors.approver1Id,approve:true,hours:2});
    assert.equal((await db.execute<{status:string}>(sql`select status from close_reopen_requests where id=${narrowId}`)).rows[0]!.status,'approved');
  } finally { await dropScratchOrg(org.orgId); }
});

test('an org-wide reopen window covers subsidiary-scoped locks and re-closes them', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  const org=await createScratchOrg();
  try {
    const actors=await seedFlowActors(org.orgId);
    const target={orgId:org.orgId,periodId:org.periodId,bookId:org.bookId};
    // Post-tightening state: the subsidiary row and the org-wide row are
    // both closed. Storage prefers the exact row, so a window written only
    // to the org-wide row would silently leave this entity closed.
    await setPeriodLockState({...target,subsidiaryId:org.subsidiaryId,module:'gl',state:'closed',actorId:actors.adminId,reason:'Entity close'});
    await setPeriodLockState({...target,module:'gl',state:'closed',actorId:actors.adminId,reason:'Global close'});
    const requestId=await requestPeriodReopen({...target,modules:['gl'],actorId:actors.adminId,reason:'Global correction window'});
    await decidePeriodReopen({orgId:org.orgId,requestId,actorId:actors.approver1Id,approve:true,hours:2});
    await assertPeriodModulesOpen(db, {
      orgId:org.orgId,periodId:org.periodId,bookId:org.bookId,
      subsidiaryIds:[org.subsidiaryId],modules:['gl'],
    });
    // Ending the window must re-close the subsidiary row it relaxed: an
    // open child shadows the re-closed scope and keeps posting.
    await recloseApprovedReopen({orgId:org.orgId,requestId,actorId:actors.approver1Id,reason:'Correction work completed'});
    await assert.rejects(
      assertPeriodModulesOpen(db, {
        orgId:org.orgId,periodId:org.periodId,bookId:org.bookId,
        subsidiaryIds:[org.subsidiaryId],modules:['gl'],
      }),
      /GL is closed/,
    );
  } finally { await dropScratchOrg(org.orgId); }
});

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
