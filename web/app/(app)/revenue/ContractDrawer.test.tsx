import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { tsImport } from 'tsx/esm/api'

type ContractDrawerModule = typeof import('./ContractDrawer.tsx')
const { contractSummaryTotals } = (await tsImport('./ContractDrawer.tsx', {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
})) as ContractDrawerModule

test('contract summary totals preserve exact decimal arithmetic for large values', () => {
  assert.deepEqual(
    contractSummaryTotals([
      { planned: '900719925474.0993', recognized: '900719925474.0990' },
      { planned: '0.0004', recognized: '0.0003' },
    ]),
    { recognized: '900719925474.0993', deferred: '0.0004' },
  )
})

test('contract summary totals retain ordinary obligation balances', () => {
  assert.deepEqual(
    contractSummaryTotals([
      { planned: '125.5000', recognized: '25.2500' },
      { planned: '4.7500', recognized: '1.0000' },
    ]),
    { recognized: '26.2500', deferred: '104.0000' },
  )
})
