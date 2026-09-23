import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, _context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier)
  },
})

const { sql } = await import('drizzle-orm')
const { db, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createSetupRecord } = await import('./write.ts')
const { SETUP_ENTITY_BY_KEY } = await import('./registry.ts')

// OM-18: an empty org configures its reason codes through the rehomed
// setup section on /hrm/change-requests (?reasons=1&row=new). The drawer
// opens only if the generic setup writer accepts the entity — this pins
// the entity descriptor the drawer renders and proves a created code
// persists and lists through that same writer.
test('hrm-action-reasons declares the drawer fields the rehomed section renders', () => {
  const entity = SETUP_ENTITY_BY_KEY.get('hrm-action-reasons')
  assert.ok(entity, 'hrm-action-reasons is a registered setup entity')
  assert.deepEqual(
    entity.fields.map((f) => f.key),
    ['action', 'reasonCode', 'label', 'requiresComment', 'isActive'],
    'the drawer edits Action, Reason code, Label, Requires comment, Active',
  )
  assert.equal(entity.rehomed, true, 'reasons configure where changes are proposed, never on the setup rail')
})

async function seedOrg(): Promise<{ orgId: string; actorId: string }> {
  // The child gate never stands alone: hrmActionReasons requires its hrm
  // parent (feature-gate hierarchy), so the seed enables both — exactly
  // what the Features switchboard enforces.
  const org = await withBypass(() => createScratchOrg())
  const actorId = await withBypass(() => createScratchUser(org.orgId, 'Setup Admin', 'admin'))
  await withBypass(() => db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"hrm": true, "hrmActionReasons": true}'::jsonb)
     where id = ${org.orgId}`))
  return { orgId: org.orgId, actorId }
}

function actor(orgId: string, actorId: string) {
  return { orgId, id: actorId, permissions: ['admin.setup.manage'] }
}

test('a reason code created through the setup writer persists and lists', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId, actorId } = await seedOrg()
  try {
    const created = await withBypass(() => createSetupRecord(actor(orgId, actorId), 'hrm-action-reasons', {
      action: 'promotion',
      reasonCode: 'MERIT',
      label: 'Merit increase',
      requiresComment: false,
    }))
    assert.equal(created.status, 200, `the write is accepted, not refused: ${JSON.stringify(created.body)}`)
    const rows = (await withBypass(() => db.execute<{
      action: string; reason_code: string; label: string; requires_comment: boolean; is_active: boolean
    }>(sql`
      select action, reason_code, label, requires_comment, is_active
        from hrm_action_reasons where org_id = ${orgId}`))).rows
    assert.equal(rows.length, 1, 'the code persists')
    assert.deepEqual(
      rows[0],
      { action: 'promotion', reason_code: 'MERIT', label: 'Merit increase', requires_comment: false, is_active: true },
      'the stored row carries exactly what the drawer submitted (active by default)',
    )
  } finally {
    await withBypass(() => dropScratchOrg(orgId))
  }
})
