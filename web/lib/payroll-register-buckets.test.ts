import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { bucketAmounts, buildRegisterBuckets } from './payroll-register-buckets.ts'
import { decimalSum } from './statement-format.ts'

// F-t08-012: the payroll register and stub header summarized a US run into
// hardcoded Canadian buckets (PROVINCE/CPP/EI/TAX read off CA factor keys),
// showing TAX $0.00 while $218.76 of withholding hid in the pay lines. The
// columns must come from the installed pack's declared buckets — labels and
// order from the declarations, presence from the run's own lines.
const DECLARED = [
  { code: 'FIT', label: 'Federal income tax', sequence: 110 },
  { code: 'SS', label: 'Social Security', sequence: 120 },
  { code: 'MED', label: 'Medicare', sequence: 130 },
  { code: 'SIT', label: 'State income tax', sequence: 140 },
]

function line(componentCode: string | null, amount: string, kind = 'deduction') {
  return { componentCode, kind, amount }
}

test('buckets follow pack declaration labels and sequence order', () => {
  const buckets = buildRegisterBuckets(
    [line('SS', '95.48'), line('FIT', '100.95'), line('MED', '22.33')],
    DECLARED,
  )
  assert.deepEqual(buckets, [
    { code: 'FIT', label: 'Federal income tax' },
    { code: 'SS', label: 'Social Security' },
    { code: 'MED', label: 'Medicare' },
  ])
})

test('buckets with no nonzero deduction line in the run are not shown', () => {
  const buckets = buildRegisterBuckets(
    [line('SS', '95.48'), line('FIT', '100.95'), line('MED', '22.33'), line('SIT', '0.00')],
    DECLARED,
  )
  assert.deepEqual(buckets.map((b) => b.code), ['FIT', 'SS', 'MED'])
})

test('employer-contribution lines never open a withholding bucket', () => {
  const buckets = buildRegisterBuckets(
    [line('SS', '95.48', 'employer_contribution'), line('FIT', '100.95')],
    DECLARED,
  )
  assert.deepEqual(buckets.map((b) => b.code), ['FIT'])
})

test('lines whose codes no pack declares are ignored', () => {
  const buckets = buildRegisterBuckets(
    [line('FIT', '100.95'), line('MYSTERY', '12.34')],
    DECLARED,
  )
  assert.deepEqual(buckets.map((b) => b.code), ['FIT'])
})

test('bucket amounts sum the stub deduction lines by component code', () => {
  const buckets = buildRegisterBuckets(
    [line('ss', '50.00'), line('SS', '45.48'), line('FIT', '100.95'), line('MED', '22.33')],
    DECLARED,
  )
  assert.deepEqual(bucketAmounts(
    [line('ss', '50.00'), line('SS', '45.48'), line('FIT', '100.95'), line('MED', '22.33')],
    buckets,
  ), ['100.9500', '95.4800', '22.3300'])
})

test('the run wizard renders register columns from the declared buckets', () => {
  const source = readFileSync(
    new URL('../app/(app)/payroll/runs/[id]/RunWizard.tsx', import.meta.url),
    'utf8',
  )
  assert.match(source, /registerBuckets\.map\(\(bucket, index\)/)
  assert.match(source, /withholding\(stub, registerBuckets\)/)
  assert.match(source, /\{t\('run\.stub\.trace', \{ engine: traceEngine \}\)\}/)
  // No column reads hardcoded CA factor keys anymore.
  assert.doesNotMatch(source, /statutory\(stub\)/)
  assert.doesNotMatch(source, /f\.C\b/)
})

test('a US stub totals FIT plus Social Security plus Medicare', () => {
  const buckets = buildRegisterBuckets(
    [line('FIT', '100.95'), line('SS', '95.48'), line('MED', '22.33')],
    DECLARED,
  )
  const amounts = bucketAmounts(
    [line('FIT', '100.95'), line('SS', '95.48'), line('MED', '22.33')],
    buckets,
  )
  assert.equal(decimalSum(amounts), '218.7600')
})
