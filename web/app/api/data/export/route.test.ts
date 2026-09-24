import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import {
  subsidiaryReadFilter,
  subsidiaryReadFilterWithUnassigned,
} from '../../../../lib/data-io/subsidiary-scope.ts'

// The generic export binds the caller's subsidiary fence before any resource
// read: without it a restricted reader exports another subsidiary's rows.
// This drives the real route, real registry, and real storage against a
// scratch org with two same-named customers in different legal entities —
// only the session boundary is stubbed.

const DB = Boolean(process.env.OPENBOOKS_DB_URL)

const stateKey = Symbol.for('openbooks.data-export-scope-test')
const state: {
  authz: {
    user: { id: string; orgId: string }
    permissions: Set<string>
    allowedSubsidiaryIds: Set<string> | null
  } | null
} = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const permissionsUrl = new URL('../../../../lib/permissions.ts', import.meta.url).href
const subsidiaryScopeUrl = new URL(
  '../../../../../engine/src/organization/subsidiary-scope.ts',
  import.meta.url,
).href
const jsonUrl = new URL('../../../../lib/api/json.ts', import.meta.url).href

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    }
    if (specifier === '@/lib/authz' || /(^|\/)lib\/authz$/.test(specifier)) {
      return { shortCircuit: true, url: 'mock:data-export-authz' }
    }
    if (specifier === '@/lib/api/json') {
      return nextResolve(jsonUrl, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:data-export-authz') {
      return {
        shortCircuit: true,
        format: 'module',
        source: `import { permissionSetCovers } from '${permissionsUrl}'
          import { subsidiaryScopeAllows } from '${subsidiaryScopeUrl}'
          const state = globalThis[Symbol.for('openbooks.data-export-scope-test')]
          export function can(authz, permission) { return permissionSetCovers(authz.permissions, permission) }
          export { subsidiaryScopeAllows }
          export async function getAuthz() { return state.authz }
          export async function guardPermission(permission) {
            const authz = state.authz
            if (!authz) return Response.json({ error: 'unauthorized' }, { status: 401 })
            if (!permissionSetCovers(authz.permissions, permission)) {
              return Response.json({ error: \`missing permission: \${permission}\` }, { status: 403 })
            }
            return authz
          }`,
      }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?data-export-scope'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)

function gate(orgId: string, userId: string, permissions: string[], allowedSubsidiaryIds: Set<string> | null) {
  state.authz = { user: { id: userId, orgId }, permissions: new Set(permissions), allowedSubsidiaryIds }
}

function postRequest(body: unknown): Request {
  return new Request('http://openbooks.test/api/data/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('a subsidiary-scoped export never carries another subsidiary’s rows', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  try {
    const subB = randomUUID()
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`)
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, short_code, email, subsidiary_id, is_active, custom)
      values (${randomUUID()}, ${org.orgId}, 'customer', 'Acme', null, 'a@example.com', ${org.subsidiaryId}, true, '{}'::jsonb),
             (${randomUUID()}, ${org.orgId}, 'customer', 'Acme', null, 'b@example.com', ${subB}, true, '{}'::jsonb)`)
    gate(org.orgId, randomUUID(), ['data.export', 'parties.read'], new Set([org.subsidiaryId]))

    const response = await POST(postRequest({ resource: 'parties', format: 'json' }))

    assert.equal(response.status, 200)
    const body = (await response.json()) as Array<{ email?: string }>
    const emails = body.map((row) => row.email)
    // The scratch org seeds its own parties: assert the scope property, not
    // the exact set — the in-scope row is present, the other entity's is not.
    assert.ok(emails.includes('a@example.com'), JSON.stringify(emails))
    assert.ok(!emails.includes('b@example.com'), JSON.stringify(emails))
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
})

test('an unknown resource is a 404 and a missing read grant is a 403', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  try {
    gate(org.orgId, randomUUID(), ['data.export', 'parties.read'], null)

    const unknown = await POST(postRequest({ resource: 'nope', format: 'json' }))
    assert.equal(unknown.status, 404)
    assert.deepEqual(await unknown.json(), { error: 'unknown resource' })

    gate(org.orgId, randomUUID(), ['data.export'], null)
    const forbidden = await POST(postRequest({ resource: 'parties', format: 'json' }))
    assert.equal(forbidden.status, 403)
    assert.deepEqual(await forbidden.json(), { error: 'forbidden' })
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
})

// Render a drizzle SQL fragment to its inline text: strings verbatim,
// nested fragments recursively, bound params by value.
function renderChunks(node: unknown): string {
  const chunks = (node as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk
      if (chunk && typeof chunk === 'object' && 'value' in chunk) {
        return String((chunk as { value?: unknown }).value ?? '')
      }
      return renderChunks(chunk)
    })
    .join('')
}

test('unrestricted exports remain a pass-through while restricted scopes fail closed', () => {
  // Happy path: null is the explicit unrestricted sentinel; an empty
  // allow-list must become `and false`, never an unscoped query. This
  // exercises the real shared helper, not a copy of its source.
  assert.equal(renderChunks(subsidiaryReadFilter(sql`subsidiary_id`, null)), '')
  assert.equal(renderChunks(subsidiaryReadFilterWithUnassigned(sql`subsidiary_id`, undefined)), '')
  assert.match(
    renderChunks(subsidiaryReadFilter(sql`subsidiary_id`, new Set())),
    /and false/,
  )
  assert.match(
    renderChunks(subsidiaryReadFilterWithUnassigned(sql`subsidiary_id`, new Set())),
    /and false/,
  )
  assert.match(
    renderChunks(
      subsidiaryReadFilter(sql`subsidiary_id`, new Set(['00000000-0000-4000-8000-000000000001'])),
    ),
    /= any\(/,
  )
})
