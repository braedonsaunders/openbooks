import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Only the RSC bundling marker is replaced; policy and error translation are real.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    return nextResolve(specifier, context)
  },
})
const { DocumentEditError } = await import('@openbooks/engine/src/records/document-edit-policy.ts')
const { domainFailure } = await import('./application/documents.ts')
const { ApplicationError } = await import('./application/errors.ts')
hooks.deregister()

test('application preserves engine refusal status, details and remedy', () => {
  const refusal = new DocumentEditError(409, 'reload and review the latest revision', { revision: 'stale' })
  assert.deepEqual(refusal.fieldErrors, { revision: 'stale' })
  assert.throws(() => domainFailure(refusal), (error: unknown) => error instanceof ApplicationError
    && error.status === 409 && error.message === refusal.message)
})

test('web editor owns edits without forwarding engine policies or reads', () => {
  const source = readFileSync(new URL('./documents.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /export\s+(?:type\s+)?\{[\s\S]*?\}\s+from/)
  assert.doesNotMatch(source, /export\s+async\s+function\s+loadDocument\b/)
})
