import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Q13: the .qwc route refuses regions the Intuit Web Connector does not
// support (AU/NZ) by name instead of emitting a working-looking file, while
// US/CA/UK still generate.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __qwcRegionState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
const AUTHZ = `
  export function guardUnrestrictedScope(authz) { return authz.allowedSubsidiaryIds == null ? null : new Response(JSON.stringify({ error: "requires unrestricted subsidiary access" }), { status: 403 }) }
      export async function guardPermission() {
    const s = globalThis.__qwcRegionState;
    return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
  }
`
const TRANSLATIONS = `
  export async function getTranslations() {
    return (key) => key;
  }
`
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier.endsWith('/lib/authz')) return virtual(AUTHZ)
    if (specifier === 'next-intl/server') return virtual(TRANSLATIONS)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, schema, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { sql } = await import('drizzle-orm')
const { GET } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function connectionWithRegion(orgId: string, region: string): Promise<string> {
  const [connection] = await db.insert(schema.connections).values({
    orgId,
    source: 'qbd',
    displayName: `QBD region test ${region} ${Date.now()}`,
    authKind: 'token',
    status: 'active',
    config: { historyStartDate: '2024-01-01', region, baseCurrency: 'USD' },
    secrets: null,
  }).returning({ id: schema.connections.id })
  assert.ok(connection)
  return connection.id
}

test('the .qwc route refuses AU/NZ by name and still generates US/CA/UK', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = 'user-1'
  const ids: string[] = []
  try {
    for (const region of ['AU', 'NZ']) {
      const id = await connectionWithRegion(org.orgId, region)
      ids.push(id)
      const response = await withOrgContext(org.orgId, () =>
        GET(new Request('http://platform.test/api/platform/connections/x/qwc'), { params: Promise.resolve({ id }) }))
      assert.equal(response.status, 400)
      const body = await response.json() as { error?: string }
      assert.match(body.error ?? '', new RegExp(`QuickBooks Desktop ${region} editions are not supported by the Intuit Web Connector`))
    }
    for (const region of ['US', 'CA', 'UK']) {
      const id = await connectionWithRegion(org.orgId, region)
      ids.push(id)
      const response = await withOrgContext(org.orgId, () =>
        GET(new Request('http://platform.test/api/platform/connections/x/qwc'), { params: Promise.resolve({ id }) }))
      assert.equal(response.status, 200)
      const xml = await response.text()
      assert.match(xml, /<QBWCXML>/)
      assert.match(xml, new RegExp(`/api/qbd/web-connector/${id}`))
    }
  } finally {
    for (const id of ids) await db.execute(sql`delete from connections where id = ${id}`)
    await dropScratchOrg(org.orgId)
  }
})
