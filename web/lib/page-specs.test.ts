import assert from 'node:assert/strict'
import { test } from 'node:test'
import { page, widgetBlock, textBlock, frame, ref, validateSpec } from '@braedonsaunders/appkit-viewspec'
import { validateAgainstRegistries } from './page-spec-validate'

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
