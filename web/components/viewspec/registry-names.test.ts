import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FRAME_NAMES, WIDGET_NAMES } from './registry-names'

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only' || specifier.endsWith('.css')) {
      return { shortCircuit: true, url: 'data:text/javascript,' }
    }
    return next(specifier, context)
  },
})
const { WIDGET_REGISTRY } = await import('./widgets')
const { FRAME_REGISTRY } = await import('./blocks')

test('WIDGET_NAMES mirrors the composed WIDGET_REGISTRY exactly', () => {
  const actual = Object.keys(WIDGET_REGISTRY)
  assert.deepEqual({
    missing: actual.filter((name) => !WIDGET_NAMES.has(name)),
    extra: [...WIDGET_NAMES].filter((name) => !actual.includes(name)),
  }, { missing: [], extra: [] })
})

test('FRAME_NAMES mirrors FRAME_REGISTRY exactly', () => {
  const actual = Object.keys(FRAME_REGISTRY)
  assert.deepEqual({ missing: actual.filter((name) => !FRAME_NAMES.has(name)), extra: [...FRAME_NAMES].filter((name) => !actual.includes(name)) }, { missing: [], extra: [] })
})

test('every registry name is a slug the spec schema accepts', () => {
  for (const name of [...WIDGET_NAMES, ...FRAME_NAMES]) assert.match(name, /^[a-z][a-z0-9-]*$/, `${name} cannot be named by a spec`)
})
