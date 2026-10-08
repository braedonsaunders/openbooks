import assert from 'node:assert/strict'
import test from 'node:test'
import { prebillStage, type PrebillStageFacts } from './pre-billing-stages'

const facts = (overrides: Partial<PrebillStageFacts>): PrebillStageFacts => ({
  status: 'converted',
  invoiceStatus: 'posted',
  invoiceOpenBalance: '250.0000',
  deliveredAt: null,
  ...overrides,
})

/**
 * Before conversion the worksheet's own status places it; after conversion
 * the invoice does — posted and unsent stays "invoiced", delivered with a
 * balance is "sent", a cleared balance is "paid", and a voided invoice takes
 * the worksheet off the board.
 */
test('pre-billing stages follow the worksheet, then the invoice it produced', () => {
  const cases: Array<[Partial<PrebillStageFacts>, string]> = [
    [{ status: 'draft', invoiceStatus: null, invoiceOpenBalance: null }, 'draft'],
    [{ status: 'review', invoiceStatus: null, invoiceOpenBalance: null }, 'review'],
    [{ status: 'approved', invoiceStatus: null, invoiceOpenBalance: null }, 'ready'],
    [{ status: 'customer_review', invoiceStatus: null, invoiceOpenBalance: null }, 'customer'],
    [{ invoiceStatus: 'draft', invoiceOpenBalance: null }, 'invoiced'],
    [{}, 'invoiced'],
    [{ deliveredAt: '2026-10-01T12:00:00.000Z' }, 'sent'],
    [{ deliveredAt: '2026-10-01T12:00:00.000Z', invoiceOpenBalance: '0.0000' }, 'paid'],
    [{ invoiceOpenBalance: '-5.0000' }, 'paid'],
    [{ invoiceStatus: 'voided', deliveredAt: '2026-10-01T12:00:00.000Z' }, 'void'],
    [{ status: 'void', invoiceStatus: null, invoiceOpenBalance: null }, 'void'],
  ]
  for (const [overrides, expected] of cases) {
    assert.equal(prebillStage(facts(overrides)), expected, JSON.stringify(overrides))
  }
})
