import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { db } from '../platform/db.ts';
import { registerQueryObserver } from '../platform/query-observer.ts';
import { assertDedicatedFixtureDatabase } from '../testing/fixtures.ts';
import { DB, setupHarness, withHarness, seedNamedWorker } from '../testing/hrm-harness.ts';
import { createQualificationType } from '../hrm/qualifications/types.ts';
import { recordQualification, verifyQualification } from '../hrm/qualifications/qualifications.ts';
import { countInbox, listInbox } from './registry.ts';
import './index.ts';

test('qualification badges count the complete personal population without loading the bounded alert rows', { skip: !DB }, async () => {
  await assertDedicatedFixtureDatabase();
  await withHarness(() => setupHarness({
    features: ['hrm', 'hrmCertifications'],
    users: [{ key: 'actorId', name: 'Qualification holder', handle: 'qualification_holder',
      permissions: ['hrm.certifications.read', 'hrm.certifications.manage'] }],
  }), async h => {
    const own = await seedNamedWorker(h.org.orgId, h.org.subsidiaryId, 'Qualification holder');
    const other = await seedNamedWorker(h.org.orgId, h.org.subsidiaryId, 'Another holder');
    const linked = await db.execute(sql`update users set party_id=${own.partyId}
      where org_id=${h.org.orgId} and id=${h.actorId} returning id`);
    assert.equal(linked.rows.length, 1);
    const record = async (index: number, options: { employmentId?: string; expiresOn?: string | null; verified?: boolean } = {}) => {
      const type = await createQualificationType(db, { orgId: h.org.orgId, actorId: h.actorId,
        code: `CERT-${index}`, name: `Credential ${index}`, category: 'certification',
        validityMonths: null, requiresEvidence: false, renewalLeadDays: 30 });
      const qualification = await recordQualification(db, { orgId: h.org.orgId, actorId: h.actorId,
        employmentId: options.employmentId ?? own.employmentId, typeId: type.id,
        issuedOn: '2026-09-01', expiresOn: options.expiresOn === undefined ? '2026-10-20' : options.expiresOn,
        expiryPolicy: 'explicit' });
      if (options.verified !== false) await verifyQualification(db, { orgId: h.org.orgId, actorId: h.actorId,
        qualificationId: qualification.id, reason: 'Evidence reviewed' });
    };
    for (let index = 0; index < 25; index++) await record(index);
    await record(25, { expiresOn: '2026-11-08' });
    await record(26, { expiresOn: null });
    await record(27, { verified: false });
    await record(28, { employmentId: other.employmentId });
    const ctx = { orgId: h.org.orgId, actorId: h.actorId, asOf: '2026-10-08' };
    const before = (await db.execute(sql`select id,status,expires_on from hrm_worker_qualifications
      where org_id=${h.org.orgId} order by id`)).rows;
    assert.equal(before.length, 29);
    const listed = await listInbox(ctx, { kinds: ['hrm_qualification_alert'] });
    assert.equal(listed.length, 20);
    assert.equal(new Set(listed.map(item => item.source.id)).size, 20);
    const statements: string[] = [];
    const close = registerQueryObserver(statement => statements.push(statement));
    try {
      assert.equal(await countInbox(ctx, { kinds: ['hrm_qualification_alert'] }), 25);
    } finally { close(); }
    assert.equal(statements.filter(statement => /select count\(\*\)::int as n/.test(statement)).length, 1);
    assert.equal(statements.some(statement => statement.includes('select q.id::text as id')), false);
    assert.equal(await countInbox({ ...ctx, asOf: '2026-10-09' }, { kinds: ['hrm_qualification_alert'] }), 26,
      'each read uses its fresh date, including the exact 30-day boundary');
    await withHarness(() => setupHarness({
      features: ['hrm', 'hrmCertifications'],
      users: [{ key: 'actorId', name: 'Separate holder', handle: 'separate_holder',
        permissions: ['hrm.certifications.read', 'hrm.certifications.manage'] }],
    }), async foreign => {
      const worker = await seedNamedWorker(foreign.org.orgId, foreign.org.subsidiaryId, 'Separate holder');
      const linkedForeign = await db.execute(sql`update users set party_id=${worker.partyId}
        where org_id=${foreign.org.orgId} and id=${foreign.actorId} returning id`);
      assert.equal(linkedForeign.rows.length, 1);
      const type = await createQualificationType(db, { orgId: foreign.org.orgId, actorId: foreign.actorId,
        code: 'CERT-0', name: 'Credential 0', category: 'certification', validityMonths: null,
        requiresEvidence: false, renewalLeadDays: 30 });
      const qualification = await recordQualification(db, { orgId: foreign.org.orgId, actorId: foreign.actorId,
        employmentId: worker.employmentId, typeId: type.id, issuedOn: '2026-09-01',
        expiresOn: '2026-10-20', expiryPolicy: 'explicit' });
      await verifyQualification(db, { orgId: foreign.org.orgId, actorId: foreign.actorId,
        qualificationId: qualification.id, reason: 'Evidence reviewed' });
      assert.equal(await countInbox({ ...ctx, orgId: foreign.org.orgId, actorId: foreign.actorId },
        { kinds: ['hrm_qualification_alert'] }), 1);
      assert.equal(await countInbox({ ...ctx, orgId: foreign.org.orgId }, { kinds: ['hrm_qualification_alert'] }), 0);
      assert.equal(await countInbox(ctx, { kinds: ['hrm_qualification_alert'] }), 25);
    });
    const disabled = await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,hrm}','false'::jsonb)
      where id=${h.org.orgId} returning id`);
    assert.equal(disabled.rows.length, 1);
    assert.equal(await countInbox(ctx, { kinds: ['hrm_qualification_alert'] }), 0);
    assert.deepEqual((await db.execute(sql`select id,status,expires_on from hrm_worker_qualifications
      where org_id=${h.org.orgId} order by id`)).rows, before,
      'read and feature changes preserve the qualification ledger');
  });
});
