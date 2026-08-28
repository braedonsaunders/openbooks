import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { toUnits } from '../../engine/src/money.ts'
import { readFileSync } from 'node:fs'

// invoice-backup is a server-only module; mock that marker so its pure amount
// allocator can be exercised directly without starting a Next.js server.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier.startsWith('@openbooks/')) {
      const [packageName, ...packagePath] = specifier.slice('@openbooks/'.length).split('/')
      const packageRoot = packageName === 'engine' || packageName === 'schema'
        ? `../../${packageName}`
        : `../../packages/${packageName}`
      const localPath = packagePath.length ? packagePath.join('/') : 'src/index.ts'
      return { shortCircuit: true, url: new URL(`${packageRoot}/${localPath}`, import.meta.url).href }
    }
    return nextResolve(specifier, context)
  },
})
const { allocateTimesheetBillAmounts } = await import('./invoice-backup.ts')
hooks.deregister()

const unitsTotal = (amounts: readonly string[]) => amounts.reduce((total, amount) => total + toUnits(amount), 0n)

test('a rolled-up line allocates its full posted amount by native bill value', () => {
  const shares = allocateTimesheetBillAmounts({
    lineAmount: '100.0000',
    // These are the exact hours × bill-rate values for the three entries.
    nativeBillAmounts: ['1.0000', '2.0000', '3.0000'],
  })

  assert.deepEqual(shares, ['16.6667', '33.3333', '50.0000'])
  assert.equal(unitsTotal(shares), toUnits('100.0000'))
})

test('negative and fractional posted totals cross-foot exactly in bigint units', () => {
  const negative = allocateTimesheetBillAmounts({
    lineAmount: '-100.0000',
    nativeBillAmounts: ['1.0000', '2.0000', '3.0000'],
  })
  assert.deepEqual(negative, ['-16.6667', '-33.3333', '-50.0000'])
  assert.equal(unitsTotal(negative), toUnits('-100.0000'))

  const fractional = allocateTimesheetBillAmounts({
    lineAmount: '0.0005',
    nativeBillAmounts: ['1.0000', '1.0000'],
  })
  assert.deepEqual(fractional, ['0.0003', '0.0002'])
  assert.equal(unitsTotal(fractional), toUnits('0.0005'))
})

test('a zero native total uses equal weights and largest-remainder tie order', () => {
  const shares = allocateTimesheetBillAmounts({
    lineAmount: '100.0000',
    nativeBillAmounts: ['0.0000', '0.0000', '0.0000'],
  })

  assert.deepEqual(shares, ['33.3334', '33.3333', '33.3333'])
  assert.equal(unitsTotal(shares), toUnits('100.0000'))
  assert.deepEqual(
    shares,
    allocateTimesheetBillAmounts({ lineAmount: '100.0000', nativeBillAmounts: ['0.0000', '0.0000', '0.0000'] }),
  )
})

test('a line linked to one entry keeps its exact posted amount', () => {
  assert.deepEqual(
    allocateTimesheetBillAmounts({ lineAmount: '12.34', nativeBillAmounts: ['125.0000'] }),
    ['12.3400'],
  )
})

test('invoice backup replacement serializes and audits the complete lifecycle unit', () => {
  const source = readFileSync(new URL('./invoice-backup.ts', import.meta.url), 'utf8')
  assert.match(source, /inDbTransaction\(async \(tx\)/)
  assert.match(source, /from documents[\s\S]*?for update/)
  assert.match(source, /uploadAndAttach\([\s\S]*?executor: tx/)
  assert.match(source, /action: 'replace',[\s\S]*?before:[\s\S]*?after:/)
  assert.match(source, /delete from files where id = \$\{priorFileId\}/)
})
