import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const route = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'route.ts'), 'utf8')

test('rejection refuses an employee outside the caller subsidiary scope', () => {
  const pin = route.indexOf('pinTimesheetEmployee(')
  const weekRead = route.indexOf('loadWeek(')
  assert.match(route, /pinTimesheetEmployee\([\s\S]*?gate\.allowedSubsidiaryIds/)
  assert.ok(pin >= 0 && pin < weekRead, 'scope pin must precede the week read')
})

test('rejection changes its header and entries in one transaction', () => {
  assert.match(route, /withOrgTransaction\(orgId, async \(\) => \{/)
  const transaction = route.indexOf('withOrgTransaction(')
  const header = route.indexOf('setTimesheetWeekStatus(')
  const entries = route.indexOf('update time_entries')
  assert.ok(transaction < header && header < entries)
})
