import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { resolveNullSubsidiaryInclusion } = await import('./consolidation')

/**
 * Pure root-owned rule: document-side readers built from subsidiary-context
 * ids match null-subsidiary rows exactly when the caller is unrestricted AND
 * the viewed set contains the org root. (Database behavior — the aging
 * tie-out, the empty-scope guard — is pinned in
 * aging-null-subsidiary.integration.test.ts.)
 */
test('unrestricted root-covering views include root-owned rows', () => {
  assert.equal(resolveNullSubsidiaryInclusion(null, 'root', ['root', 'branch']), true)
  assert.equal(resolveNullSubsidiaryInclusion(null, 'root', ['root']), true)
})

test('explicitly branch-scoped views hide root-owned rows like their cell', () => {
  assert.equal(resolveNullSubsidiaryInclusion(null, 'root', ['branch']), false)
  assert.equal(resolveNullSubsidiaryInclusion(null, 'root', []), false)
})

test('restricted callers stay fail-closed at any visibility', () => {
  assert.equal(resolveNullSubsidiaryInclusion(new Set(['root', 'branch']), 'root', ['root', 'branch']), false)
  assert.equal(resolveNullSubsidiaryInclusion(new Set(['root']), 'root', ['root']), false)
  assert.equal(resolveNullSubsidiaryInclusion(new Set(['branch']), 'root', ['branch']), false)
  assert.equal(resolveNullSubsidiaryInclusion(new Set(), 'root', []), false)
})

test('a missing root keeps the unrestricted unaffected behavior', () => {
  assert.equal(resolveNullSubsidiaryInclusion(null, undefined, ['a']), true)
})
