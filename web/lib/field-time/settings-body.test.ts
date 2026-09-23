// Run with:  TSX_TSCONFIG_PATH="$PWD/web/tsconfig.json" node --import tsx --test web/lib/field-time/settings-body.test.ts   (from repo root)
//
// P7: PUT /api/time/settings rejected an explicit null with an unnamed 400
// ("Invalid input: expected number, received null") before the domain
// validator could name the missing rule. The transport schema now accepts
// null (null == absent) and validateFieldTimeSettings refuses each missing
// required rule by name with its remedy.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fieldTimeSettingsBody, normalizeFieldTimeSettingsBody } from './settings-body.ts'
import { validateFieldTimeSettings } from '@openbooks/engine/src/hrm/field-time/settings.ts'
import { FieldTimeError } from '@openbooks/engine/src/hrm/field-time/errors.ts'

const fullRules = {
  roundingIncrement: 15,
  roundingMode: 'nearest',
  unpaidBreakMinutes: 30,
  autoCloseHours: 16,
  signatureRequired: true,
  equipmentToleranceHours: '0.5',
  photoRequired: false,
}

test('a complete rule set parses and validates', () => {
  const parsed = fieldTimeSettingsBody.safeParse(fullRules)
  assert.equal(parsed.success, true)
  const settings = validateFieldTimeSettings(normalizeFieldTimeSettingsBody(parsed.data))
  assert.deepEqual(settings, {
    rounding: { incrementMinutes: 15, mode: 'nearest' },
    unpaidBreakMinutes: 30,
    autoCloseHours: 16,
    signatureRequired: true,
    equipmentToleranceHours: '0.5',
    photoRequired: false,
  })
})

for (const [key, code, remedy] of [
  ['roundingIncrement', 'rounding_not_declared', /Rounding is not declared.*Timesheets setup/],
  ['unpaidBreakMinutes', 'break_rule_not_declared', /unpaid break rule is not declared.*Timesheets setup/],
  ['autoCloseHours', 'auto_close_not_declared', /Auto-close is not declared.*Timesheets setup/],
] as const) {
  test(`an explicit null ${key} is refused by name with a remedy, not an unnamed type error`, () => {
    const parsed = fieldTimeSettingsBody.safeParse({ ...fullRules, [key]: null })
    assert.equal(parsed.success, true, 'null must pass the transport schema to the validator')
    assert.throws(
      () => validateFieldTimeSettings(normalizeFieldTimeSettingsBody(parsed.data)),
      (error: unknown) =>
        error instanceof FieldTimeError && error.code === code && remedy.test(error.message),
    )
  })
}

test('null mode and tolerance fall through to the documented defaults', () => {
  const parsed = fieldTimeSettingsBody.safeParse({
    ...fullRules,
    roundingMode: null,
    equipmentToleranceHours: null,
  })
  assert.equal(parsed.success, true)
  const settings = validateFieldTimeSettings(normalizeFieldTimeSettingsBody(parsed.data))
  assert.equal(settings.rounding.mode, 'nearest')
  assert.equal(settings.equipmentToleranceHours, '0.5000')
})

test('a wrong-typed key still fails at the boundary carrying its field path', () => {
  const parsed = fieldTimeSettingsBody.safeParse({ ...fullRules, autoCloseHours: '16' })
  assert.equal(parsed.success, false)
  assert.equal(parsed.error.issues[0]?.path.join('.'), 'autoCloseHours')
})

