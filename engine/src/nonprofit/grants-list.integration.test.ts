import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db, withBypassContext, withOrgContext } from '../platform/db.ts';
import { createScratchOrg, createScratchUser, dropScratchOrg } from '../testing/fixtures.ts';
import { createGrant, listGrants, type GrantListItem } from './grants.ts';
import { provisionFundAccounting } from './provision.ts';

test('grant lists map populated pages and preserve counts for empty, filtered and past-end pages', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  let otherOrgId: string | undefined;
  try {
    const other = await withBypassContext(() => createScratchOrg());
    otherOrgId = other.orgId;
    for (const orgId of [org.orgId, other.orgId]) {
      await withOrgContext(orgId, async () => {
        const enabled = await db.execute(sql`update orgs set settings = jsonb_set(
          coalesce(settings, '{}'::jsonb), '{features}',
          coalesce(settings->'features', '{}'::jsonb) || '{"nonprofit":true,"fundAccounting":true,"grantManagement":true}'::jsonb, true)
          where id = ${orgId} returning id`);
        assert.equal(enabled.rows.length, 1, 'grant register fixture enables its organization features');
      });
    }
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, 'Grant Register Reader', 'grant-register-reader'));
    const { defaultFundId: fundId } = await provisionFundAccounting({
      orgId: org.orgId, actorId,
      defaultFund: { code: 'OPERATING', name: 'Operating Fund' },
      classifications: { OPERATING: { kind: 'operating', restrictionClass: 'unrestricted' } },
    });
    const groupId = await withOrgContext(org.orgId, async () => {
      const sponsor = await db.execute(sql`update parties set display_name = 'Community Foundation'
        where org_id = ${org.orgId} and id = ${org.customerId} returning id`);
      assert.equal(sponsor.rows.length, 1, 'grant register fixture names its sponsor');
      const group = await db.execute<{ id: string }>(sql`insert into account_groups
        (org_id, dimension, key, name, match, is_catch_all, is_active, created_by, updated_by)
        values (${org.orgId}, 'grant_allowable_costs', 'register-costs', 'Grant Register Costs', '{}'::jsonb, false, true, ${actorId}, ${actorId}) returning id`);
      assert.equal(group.rows.length, 1, 'grant register fixture creates its allowable account group');
      return group.rows[0]!.id;
    });
    const expected: GrantListItem[] = [];
    for (const code of ['Z-AWARD', 'A-AWARD']) {
      const grant = await createGrant({
        orgId: org.orgId, code, name: `${code} community program`, sponsorPartyId: org.customerId,
        sponsorKind: 'foundation', determination: 'contribution_unconditional', awardAmount: '1234.5678',
        periodFrom: '2026-01-01', periodTo: '2026-12-31', fundId, allowableAccountGroupId: groupId, actorId,
      });
      expected.push({ id: grant.id, code, name: `${code} community program`, sponsorName: 'Community Foundation',
        determination: 'contribution_unconditional', status: 'draft', awardAmount: '1234.5678',
        periodFrom: '2026-01-01', periodTo: '2026-12-31', fundCode: 'OPERATING', version: 1 });
    }
    expected.reverse();
    assert.deepEqual(await listGrants({ orgId: org.orgId }), { items: expected, total: 2 });
    assert.deepEqual(await listGrants({ orgId: org.orgId, limit: 1 }), { items: [expected[0]], total: 2 });
    assert.deepEqual(await listGrants({ orgId: org.orgId, limit: 1, offset: 1 }), { items: [expected[1]], total: 2 });
    assert.deepEqual(await listGrants({ orgId: org.orgId, offset: 2 }), { items: [], total: 2 }, 'empty page preserves the filtered total');
    assert.deepEqual(await listGrants({ orgId: org.orgId, q: 'A-AWARD', fundId, status: ['draft'] }), { items: [expected[0]], total: 1 });
    assert.deepEqual(await listGrants({ orgId: org.orgId, q: 'unmatched' }), { items: [], total: 0 });
    assert.deepEqual(await listGrants({ orgId: org.orgId, fundId: randomUUID() }), { items: [], total: 0 });
    assert.deepEqual(await listGrants({ orgId: other.orgId }), { items: [], total: 0 }, 'empty foreign organization receives no fabricated or cross-tenant grant');
  } finally {
    try { if (otherOrgId) await dropScratchOrg(otherOrgId); }
    finally { await dropScratchOrg(org.orgId); }
  }
});
