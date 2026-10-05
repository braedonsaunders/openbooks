import assert from 'node:assert/strict'
import test from 'node:test'

const { currencyExponent, ContractCostError } = await import('@openbooks/engine/revenue')

function runner(rows: { minor_units: number }[]) {
  return { execute: async () => ({ rows }) }
}

/**
 * Display exponents come from the ISO registry, never a 2dp guess: a
 * zero-decimal currency reads 0 and a missing row refuses by name with the
 * read-only-registry remedy.
 */
test('currency exponents come from the registry and refuse unknown codes', async () => {
  assert.equal(await currencyExponent(runner([{ minor_units: 0 }]), 'JPY'), 0)
  assert.equal(await currencyExponent(runner([{ minor_units: 2 }]), 'USD'), 2)
  await assert.rejects(() => currencyExponent(runner([]), 'BHD'), (error: unknown) => {
    assert.ok(error instanceof ContractCostError)
    assert.equal(error.code, 'contract_cost_currency_unknown')
    assert.match(error.message, /BHD/)
    assert.match(error.remedy, /ISO registry/)
    return true
  })
})
