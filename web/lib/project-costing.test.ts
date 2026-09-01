import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { add, mul, mulRate, neg } from '@openbooks/engine/src/money.ts'

// The scripted database below models the two SQL rollups with transaction- and
// functional-currency fixture values. A query that omits its document FX rate
// therefore returns the old, unconverted result and fails the assertions.

interface OrderFixture {
  kind: 'purchase_order' | 'sales_order'
  quantity: string
  quantityBilled: string
  unitPrice: string
  fxRate: string
}

interface CostFixture {
  kind: 'project_charge' | 'vendor_bill'
  amount: string
  billAmount?: string
  costMultiplier?: string
  fxRate: string
}

interface ProjectCostingHarness {
  queries: string[]
  orders: OrderFixture[]
  costs: CostFixture[]
}

const stateKey = Symbol.for('openbooks.project-costing-fx-test')
const harness: ProjectCostingHarness = {
  queries: [],
  orders: [
    {
      kind: 'purchase_order',
      quantity: '2.0000',
      quantityBilled: '0.5000',
      unitPrice: '100.1250',
      fxRate: '1.2000000000',
    },
    {
      kind: 'sales_order',
      quantity: '3.0000',
      quantityBilled: '1.0000',
      unitPrice: '45.6789',
      fxRate: '0.8750000000',
    },
  ],
  costs: [
    {
      kind: 'project_charge',
      amount: '12.3456',
      billAmount: '12.3456',
      fxRate: '1.2000000000',
    },
    {
      kind: 'vendor_bill',
      amount: '20.0000',
      costMultiplier: '1.1500',
      fxRate: '0.8750000000',
    },
  ],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = harness

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk
      const value = (chunk as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk)
      return ''
    })
    .join('')
}
;(globalThis as typeof globalThis & Record<string, unknown>).projectCostingSqlText = sqlText

function sumMoney(values: string[]): string {
  return values.reduce((total, value) => add(total, value), '0.0000')
}

function orderAmount(order: OrderFixture, convert: boolean): string {
  const remainder = add(order.quantity, neg(order.quantityBilled))
  const transactionAmount = mul(remainder, order.unitPrice)
  return convert ? mulRate(transactionAmount, order.fxRate) : transactionAmount
}

function costAmounts(cost: CostFixture, convert: boolean): { revenue: string; cost: string } {
  const fx = (amount: string) => convert ? mulRate(amount, cost.fxRate) : amount
  const amount = cost.kind === 'project_charge'
    ? (cost.billAmount ?? '0.0000')
    : mul(cost.amount, cost.costMultiplier ?? '1.0000')
  return { revenue: fx(amount), cost: fx(cost.amount) }
}
;(globalThis as typeof globalThis & Record<string, unknown>).projectCostingFx = {
  sumMoney,
  orderAmount,
  costAmounts,
}

const mockSources = new Map<string, string>([
  ['mock:server-only', 'export {}'],
  [
    'mock:db',
    `
      const harness = globalThis[Symbol.for('openbooks.project-costing-fx-test')]
      const sqlText = globalThis.projectCostingSqlText
      const fx = globalThis.projectCostingFx

      export const db = {
        execute: async (query) => {
          const text = sqlText(query)
          harness.queries.push(text)
          const convert = text.includes('d.fx_rate')

          if (text.includes('billing_status')) {
            return { rows: [{ revenue: '0.0000', cost: '0.0000', hours: '0', cnt: '0' }] }
          }

          if (text.includes('billed_by_line_id')) {
            const amounts = harness.costs.map((cost) => fx.costAmounts(cost, convert))
            return {
              rows: [{
                revenue: fx.sumMoney(amounts.map((amount) => amount.revenue)),
                cost: fx.sumMoney(amounts.map((amount) => amount.cost)),
                cnt: String(amounts.length),
              }],
            }
          }

          if (text.includes('from projects p')) return { rows: [{ contract_value: '0.0000', cost_budget: '0.0000' }] }
          if (text.includes('select a.id as account_id')) return { rows: [] }
          if (text.includes('from journal_lines l')) return { rows: [{ cost: '0.0000', revenue: '0.0000' }] }
          if (text.includes('from document_lines dl') && text.includes('quantity_billed')) {
            const orders = harness.orders
            return {
              rows: [{
                committed_cost: fx.sumMoney(
                  orders
                    .filter((order) => order.kind === 'purchase_order')
                    .map((order) => fx.orderAmount(order, convert)),
                ),
                committed_revenue: fx.sumMoney(
                  orders
                    .filter((order) => order.kind === 'sales_order')
                    .map((order) => fx.orderAmount(order, convert)),
                ),
              }],
            }
          }
          if (text.includes('from accounts a')) return { rows: [] }
          if (text.includes('from documents d')) return { rows: [] }
          throw new Error('unexpected project-costing query: ' + text)
        },
      }
      // The production summary participates in an ambient tenant transaction
      // when one exists. Keep the fixture on that path so the test exercises
      // the rollup queries without opening a real pool connection.
      export const orgContext = {
        getStore: () => ({ orgId: 'org-1', bypass: false, txDb: db }),
        run: async (_ctx, fn) => fn(),
      }
      export const pool = {
        connect: async () => { throw new Error('project-costing FX fixture unexpectedly opened a pool') },
      }
    `,
  ],
  ['mock:subcontract-commitments', 'export async function directSubcontractOpenCommitment() { return "0.0000" }'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { url: 'mock:server-only', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/db.ts') return { url: 'mock:db', shortCircuit: true }
    if (specifier === './subcontract-commitments') {
      return { url: 'mock:subcontract-commitments', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const projectCostingUrl = './project-costing.ts?project-costing-fx-test'
const { projectCostSummary, projectUnbilled } = await import(projectCostingUrl) as typeof import('./project-costing.ts')
hooks.deregister()

function resetHarness(): void {
  harness.queries.length = 0
}

test('committed order remainders are translated with each document FX rate', async () => {
  resetHarness()
  const summary = await projectCostSummary('org-1', 'project-1')

  assert.deepEqual(summary.committed, {
    cost: '180.2250',
    revenue: '79.9381',
  })
  const query = harness.queries.find((text) => text.includes('committed_cost'))
  assert.ok(query)
  assert.match(query, /d\.fx_rate/)
  assert.doesNotMatch(query, /Number\(|parseFloat\(|parseInt\(/)
})

test('unbilled document revenue and cost are translated with each document FX rate', async () => {
  resetHarness()
  const unbilled = await projectUnbilled('org-1', 'project-1')

  assert.deepEqual(
    {
      revenue: unbilled.revenue,
      cost: unbilled.cost,
      costLineCount: unbilled.costLineCount,
    },
    {
      revenue: '34.9397',
      cost: '32.3147',
      costLineCount: 2,
    },
  )
  const query = harness.queries.find((text) => text.includes('billed_by_line_id'))
  assert.ok(query)
  assert.match(query, /coalesce\(dl\.bill_amount, 0\) \* d\.fx_rate/)
  assert.match(query, /dl\.amount \* d\.fx_rate/)
  assert.doesNotMatch(query, /Number\(|parseFloat\(|parseInt\(/)
})

test('document rollups keep FX and money arithmetic in SQL decimal expressions', () => {
  const source = readFileSync(new URL('./project-costing.ts', import.meta.url), 'utf8')
  const committed = source.slice(source.indexOf('// committed: open order remainders'), source.indexOf('// actual cost broken down by account'))
  const unbilled = source.slice(source.indexOf('select coalesce(sum(case when d.kind = \'project_charge\''), source.indexOf('count(*) as cnt', source.indexOf('select coalesce(sum(case when d.kind = \'project_charge\'')))

  assert.match(committed, /quantity - dl\.quantity_billed[\s\S]+dl\.unit_price \* d\.fx_rate/)
  assert.match(committed, /committed_cost[\s\S]+d\.fx_rate[\s\S]+committed_revenue/)
  assert.match(unbilled, /coalesce\(dl\.bill_amount, 0\) \* d\.fx_rate/)
  assert.match(unbilled, /dl\.amount \* coalesce\(nullif\(dl\.cost_multiplier, 0\), 1\) \* d\.fx_rate/)
  assert.match(unbilled, /sum\(round\(dl\.amount \* d\.fx_rate, 4\)\)/)
  assert.doesNotMatch(committed, /\b(?:Number|parseFloat|parseInt)\s*\(/)
  assert.doesNotMatch(unbilled, /\b(?:Number|parseFloat|parseInt)\s*\(/)
  assert.doesNotMatch(`${committed}${unbilled}`, /::(?:float|real|double precision)\b/i)
})
