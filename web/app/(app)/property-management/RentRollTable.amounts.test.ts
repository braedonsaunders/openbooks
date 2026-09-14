import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tsImport } from 'tsx/esm/api'

const { monthlyCharges, pastDue } = (await tsImport('./RentRollTable.tsx', {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
})) as {
  monthlyCharges: (data: { charges: unknown[] }, lease: unknown, today: string) => string
  pastDue: (data: { schedules: unknown[] }, lease: unknown, today: string) => string
}

test('rent-roll monetary aggregates retain exact decimal values', () => {
  const lease = { id: 'lease-1', status: 'active', unitId: 'unit-1' }
  const data = {
    charges: [
      {
        leaseId: 'lease-1',
        frequency: 'monthly',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        amount: '9007199254740992.1250',
      },
      {
        leaseId: 'lease-1',
        frequency: 'monthly',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        amount: '0.1250',
      },
    ],
  }
  const schedules = {
    schedules: [
      {
        leaseId: 'lease-1',
        invoiceDocumentId: 'invoice-a',
        invoiceStatus: 'posted',
        invoiceDueOn: '2026-08-01',
        invoiceOpenBalance: '9007199254740992.1250',
      },
      {
        leaseId: 'lease-1',
        invoiceDocumentId: 'invoice-b',
        invoiceStatus: 'posted',
        invoiceDueOn: '2026-08-01',
        invoiceOpenBalance: '0.1250',
      },
    ],
  }

  assert.equal(monthlyCharges(data, lease, '2026-08-28'), '9007199254740992.2500')
  assert.equal(pastDue(schedules, lease, '2026-08-28'), '9007199254740992.2500')
})
