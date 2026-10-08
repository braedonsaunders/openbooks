import assert from 'node:assert/strict'
import test from 'node:test'
import { aiSettingsDestination } from './ai-settings-links'

test('provider navigation stays on the provider page without policy context', () => {
  assert.equal(aiSettingsDestination({}), null)
  assert.equal(aiSettingsDestination({ provider: 'anthropic' }), null)
})

test('legacy policy drawers retain selected record and edit context in native Setup', () => {
  const href = aiSettingsDestination({ row: 'org-policy', mode: 'edit', section: 'drafting', page: '2' })!
  const url = new URL(href, 'https://example.test')
  assert.equal(url.pathname, '/admin/setup/ai-rails-settings')
  assert.equal(url.searchParams.get('row'), 'org-policy')
  assert.equal(url.searchParams.get('mode'), 'edit')
  assert.equal(url.searchParams.get('section'), 'drafting')
  assert.equal(url.searchParams.get('page'), '2')
})

test('legacy activity filters lead to the paginated native activity body', () => {
  const href = aiSettingsDestination({ tab: 'decisions', capabilityKey: 'hrmDrafting', outcome: 'accepted', page: '3' })!
  const url = new URL(href, 'https://example.test')
  assert.equal(url.pathname, '/admin/setup/ai-capabilities')
  assert.equal(url.searchParams.get('tab'), 'activity')
  assert.equal(url.searchParams.get('capabilityKey'), 'hrmDrafting')
  assert.equal(url.searchParams.get('outcome'), 'accepted')
  assert.equal(url.searchParams.get('page'), '3')
})
