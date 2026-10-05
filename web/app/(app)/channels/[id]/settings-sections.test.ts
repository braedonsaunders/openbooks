import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveSettingsSection,
  settingsSectionHref,
} from './settings-sections.ts'

describe('resolveSettingsSection', () => {
  it('honours each explicit section', () => {
    for (const key of ['connection', 'posting', 'locations', 'adspend'] as const) {
      assert.equal(resolveSettingsSection({ tab: 'settings', section: key }), key)
    }
  })

  it('falls back to posting for an unknown section', () => {
    assert.equal(resolveSettingsSection({ tab: 'settings', section: 'bogus' }), 'posting')
    assert.equal(resolveSettingsSection({ tab: 'settings' }), 'posting')
  })

  it('infers the section from legacy row deep links when section is absent', () => {
    assert.equal(resolveSettingsSection({ tab: 'settings', spendRow: 'abc' }), 'adspend')
    assert.equal(resolveSettingsSection({ tab: 'settings', locationRow: 'abc' }), 'locations')
    assert.equal(resolveSettingsSection({ tab: 'settings', mapRow: 'abc' }), 'posting')
  })

  it('prefers an explicit section over a row link from another section', () => {
    assert.equal(
      resolveSettingsSection({ tab: 'settings', section: 'posting', spendRow: 'abc' }),
      'posting',
    )
  })
})

describe('settingsSectionHref', () => {
  it('preserves unrelated filters while switching section', () => {
    const href = settingsSectionHref('ch-1', { tab: 'settings', q: 'fee', page: '2' }, 'locations')
    assert.match(href, /tab=settings/)
    assert.match(href, /section=locations/)
    assert.match(href, /q=fee/)
    assert.match(href, /page=2/)
  })

  it('clears other sections row drawers when switching section', () => {
    const href = settingsSectionHref(
      'ch-1',
      { tab: 'settings', section: 'adspend', spendRow: 'abc' },
      'locations',
    )
    assert.match(href, /section=locations/)
    assert.doesNotMatch(href, /spendRow/)
  })
})
