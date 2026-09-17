import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * F-t07-003: the drawer renders Submit / Approve / Reject buttons with
 * confirm dialogs and feedback toasts through budgets.actions.*,
 * budgets.confirm.* and budgets.feedback.*. A missing key renders the raw
 * key path on the button, so every key the drawer uses must exist in every
 * locale.
 */
const LOCALES = ['en', 'es', 'fr', 'de', 'ja', 'pt-BR', 'zh'] as const
const KEYS: Record<string, string[]> = {
  actions: ['submit', 'approve', 'reject'],
  confirm: ['submit', 'approve', 'reject'],
  feedback: ['submitted', 'approved', 'rejected'],
}

test('budget approval buttons, confirms and feedback exist in every locale', () => {
  const missing: string[] = []
  for (const locale of LOCALES) {
    const catalog = JSON.parse(
      readFileSync(new URL(`../messages/${locale}/budgets.json`, import.meta.url), 'utf8'),
    ) as Record<string, Record<string, unknown>>
    for (const [block, keys] of Object.entries(KEYS)) {
      for (const key of keys) {
        const value = catalog[block]?.[key]
        if (typeof value !== 'string' || !value.trim()) missing.push(`${locale}:budgets.${block}.${key}`)
      }
    }
  }
  assert.deepEqual(missing, [], `budget approval copy missing:\n${missing.join('\n')}`)
})
