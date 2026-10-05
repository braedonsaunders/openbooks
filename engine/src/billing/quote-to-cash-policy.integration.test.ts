import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db, withBypassContext, withOrgContext } from '../platform/db.ts';
import { createScratchOrg, createScratchUser, dropScratchOrg } from '../testing/fixtures.ts';
import { clearQuoteToCashSettings, saveQuoteToCashSettings } from './quote-to-cash.ts';

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

test('quote policy creation, replacement and reset preserve all six before/after fields and actor', DB, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Policy administrator', 'admin'));
    const template = randomUUID();
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`update orgs set settings=settings || '{"features":{"quoteToCash":true,"subscriptionBilling":true,"advancedSubscriptions":true,"orders":true}}'::jsonb where id=${org.orgId}`);
      await db.execute(sql`insert into pdf_templates (id,org_id,record_type,name,created_by) values (${template},${org.orgId},'quote','Signed order form',${actor})`);
    });
    const first = { maxDiscountPercent: '12.50', autoActivateOnSign: true, defaultBillingTiming: 'arrears' as const, defaultStartRule: 'first_of_next_month' as const, signatureExpiryDays: 30, orderFormTemplateId: template };
    const second = { maxDiscountPercent: '5', autoActivateOnSign: false, defaultBillingTiming: 'advance' as const, defaultStartRule: 'quote_date' as const, signatureExpiryDays: 7, orderFormTemplateId: null };
    await saveQuoteToCashSettings(org.orgId, actor, first);
    await saveQuoteToCashSettings(org.orgId, actor, second);
    await clearQuoteToCashSettings(org.orgId, actor);
    const evidence = await withOrgContext(org.orgId, () => db.execute<{ action: string; actor_id: string; at: string; changes: { before: unknown; after: unknown; reason?: string } }>(sql`
      select action, actor_id, at::text, changes from audit_log where org_id=${org.orgId} and table_name='quote_to_cash_settings' order by at,id`));
    assert.equal(evidence.rows.length, 3);
    const storedFirst = { ...first, maxDiscountPercent: '12.5000' };
    const storedSecond = { ...second, maxDiscountPercent: '5.0000' };
    assert.deepEqual(evidence.rows.map(r => r.action), ['insert','update','delete']);
    assert.deepEqual(evidence.rows.map(r => r.changes.before), [null, storedFirst, storedSecond]);
    assert.deepEqual(evidence.rows.map(r => r.changes.after), [storedFirst, storedSecond, { maxDiscountPercent: '10', autoActivateOnSign: false, defaultBillingTiming: 'advance', defaultStartRule: 'quote_date', signatureExpiryDays: 14, orderFormTemplateId: null }]);
    assert.ok(evidence.rows.every(r => r.actor_id === actor && r.at));
    assert.equal(evidence.rows[2]!.changes.reason, 'Reset to defaults');
    await assert.rejects(() => clearQuoteToCashSettings(org.orgId, actor), /No quote-to-cash policy is saved/);
    const count = await withOrgContext(org.orgId, () => db.execute<{ n: number }>(sql`select count(*)::int n from audit_log where org_id=${org.orgId} and table_name='quote_to_cash_settings'`));
    assert.equal(count.rows[0]!.n, 3, 'refused reset cannot report a second successful deletion');
  } finally { await dropScratchOrg(org.orgId); }
});

test('concurrent quote policy writes retain a complete ordered audit chain', DB, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Policy administrator', 'admin'));
    await withOrgContext(org.orgId, () => db.execute(sql`update orgs set settings=settings || '{"features":{"quoteToCash":true,"subscriptionBilling":true,"orders":true}}'::jsonb where id=${org.orgId}`));
    await Promise.all([20,30,40].map(n => saveQuoteToCashSettings(org.orgId, actor, { maxDiscountPercent: String(n), autoActivateOnSign: false, defaultBillingTiming: 'advance', defaultStartRule: 'quote_date', signatureExpiryDays: n })));
    const rows = (await withOrgContext(org.orgId, () => db.execute<{ changes: { before: unknown; after: unknown } }>(sql`select changes from audit_log where org_id=${org.orgId} and table_name='quote_to_cash_settings' order by at,id`))).rows;
    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.changes.before, null);
    assert.deepEqual(rows[1]!.changes.before, rows[0]!.changes.after);
    assert.deepEqual(rows[2]!.changes.before, rows[1]!.changes.after);
  } finally { await dropScratchOrg(org.orgId); }
});
