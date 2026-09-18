import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../auth'

const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __partyScope: state })
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__partyScope.user}' }
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2)
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(new URL(path + suffix))) return nextResolve(path + suffix, context)
    return nextResolve(path, context)
  }
  return nextResolve(specifier, context)
} })

const { sql } = await import('drizzle-orm')
const { db, env, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { getAuthz } = await import('../authz')
const { executeAssistantTool } = await import('./registry')

test('find_parties hides parties assigned to an inaccessible subsidiary', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Party scope prober', 'party_scope_prober'))
  const hidden = randomUUID()
  const visibleParty = randomUUID()
  const hiddenParty = randomUUID()
  await withBypassContext(() => db.execute(sql`update app_roles
    set permissions=${JSON.stringify(['parties.read', 'assistant.use'])}::jsonb,
        subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb
    where org_id=${org.orgId} and key='party_scope_prober'`))
  await withBypassContext(() => db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
    values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden Party Branch','CAD','CA')`))
  await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active)
    values (${visibleParty},${org.orgId},'customer','Visible Party',${org.subsidiaryId},true),
           (${hiddenParty},${org.orgId},'customer','Hidden Party',${hidden},true)`))
  state.user = {
    id: actor,
    orgId: org.orgId,
    name: 'Party scope prober',
    email: 'party-scope@scratch.test',
    roles: [],
    isSuperAdmin: false,
    envKind: 'production',
    productionOrgId: org.orgId,
    homeOrgId: org.orgId,
    homeUserId: actor,
  }
  try {
    await withOrgContext(org.orgId, async () => {
      const authz = await getAuthz()
      assert.ok(authz)
      const result = await executeAssistantTool(authz, 'find_parties', { query: 'Party' })
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.ok(result.ok)
      const names = (result.data as { items: { displayName: string }[] }).items
        .map((item) => item.displayName)
      assert.deepEqual(names, ['Visible Party'])
    })
  } finally {
    state.user = null
    await dropScratchOrg(org.orgId)
  }
})
