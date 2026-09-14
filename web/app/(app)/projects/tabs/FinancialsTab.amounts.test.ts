import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tsImport } from 'tsx/esm/api'

const { shouldHideFinancialLine } = (await tsImport('./FinancialsTab.tsx', {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
})) as { shouldHideFinancialLine: (hideWhenZero: boolean, value: string | number) => boolean }

test('financial profiles hide decimal-string zero lines', () => {
  assert.equal(shouldHideFinancialLine(true, '0.0000'), true)
  assert.equal(shouldHideFinancialLine(true, '0.0001'), false)
  assert.equal(shouldHideFinancialLine(false, '0.0000'), false)
})
