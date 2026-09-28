import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { resAssignments } from '@openbooks/schema'
import { buildResourcingForecast } from '@openbooks/engine/src/resourcing/forecast.ts'
import { stubModules } from '../../testing/stub-modules'

const week = '2026-10-04'
const assignment: typeof resAssignments.$inferSelect = {
  id: 'assignment', orgId: 'org', projectId: 'project', employeePartyId: 'person', jobTitle: null,
  weekStart: week, plannedHours: '8.0000', isBillable: true, billItemId: null,
  projectTaskId: null, booking: 'hard', state: 'active', source: 'manual', requestId: null,
  custom: {}, createdAt: new Date(0), createdBy: 'actor', updatedAt: new Date(0), updatedBy: 'actor',
}
const forecast = buildResourcingForecast([assignment], [], {
  firstWeek: week, lastWeek: week, asOf: week, rolloffWeeks: 4,
})
Object.assign(globalThis, { __tieOutUnknownCapacity: forecast })
// The board and approved-time query are I/O boundaries. The forecast and
// tie-out arithmetic stay real, including the absence of capacity evidence.
stubModules({ extra: {
  './queries': `export async function loadResourcingBoard() {
    return { people: [{ partyId: 'person', displayName: 'Planner' }],
      forecast: globalThis.__tieOutUnknownCapacity, total: 1, pageSize: 25 };
  }`,
} })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@openbooks/engine/src/platform/db.ts' && context.parentURL?.endsWith('/tie-out.ts')) {
    return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`export const db = {
      select() { return { from() { return { innerJoin() { return { where: async () => [] } } } } } },
      execute() { throw new Error('Missing availability must not query absence evidence') }
    };`) }
  }
  return next(specifier, context)
} })
const { loadPlanVsActual } = await import('./tie-out.ts')

test('a planned week without availability preserves unknown capacity and exact hours', async () => {
  const rows = await loadPlanVsActual('org', null, { firstSunday: week, lastSunday: week })
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.ok(row)
  assert.equal(row.plannedHours, '8.0000')
  assert.equal(row.approvedHours, '0.0000')
  assert.equal(row.varianceHours, '-8.0000')
  assert.equal(row.netCapacity, null)
  assert.equal(row.overallocated, null)
  assert.equal(row.capacityTier, 'unknown')
  assert.deepEqual(row.assignmentIds, ['assignment'])
  assert.deepEqual(row.scheduleIds, [])
  assert.deepEqual(row.holidayDates, [])
  assert.equal(row.holidayJurisdiction, null)
  assert.equal(row.holidaysApplied, false)
  assert.deepEqual(row.absences, [])
})
