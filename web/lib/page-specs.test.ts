import assert from 'node:assert/strict'
import { test } from 'node:test'
import { page, widgetBlock, textBlock, frame, ref, validateSpec } from '@openbooks/viewspec'
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
