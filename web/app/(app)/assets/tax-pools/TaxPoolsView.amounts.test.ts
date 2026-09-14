import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tsImport } from 'tsx/esm/api'

const { formatTaxPoolAmount } = (await tsImport('./TaxPoolsView.tsx', {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
})) as { formatTaxPoolAmount: (value: string, locale: string) => string }

test('tax-pool amounts round exact decimal text only at display time', () => {
  assert.equal(
    formatTaxPoolAmount('9007199254740992.1250', 'en-US'),
    '9,007,199,254,740,992.13',
  )
})
