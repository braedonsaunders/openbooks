import assert from 'node:assert/strict'
import test from 'node:test'
import { countryTimeZoneDirectory, listCanonicalTimeZones } from '@openbooks/engine/src/platform/time-zone.ts'
import { defaultBusinessTimeZone, sameTimeZone } from './time-zone-default'

const directory = countryTimeZoneDirectory(['US', 'CA', 'JP', 'AQ', 'BV'])
const offered = new Set(listCanonicalTimeZones())
const zone = (name: string) => new Intl.DateTimeFormat('en-CA', { timeZone: name }).resolvedOptions().timeZone

test('a US company set up from a Toronto browser starts on a US zone, not Toronto', () => {
  const chosen = defaultBusinessTimeZone({ country: 'US', browserZone: 'America/Toronto', directory, offered })
  assert.equal(chosen, zone('America/New_York'))
  assert.notEqual(chosen, zone('America/Toronto'))
})

test('the browser zone wins when it belongs to the chosen country', () => {
  assert.equal(
    defaultBusinessTimeZone({ country: 'US', browserZone: 'America/Chicago', directory, offered }),
    zone('America/Chicago'),
  )
  assert.equal(
    defaultBusinessTimeZone({ country: 'CA', browserZone: 'America/Vancouver', directory, offered }),
    zone('America/Vancouver'),
  )
  // An alias spelling of a member zone still counts as the country's own.
  assert.equal(
    defaultBusinessTimeZone({ country: 'US', browserZone: 'US/Central', directory, offered }),
    zone('America/Chicago'),
  )
})

test('with no usable browser zone the country primary is chosen', () => {
  assert.equal(defaultBusinessTimeZone({ country: 'CA', browserZone: null, directory, offered }), zone('America/Toronto'))
  assert.equal(defaultBusinessTimeZone({ country: 'JP', browserZone: 'Europe/Paris', directory, offered }), zone('Asia/Tokyo'))
})

test('a country without zones falls back to the browser zone, then UTC', () => {
  assert.equal(defaultBusinessTimeZone({ country: 'BV', browserZone: 'Europe/Oslo', directory, offered }), zone('Europe/Oslo'))
  assert.equal(defaultBusinessTimeZone({ country: 'BV', browserZone: 'Not/AZone', directory, offered }), 'UTC')
  assert.equal(defaultBusinessTimeZone({ country: 'XX', browserZone: null, directory, offered }), 'UTC')
})

test('the default is always a zone the picker offers', () => {
  const narrow = new Set(['UTC', zone('America/Chicago')])
  assert.equal(defaultBusinessTimeZone({ country: 'US', browserZone: null, directory, offered: narrow }), zone('America/Chicago'))
  assert.equal(defaultBusinessTimeZone({ country: 'JP', browserZone: null, directory, offered: new Set(['UTC']) }), 'UTC')
})

test('zone aliases compare equal through the runtime', () => {
  assert.equal(sameTimeZone('US/Eastern', 'America/New_York'), true)
  assert.equal(sameTimeZone('America/Toronto', 'America/New_York'), false)
  assert.equal(sameTimeZone('Not/AZone', 'UTC'), false)
})
