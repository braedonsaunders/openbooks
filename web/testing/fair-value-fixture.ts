import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { db, withOrgContext } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from '@openbooks/engine/src/testing/fixtures.ts'
import { resolveAuthzByUserId } from '../lib/authz-core.ts'
import { withAuthzContext } from '../lib/authz-context.ts'

/** Native item, active actor and explicit grants for dated selling-price commands. */
export async function createFairValueFixture() {
  const org = await createScratchOrg()
  try {
    return await withOrgContext(org.orgId, async () => {
      const actorId = await createScratchUser(org.orgId, 'Selling Price Editor', 'selling-price-editor')
      assert.equal((await db.execute(sql`
        insert into user_permission_overrides (org_id, user_id, permission, effect)
        values (${org.orgId}, ${actorId}, 'items.read', 'grant'),
               (${org.orgId}, ${actorId}, 'items.manage', 'grant') returning id`)).rows.length, 2)
      assert.equal((await db.execute(sql`
        update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
          coalesce(settings->'features', '{}'::jsonb) || '{"revenueRecognition":true}'::jsonb, true)
        where id = ${org.orgId} returning id`)).rows.length, 1)
      const itemId = (await db.execute<{ id: string }>(sql`
        insert into items (org_id, kind, name, is_active)
        values (${org.orgId}, 'service', 'Fair Value Item', true) returning id`)).rows[0]!.id
      return { org, actorId, itemId }
    })
  } catch (error) {
    await dropScratchOrgReporting(org.orgId)
    throw error
  }
}

export async function callFairValueRoute(
  fixture: Awaited<ReturnType<typeof createFairValueFixture>>,
  method: 'POST' | 'PATCH' | 'DELETE', id: string, body?: unknown, rowId?: string,
): Promise<{ status: number; json: unknown }> {
  return withOrgContext(fixture.org.orgId, async () => {
    const authz = await resolveAuthzByUserId(fixture.org.orgId, fixture.actorId)
    assert.ok(authz, 'the request actor is active and resolves through native authorization')
    const routes = await import('../app/api/items/[id]/fair-values/route.ts')
    const request = new Request(`http://fv.test/api/items/${id}/fair-values${rowId ? `?id=${rowId}` : ''}`, {
      method, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const response = await withAuthzContext(authz, () => routes[method](request, { params: Promise.resolve({ id }) }))
    if (!response.ok) return { status: response.status, json: await response.json() }
    return { status: response.status, json: await response.json() }
  })
}
