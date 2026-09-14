import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tsImport } from 'tsx/esm/api'

const { filed } = (await tsImport('./[id]/FilingWorksheet.tsx', {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
})) as {
  filed: (recipient: { computedAmounts: Record<string, string>; adjustments: Record<string, string> }, box: string) => string
}

test('worksheet filed figures retain exact decimal arithmetic before display rounding', () => {
  const recipient = {
    computedAmounts: { nec1: '999999999999998.1250' },
    adjustments: { nec1: '1.0000' },
  }

  assert.equal(filed(recipient, 'nec1'), '999,999,999,999,999.13')
})
