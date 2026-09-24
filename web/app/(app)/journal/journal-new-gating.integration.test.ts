/**
 * F1-1: the journal New button shows iff the server would allow the save.
 *
 * Before the fix the spec rendered the New button unconditionally, but the
 * loader opens the ?entryNew=1 drawer only with gl.post — a gl.read-only
 * reader got a dead click. Now the loader derives canPost from the session
 * and the spec omits both the header button and the empty-state action
 * without it.
 *
 * DB-owned: drives the real loader (real authz resolution) with and
 * without gl.post, then drives the real spec builder and resolves its
 * `when` conditions through the viewspec package's own resolver.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { sql } from 'drizzle-orm'
import type { SessionUser } from '../../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __journalGating: session })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (specifier === 'next-intl/server') {
      return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(namespace){return (key,vars)=>vars&&typeof vars.count==='number'?`${key}:${vars.count}`:key};export async function getLocale(){return 'en'}" }
    }
    if (specifier === 'next/navigation') {
      return { shortCircuit: true, url: "data:text/javascript,export function redirect(url){throw new Error('REDIRECT:'+url)};export function notFound(){throw new Error('NOT_FOUND')}" }
    }
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__journalGating.user}' }
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})

const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { loadJournal, journalSpec } = await import('./view')
const { isFieldRef, resolveValue } = await import('@braedonsaunders/appkit-viewspec')

function asUser(id: string, orgId: string): SessionUser {
  return {
    id,
    orgId,
    name: 'Journal gating probe',
    email: `probe-${id.slice(0, 8)}@scratch.test`,
    roles: [],
    isSuperAdmin: false,
    envKind: 'production',
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: id,
  } as SessionUser
}

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
        when: (record as { when?: unknown }).when,
      })
    }
    for (const value of Object.values(record)) collectWidgets(value, out)
  }
  return out
}

async function fixture() {
  const org = await createScratchOrg()
  const reader = await createScratchUser(org.orgId, 'Reader', 'journal_reader')
  const poster = await createScratchUser(org.orgId, 'Poster', 'journal_poster')
  await db.execute(sql`
    update app_roles set permissions = '["gl.read"]'::jsonb
     where org_id = ${org.orgId} and key = 'journal_reader'`)
  await db.execute(sql`
    update app_roles set permissions = '["gl.read", "gl.post"]'::jsonb
     where org_id = ${org.orgId} and key = 'journal_poster'`)
  const load = (userId: string, sp: Record<string, string | string[] | undefined>) => {
    session.user = asUser(userId, org.orgId)
    return withOrgContext(org.orgId, () => loadJournal(sp))
  }
  const close = async () => {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
  return { org, reader, poster, load, close }
}

test('journal New hides without gl.post and shows with it', async () => {
  const f = await fixture()
  try {
    const readerPage = await f.load(f.reader, {})
    assert.strictEqual(readerPage.canPost, false)

    const widgets = collectWidgets(journalSpec(readerPage))
    const headerNew = widgets.find((w) => w.widget === 'new-journal')
    assert.ok(headerNew, 'the built spec carries the New action shape')
    assert.ok(isFieldRef(headerNew.when), 'New visibility is a loader-resolved flag')
    assert.strictEqual(
      resolveValue(headerNew.when as never, readerPage as never),
      false,
      'a gl.read-only reader is shown no New button',
    )
    const emptyAction = (journalSpec(readerPage) as unknown as {
      body?: { props?: { emptyAction?: unknown } }[]
    }).body?.flatMap((b) => (b?.props ? [b.props] : []))
    assert.ok(
      emptyAction?.every((props) => props.emptyAction == null),
      'the empty state offers no New action without gl.post',
    )

    const posterPage = await f.load(f.poster, {})
    assert.strictEqual(posterPage.canPost, true)
    const posterWidgets = collectWidgets(journalSpec(posterPage))
    const posterNew = posterWidgets.find((w) => w.widget === 'new-journal')
    assert.ok(posterNew)
    assert.notStrictEqual(
      resolveValue(posterNew.when as never, posterPage as never),
      false,
      'a gl.post holder is shown the New button',
    )
  } finally {
    await f.close()
  }
})

test('?entryNew=1 opens nothing without gl.post', async () => {
  const f = await fixture()
  try {
    const readerPage = await f.load(f.reader, { entryNew: '1', mode: 'edit' })
    assert.strictEqual(readerPage.drawerOpen, false)
    assert.strictEqual(readerPage.drawer, null)
  } finally {
    await f.close()
  }
})
