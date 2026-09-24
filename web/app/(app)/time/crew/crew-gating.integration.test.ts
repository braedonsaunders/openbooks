/**
 * F2-2: the crew page shows New Batch / Setup iff the server would allow
 * them. The batch POST requires time.crew.enter and the Setup page requires
 * time.manage — the loader must derive both flags from the caller's session
 * instead of hard-coding them true, and the spec must omit each button when
 * its flag is false.
 *
 * DB-owned: drives the real loader (real authz resolution, real feature
 * gate) with three permission shapes, then drives the real spec builder and
 * resolves its `when` conditions through the viewspec package's own
 * resolver — the same evaluation the renderer performs.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { sql } from 'drizzle-orm'
import type { SessionUser } from '../../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __crewGating: session })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (specifier === 'next-intl/server') {
      return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return (key)=>key};export async function getLocale(){return 'en'}" }
    }
    if (specifier === 'next/navigation') {
      return { shortCircuit: true, url: "data:text/javascript,export function redirect(url){throw new Error('REDIRECT:'+url)};export function notFound(){throw new Error('NOT_FOUND')}" }
    }
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__crewGating.user}' }
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})

const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { loadCrewPage, crewSpec } = await import('./view')
const { isFieldRef, resolveValue } = await import('@braedonsaunders/appkit-viewspec')

function asUser(id: string, orgId: string): SessionUser {
  return {
    id,
    orgId,
    name: 'Crew gating probe',
    email: `probe-${id.slice(0, 8)}@scratch.test`,
    roles: [],
    isSuperAdmin: false,
    envKind: 'production',
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: id,
  } as SessionUser
}

async function setRolePermissions(orgId: string, key: string, permissions: string[]): Promise<void> {
  await db.execute(sql`
    update app_roles set permissions = ${JSON.stringify(permissions)}::jsonb
     where org_id = ${orgId} and key = ${key}`)
}

async function enableCrewEntry(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs set settings = coalesce(settings, '{}'::jsonb)
      || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb)
      || '{"projects": true, "timeTracking": true, "fieldTime": true, "fieldTimeCrewEntry": true}'::jsonb)
     where id = ${orgId}`)
}

/** Every widget reference anywhere in the built spec, depth-first. */
function collectWidgets(node: unknown, out: { widget: string; props?: Record<string, unknown>; when?: unknown }[] = []): {
  widget: string
  props?: Record<string, unknown>
  when?: unknown
}[] {
  if (Array.isArray(node)) {
    for (const item of node) collectWidgets(item, out)
  } else if (node !== null && typeof node === 'object') {
    const record = node as Record<string, unknown>
    if (typeof record.widget === 'string') {
      out.push({
        widget: record.widget,
        props: (record.props ?? {}) as Record<string, unknown>,
        when: record.when,
      })
    }
    for (const value of Object.values(record)) collectWidgets(value, out)
  }
  return out
}

/** The renderer's own visibility rule: no `when` reads as visible. */
function visible(
  when: unknown,
  data: Record<string, unknown>,
  resolve: (value: unknown, scope: unknown) => unknown,
): boolean {
  if (when == null) return true
  if (!isFieldRef(when)) return true
  return resolve(when, data) !== false && resolve(when, data) != null && resolve(when, data) !== ''
}

test('crew New Batch and Setup follow the caller permissions', async () => {
  const org = await createScratchOrg()
  try {
    await enableCrewEntry(org.orgId)
    const reader = await createScratchUser(org.orgId, 'Reader', 'crew_reader')
    const foreman = await createScratchUser(org.orgId, 'Foreman', 'crew_foreman')
    const manager = await createScratchUser(org.orgId, 'Manager', 'crew_manager')
    await setRolePermissions(org.orgId, 'crew_reader', ['time.read'])
    await setRolePermissions(org.orgId, 'crew_foreman', ['time.read', 'time.crew.enter'])
    await setRolePermissions(org.orgId, 'crew_manager', ['time.read', 'time.crew.enter', 'time.manage'])

    const load = (userId: string) => {
      session.user = asUser(userId, org.orgId)
      return withOrgContext(org.orgId, () => loadCrewPage({}))
    }
    const readerPage = await load(reader)
    assert.equal(readerPage.canEnter, false)
    assert.equal(readerPage.canSetup, false)

    const foremanPage = await load(foreman)
    assert.equal(foremanPage.canEnter, true)
    assert.equal(foremanPage.canSetup, false)

    const managerPage = await load(manager)
    assert.equal(managerPage.canEnter, true)
    assert.equal(managerPage.canSetup, true)
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})

test('crew spec omits New Batch and Setup when their flags are false', async () => {
  const org = await createScratchOrg()
  try {
    await enableCrewEntry(org.orgId)
    const reader = await createScratchUser(org.orgId, 'Reader', 'crew_reader_spec')
    await setRolePermissions(org.orgId, 'crew_reader_spec', ['time.read'])
    session.user = asUser(reader, org.orgId)
    const data = await withOrgContext(org.orgId, () => loadCrewPage({}))

    const widgets = collectWidgets(crewSpec(data, '/time/crew'))
    const resolve = (value: unknown, scope: unknown) => resolveValue(value as never, scope)
    const findAction = (href: string) =>
      widgets.find(
        (w) => w.widget === 'link-button' && resolveValue(w.props?.href as never, data) === href,
      )
    const newButton = findAction('/time/crew?new=1')
    assert.ok(newButton, 'the built spec carries a New Batch action')
    assert.ok(isFieldRef(newButton.when), 'New Batch visibility is a loader-resolved flag')
    assert.equal(visible(newButton.when, data as unknown as Record<string, unknown>, resolve), false)

    const setupButton = findAction('/time/setup')
    assert.ok(setupButton, 'the built spec carries a Setup action')
    assert.ok(isFieldRef(setupButton.when), 'Setup visibility is a loader-resolved flag')
    assert.equal(visible(setupButton.when, data as unknown as Record<string, unknown>, resolve), false)

    // And the same spec with both grants shows both actions.
    const shown = { ...data, canEnter: true, canSetup: true }
    assert.equal(visible(newButton.when, shown as unknown as Record<string, unknown>, resolve), true)
    assert.equal(visible(setupButton.when, shown as unknown as Record<string, unknown>, resolve), true)
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})
