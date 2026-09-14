import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tsImport } from 'tsx/esm/api'

const { preserveChargeRate } = (await tsImport('./ChargesSection.tsx', {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
})) as { preserveChargeRate: (value: unknown) => string }

test('selecting an item keeps its exact persisted charge rate', () => {
  assert.equal(preserveChargeRate('999999999999999.1250'), '999999999999999.1250')
  assert.equal(preserveChargeRate(null), '')
})
