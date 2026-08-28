import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { getRecordType } from '../src/registry.ts'

const MESSAGES = join(import.meta.dirname, '..', '..', '..', 'web', 'messages')

const locales = readdirSync(MESSAGES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

function resolveMessage(catalog: unknown, labelKey: string): unknown {
  return labelKey.split('.').reduce<unknown>((value, key) => {
    if (value === null || typeof value !== 'object') return undefined
    return (value as Record<string, unknown>)[key]
  }, catalog)
}

test('field-ticket pending status resolves in every supported locale', () => {
  assert.ok(locales.includes('en'), 'English is the source catalog and must exist')

  const fieldTicket = getRecordType('field_ticket')
  assert.ok(fieldTicket)

  const statusFilter = fieldTicket.listFilters.find((filter) => filter.key === 'status')
  assert.ok(statusFilter)

  const pendingOption = statusFilter.options?.find((option) => option.value === 'pending_approval')
  assert.ok(pendingOption)
  assert.equal(pendingOption.labelKey, 'common.status.pendingApproval')

  const missingLocales = locales.filter((locale) => {
    const common = JSON.parse(readFileSync(join(MESSAGES, locale, 'common.json'), 'utf8')) as unknown
    const label = resolveMessage(common, pendingOption.labelKey.replace(/^common\./, ''))
    return typeof label !== 'string' || label.trim() === ''
  })

  assert.deepEqual(
    missingLocales,
    [],
    `field-ticket pending status is missing from: ${missingLocales.join(', ')}`,
  )
})
