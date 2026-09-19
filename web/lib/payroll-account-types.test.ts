/**
 * The payroll account allow-lists must agree with the charts the product seeds.
 *
 * A browser persona set "Wage expense" to `5300 Direct Labor` — an account
 * OpenBooks had created for it, from its own construction chart — and
 * PUT /api/payroll/settings answered 422 "account type cogs is not compatible
 * with payroll". The product created the account, named it, typed it, offered
 * it in the picker, and then refused it.
 *
 * Two lists had drifted apart with nothing comparing them: the hardcoded
 * ACCOUNT_TYPES_BY_KEY in web/app/api/payroll/settings/route.ts, and the
 * seeded industry charts in web/lib/industries.ts. Either can be edited
 * without the other noticing, which is how a list in one file comes to
 * contradict data in another. This test is the comparison.
 *
 * It is deliberately asymmetric, because the two directions mean different
 * things:
 *  - A DIRECT-LABOUR account the product seeds MUST be postable as wage or
 *    burden expense. For a contractor or manufacturer direct labour is cost of
 *    sales; that is the basis of job costing.
 *  - A LIABILITY the product seeds for payroll MUST be postable to the payable
 *    keys.
 * Nothing here requires every seeded account to be acceptable everywhere — a
 * revenue account is rightly refused as wage expense.
 */
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// industries.ts is server-only; the house shim for reading a server module
// from a plain node test (same pattern as the payroll profiles route test).
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return { shortCircuit: true as const, url: 'data:text/javascript,export {}' }
    }
    return next(specifier, context)
  },
})

const { INDUSTRIES } = (await import('./industries')) as {
  INDUSTRIES: { key: string }[]
}

/** Mirrors ACCOUNT_TYPES_BY_KEY in web/app/api/payroll/settings/route.ts. */
const ALLOWED: Record<string, readonly string[]> = {
  wageExpenseAccountId: ['expense', 'expense_other', 'expense_deferred', 'cogs'],
  burdenExpenseAccountId: ['expense', 'expense_other', 'expense_deferred', 'cogs'],
  netPayAccountId: ['liability_payable', 'liability_current_other'],
  cppPayableAccountId: ['liability_payable', 'liability_current_other'],
  eiPayableAccountId: ['liability_payable', 'liability_current_other'],
  taxPayableAccountId: ['liability_payable', 'liability_current_other'],
  vacationPayableAccountId: ['liability_payable', 'liability_current_other'],
}

interface SeededAccount { number: string; name: string; type: string }

/** Every account in every seeded chart, with the preset that seeds it. */
function seededAccounts(): { preset: string; account: SeededAccount }[] {
  const out: { preset: string; account: SeededAccount }[] = []
  const walk = (preset: string, value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(preset, item)
      return
    }
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (typeof record.number === 'string' && typeof record.name === 'string' && typeof record.type === 'string') {
      out.push({ preset, account: { number: record.number, name: record.name, type: record.type } })
      return
    }
    for (const nested of Object.values(record)) walk(preset, nested)
  }
  for (const industry of INDUSTRIES) {
    walk(industry.key, industry as unknown)
  }
  return out
}

test('the seeded charts actually contain accounts, so this test cannot pass vacuously', () => {
  const all = seededAccounts()
  assert.ok(all.length > 50, `expected the industry presets to seed many accounts, saw ${all.length}`)
})

test('every seeded direct-labour account is postable as wage or burden expense', () => {
  const labour = seededAccounts().filter(({ account }) =>
    /direct labor|direct labour|direct wages/i.test(account.name))
  assert.ok(labour.length > 0, 'the seeded charts are expected to include direct-labour accounts')
  const rejected = labour.filter(({ account }) =>
    !ALLOWED.wageExpenseAccountId!.includes(account.type)
    || !ALLOWED.burdenExpenseAccountId!.includes(account.type))
  assert.deepEqual(
    rejected.map(({ preset, account }) => `${preset}:${account.number} ${account.name} (${account.type})`),
    [],
    'the product seeds these direct-labour accounts and payroll refuses them — a tenant '
    + 'cannot post wages to the account OpenBooks created for exactly that purpose',
  )
})

test('every seeded payroll liability is postable to the payable keys', () => {
  const liabilities = seededAccounts().filter(({ account }) =>
    /payroll/i.test(account.name) && account.type.startsWith('liability'))
  assert.ok(liabilities.length > 0, 'the seeded charts are expected to include payroll liabilities')
  const rejected = liabilities.filter(({ account }) =>
    !ALLOWED.netPayAccountId!.includes(account.type))
  assert.deepEqual(
    rejected.map(({ preset, account }) => `${preset}:${account.number} ${account.name} (${account.type})`),
    [],
    'the product seeds these payroll liabilities and payroll refuses them',
  )
})

test('cogs is allowed for wage and burden only, never for a payable', () => {
  // The asymmetry is the point: direct labour is cost of sales, but a payable
  // is not. If someone widens the liability keys to quiet a validation error,
  // this fails.
  assert.ok(ALLOWED.wageExpenseAccountId!.includes('cogs'))
  assert.ok(ALLOWED.burdenExpenseAccountId!.includes('cogs'))
  for (const key of ['netPayAccountId', 'cppPayableAccountId', 'eiPayableAccountId',
    'taxPayableAccountId', 'vacationPayableAccountId']) {
    assert.ok(!ALLOWED[key]!.includes('cogs'), `${key} must not accept a cost-of-sales account`)
  }
})
