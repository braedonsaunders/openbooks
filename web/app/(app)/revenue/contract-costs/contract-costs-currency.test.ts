import assert from 'node:assert/strict'
import test from 'node:test'

const { currencyExponent, ContractCostError } = await import('@openbooks/engine/revenue')

function runner(rows: { minor_units: unknown }[]) {
  return { execute: async () => ({ rows }) }
}

/**
 * Display exponents come from the ISO registry, never a 2dp guess: a
 * zero-decimal currency reads 0, while a missing row or a damaged
 * precision (null, non-integer, out of range) refuses by name with the
 * lifecycle-safe conditional remedy — the seed restores supported rows
 * without touching history, and a legacy code the seed cannot carry goes
 * to original-currency evidence review, never reinterpretation.
 */
test('currency exponents come from the registry and refuse unknown codes', async () => {
  assert.equal(await currencyExponent(runner([{ minor_units: 0 }]), 'JPY'), 0)
  assert.equal(await currencyExponent(runner([{ minor_units: 2 }]), 'USD'), 2)
  for (const code of ['BHD', 'RHD']) {
    await assert.rejects(() => currencyExponent(runner([]), code), (error: unknown) => {
      assert.ok(error instanceof ContractCostError)
      assert.equal(error.code, 'contract_cost_currency_unknown')
      assert.match(error.message, new RegExp(code))
      assert.match(error.remedy, /seedCurrencies/)
      assert.match(error.remedy, /without changing posted history/)
      assert.match(error.remedy, /original-currency evidence/)
      assert.match(error.remedy, /without reinterpreting posted costs/)
      return true
    })
  }
  for (const [label, precision] of [
    ['null', null],
    ['non-integer', 2.5],
    ['negative', -1],
    ['past ledger precision', 5],
  ] as const) {
    await assert.rejects(
      () => currencyExponent(runner([{ minor_units: precision }]), 'BHD'),
      (error: unknown) => {
        assert.ok(error instanceof ContractCostError, `${label} precision refuses`)
        assert.equal(error.code, 'contract_cost_currency_exponent')
        assert.match(error.message, /BHD/)
        assert.match(error.remedy, /seedCurrencies/)
        return true
      },
    )
  }
})
