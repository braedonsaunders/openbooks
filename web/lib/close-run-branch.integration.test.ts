import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import * as React from 'react'
import { resolveAppModule } from './test-module-hooks'
import type { SessionUser } from './auth'

/**
 * `/close` has two branches behind one route, and one of them was blank.
 *
 * `?run=<uuid>` renders the period-close wizard; everything else renders the
 * period list. The ViewSpec conversion left the run branch on the native path
 * and a later commit deleted that path, so `page.tsx` answered `null` for
 * every run. "Resume" led to an empty page and nothing noticed, because
 * nothing tested it: the route sweep visits `/close` with no query string, so
 * a branch selected BY a query string is invisible to it.
 *
 * That is the gap this file closes. It asserts the two things a whole-page
 * sweep cannot: that the loader produces the wizard's data for a real run,
 * and that the spec built from it is the wizard's own document — `bare`, so
 * the wizard's full-height shell is the only one, rather than the list's
 * layout with a widget bolted into it.
 */

const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
// The tsx runner compiles these RSC sources with the CLASSIC JSX transform.
Object.assign(globalThis, { __closeRunBranch: state, React })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next-intl/server') {
      return virtual('export async function getTranslations(){return (key)=>key}; export async function getLocale(){return "en"}')
    }
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__closeRunBranch.user}')
    }
    const app = resolveAppModule(specifier, context, next, root)
    if (app) return app
    return next(specifier, context)
  },
})

const { sql } = await import('drizzle-orm')
const { db, withOrgContext, withBypassContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  '@openbooks/engine/src/test-fixtures.ts'
)
const { startCloseRun } = await import('@openbooks/engine/src/close.ts')
const { loadClose, closeSpec } = await import('../app/(app)/close/view')

test('the run branch loads the wizard and renders under its own shell', {
  skip: !process.env.OPENBOOKS_DB_URL,
}, async (t) => {
  const org = await withBypassContext(() => createScratchOrg())
  t.after(() => withBypassContext(() => dropScratchOrg(org.orgId)))
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Close operator', 'admin'))
  await withBypassContext(async () => {
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`)
    // The whole /close segment is gated on Continuous Close; without it the
    // loader answers not-found and this would prove nothing.
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features','{}'::jsonb) || '{"continuousClose":true}'::jsonb)
       where id = ${org.orgId}`)
  })
  state.user = {
    id: actor, orgId: org.orgId, isSuperAdmin: false, name: 'Close operator',
    email: 'close@scratch.test', roles: [], envKind: 'production',
    productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor,
  } as SessionUser

  const runId = await withBypassContext(() =>
    startCloseRun({ orgId: org.orgId, periodId: org.periodId, bookId: org.bookId, actorId: actor }),
  )

  await withOrgContext(org.orgId, async () => {
    const data = await loadClose({ run: runId })
    assert.equal(data.onRun, true)
    assert.ok(data.wizard, 'the run branch must carry the wizard its page renders')

    // The data the wizard actually needs, not merely a truthy object. A
    // wizard handed an empty run renders a shell with nothing in it, which
    // looks like a working page and is not one.
    assert.equal((data.wizard.run as { id: string }).id, runId)
    assert.ok(data.wizard.tasks.length > 0, 'a started run has its blueprint steps')
    assert.equal(typeof data.wizard.canRun, 'boolean')
    assert.equal(typeof data.wizard.advancedClose, 'boolean')

    const spec = closeSpec(data)
    // `bare`, because the wizard brings its own full-height shell. A `list`
    // layout here would nest one page chrome inside another.
    assert.equal(spec.layout, 'bare')
    assert.deepEqual(spec.header, [])
    assert.deepEqual(spec.body.map((block) => block.kind), ['widget'])
    assert.equal((spec.body[0] as { widget: string }).widget, 'close-wizard')
  })

  await withOrgContext(org.orgId, async () => {
    // `?stage=` is how the wizard deep-links its own steps. It rides through
    // the loader, and dropping it silently sends every link to the run's
    // current stage instead of the one the url names.
    const staged = await loadClose({ run: runId, stage: 'publish' })
    assert.equal(staged.wizard?.stage, 'publish')
  })

  await withOrgContext(org.orgId, async () => {
    // An id that names no run falls through to the LIST rather than erroring:
    // a stale bookmark should show the periods, which is something a reader
    // can act on.
    for (const bogus of ['not-a-uuid', '00000000-0000-4000-8000-000000000000']) {
      const data = await loadClose({ run: bogus })
      assert.equal(data.onRun, false, bogus)
      assert.equal(data.wizard, null, bogus)
      assert.equal(closeSpec(data).layout, 'list', bogus)
    }
  })
})
