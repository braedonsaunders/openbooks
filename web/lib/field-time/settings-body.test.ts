// Run with:  TSX_TSCONFIG_PATH="$PWD/web/tsconfig.json" node --import tsx --test web/lib/field-time/settings-body.test.ts   (from repo root)
//
// P7: PUT /api/time/settings rejected an explicit null with an unnamed 400
// ("Invalid input: expected number, received null") before the domain
// validator could name the missing rule. The transport schema now accepts
// null (null == absent) and validateFieldTimeSettings refuses each missing
// required rule by name with its remedy.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { fieldTimeSettingsBody, normalizeFieldTimeSettingsBody } from './settings-body.ts'
import {
  loadFieldTimeSettings,
  validateFieldTimeSettings,
} from '@openbooks/engine/src/hrm/field-time/settings.ts'
import { FieldTimeError } from '@openbooks/engine/src/hrm/field-time/errors.ts'
import { db, env, withBypass } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'

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

test('a saved full rule set loads back through the clock gate', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const parsed = fieldTimeSettingsBody.safeParse(fullRules)
    assert.equal(parsed.success, true)
    const settings = validateFieldTimeSettings(normalizeFieldTimeSettingsBody(parsed.data))
    // The route's exact store statement (web/app/api/time/settings/route.ts):
    // validated settings persist flat under settings->'fieldTime'.
    await withBypass(
      () => db.execute(sql`
        update orgs
           set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{fieldTime}', ${JSON.stringify({
             roundingIncrement: settings.rounding.incrementMinutes,
             roundingMode: settings.rounding.mode,
             unpaidBreakMinutes: settings.unpaidBreakMinutes,
             autoCloseHours: settings.autoCloseHours,
             signatureRequired: settings.signatureRequired,
             equipmentToleranceHours: settings.equipmentToleranceHours,
             photoRequired: settings.photoRequired,
           })}::jsonb),
               updated_at = now()
         where id = ${org.orgId}`),
    )
    // ...and the clock gate that refused field_time_not_configured now loads.
    const loaded = await withBypass(() => loadFieldTimeSettings(org.orgId))
    assert.equal(loaded.rounding.incrementMinutes, 15)
    assert.equal(loaded.rounding.mode, 'nearest')
    assert.equal(loaded.unpaidBreakMinutes, 30)
    assert.equal(loaded.autoCloseHours, 16)
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
