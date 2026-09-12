import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { page, widgetBlock, textBlock, frame, ref, validateSpec, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { validateAgainstRegistries } from './page-spec-validate'

/**
 * Module precedence (Phase 1d): user > org-native > module > built-in.
 *
 * This file runs in the no-database unit suite, so the engine's `db` pool is
 * swapped for a queue of canned `{ rows }` responses (the
 * `analytics-drill-decimal.test.ts` pattern) and the real `loadPageSpec` /
 * `savePageSpec` / `clearPageSpec` / `restorePageSpec` run against it. The
 * `server-only` marker is shimmed the way `documents.test.ts` shims it:
 * node's test runner isolates each file in its own process, so neither hook
 * can leak elsewhere.
 */

const PRECEDENCE_DB_KEY = Symbol.for('openbooks.page-specs-precedence-test')

interface PrecedenceDbState {
  responses: Array<{ rows: unknown[] }>
  queries: string[]
}

const precedenceDb: PrecedenceDbState = { responses: [], queries: [] }
;(globalThis as unknown as Record<symbol, PrecedenceDbState>)[PRECEDENCE_DB_KEY] = precedenceDb

// Walks drizzle's chunk tree instead of calling `toQuery()`, which needs a
// live dialect. Kept as a source string (not a serialized closure) because
// the tsx transform injects helpers that do not exist inside the mock.
const MOCK_DB_SOURCE = `
  const state = globalThis[Symbol.for('openbooks.page-specs-precedence-test')]
  function flattenSqlChunks(query) {
    const top = query == null ? undefined : query.queryChunks
    if (!Array.isArray(top)) return String(query)
    let out = ''
    const walk = (chunks) => {
      for (const chunk of chunks) {
        if (typeof chunk === 'string') {
          out += chunk
          continue
        }
        if (chunk && typeof chunk === 'object') {
          if (Array.isArray(chunk.queryChunks)) {
            walk(chunk.queryChunks)
            continue
          }
          // StringChunk carries string[]; Param carries the bound value.
          if (typeof chunk.value === 'string') {
            out += chunk.value
            continue
          }
          if (Array.isArray(chunk.value)) {
            out += chunk.value.join('')
            continue
          }
        }
        out += '?'
      }
    }
    walk(top)
    return out.replace(/\\s+/g, ' ').trim()
  }
  async function execute(query) {
    state.queries.push(flattenSqlChunks(query))
    return state.responses.shift() ?? { rows: [] }
  }
  export const db = { execute, transaction: async (fn) => fn({ execute }) }
`

const precedenceHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === '@openbooks/engine/src/db.ts') {
      return { shortCircuit: true, format: 'module', url: 'mock:page-specs-precedence-db' }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url !== 'mock:page-specs-precedence-db') return nextLoad(url, context)
    return { format: 'module', shortCircuit: true, source: MOCK_DB_SOURCE }
  },
})

const { loadPageSpec, savePageSpec, clearPageSpec, restorePageSpec } = await import('./page-specs.ts')
precedenceHooks.deregister()

/**
 * What a stored page spec is allowed to be.
 *
 * These are the properties that make it safe to render a document a tenant
 * wrote, so they are asserted rather than assumed. The schema tests next door
 * cover the language; this covers the extra gate a STORED spec passes — that
 * it only names components the host can actually render.
 */

const registries = {
  widgets: new Set(['stat-tile-row', 'banking-roster', 'save-view']),
  frames: new Set(['page-container', 'card']),
}

test('accepts a spec that names only registered widgets and frames', () => {
  const spec = page({
    route: '/banking',
    body: [frame('card', [widgetBlock('banking-roster', { accounts: [] })])],
  })
  const result = validateAgainstRegistries(spec, registries)
  assert.equal(result.ok, true)
})

test('rejects a widget the host cannot render, naming it', () => {
  // The schema only requires a slug, so `payrol-cockpit` passes it and would
  // throw UnknownWidgetError mid-render — a blank page for the tenant and a
  // stack trace for us. This is the gate that turns it into a save-time error.
  const spec = page({ route: '/banking', body: [widgetBlock('payrol-cockpit')] })
  assert.equal(validateSpec(spec).ok, true, 'the schema alone accepts it')

  const result = validateAgainstRegistries(spec, registries)
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.errors.some((e) => e.includes('payrol-cockpit')))
})

test('rejects an unregistered frame', () => {
  const spec = page({ route: '/banking', body: [frame('trapdoor', [textBlock('hi')])] })
  const result = validateAgainstRegistries(spec, registries)
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.errors.some((e) => e.includes('trapdoor')))
})

test('finds names at any depth, not just the top level', () => {
  const spec = page({
    route: '/banking',
    body: [frame('card', [frame('page-container', [widgetBlock('not-a-widget')])])],
  })
  const result = validateAgainstRegistries(spec, registries)
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.errors.some((e) => e.includes('not-a-widget')))
})

test('reports each unknown name once, however often it appears', () => {
  const spec = page({
    route: '/banking',
    body: [widgetBlock('ghost'), widgetBlock('ghost'), widgetBlock('ghost')],
  })
  const result = validateAgainstRegistries(spec, registries)
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.equal(result.errors.filter((e) => e.includes('ghost')).length, 1)
})

test('a stored spec cannot smuggle a function, an org id, or a component', () => {
  // The three things the language forbids, as they would arrive over the
  // wire: JSON cannot carry a function, but an object shaped like a call is
  // the shape an attacker would try. `strictObject` refuses every one.
  for (const body of [
    [{ kind: 'text', content: { $fn: 'process.exit' } }],
    [{ kind: 'widget', widget: 'save-view', props: {}, orgId: 'other-tenant' }],
    [{ kind: 'widget', widget: 'save-view', component: 'AdminPanel' }],
  ]) {
    const result = validateAgainstRegistries(
      { specVersion: 1, route: '/banking', layout: 'list', header: [], body },
      registries,
    )
    assert.equal(result.ok, false, `should have rejected ${JSON.stringify(body)}`)
  }
})

test('a field ref is a dot path and nothing more', () => {
  // The one place a spec touches property lookup. `resolvePath` guards the
  // prototype segments; here we prove the schema keeps a ref to a plain path
  // rather than anything evaluable.
  const f = ref<{ title: string }>()
  const spec = page({ route: '/banking', body: [textBlock(f('title'))] })
  const result = validateAgainstRegistries(spec, registries)
  assert.equal(result.ok, true)
  assert.deepEqual((spec.body[0] as { content: unknown }).content, { $: 'title' })
})

test('validateSpec hands back the parsed spec, so callers stop holding unknown', () => {
  const result = validateSpec(page({ route: '/banking', body: [textBlock('hi')] }))
  assert.equal(result.ok, true)
  assert.ok(result.ok && result.spec.route === '/banking')
})

/**
 * Prop contracts — the gate that turns a silent typo into a refusal.
 *
 * A widget's props are `Record<string, unknown>` by design, so before this
 * the only feedback for `placeholer` was a control that never appeared.
 */
const withContracts = {
  ...registries,
  contracts: {
    'banking-roster': { props: ['accounts', 'totalCash'] },
    'save-view': { props: [] },
    'stat-tile-row': { props: ['anything'], open: true as const },
  },
}

test('a prop the widget does not read is refused, with the near miss named', () => {
  const spec = page({
    route: '/banking',
    body: [widgetBlock('banking-roster', { accounts: [], totalCsh: 0 })],
  })
  const result = validateAgainstRegistries(spec, withContracts)
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.equal(result.errors.length, 1)
  // Both names in one message: the one that is wrong and the one that is
  // probably meant. A bare "unknown prop" leaves an author scanning a list.
  assert.match(result.errors[0]!, /banking-roster/)
  assert.match(result.errors[0]!, /"totalCsh"/)
  assert.match(result.errors[0]!, /did you mean "totalCash"/)
})

test('a prop nothing resembles is refused without a guess', () => {
  // A wrong suggestion costs more than none — it sends the author to rename a
  // prop that was never the problem.
  const spec = page({ route: '/banking', body: [widgetBlock('banking-roster', { zzzzzzzz: 1 })] })
  const result = validateAgainstRegistries(spec, withContracts)
  assert.ok(!result.ok)
  assert.doesNotMatch(result.errors[0]!, /did you mean/)
})

test('a missing prop is NOT an error, because a widget may have a default', () => {
  const spec = page({ route: '/banking', body: [widgetBlock('banking-roster', {})] })
  assert.equal(validateAgainstRegistries(spec, withContracts).ok, true)
})

test('an open widget is checked for nothing', () => {
  // Seventeen entries forward their props wholesale, so any name may be
  // meaningful. Guessing at those would trade a silent typo for a confident
  // false refusal, which is the worse failure.
  const spec = page({ route: '/banking', body: [widgetBlock('stat-tile-row', { whatever: 1 })] })
  assert.equal(validateAgainstRegistries(spec, withContracts).ok, true)
})

test('with no contracts supplied, props are not checked at all', () => {
  // This is what the RENDER path passes. A layout stored under older rules
  // must keep rendering: tightening a rule must never take a working page
  // away from a reader who had nothing to do with it.
  const spec = page({ route: '/banking', body: [widgetBlock('banking-roster', { totalCsh: 0 })] })
  assert.equal(validateAgainstRegistries(spec, registries).ok, true)
})

test('the same bad prop is reported once, however often it appears', () => {
  const spec = page({
    route: '/banking',
    body: [widgetBlock('banking-roster', { nope: 1 }), widgetBlock('banking-roster', { nope: 2 })],
  })
  const result = validateAgainstRegistries(spec, withContracts)
  assert.ok(!result.ok)
  assert.equal(result.errors.length, 1)
})

test('props are checked on widget CELLS and refs too, not only blocks', () => {
  // A widget reached through a table cell renders the same component, so a
  // prop that reaches nothing there is the same defect.
  const spec = page({
    route: '/banking',
    header: [
      {
        kind: 'page-header',
        title: 'x',
        actions: [{ widget: 'banking-roster', props: { totalCsh: 1 } }],
      },
    ],
    body: [],
  })
  const result = validateAgainstRegistries(spec, withContracts)
  assert.ok(!result.ok)
  assert.match(result.errors[0]!, /totalCsh/)
})


const PRECEDENCE_ROUTE = '/reports/aging'

function precedenceSpec(marker: string): PageSpec {
  return page({ route: PRECEDENCE_ROUTE, body: [textBlock(marker)] })
}

function candidateRow(
  marker: string,
  opts: { userId?: string | null; moduleVersionId?: string | null; updatedAt?: string } = {},
) {
  return {
    id: `row-${marker}`,
    spec: precedenceSpec(marker),
    user_id: opts.userId ?? null,
    module_version_id: opts.moduleVersionId ?? null,
    updated_at: opts.updatedAt ?? '2026-03-01T00:00:00.000Z',
  }
}

function contentMarker(result: { spec: PageSpec } | null): unknown {
  const first = result?.spec.body[0] as { content?: unknown } | undefined
  return first?.content
}

function resetPrecedenceDb(responses: Array<{ rows: unknown[] }>): void {
  precedenceDb.responses = responses
  precedenceDb.queries = []
}

function recordedUpdates(): string[] {
  return precedenceDb.queries.filter((q) => q.toLowerCase().startsWith('update page_specs'))
}

test('an installed module spec resolves when the tenant stored nothing', async () => {
  resetPrecedenceDb([{ rows: [candidateRow('from-module', { moduleVersionId: 'mv-1' })] }])
  const result = await loadPageSpec('org-1', PRECEDENCE_ROUTE, registries)
  assert.ok(result)
  assert.equal(contentMarker(result), 'from-module')
  assert.equal(result.scope, 'org')
  assert.equal(result.moduleVersionId, 'mv-1')
})

test('a tenant org layout beats an installed module, whatever order the rows arrive in', async () => {
  resetPrecedenceDb([
    {
      rows: [
        candidateRow('from-module', { moduleVersionId: 'mv-1' }),
        candidateRow('tenant-org'),
      ],
    },
  ])
  const result = await loadPageSpec('org-1', PRECEDENCE_ROUTE, registries)
  assert.ok(result)
  assert.equal(contentMarker(result), 'tenant-org')
  assert.equal(result.moduleVersionId, null)
})

test('a personal layout beats the org layout and the module', async () => {
  resetPrecedenceDb([
    {
      rows: [
        candidateRow('from-module', { moduleVersionId: 'mv-1' }),
        candidateRow('tenant-org'),
        candidateRow('mine', { userId: 'user-1' }),
      ],
    },
  ])
  const result = await loadPageSpec('org-1', PRECEDENCE_ROUTE, registries, 'user-1')
  assert.ok(result)
  assert.equal(contentMarker(result), 'mine')
  assert.equal(result.scope, 'user')
})

test('nothing stored resolves to nothing: the page renders its built-in spec', async () => {
  resetPrecedenceDb([{ rows: [] }])
  assert.equal(await loadPageSpec('org-1', PRECEDENCE_ROUTE, registries, 'user-1'), null)
})

test('a corrupt tenant layout does not fall through to the module: the page renders built-in', async () => {
  // Fail closed, as before modules existed: an invalid winner resolves to
  // null rather than promoting a lower layer the tenant did not choose.
  resetPrecedenceDb([
    {
      rows: [
        {
          id: 'row-bad',
          spec: { nonsense: true },
          user_id: null,
          module_version_id: null,
          updated_at: '2026-03-01T00:00:00.000Z',
        },
        candidateRow('from-module', { moduleVersionId: 'mv-1' }),
      ],
    },
  ])
  assert.equal(await loadPageSpec('org-1', PRECEDENCE_ROUTE, registries), null)
})

test('a corrupt module row does not block the tenant layout above it', async () => {
  resetPrecedenceDb([
    {
      rows: [
        {
          id: 'row-bad-module',
          spec: { nonsense: true },
          user_id: null,
          module_version_id: 'mv-1',
          updated_at: '2026-03-01T00:00:00.000Z',
        },
        candidateRow('tenant-org'),
      ],
    },
  ])
  const result = await loadPageSpec('org-1', PRECEDENCE_ROUTE, registries)
  assert.ok(result)
  assert.equal(contentMarker(result), 'tenant-org')
})

test('two modules on one route resolve deterministically: last write wins', async () => {
  resetPrecedenceDb([
    {
      rows: [
        candidateRow('module-old', { moduleVersionId: 'mv-1', updatedAt: '2026-01-01T00:00:00.000Z' }),
        candidateRow('module-new', { moduleVersionId: 'mv-2', updatedAt: '2026-02-01T00:00:00.000Z' }),
      ],
    },
  ])
  const result = await loadPageSpec('org-1', PRECEDENCE_ROUTE, registries)
  assert.ok(result)
  assert.equal(contentMarker(result), 'module-new')
  assert.equal(result.moduleVersionId, 'mv-2')
})

test('resolution reads the module pointer, so installer rows are distinguishable', async () => {
  resetPrecedenceDb([{ rows: [] }])
  await loadPageSpec('org-1', PRECEDENCE_ROUTE, registries)
  const selects = precedenceDb.queries.filter((q) => q.toLowerCase().startsWith('select'))
  assert.ok(selects.length >= 1, 'expected a select against page_specs')
  for (const q of selects) assert.match(q, /module_version_id/)
})

test('saving a tenant layout replaces a module projection instead of colliding with it', async () => {
  // The org layer holds exactly one active occupant (partial unique index),
  // so the save must deactivate the module row it replaces — excluding
  // module rows here would let the insert below violate the index and hand
  // the tenant a 500 for daring to customize an installed page.
  resetPrecedenceDb([
    { rows: [{ id: 'row-module', module_version_id: 'mv-1' }] },
    { rows: [] },
    { rows: [{ id: 'new-row' }] },
  ])
  const saved = await savePageSpec({
    orgId: 'org-1',
    actorId: 'user-1',
    route: PRECEDENCE_ROUTE,
    spec: precedenceSpec('tenant-new'),
    registries,
  })
  assert.equal(saved.ok, true)
  const updates = recordedUpdates()
  assert.ok(updates.length >= 1, 'expected a supersession update')
  for (const q of updates) assert.doesNotMatch(q, /module_version_id is null/)
  assert.ok(
    precedenceDb.queries.some((q) => q.includes('insert into audit_log')),
    'expected the replaced projection to be audited',
  )
})

test('clearing an override switches a module projection off too', async () => {
  // Clearing is the tenant choosing the built-in page over everything
  // stored; the module row survives inactive with an audit entry.
  resetPrecedenceDb([{ rows: [{ id: 'row-module' }] }])
  const cleared = await clearPageSpec({ orgId: 'org-1', actorId: 'user-1', route: PRECEDENCE_ROUTE })
  assert.equal(cleared.cleared, 1)
  const updates = recordedUpdates()
  assert.equal(updates.length, 1)
  assert.doesNotMatch(updates[0]!, /module_version_id is null/)
})

test('restoring a version replaces a module projection too', async () => {
  resetPrecedenceDb([
    { rows: [{ spec: precedenceSpec('restored'), note: null, is_active: false }] },
    { rows: [{ id: 'row-module', module_version_id: 'mv-1' }] },
    { rows: [] },
    { rows: [{ id: 'restored-row' }] },
  ])
  const restored = await restorePageSpec({
    orgId: 'org-1',
    actorId: 'user-1',
    route: PRECEDENCE_ROUTE,
    versionId: 'v-old',
    registries,
  })
  assert.equal(restored.ok, true)
  const updates = recordedUpdates()
  assert.ok(updates.length >= 1, 'expected a supersession update')
  for (const q of updates) assert.doesNotMatch(q, /module_version_id is null/)
})
