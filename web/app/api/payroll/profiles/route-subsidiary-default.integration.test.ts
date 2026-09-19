import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __payrollSubsidiaryDefaultState: state, __payrollSubsidiaryDefaultSession: session })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next-intl/server') return virtual(`export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}`)
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__payrollSubsidiaryDefaultState;
        return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: null };
      }
    `)
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return virtual(`
      export async function currentUser(){return globalThis.__payrollSubsidiaryDefaultSession.user}
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})

const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { GET: profilesGet } = await import('./route')
const { PATCH: partiesPatch, GET: partiesGet } = await import('../../parties/[id]/route')

const DB = !!process.env.OPENBOOKS_DB_URL
const params = (id: string) => ({ params: Promise.resolve({ id }) })

async function fixture() {
  // Scratch seeding runs under bypass: importing the routes registers the
  // web request-org resolver, which denies outside a Next request store.
  return withBypassContext(async () => {
    const org = await createScratchOrg()
    state.orgId = org.orgId
    state.actorId = await createScratchUser(org.orgId, 'Payroll clerk', 'admin')
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Party clerk', 'reviewer'))
    await withBypassContext(() => db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`))
    session.user = { id: actor, orgId: org.orgId, name: 'Clerk', email: 'clerk@example.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
    const rootSub = (await db.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id = ${org.orgId} and parent_id is null limit 1`)).rows[0]!.id
    const ieSub = randomUUID()
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, is_elimination, is_active, created_by, updated_by)
      values (${ieSub}, ${org.orgId}, ${rootSub}, 'Dublin Ltd', 'EUR', 'IE', false, true, ${state.actorId}, ${state.actorId})`)
    return { org, rootSub, ieSub }
  })
}

async function draftParty(orgId: string): Promise<string> {
  const id = randomUUID()
  await withBypassContext(() => db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${id}, ${orgId}, 'company', 'New party', false, '{}'::jsonb)`))
  await withBypassContext(() => db.execute(sql`
    insert into employee_roles (id, org_id, party_id, is_active)
    values (${randomUUID()}, ${orgId}, ${id}, true)`))
  return id
}

async function revision(orgId: string, partyId: string): Promise<string> {
  const res = await withOrgContext(orgId, () => partiesGet(new Request('http://hire.local'), params(partyId)))
  assert.equal(res.status, 200)
  return ((await res.json()) as { party: { updated_at: string } }).party.updated_at
}

async function defaultCountry(orgId: string, employeeId: string): Promise<{ status: number; country: unknown }> {
  const res = await withOrgContext(orgId, () =>
    profilesGet(new Request(`http://payroll.local?employee=${employeeId}`)))
  const body = (await res.json()) as { defaultCountry?: unknown; error?: unknown }
  return { status: res.status, country: body.defaultCountry }
}

test('a hire that records a non-root subsidiary defaults the profile to that subsidiary\u2019s country', { skip: !DB }, async () => {
  // The guided hire, at route level: the drawer names the draft and sends
  // the operator-chosen subsidiaryId (Save and, since the drawer fix,
  // Activate both carry it). The new-profile default must then resolve the
  // EMPLOYEE's entity — not the root — or a Dublin hire is silently priced
  // as a root-country employee.
  const { org, ieSub } = await fixture()
  try {
    await withOrgContext(org.orgId, async () => {
      const partyId = await draftParty(org.orgId)
      const saved = await partiesPatch(
        new Request('http://hire.local', { method: 'PATCH', body: JSON.stringify({
          kind: 'employee',
          displayName: 'Sean Murphy',
          subsidiaryId: ieSub,
          additionalSubsidiaryIds: [],
          roles: { employee: { enabled: true, hiredOn: '2026-09-01' } },
          expectedUpdatedAt: await revision(org.orgId, partyId),
        }) }),
        params(partyId),
      )
      assert.equal(saved.status, 200, await saved.clone().text())
      const stored = (await db.execute<{ subsidiary_id: string | null; is_active: boolean }>(sql`
        select subsidiary_id, is_active from parties where id = ${partyId} and org_id = ${org.orgId}`)).rows[0]!
      assert.equal(stored.subsidiary_id, ieSub)
      assert.equal(stored.is_active, true)
      const { status, country } = await defaultCountry(org.orgId, partyId)
      assert.equal(status, 200)
      assert.equal(country, 'IE')
    })
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})

test('an org-wide hire still falls back to the root entity\u2019s country', { skip: !DB }, async () => {
  // The fallback chain itself is correct and untouched: a party that is
  // genuinely org-wide (NULL subsidiary — e.g. hired before the org went
  // multi-entity) resolves the ROOT subsidiary's country. This pins the
  // behaviour the fix preserves.
  const { org } = await fixture()
  try {
    await withOrgContext(org.orgId, async () => {
      const partyId = await draftParty(org.orgId)
      const saved = await partiesPatch(
        new Request('http://hire.local', { method: 'PATCH', body: JSON.stringify({
          kind: 'employee',
          displayName: 'Orla Wide',
          roles: { employee: { enabled: true, hiredOn: '2026-09-01' } },
          expectedUpdatedAt: await revision(org.orgId, partyId),
        }) }),
        params(partyId),
      )
      assert.equal(saved.status, 200, await saved.clone().text())
      const { status, country } = await defaultCountry(org.orgId, partyId)
      assert.equal(status, 200)
      assert.equal(country, 'CA')
    })
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})
