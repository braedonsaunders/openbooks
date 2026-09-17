import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

// F-t09-010: lease Add-charge always 422d ('Charge tax code is invalid') and
// failed silently on a missing toast key. The form state carries an empty
// taxCodeId with no tax field, and the submit spread it verbatim while the
// server rejects '' as a non-uuid — so no CAM/parking/storage charge could
// be added. The submit must send null when unset. The toasts block never
// existed in English (the runtime merges every locale over en, and the
// property-management namespace is tracked English fallback), so the source
// block plus manifest-declared fallbacks cover all seven locales.
const MESSAGES = join(import.meta.dirname, '..', '..', '..', 'messages')
const LOCALES = ['fr', 'de', 'es', 'pt-BR', 'ja', 'zh']
const TOAST_KEYS = [
  'actionFailed', 'camPoolCreated', 'camPoolReopened', 'camPoolUpdated',
  'chargeAdded', 'couldNotLoad', 'depositPosted', 'depositReversed',
  'escalationApplied', 'escalationScheduled', 'lateFeesAssessed',
  'leaseCreated', 'leaseUpdated', 'propertyCreated', 'propertyDeleted',
  'propertyUpdated', 'rentBilled', 'unitAdded', 'unitDeleted', 'unitUpdated',
]

test('English sources every property-management toast', () => {
  const catalog = JSON.parse(readFileSync(join(MESSAGES, 'en', 'entities.json'), 'utf8')) as {
    propertyManagement?: { toasts?: Record<string, string> }
  }
  for (const key of TOAST_KEYS) {
    const label = catalog.propertyManagement?.toasts?.[key]
    assert.ok(label && label !== key, `en is missing entities.propertyManagement.toasts.${key}`)
  }
})

for (const locale of LOCALES) {
  test(`${locale} tracks the property-management toasts as English fallback`, () => {
    const manifest = JSON.parse(readFileSync(join(MESSAGES, 'untranslated-fallbacks.json'), 'utf8')) as {
      fallbacks?: Record<string, string[]>
    }
    const declared = manifest.fallbacks?.[locale] ?? []
    for (const key of TOAST_KEYS) {
      assert.ok(
        declared.includes(`entities.propertyManagement.toasts.${key}`),
        `${locale} fallback manifest is missing entities.propertyManagement.toasts.${key}`,
      )
    }
  })
}

test('the add-charge submit sends no empty tax code', () => {
  const source = readFileSync(new URL('./LeaseSections.tsx', import.meta.url), 'utf8')
  const submit = source.slice(source.indexOf('action: "addCharge"'))
  assert.match(submit, /taxCodeId: form\.taxCodeId \|\| null/)
})
