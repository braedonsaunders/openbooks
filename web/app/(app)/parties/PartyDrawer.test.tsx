import assert from 'node:assert/strict'
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

const { formatCreditLimit } = await import('./PartyDrawer.tsx')

test('credit-limit display preserves large persisted numeric values exactly', () => {
  assert.equal(formatCreditLimit('9007199254740993.0000'), '9007199254740993.00')
})

test('credit-limit display rounds fractional cents with exact decimal arithmetic', () => {
  assert.equal(formatCreditLimit('86.6150'), '86.62')
  assert.equal(formatCreditLimit(null), '')
})
