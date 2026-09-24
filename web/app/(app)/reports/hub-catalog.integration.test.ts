import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// The hub materialises the built-in report catalog before it reads it, and
// reads it without truncation. Two silent failures this guards:
//
//  1. The hub read `report_definitions` rows without seeding them. Those rows
//     appear only once something calls `ensureReportDefinitions`, so on an org
//     where none of those had run the hub rendered with no built-in reports
//     at all: no Payroll group, no Human-resources group, nothing to say they
//     were missing.
//  2. The catalog read was capped at twelve rows ordered by `updated_at` desc,
//     so a module's entire group could drop off because twelve unrelated
//     reports had been touched more recently — and the page looked complete.
//
// Postgres is live; auth and translations are scripted. Feature probes run
// for real, so the org enables Payroll and HRM the way an adopting org would.
const stateKey = Symbol.for('openbooks.hub-catalog-test')
const state: { orgId: string | null; userId: string | null } = { orgId: null, userId: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockAuthz = `
  import { permissionSetCovers } from '@openbooks/engine/src/organization/permissions.ts'
  const state = globalThis[Symbol.for('openbooks.hub-catalog-test')]
  export async function getAuthz() {
    if (!state.orgId || !state.userId) return null
    return { user: { orgId: state.orgId, id: state.userId }, permissions: new Set(['*']), allowedSubsidiaryIds: null }
  }
  export function can(authz, perm) { return permissionSetCovers(authz.permissions, perm) }
`
const mockIntl = `
  export async function getTranslations() { return (key) => key }
`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === '../../../lib/authz' && context.parentURL?.includes('/reports/view.ts')) {
      return { url: 'mock:hub-catalog-authz', shortCircuit: true }
    }
    if (specifier === 'next-intl/server') {
      return { url: 'mock:hub-catalog-intl', shortCircuit: true }
    }
    if (context.parentURL?.startsWith('mock:')) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url })
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:hub-catalog-authz') return { format: 'module', source: mockAuthz, shortCircuit: true }
    if (url === 'mock:hub-catalog-intl') return { format: 'module', source: mockIntl, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const { loadReportsHub } = await import('./view.ts')
const { sql } = await import('drizzle-orm')
const { db, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')


async function freshOrg(): Promise<string> {
  const org = await withBypass(() => createScratchOrg())
  await withBypass(() =>
    db.execute(sql`update orgs set settings = '{"features": {"payroll": true, "hrm": true}}'::jsonb where id = ${org.orgId}`),
  )
  const userId = (await withBypass(() => createScratchUser(org.orgId, 'Hub Admin', 'admin'))) as unknown as string
  state.orgId = org.orgId
  state.userId = userId
  return org.orgId
}

function releaseOrg(): void {
  state.orgId = null
  state.userId = null
}

function groupKeys(data: Awaited<ReturnType<typeof loadReportsHub>>): string[] {
  return data.groups.map((group) => group.key)
}

test('a fresh org reads the payroll group on its first hub visit', async () => {
  const orgId = await freshOrg()
  try {
    // Never opened the builder, the definitions API, or the evidence pack:
    // the hub itself must seed the catalog it renders.
    const data = await withOrgContext(orgId, () => loadReportsHub())
    const payroll = data.groups.find((group) => group.key === 'payroll')
    assert.ok(payroll, `the hub must show a payroll group, saw [${groupKeys(data).join(', ')}]`)
    assert.ok(payroll.cards.length > 0, 'the payroll group must carry the seeded payroll built-ins')
  } finally {
    releaseOrg()
    await withBypass(() => dropScratchOrg(orgId))
  }
})

test('a fresh org reads the workforce group on its first hub visit', async () => {
  const orgId = await freshOrg()
  try {
    const data = await withOrgContext(orgId, () => loadReportsHub())
    const hrm = data.groups.find((group) => group.key === 'hrm')
    assert.ok(hrm, `the hub must show a workforce group, saw [${groupKeys(data).join(', ')}]`)
    assert.ok(hrm.cards.length > 0, 'the workforce group must carry the seeded HRM built-ins')
  } finally {
    releaseOrg()
    await withBypass(() => dropScratchOrg(orgId))
  }
})

test('thirteen org-authored definitions all surface in Custom & Saved', async () => {
  const orgId = await freshOrg()
  try {
    await withBypass(async () => {
      for (let i = 1; i <= 13; i++) {
        await db.execute(sql`insert into report_definitions (org_id, kind, slug, name, description, query)
          values (${orgId}, 'custom', ${`custom-${i}`}, ${`Custom ${i}`}, null, '{}'::jsonb)`)
      }
    })
    const data = await withOrgContext(orgId, () => loadReportsHub())
    const custom = data.groups.find((group) => group.key === 'custom')
    assert.ok(custom, 'the hub must always render Custom & Saved')
    // One studio card plus every org-authored definition: a row cap ordered by
    // recency would silently drop the thirteenth.
    const authored = custom.cards.filter((card) => card.href.startsWith('/reports/custom/run/'))
    assert.equal(authored.length, 13, 'all thirteen org-authored definitions must surface, not the twelve most recent')
    const runIds = authored.map((card) => card.href.slice('/reports/custom/run/'.length))
    const { rows: builtIns } = await withBypass(() => db.execute<{ id: string }>(
      sql`select id from report_definitions where org_id = ${orgId} and kind = 'built_in'`,
    ))
    const builtInIds = new Set(builtIns.map((row) => row.id))
    assert.deepEqual(runIds.filter((id) => builtInIds.has(id)), [], 'no built-in definition may surface inside Custom & Saved')
  } finally {
    releaseOrg()
    await withBypass(() => dropScratchOrg(orgId))
  }
})
