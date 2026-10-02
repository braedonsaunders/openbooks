import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createMoneyFormatter } from '../money-format'
import {
  buildAttentionQueue,
  decimalFieldRefusal,
  translatedFieldErrors,
  emptyProgramDraft,
  parsePortfolioView,
  totalsByCurrency,
  validateAwardDraft,
  validateMembershipDraft,
  validateProgramDraft,
} from './benefits-portfolio'

function blankFields<const K extends string>(...keys: K[]): Record<K, string> {
  return Object.fromEntries(keys.map((key) => [key, ''])) as Record<K, string>
}

test('totals keep one line per currency and never merge them', () => {
  const lines = totalsByCurrency([
    { value: '100.00', currency: 'USD' },
    { value: '50.00', currency: 'USD' },
    { value: '10000', currency: 'JPY' },
  ], (value, currency) => createMoneyFormatter('en', currency).money(value, { currency }))
  assert.deepEqual(lines.map(line => [line.currency, line.amount]), [['JPY', '10000.0000'], ['USD', '150.0000']])
})

const attentionDefaults = { pendingEnrollments: 0, pendingAwards: 0, queuedAwards: 0, draftPrograms: 0, programsMissingComponent: [], format: (key: string) => key, basePath: '/hrm/benefits' }

test('attention items each carry an operable destination', () => {
  const items = buildAttentionQueue({
    ...attentionDefaults,
    pendingEnrollments: 2,
    pendingAwards: 1,
    draftPrograms: 1,
    programsMissingComponent: [{ id: 'p1', code: 'BONUS' }],
    format: (key, params) => `${key}:${JSON.stringify(params)}`,
  })
  assert.equal(items.length, 4)
  for (const item of items) assert.match(item.href, /^(?:\/hrm\/benefits\?|\/approvals$)/)
  assert.equal(items.find((item) => item.key === 'pending-awards')?.href, '/approvals')
  assert.ok(items.some((item) => item.key === 'missing-component-p1' && item.tone === 'negative'))
})

test('empty counts produce an empty queue, never placeholder rows', () => {
  assert.deepEqual(buildAttentionQueue(attentionDefaults), [])
})

test('incentive drafts require a metric, scope picks, and a period basis', () => {
  const draft = { ...emptyProgramDraft('incentive'), metricScope: 'department' as const }
  const errors = validateProgramDraft({
    ...draft,
    code: 'INC',
    name: 'Incentive',
    currency: 'USD',
    effectiveFrom: '2026-01-01',
    budgetAmount: '10000',
    frequency: 'quarterly' as const,
    metric: '',
  })
  assert.equal(errors.metric, 'portfolio.validation.metric')
  assert.equal(errors.scopeIds, 'portfolio.validation.scopeIds')
  assert.equal(errors.periodBasis, 'portfolio.validation.periodBasis')
})

for (const [name, errors, expected] of [
  ['program', validateProgramDraft(emptyProgramDraft('reward')), { code: 'programCode', name: 'programName', currency: 'currency', effectiveFrom: 'effectiveFrom', fixedAmount: 'fixedAmount' }],
  ['reward', validateAwardDraft({ ...blankFields('programId', 'employmentId', 'periodFrom', 'periodTo', 'value', 'reason', 'recipientNote', 'recordReference'), currency: 'usd' }), { programId: 'awardProgram', employmentId: 'awardRecipient', periodFrom: 'periodFrom', value: 'awardValue', currency: 'currency', reason: 'awardReason' }],
  ['participation', validateMembershipDraft(blankFields('employmentId', 'effectiveFrom', 'effectiveTo', 'weight', 'role')), { employmentId: 'memberEmployment', effectiveFrom: 'membershipFrom' }],
] as const) test(`${name} creation refuses missing inputs with field-specific remedies`, () => {
  for (const [field, remedy] of Object.entries(expected)) assert.equal((errors as Record<string, string>)[field], `portfolio.validation.${remedy}`, field)
})

test('portfolio views parse to canonical values with overview default', () => {
  assert.equal(parsePortfolioView(undefined), 'overview')
  assert.equal(parsePortfolioView('programs'), 'programs')
  assert.equal(parsePortfolioView('employees'), 'employees')
  assert.equal(parsePortfolioView('delivery'), 'delivery')
  for (const removed of ['windows', 'enrolments', 'rewards', 'incentives', 'payouts', 'policies']) assert.equal(parsePortfolioView(removed), 'overview')
  assert.equal(parsePortfolioView('nope'), 'overview')
})

const locales = ['en', 'fr', 'de', 'es', 'pt-BR', 'zh', 'ja'] as const
function catalog(locale: string) {
  const data = JSON.parse(readFileSync(new URL(`../../messages/${locale}/hrm.json`, import.meta.url), 'utf8'))
  return (key: string, params?: Record<string, string | number>): string => {
    const text = key.split('.').reduce((node, part) => node?.[part], data)
    assert.equal(typeof text, 'string', `${locale} must translate ${key}`)
    return text.replace(/\{(\w+)\}/g, (_: string, name: string) => String(params?.[name] ?? `{${name}}`))
  }
}

test('invalid calendar dates and reversed periods receive usable localized remedies', () => {
  const program = validateProgramDraft({ ...emptyProgramDraft('reward'), effectiveFrom: '2026-02-30' })
  assert.equal(program.effectiveFrom, 'portfolio.validation.effectiveFrom')
  const award = validateAwardDraft({ programId: 'program', employmentId: 'employment', periodFrom: '2026-04-01', periodTo: '2026-03-31', value: '25', currency: 'USD', reason: 'Recognition', recipientNote: '', recordReference: '' })
  assert.equal(award.periodTo, 'portfolio.validation.dateOrder')
  for (const locale of locales) {
    const errors = translatedFieldErrors(program, catalog(locale))
    assert.ok(errors.effectiveFrom && !errors.effectiveFrom.includes('portfolio.validation'))
    const end = translatedFieldErrors(award, catalog(locale))
    assert.ok(end.periodTo && !end.periodTo.includes('portfolio.validation'))
  }
})

test('decimal comma remedies preserve the intended amount and ambiguous commas name both readings', () => {
  for (const locale of locales) {
    const t = catalog(locale)
    const comma = decimalFieldRefusal('12,34', 'Value', t)
    assert.ok(comma.includes('12,34') && comma.includes('12.34'), locale)
    const mixed = decimalFieldRefusal('1.234,56', 'Value', t)
    assert.ok(mixed.includes('1.234,56') && mixed.includes('1234.56'), locale)
    const ambiguous = decimalFieldRefusal('1,234', 'Value', t)
    assert.ok(ambiguous.includes('1234') && ambiguous.includes('1.234'), locale)
  }
})

test('all validation remedies resolve in each supported catalog', () => {
  const keys = ['programCode', 'programName', 'currency', 'effectiveFrom', 'effectiveTo', 'dateOrder', 'fixedAmount', 'percentRate', 'budgetAmount', 'metric', 'scopeIds', 'sourceAccounts', 'periodBasis', 'payComponent', 'paymentDelay', 'awardProgram', 'awardRecipient', 'periodFrom', 'periodTo', 'awardValue', 'awardReason', 'memberEmployment', 'membershipFrom', 'legalEntity', 'weight']
  for (const locale of locales) for (const key of keys) assert.ok(catalog(locale)(`portfolio.validation.${key}`).length > 0)
})


test('cash and external delivery offer only matching native payroll representations', async () => {
  const { componentsForDelivery } = await import('./benefits-portfolio.ts')
  const options = [{ value: 'cash', label: 'Cash bonus', paymentKind: 'cash' as const }, { value: 'noncash', label: 'Gift card', paymentKind: 'non_cash' as const }]
  assert.deepEqual(componentsForDelivery(options, 'payroll').map((option) => option.value), ['cash'])
  assert.deepEqual(componentsForDelivery(options, 'external').map((option) => option.value), ['noncash'])
  const draft = emptyProgramDraft('reward')
  draft.deliveryMethod = 'external'
  assert.equal(validateProgramDraft(draft).payComponentId, 'portfolio.validation.payComponent', 'external value must be represented in taxable payroll')
})

test('every employer program defaults to no approvals without workflow configuration', () => {
  for (const family of ['reward', 'allowance', 'incentive', 'custom'] as const) {
    assert.equal(emptyProgramDraft(family).approvalMode, 'none')
  }
})
