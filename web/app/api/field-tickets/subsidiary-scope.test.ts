import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

function source(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), 'utf8')
}

test('the ticket list narrows to the caller subsidiary scope like every documents list', () => {
  const src = source('app/api/field-tickets/route.ts')
  assert.match(src, /gate\.allowedSubsidiaryIds/, 'the list must read the caller scope')
  assert.match(src, /d\.subsidiary_id = any\(/, 'restricted callers see only their subsidiaries')
  assert.match(src, /and false/, 'an empty scope sees nothing')
})

test('opening a ticket under a project crosses the project subsidiary boundary', () => {
  const src = source('app/api/field-tickets/route.ts')
  const lookup = src.indexOf('from projects p')
  const create = src.indexOf('createFieldTicket(')
  assert.ok(lookup >= 0 && lookup < create, 'the project subsidiary must resolve before creation')
  assert.match(src, /guardSubsidiaryScope\([\s\S]*?scopedProject|guardSubsidiaryScope\([\s\S]*?subsidiaryId/)
})
