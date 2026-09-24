import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgingData } from './view'

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    // Platform boundary, not our own module: lets the unit partition import
    // the pure spec builder without a Next server runtime.
    if (specifier === 'server-only') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default {}',
      }
    }
    return next(specifier, context)
  },
})

const { agingSpec } = await import('./view')

// F-t07-011: the Export button built its URL from the raw page params, so
// the screen's resolved as-of never reached the endpoint — the CSV aged as
// of the fiscal year end while the screen showed today. The loader carries
// its resolved as-of into the export params; this test pins the spec half:
// whatever the screen resolved (including the as-of) must reach the export
// menu unchanged. (Resolving the as-of needs a database and has no unit
// interface.)
test('the export menu receives the screen params including the resolved as-of', () => {
  const exportParams = { period: 'custom', asOf: '2026-09-30', side: 'ar' }
  const spec = agingSpec({ exportParams } as unknown as AgingData)
  const found: Record<string, unknown>[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (typeof node === 'object' && node !== null) {
      found.push(node as Record<string, unknown>)
      for (const value of Object.values(node)) visit(value)
    }
  }
  visit((spec as { header: unknown }).header)
  const menu = found.find((block) => block.widget === 'export-menu')
  assert.ok(menu, 'the export menu must be on the page')
  assert.deepEqual(
    (menu.props as Record<string, unknown>).params,
    exportParams,
    'the export must run against the screen-resolved params, not just the raw page params',
  )
})
