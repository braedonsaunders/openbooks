import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const route = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'submit/route.ts'),
  'utf8',
)

test('submission updates entries, week, and flows inside one tenant transaction', () => {
  const transaction = route.indexOf('withOrgTransaction(orgId, async () =>')
  const entryUpdate = route.indexOf('update time_entries')
  const weekEnsure = route.indexOf('ensureTimesheetWeek(')
  const flowDispatch = route.indexOf('runRecordFlows(')
  assert.ok(transaction >= 0, 'submit must establish a tenant transaction')
  assert.ok(transaction < entryUpdate, 'entry update must be inside the transaction')
  assert.ok(entryUpdate < weekEnsure, 'entry update must precede week initialization')
  assert.ok(weekEnsure < flowDispatch, 'week initialization must precede flow dispatch')
  assert.match(route, /if \(dispatched\.failed\) throw new SubmissionFlowError\(\)/)
  assert.doesNotMatch(route, /if \(flow\.failed\)\s*\{[\s\S]*?update time_entries/)
})
