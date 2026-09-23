import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string) => readFileSync(join(webRoot, path), 'utf8')

// d6cd4b71e moved rate resolution into a `let resolved` try/catch (FX
// refusals map to 422 with the remedy). The money invariant did not move:
// every persisted cost/bill quantity, rate and amount passes through
// canonicalDecimal THEN normalizeMoney — never a raw String() coercion and
// never a bare normalizeMoney that skips the exactness refusal.
function helperSpan(charges: string, name: string): [number, number] {
  const start = charges.indexOf(`function ${name}`)
  assert.ok(start >= 0, `${name} helper is defined`)
  const end = charges.indexOf('\n}', start)
  assert.ok(end > start, `${name} helper body ends`)
  return [start, end + 2]
}

test('project-charge money helpers refuse inexact input before normalizing', () => {
  const charges = source('lib/project-charges.ts')
  const [moneyStart, moneyEnd] = helperSpan(charges, 'exactMoney')
  const money = charges.slice(moneyStart, moneyEnd)
  const canonicalAt = money.indexOf('canonicalDecimal(value, 4)')
  const normalizeAt = money.indexOf('normalizeMoney(exact)')
  assert.ok(canonicalAt >= 0, 'exactMoney parses with canonicalDecimal(value, 4)')
  assert.ok(normalizeAt > canonicalAt, 'exactMoney normalizes AFTER the exactness check, not before')
  const [qtyStart, qtyEnd] = helperSpan(charges, 'exactQuantity')
  const qty = charges.slice(qtyStart, qtyEnd)
  assert.match(qty, /canonicalDecimal\(value, 8\)/, 'quantities parse at storage scale (28,8), not money scale')

  // No parsing bypass anywhere else: every canonicalDecimal call site lives
  // inside one of the two helpers above.
  for (const match of charges.matchAll(/canonicalDecimal\(/g)) {
    const at = match.index ?? -1
    const inside = (at >= moneyStart && at <= moneyEnd) || (at >= qtyStart && at <= qtyEnd)
    assert.ok(inside, `canonicalDecimal at offset ${at} bypasses the exactMoney/exactQuantity refusal path`)
  }
  for (const match of charges.matchAll(/normalizeMoney\(/g)) {
    const at = match.index ?? -1
    assert.ok(at >= moneyStart && at <= moneyEnd, `normalizeMoney at offset ${at} skips the exactness refusal`)
  }
})

test('project charges persist cost/bill qty-rate-amount through the exact path', () => {
  const charges = source('lib/project-charges.ts')
  // Quantity enters through the 8dp exact path and gates positivity.
  assert.match(charges, /const quantity = exactQuantity\(line\.quantity/)
  // Entered and default rates merge through exactMoney, never String().
  assert.match(charges, /enteredCostRate = exactMoneyOrNull\(line\.costRate/)
  assert.match(charges, /enteredBillRate = exactMoneyOrNull\(line\.billRate/)
  assert.match(charges, /fallbackCostRate = exactMoney\(enteredCostRate \?\? it\.default_cost \?\? '0'/)
  assert.match(charges, /fallbackBillRate = exactMoney\(enteredBillRate \?\? it\.default_rate \?\? fallbackCostRate/)
  // Line amounts and the derived unit rates stay exact.
  assert.match(charges, /costAmount = exactMoney\(resolved\?\.cost\.amount \?\? mul\(quantity, fallbackCostRate\)/)
  assert.match(charges, /billAmount = exactMoney\(resolved\?\.bill\.amount \?\? mul\(quantity, fallbackBillRate\)/)
  assert.match(charges, /costRate = exactMoney\(canDerive \? div\(costAmount, quantity\) : fallbackCostRate/)
  assert.match(charges, /billRate = exactMoney\(canDerive \? div\(billAmount, quantity\) : fallbackBillRate/)
  // The stored row carries exactly those locals — no raw input reaches the insert.
  assert.match(charges, /\$\{costRate\}, \$\{billRate\}, \$\{costAmount\}, \$\{billAmount\}/)
  assert.match(charges, /exactQuantity\(c\.quantity, 'Component quantity'\)/)
  assert.match(charges, /exactMoney\(c\.rate, 'Component rate'\)/)
  assert.match(charges, /exactMoney\(c\.amount, 'Component amount'\)/)

  assert.doesNotMatch(charges, /String\(enteredCostRate/)
  assert.doesNotMatch(charges, /String\(enteredBillRate/)
  assert.doesNotMatch(charges, /String\(it\.default_cost/)
  assert.doesNotMatch(charges, /String\(it\.default_rate/)
})
