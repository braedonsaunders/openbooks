import assert from 'node:assert/strict'
import test from 'node:test'
import { REPORT_ENTITY_MAP } from './entities'
import { runCustomQuery, type PgQueryable } from './run'

test('summarize totals refuse invalid values and identify the affected group row', async () => {
  const client: PgQueryable = {
    async query() {
      return {
        rows: [
          { d0: 'expense', m0: '2.0000' },
          { d0: 'income', m0: 'invalid-decimal' },
        ],
      }
    },
  }

  await assert.rejects(
    runCustomQuery(client, {
      entity: 'ledger_lines',
      mode: 'summarize',
      columns: [],
      breakouts: [{ column: 'account_type' }],
      measures: [{ fn: 'sum', column: 'quantity' }],
    }, {
      orgId: 'org-one',
      entityMap: REPORT_ENTITY_MAP,
    }),
    /incomplete.*account type=income/i,
  )
})
