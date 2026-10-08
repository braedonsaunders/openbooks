import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FRAME_NAMES, WIDGET_NAMES } from './registry-names'
import { WIDGET_FAMILIES, WIDGET_FAMILY } from './widget-index'
import { UnknownWidgetError, loadWidgetFamily, renderWidget } from './widget-loader'

const { WIDGET_REGISTRY } = await import('./widgets')
const { FRAME_REGISTRY } = await import('./blocks')

test('WIDGET_NAMES mirrors the composed WIDGET_REGISTRY exactly', () => {
  const actual = Object.keys(WIDGET_REGISTRY)
  assert.deepEqual({
    missing: actual.filter((name) => !WIDGET_NAMES.has(name)),
    extra: [...WIDGET_NAMES].filter((name) => !actual.includes(name)),
  }, { missing: [], extra: [] })
})

test('the widget index names the one family that defines each registered widget', async () => {
  const defined = new Map<string, string>()
  const duplicates: string[] = []
  for (const family of WIDGET_FAMILIES) {
    for (const name of Object.keys(await loadWidgetFamily(family))) {
      if (defined.has(name)) duplicates.push(`${name}: ${defined.get(name)}, ${family}`)
      defined.set(name, family)
    }
  }
  assert.deepEqual(duplicates, [], 'a widget name must belong to exactly one family')
  assert.deepEqual([...defined.keys()].sort(), Object.keys(WIDGET_REGISTRY).sort(), 'the families must compose the registry')
  const stale = [...defined]
    .filter(([name, family]) => WIDGET_FAMILY[name] !== family)
    .map(([name, family]) => `  '${name}': '${family}',`)
  const extra = Object.keys(WIDGET_FAMILY).filter((name) => !defined.has(name))
  assert.deepEqual({ stale, extra }, { stale: [], extra: [] }, 'update widget-index.ts with the listed entries')
})

test('an unknown widget name refuses before any family loads', () => {
  for (const name of ['frobnicator', 'constructor', '__proto__']) {
    assert.throws(() => renderWidget(name, {}), UnknownWidgetError, name)
  }
})

test('FRAME_NAMES mirrors FRAME_REGISTRY exactly', () => {
  const actual = Object.keys(FRAME_REGISTRY)
  assert.deepEqual({ missing: actual.filter((name) => !FRAME_NAMES.has(name)), extra: [...FRAME_NAMES].filter((name) => !actual.includes(name)) }, { missing: [], extra: [] })
})

test('every registry name is a slug the spec schema accepts', () => {
  for (const name of [...WIDGET_NAMES, ...FRAME_NAMES]) assert.match(name, /^[a-z][a-z0-9-]*$/, `${name} cannot be named by a spec`)
})
