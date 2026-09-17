import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

// PartyDrawer is a client component, but its exact decimal formatter is pure.
// Resolve the app's @/ alias so this focused test can exercise that production
// helper without requiring a browser or a Next.js runtime.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}`, import.meta.url).href, context)
    }
    return nextResolve(specifier, context)
  },
})

const React = await import('react')
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const { formatCreditLimit, rememberDrawerTab } = await import('./PartyDrawer.tsx')
const drawerSource = readFileSync(new URL('./PartyDrawer.tsx', import.meta.url), 'utf8')

test('credit-limit display preserves large persisted numeric values exactly', () => {
  assert.equal(formatCreditLimit('9007199254740993.0000'), '9007199254740993.00')
})

test('credit-limit display rounds fractional cents with exact decimal arithmetic', () => {
  assert.equal(formatCreditLimit('86.6150'), '86.62')
  assert.equal(formatCreditLimit(null), '')
})

// F-t08-003: switching employee drawer tabs unmounted the payroll/wage
// panels, silently discarding unsaved profile edits. Visited compensation
// tabs must stay mounted (hidden) so their local edits survive a switch.
test('remembering a visited drawer tab keeps it without mutating the set', () => {
  const kept = rememberDrawerTab(new Set(['overview']), 'payroll')
  assert.ok(kept.has('overview'))
  assert.ok(kept.has('payroll'))
})

test('remembering an already kept tab returns the same set', () => {
  const kept = new Set(['overview', 'payroll'] as const)
  assert.equal(rememberDrawerTab(kept, 'payroll'), kept)
})

test('the drawer routes tab switches through the visit-recording helper', () => {
  assert.match(drawerSource, /rememberDrawerTab\(/)
  assert.match(drawerSource, /onClick=\{\(\) => showTab\(item\.key\)\}/)
})

test('the wage and payroll panels stay mounted once visited instead of unmounting', () => {
  assert.match(drawerSource, /keptTabs\.has\('wages'\)/)
  assert.match(drawerSource, /keptTabs\.has\('payroll'\)/)
  assert.match(drawerSource, /hidden=\{tab !== 'wages'\}/)
  assert.match(drawerSource, /hidden=\{tab !== 'payroll'\}/)
  assert.doesNotMatch(drawerSource, /\{tab === 'wages' &&/)
  assert.doesNotMatch(drawerSource, /\{tab === 'payroll' &&/)
})
