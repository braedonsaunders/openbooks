import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

/**
 * Page layouts as an agent capability, exercised against a real tenant.
 *
 * The unit tests next door prove the validator's rules. This proves the parts
 * only a database can: that the permission actually gates, that a stored
 * layout belongs to exactly one org, and that clearing one leaves the row
 * behind for the audit trail rather than destroying it.
 */

const root = pathToFileURL(process.cwd() + '/web/').href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (specifier.startsWith('@/')) return next(root + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})

const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  '@openbooks/engine/src/test-fixtures.ts'
)
const layouts = await import('./page-layouts')

type Ctx = Parameters<typeof layouts.listLayouts>[0]

function contextFor(orgId: string, userId: string, permissions: string[]): Ctx {
  return {
    authz: {
      user: { id: userId, orgId, name: 'Test', email: 't@example.test', roles: [] },
      permissions: new Set(permissions),
      allowedSubsidiaryIds: null,
    },
    source: 'mcp',
    requestId: randomUUID(),
    apiKeyId: null,
  } as unknown as Ctx
}

const validSpec = (route: string) => ({
  specVersion: 1,
  route,
  layout: 'list',
  header: [{ kind: 'page-header', title: 'Customized' }],
  body: [{ kind: 'heading', level: 2, content: 'Hello' }],
})

test('page layouts are org-scoped, permission-gated and audited', async (t) => {
  // Fixtures are created and torn down under the trusted boundary; the
  // product calls below run inside `withOrgContext`, under ordinary RLS. That
  // split is what makes the org-isolation assertion mean anything — if the
  // whole test ran bypassed, seeing nothing from the other org would prove
  // nothing about the policy.
  const { orgA, orgB, userA, userB } = await withBypassContext(async () => {
    const a = await createScratchOrg()
    const b = await createScratchOrg()
    return {
      orgA: a.orgId,
      orgB: b.orgId,
      userA: await createScratchUser(a.orgId, 'Layout Admin', 'layout_admin'),
      userB: await createScratchUser(b.orgId, 'Other Admin', 'layout_admin'),
    }
  })
  t.after(async () => {
    await withBypassContext(async () => {
      await dropScratchOrg(orgA)
      await dropScratchOrg(orgB)
    })
  })

  const allowed = contextFor(orgA, userA, ['admin.customization.manage'])
  const reader = contextFor(orgA, userA, ['reports.read'])
  const otherOrg = contextFor(orgB, userB, ['admin.customization.manage'])

  await withOrgContext(orgA, async () => {
    // The permission gates every entry point, not just the writes. Reading
    // what a tenant customized is itself administrative.
    for (const call of [
      () => layouts.listLayouts(reader),
      () => layouts.describeLayoutVocabulary(reader),
      () => layouts.setLayout(reader, { route: '/banking', spec: validSpec('/banking') }),
      () => layouts.clearLayout(reader, { route: '/banking' }),
      () => layouts.describePageLayout(reader, { route: '/banking' }),
    ]) {
      await assert.rejects(call, /forbidden/i, 'a reader must not reach page layouts')
    }

    // The vocabulary comes from the live registries, so it cannot promise a
    // widget the renderer does not have.
    const vocab = await layouts.describeLayoutVocabulary(allowed)
    assert.ok(vocab.widgets.length > 50, 'the widget registry should be non-trivial')
    assert.ok(vocab.frames.includes('page-container'))
    assert.ok(vocab.blockKinds.includes('heading'))

    // A draft is checkable without storing anything.
    const bad = await layouts.validateLayout(allowed, {
      spec: { ...validSpec('/banking'), body: [{ kind: 'widget', widget: 'no-such-widget' }] },
    })
    assert.equal(bad.valid, false)
    assert.ok(bad.errors.some((e) => e.includes('no-such-widget')))
    assert.deepEqual((await layouts.listLayouts(allowed)).layouts, [], 'validating stores nothing')

    const stored = await layouts.setLayout(allowed, {
      route: '/banking',
      spec: validSpec('/banking'),
      note: 'test',
    })
    assert.equal(stored.stored, true)

    const listed = await layouts.listLayouts(allowed)
    assert.equal(listed.layouts.length, 1)
    assert.equal(listed.layouts[0]!.route, '/banking')
    // The list also says which routes CAN be customized, so an author does not
    // have to guess a route pattern and learn it was wrong at save time.
    assert.ok(listed.customizableRoutes.includes('/banking'))

    // A route nothing declares is refused with candidates rather than an
    // empty answer: a typo is the likeliest reason to land here, and "no such
    // route" with no help is where an author gives up.
    const unknown = await layouts.describePageLayout(allowed, { route: '/bankng' })
    assert.equal(unknown.known, false)
    assert.ok(
      'didYouMean' in unknown && unknown.didYouMean.includes('/banking'),
      `expected /banking among the suggestions, got ${JSON.stringify(unknown)}`,
    )
  })

  // The other org sees none of it. This is the property that makes storing a
  // renderable document per tenant safe to do at all.
  await withOrgContext(orgB, async () => {
    assert.deepEqual((await layouts.listLayouts(otherOrg)).layouts, [])
  })

  await withOrgContext(orgA, async () => {
    // A save replaces rather than accumulates: one ACTIVE layout per route.
    await layouts.setLayout(allowed, { route: '/banking', spec: validSpec('/banking') })
    assert.equal((await layouts.listLayouts(allowed)).layouts.length, 1)

    const cleared = await layouts.clearLayout(allowed, { route: '/banking' })
    assert.equal(cleared.cleared, 1)
    assert.deepEqual((await layouts.listLayouts(allowed)).layouts, [])

    // Deactivated, not deleted — the audit entries point at rows someone can
    // still read.
    const rows = await db.execute<{ n: string }>(
      sql`select count(*) as n from page_specs where org_id = ${orgA}`,
    )
    assert.equal(Number(rows.rows[0]!.n), 2, 'both stored layouts survive as inactive rows')

    const audit = await db.execute<{ action: string }>(
      sql`select action from audit_log where org_id = ${orgA} and table_name = 'page_specs' order by at`,
    )
    assert.deepEqual(
      audit.rows.map((r) => r.action),
      ['insert', 'update', 'insert', 'update'],
      'every save and every clear is recorded',
    )
  })
})
