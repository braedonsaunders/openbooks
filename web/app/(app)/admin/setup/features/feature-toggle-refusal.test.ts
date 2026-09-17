import assert from 'node:assert/strict'
import test from 'node:test'
import { featureToggleRefusalMessage } from './feature-tree'

// F-t01-015: the toggle refusal must resolve to a localized message for
// every typed body the route can send — and to the generic blocked message
// (never a raw code, never silence) for anything else.
const t = (key: string, params?: Record<string, string>) =>
  `${key}::${JSON.stringify(params ?? {})}`

test('a dependency refusal names the required features', () => {
  assert.equal(
    featureToggleRefusalMessage({ error: 'feature-dependency', key: 'mcpAccess', requiredKeys: ['apiAccess'] }, t),
    'setup.features.errors.dependency::{"features":"features.apiAccess.title::{}"}',
  )
})

test('a dependents refusal names the still-enabled dependents', () => {
  assert.equal(
    featureToggleRefusalMessage(
      { error: 'feature-dependents-enabled', key: 'apiAccess', dependentKeys: ['mcpAccess'] },
      t,
    ),
    'setup.features.errors.dependents::{"features":"features.mcpAccess.title::{}"}',
  )
})

test('a blocked refusal and every malformed body fall back to the generic message', () => {
  assert.equal(
    featureToggleRefusalMessage({ error: 'feature-blocked', key: 'multiSubsidiary' }, t),
    'setup.features.errors.blocked::{}',
  )
  for (const payload of [{}, null, undefined, 'boom', { error: 'something-new' }, { error: null }]) {
    assert.equal(featureToggleRefusalMessage(payload, t), 'setup.features.errors.blocked::{}')
  }
})

test('non-string key entries never reach the translator', () => {
  assert.equal(
    featureToggleRefusalMessage(
      { error: 'feature-dependents-enabled', key: 'apiAccess', dependentKeys: ['mcpAccess', 42, null] },
      t,
    ),
    'setup.features.errors.dependents::{"features":"features.mcpAccess.title::{}"}',
  )
  assert.equal(
    featureToggleRefusalMessage({ error: 'feature-dependency', key: 'x' }, t),
    'setup.features.errors.dependency::{"features":""}',
  )
})
