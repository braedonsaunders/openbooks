import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// The /me loaders import server-only, Next navigation, and next-intl at
// module scope; stub those boundaries so the loader loads under plain
// node. Translations resolve to the identity with .has() false — the
// refusal path maps no rows, so no catalog copy is needed.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        format: 'module',
        url: 'data:text/javascript,export function notFound() { throw new Error("notFound") } export function redirect() { throw new Error("redirect") }',
      }
    }
    if (specifier === 'next-intl/server') {
      return {
        shortCircuit: true,
        format: 'module',
        url: 'data:text/javascript,export async function getTranslations() { const f = (key) => key; f.has = () => false; return f }',
      }
    }
    return next(specifier, context)
  },
})

const { env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { loadMeDocumentsHome } = await import('./me-documents.ts')

// /me/documents for an admin with no linked person must render the
// refusal state (reference 2003031355), never the error boundary: the
// own-scope reads refuse HrmDocumentsError REFUSED naming the remedy,
// and only that no-link text converts — everything else still throws.

function session(orgId: string, userId: string) {
  return {
    user: { orgId, id: userId },
    permissions: new Set(['hrm.self.read']),
    allowedSubsidiaryIds: null,
  } as never
}

async function grantSelfRead(orgId: string, roleKey: string) {
  await withBypass(() => db.execute(sql`
    update app_roles set permissions = '["hrm.self.read"]'::jsonb
     where org_id = ${orgId} and key = ${roleKey}`))
}

test('the /me documents loader returns the refusal state for an unlinked user', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    // Scratch users carry no party link by design; the grant gets them
    // past the permission gate to the link check — the release-lane shape.
    const userId = await withBypass(() => createScratchUser(org.orgId, 'Unlinked', 'viewer'))
    await grantSelfRead(org.orgId, 'viewer')
    const data = await withBypass(() =>
      loadMeDocumentsHome({ orgId: org.orgId, userId, session: session(org.orgId, userId) }, {}),
    )
    assert.ok(data.refusal, 'an unlinked login must get refusal state, not a throw')
    assert.match(
      data.refusal.message,
      /not linked to a person record/,
      'the refusal carries the engine refusal with its remedy',
    )
    assert.deepEqual(data.rows, [], 'no documents resolve without a party')
    assert.deepEqual(data.exportRows, [], 'no exports resolve without a party')
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('an unrelated refusal still throws out of the /me documents loader', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    // No grant at all: the reads refuse HrmAuthorizationError before ever
    // reaching the link check — that refusal is a different condition and
    // must throw rather than render as the no-link state.
    const userId = await withBypass(() => createScratchUser(org.orgId, 'Ungranted', 'viewer'))
    await assert.rejects(
      withBypass(() =>
        loadMeDocumentsHome({ orgId: org.orgId, userId, session: session(org.orgId, userId) }, {}),
      ),
      /permission/,
    )
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
