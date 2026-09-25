import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { PAYMENT_RUN_POSTING_EVENT_TYPES } from '../../../../engine/src/payments/run-posting-events.ts'
import { LOCALE_CODES as LOCALES } from "../../../i18n/config"

// a failed pay-run posting rendered raw keys
// (run_posting_failed/started/completed, instruction_sent — MISSING_MESSAGE)
// with no failure reason. The engine emits these event types and stores the
// reason in the event details, so every locale must label them and the
// activity feed must surface the stored reason.
const MESSAGES = join(import.meta.dirname, '..', '..', '..', 'messages')

for (const locale of LOCALES) {
  test(`${locale} labels every payment posting event`, () => {
    const catalog = JSON.parse(readFileSync(join(MESSAGES, locale, 'payments.json'), 'utf8')) as {
      runDrawer?: { events?: Record<string, string> }
    }
    for (const key of PAYMENT_RUN_POSTING_EVENT_TYPES) {
      const label = catalog.runDrawer?.events?.[key]
      assert.ok(label && label !== key, `${locale} is missing payments.runDrawer.events.${key}`)
    }
  })
}
