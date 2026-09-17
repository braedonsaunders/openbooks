import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// F-t10-001: a blank Recoverable % on a new tax code was refused with the
// raw key `invalid-recoverable-percent`. Blank keepDefault inputs must fall
// through to the default (F-t06-022) the same way the coerce layer treats
// them — the integrity check read the raw body instead. The validator takes
// an executor; the create-blank path must never touch storage, so the stub
// throws on any query. Only server-only is stubbed.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { validateEntityIntegrity } = await import('./write.ts')

import type { SetupEntity } from './registry.ts'

const TAX_CODES = { key: 'tax-codes', fields: [] } as unknown as SetupEntity
const ORG = '019f5ea3-44c5-72c0-ad3b-ef34c19c8763'

function noStorage() {
  return {
    execute: () => {
      throw new Error('blank create input must not query storage')
    },
  } as never
}

test('a blank recoverable percent falls through to the default', async () => {
  assert.equal(
    await validateEntityIntegrity(TAX_CODES, { recoverablePercent: '' }, ORG, undefined, noStorage()),
    null,
    'blank behaves like absent (100%)',
  )
  assert.equal(
    await validateEntityIntegrity(TAX_CODES, {}, ORG, undefined, noStorage()),
    null,
    'absent stays accepted',
  )
})

test('an out-of-range recoverable percent is still refused with its key', async () => {
  assert.equal(
    await validateEntityIntegrity(TAX_CODES, { recoverablePercent: '150' }, ORG, undefined, noStorage()),
    'invalid-recoverable-percent',
    'the drawer maps this key to human copy',
  )
})

