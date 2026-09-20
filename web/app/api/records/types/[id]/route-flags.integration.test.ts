import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __recordTypeFlagsSession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__recordTypeFlagsSession.user}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})

const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { GET, PATCH } = await import('./route')

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const patchRequest = (id: string, body: unknown) => new Request(`http://flags.local/api/records/types/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
async function openedRevision(id: string): Promise<string> {
  const opened = await GET(new Request(`http://flags.local/api/records/types/${id}`), params(id))
  assert.equal(opened.status, 200, await opened.clone().text())
  return ((await opened.json()) as { type: { updated_at: string } }).type.updated_at
}

test('record-type PATCH refuses a non-boolean showInNav instead of a storage 500', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Type flags', 'reviewer')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
    session.user = { id: actor, orgId: org.orgId, name: 'Type flags', email: 'type-flags@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
    const typeId = randomUUID()
    await db.execute(sql`insert into custom_record_types (id, org_id, key, name, plural_name) values (${typeId}, ${org.orgId}, 'flagtype', 'Flag type', 'Flag types')`)
    await withOrgContext(org.orgId, async () => {
      // 'off' would silently store false with a 200; 'maybe' throws 22P02.
      // Both must be a 4xx with no write.
      for (const body of [{ showInNav: 'off' }, { showInNav: 'maybe' }]) {
        const response = await PATCH(patchRequest(typeId, body), params(typeId))
        assert.ok(
          response.status === 400 || response.status === 422,
          `expected 4xx, got ${response.status}: ${JSON.stringify(await response.clone().json())}`,
        )
      }
      const stored = (await db.execute<{ show_in_nav: boolean }>(sql`select show_in_nav from custom_record_types where id=${typeId} and org_id=${org.orgId}`)).rows[0]
      assert.equal(stored?.show_in_nav, false, 'refused writes leave the stored flag unchanged')
      const ok = await PATCH(
        patchRequest(typeId, { showInNav: true, expectedUpdatedAt: await openedRevision(typeId) }),
        params(typeId),
      )
      assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()))
    })
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})
