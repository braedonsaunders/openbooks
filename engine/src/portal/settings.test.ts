import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_PORTAL_SETTINGS,
  mergePortalSettings,
  returnWindowDeadline,
} from './settings.ts'
import { extractPayloadTracking } from './workspace.ts'
import { mintPortalToken, normalizePortalEmail, portalTokenHash } from './tokens.ts'

test('portal tokens hash deterministically and mint unique credentials', () => {
  assert.equal(portalTokenHash('abc'), portalTokenHash('abc'))
  assert.match(portalTokenHash('abc'), /^[0-9a-f]{64}$/)
  assert.notEqual(portalTokenHash('abc'), portalTokenHash('abd'))
  assert.notEqual(mintPortalToken(), mintPortalToken())
})

test('portal emails normalize and reject non-addresses', () => {
  assert.equal(normalizePortalEmail('  Ana@Example.COM '), 'ana@example.com')
  assert.equal(normalizePortalEmail('not-an-email'), null)
  assert.equal(normalizePortalEmail('a@b'), null)
  assert.equal(normalizePortalEmail(42), null)
})

test('portal settings default when the org never configured them', () => {
  const merged = mergePortalSettings(null)
  assert.deepEqual(merged, DEFAULT_PORTAL_SETTINGS)
  assert.equal(merged.returnWindowDays, 30)
})

test('portal settings keep an explicit off and default newer sections on', () => {
  const merged = mergePortalSettings({
    portal_name: 'Acme',
    sections: { invoices: false },
    return_window_days: 14,
    return_reasons: ['damaged'],
    return_resolutions: { refund: true, exchange: false, storeCredit: true, storeCreditBonusPercent: '5' },
    save_offers: [{ id: 'x', kind: 'pause', label: 'Pause' }],
  })
  assert.equal(merged.portalName, 'Acme')
  assert.equal(merged.sections.invoices, false)
  assert.equal(merged.sections.orders, true)
  assert.equal(merged.returnWindowDays, 14)
  assert.deepEqual(merged.returnReasons, ['damaged'])
  assert.equal(merged.returnResolutions.exchange, false)
  assert.equal(merged.returnResolutions.storeCreditBonusPercent, '5')
})

test('portal settings fall back to defaults on corrupt stored values', () => {
  const merged = mergePortalSettings({
    portal_name: '  ',
    sections: { invoices: 'yes' },
    return_window_days: -3,
    return_reasons: 'damaged',
    return_resolutions: null,
    save_offers: [{ id: '', kind: 'discount' }],
  })
  assert.equal(merged.portalName, 'Customer portal')
  assert.equal(merged.sections.invoices, true)
  assert.equal(merged.returnWindowDays, 30)
  assert.deepEqual(merged.returnReasons, DEFAULT_PORTAL_SETTINGS.returnReasons)
  assert.deepEqual(merged.saveOffers, [])
})

test('return window deadline adds whole days', () => {
  assert.equal(returnWindowDeadline('2026-01-01', 30), '2026-01-31')
  assert.equal(returnWindowDeadline('2026-01-01', 0), '2026-01-01')
})

test('fulfilment tracking reads every adapter key shape', () => {
  assert.equal(extractPayloadTracking({ tracking_number: ' 1Z5 ' }), '1Z5')
  assert.equal(extractPayloadTracking({ trackingNumber: 'ABC' }), 'ABC')
  assert.equal(extractPayloadTracking({ tracking: { number: 'N1' } }), 'N1')
  assert.equal(extractPayloadTracking({ trackings: [{ number: 'N2' }] }), 'N2')
  assert.equal(extractPayloadTracking({ trackings: [{ tracking_number: 'N3' }] }), 'N3')
  assert.equal(extractPayloadTracking({}), null)
  assert.equal(extractPayloadTracking(null), null)
  assert.equal(extractPayloadTracking({ tracking_number: '   ' }), null)
})
