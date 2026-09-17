import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

// F-t04-007: a failed pay-run posting rendered raw keys
// (run_posting_failed/started/completed, instruction_sent — MISSING_MESSAGE)
// with no failure reason. The engine emits these event types and stores the
// reason in the event details, so every locale must label them and the
// activity feed must surface the stored reason.
const MESSAGES = join(import.meta.dirname, '..', '..', '..', 'messages')
const LOCALES = ['en', 'fr', 'de', 'es', 'pt-BR', 'ja', 'zh']
const EVENT_KEYS = [
  'run_posting_started',
  'run_posting_completed',
  'run_posting_failed',
  'run_posting_recovered',
  'instruction_sent',
]

for (const locale of LOCALES) {
  test(`${locale} labels every payment posting event`, () => {
    const catalog = JSON.parse(readFileSync(join(MESSAGES, locale, 'payments.json'), 'utf8')) as {
      runDrawer?: { events?: Record<string, string> }
    }
    for (const key of EVENT_KEYS) {
      const label = catalog.runDrawer?.events?.[key]
      assert.ok(label && label !== key, `${locale} is missing payments.runDrawer.events.${key}`)
    }
  })
}

test('the run activity feed surfaces the stored failure reason', () => {
  const source = readFileSync(new URL('./RunDrawer.tsx', import.meta.url), 'utf8')
  assert.match(source, /event\.details/, 'activity events must carry their details')
})
