import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { canonicalDecimal, compareDecimal } from '../../../lib/exact-decimal.ts'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const componentSource = readFileSync(join(webRoot, 'app/(app)/parties/EmployeeWageRates.tsx'), 'utf8')

interface AddRateInputs {
  rate: string
  annualHours: string
  basis?: 'hour' | 'year'
}

interface AddRateRun {
  errors: string[]
  payload: Record<string, unknown> | undefined
  stateUpdates: string[]
}

/**
 * Execute the component's addRate closure with controlled state and side
 * effects. Keeping this harness source-backed catches regressions that a
 * helper-only test would miss (for example, reintroducing Number(...)).
 */
async function runAddRate({ rate, annualHours, basis = 'year' }: AddRateInputs): Promise<AddRateRun> {
  const start = componentSource.indexOf('async function addRate()')
  const end = componentSource.indexOf('\n  const formatDate', start)
  if (start < 0 || end < 0) throw new Error('EmployeeWageRates.addRate source not found')
  const functionSource = componentSource.slice(start, end)
  const openingBrace = functionSource.indexOf('{')
  const body = functionSource.slice(openingBrace + 1, functionSource.lastIndexOf('}'))

  const errors: string[] = []
  const stateUpdates: string[] = []
  let payload: Record<string, unknown> | undefined
  const mutate = async (next: Record<string, unknown>) => {
    payload = next
    return true
  }
  const execute = new Function(
    'canonicalDecimal',
    'compareDecimal',
    'mutate',
    'toast',
    't',
    'setRate',
    'rate',
    'annualHours',
    'basis',
    'effectiveFrom',
    'partyId',
    'currency',
    'data',
    `return (async () => {${body}\n})()`,
  ) as (...args: unknown[]) => Promise<void>

  await execute(
    canonicalDecimal,
    compareDecimal,
    mutate,
    { error: (message: string) => errors.push(message) },
    (message: string) => message,
    (next: string) => stateUpdates.push(next),
    rate,
    annualHours,
    basis,
    '2026-08-28',
    'employee-1',
    'CAD',
    { defaultCurrency: 'CAD' },
  )
  return { errors, payload, stateUpdates }
}

test('employee wage edits keep decimal text and submit canonical exact strings', async () => {
  assert.match(componentSource, /import \{ canonicalDecimal, compareDecimal \} from ['"]\.\.\/\.\.\/\.\.\/lib\/exact-decimal/)
  assert.match(componentSource, /const \[rate, setRate\] = useState\(''\)/)
  assert.match(componentSource, /const \[annualHours, setAnnualHours\] = useState\('2080'\)/)
  assert.match(componentSource, /value=\{rate\}\s*\n\s*onChange=\{\(event\) => setRate\(event\.target\.value\)\}/)
  assert.match(componentSource, /value=\{annualHours\}\s*\n\s*onChange=\{\(event\) => setAnnualHours\(event\.target\.value\)\}/)

  const cases = [
    {
      rate: '0012.3456',
      annualHours: '02080.1250',
      expectedRate: '12.3456',
      expectedAnnualHours: '2080.125',
    },
    {
      rate: '9007199254740993.1234',
      annualHours: '9007199254740993.0001',
      expectedRate: '9007199254740993.1234',
      expectedAnnualHours: '9007199254740993.0001',
    },
  ]

  for (const input of cases) {
    const result = await runAddRate(input)
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.stateUpdates, [''])
    assert.ok(result.payload)
    assert.equal(result.payload.rate, input.expectedRate)
    assert.equal(typeof result.payload.rate, 'string')
    assert.equal(result.payload.annualHours, input.expectedAnnualHours)
    assert.equal(typeof result.payload.annualHours, 'string')
  }
})

test('employee wage validation rejects exponent, NaN, and infinite input before submit', async () => {
  for (const invalid of ['1e3', 'NaN', 'Infinity', '-Infinity']) {
    const invalidRate = await runAddRate({ rate: invalid, annualHours: '2080' })
    assert.deepEqual(invalidRate.errors, ['rateRequired'], invalid)
    assert.equal(invalidRate.payload, undefined, invalid)

    const invalidAnnualHours = await runAddRate({ rate: '42.125', annualHours: invalid })
    assert.deepEqual(invalidAnnualHours.errors, ['annualHoursRequired'], invalid)
    assert.equal(invalidAnnualHours.payload, undefined, invalid)
  }
})
