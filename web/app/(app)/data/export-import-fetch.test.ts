import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const exportClient = readFileSync(join(dir, 'export/ExportClient.tsx'), 'utf8')
const importWizard = readFileSync(join(dir, 'import/ImportWizard.tsx'), 'utf8')
const customField = readFileSync(join(dir, '../../../components/custom-field-input.tsx'), 'utf8')

function assertGuardedFetch(source: string, urlNeedle: string) {
  const at = source.indexOf(urlNeedle)
  assert.ok(at > -1, `${urlNeedle} must be fetched`)
  const after = source.slice(at)
  const guard = after.search(/if \(!r\.ok\)|if \(!res\.ok\)/)
  const parse = after.search(/r\.json\(\)|res\.json\(\)/)
  assert.ok(guard > -1 && guard < 400, `${urlNeedle} must check status`)
  assert.ok(parse > guard, `${urlNeedle} must parse only after the status check`)
  assert.match(after.slice(0, 500), /readApiErrorMessage/)
}

test('export, import, and custom-field option lists check status before json()', () => {
  assertGuardedFetch(exportClient, "'/api/data/resources'")
  assertGuardedFetch(exportClient, '`/api/data/resources?key=')
  assertGuardedFetch(importWizard, "'/api/data/resources'")
  assertGuardedFetch(importWizard, "'/api/data/sample-companies'")
  assertGuardedFetch(customField, '`/api/forms/options?')
})
