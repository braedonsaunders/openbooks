import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

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
const { allocateTimesheetBillAmount } = await import('./invoice-backup.ts')
hooks.deregister()

test('rolled-up timesheet amounts are allocated once across linked entries', () => {
  const first = allocateTimesheetBillAmount({
    lineAmount: '1000.00', nativeBillAmount: '400.00', nativeBillTotal: '1000.00', entryCount: 2,
  })
  const second = allocateTimesheetBillAmount({
    lineAmount: '1000.00', nativeBillAmount: '600.00', nativeBillTotal: '1000.00', entryCount: 2,
  })

  assert.equal(first, '400.0000')
  assert.equal(second, '600.0000')
  assert.equal(Number(first) + Number(second), 1000)
})

test('a line linked to one entry keeps its posted amount', () => {
  assert.equal(
    allocateTimesheetBillAmount({
      lineAmount: '1000.00', nativeBillAmount: '125.00', nativeBillTotal: '125.00', entryCount: 1,
    }),
    '1000.0000',
  )
})

test('fractional allocations use exact four-decimal rounding', () => {
  assert.equal(
    allocateTimesheetBillAmount({
      lineAmount: '100.00', nativeBillAmount: '1.00', nativeBillTotal: '3.00', entryCount: 3,
    }),
    '33.3333',
  )
})
