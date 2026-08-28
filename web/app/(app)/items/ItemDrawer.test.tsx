import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tsImport } from 'tsx/esm/api'

const source = readFileSync(new URL('./ItemDrawer.tsx', import.meta.url), 'utf8')
const { preserveItemDecimal } = await tsImport('./ItemDrawer.tsx', {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
}) as { preserveItemDecimal: (value: unknown) => string }

test('item financial fields preserve exact decimal text through an unrelated edit', () => {
  const item = {
    default_rate: '1.2345',
    default_cost: '9.8765',
    standalone_selling_price: '12.3400',
  }

  const formValues = {
    defaultRate: preserveItemDecimal(item.default_rate),
    defaultCost: preserveItemDecimal(item.default_cost),
    standaloneSellingPrice: preserveItemDecimal(item.standalone_selling_price),
  }
  const savePayload = {
    description: 'updated without changing the rates',
    defaultRate: formValues.defaultRate || null,
    defaultCost: formValues.defaultCost || null,
    standaloneSellingPrice: formValues.standaloneSellingPrice || null,
  }

  assert.deepEqual(savePayload, {
    description: 'updated without changing the rates',
    defaultRate: '1.2345',
    defaultCost: '9.8765',
    standaloneSellingPrice: '12.3400',
  })
  assert.equal(preserveItemDecimal(null), '')
  assert.equal(preserveItemDecimal(1.2345), '1.2345')
})

test('the drawer initializes and resets all persisted rates without numeric rounding', () => {
  assert.match(source, /preserveItemDecimal\(it\.default_rate\)/g)
  assert.match(source, /preserveItemDecimal\(it\.default_cost\)/g)
  assert.match(source, /preserveItemDecimal\(it\.standalone_selling_price\)/g)
  assert.match(source, /defaultRate: defaultRate \|\| null/)
  assert.match(source, /defaultCost: defaultCost \|\| null/)
  assert.match(source, /standaloneSellingPrice: standaloneSellingPrice \|\| null/)
  assert.doesNotMatch(source, /Number\(it\.(default_rate|default_cost|standalone_selling_price)\)\.toFixed\(2\)/)
})
