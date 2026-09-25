import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { tsImport } from 'tsx/esm/api'

type ContractDrawerModule = typeof import('./ContractDrawer.tsx')
const { contractSummaryTotals } = (await tsImport('./ContractDrawer.tsx', {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
})) as ContractDrawerModule

for (const [name, legs, expected] of [
  [
    'contract summary totals preserve exact decimal arithmetic for large values',
    [
      { planned: '900719925474.0993', recognized: '900719925474.0990' },
      { planned: '0.0004', recognized: '0.0003' },
    ],
    { recognized: '900719925474.0993', deferred: '0.0004' },
  ],
  [
    'contract summary totals retain ordinary obligation balances',
    [
      { planned: '125.5000', recognized: '25.2500' },
      { planned: '4.7500', recognized: '1.0000' },
    ],
    { recognized: '26.2500', deferred: '104.0000' },
  ],
] as Array<[string, Array<{ planned: string; recognized: string }>, { recognized: string; deferred: string }]>) {
  test(name, () => {
    assert.deepEqual(contractSummaryTotals(legs), expected)
  })
}
