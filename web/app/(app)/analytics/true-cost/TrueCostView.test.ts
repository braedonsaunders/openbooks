import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TrueCostView.tsx'), 'utf8')

test('True Cost mutations check status before parsing and toast the server body', () => {
  assert.match(source, /readApiErrorMessage/)
  assert.match(source, /if \(!res\.ok\) return \{ ok: false, error: await readApiErrorMessage/)
  assert.match(source, /toast\.error\(result\.error\)/)
  assert.match(source, /else router\.refresh\(\)/)
  assert.doesNotMatch(source, /Promise<boolean>/)
  assert.match(source, /reload and review/)
})
