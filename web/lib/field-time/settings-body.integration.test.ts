// P7: a saved full rule set persists through the route's store shape and
// loads back through the clock gate (no field_time_not_configured). Lives
// here — not in settings-body.test.ts — because the DB partition only runs
// *.integration.test.ts, and a DB test anywhere else is skipped forever.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { fieldTimeSettingsBody, normalizeFieldTimeSettingsBody } from './settings-body.ts'
import {
  loadFieldTimeSettings,
  validateFieldTimeSettings,
} from '@openbooks/engine/src/hrm/field-time/settings.ts'
import { db, withBypassContext } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'

test('a saved full rule set loads back through the clock gate', async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const parsed = fieldTimeSettingsBody.safeParse({
        roundingIncrement: 15,
        roundingMode: 'nearest',
        unpaidBreakMinutes: 30,
        autoCloseHours: 16,
        signatureRequired: true,
        equipmentToleranceHours: '0.5',
        photoRequired: false,
      })
      assert.equal(parsed.success, true)
      const settings = validateFieldTimeSettings(normalizeFieldTimeSettingsBody(parsed.data))
      // The route's exact store statement (web/app/api/time/settings/route.ts):
      // validated settings persist flat under settings->'fieldTime'.
      await db.execute(sql`
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
         where id = ${org.orgId}`)
      // ...and the clock gate that refused field_time_not_configured now loads.
      const loaded = await loadFieldTimeSettings(org.orgId)
      assert.equal(loaded.rounding.incrementMinutes, 15)
      assert.equal(loaded.rounding.mode, 'nearest')
      assert.equal(loaded.unpaidBreakMinutes, 30)
      assert.equal(loaded.autoCloseHours, 16)
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})
