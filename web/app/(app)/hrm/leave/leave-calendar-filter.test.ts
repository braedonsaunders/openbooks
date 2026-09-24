import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const root = pathToFileURL(process.cwd() + '/').href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (specifier === 'next-intl/server') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function getTranslations(){const t=(k)=>k;return t};export async function getLocale(){return "en"}',
      }
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { leaveQueueSpec } = await import('./view')

function findFilters(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const value of node) findFilters(value, out)
    return out
  }
  if (node !== null && typeof node === 'object') {
    const record = node as Record<string, unknown>
    if (typeof record.paramKey === 'string') out.push(record)
    for (const value of Object.values(record)) findFilters(value, out)
  }
  return out
}

// F3-58: the calendar's department filter offered the queue's
// "not available" string as its "All" option. The spec must carry the
// dedicated calendar all-departments label instead.
test('the calendar department filter offers the all-departments label, not the not-available string', () => {
  const data = {
    title: 'Leave',
    description: 'Leave queue',
    tabs: [],
    viewTabs: [],
    segmentsLabel: 'Segment',
    allLabel: 'All',
    segments: [],
    currentParams: {},
    columns: { employee: 'Employee', type: 'Type', range: 'Range', hours: 'Hours' },
    rows: [],
    emptyTitle: 'Empty',
    emptyDescription: 'None',
    calendarDepartmentLabel: 'Department',
    calendarAllDepartments: 'All departments',
    calendarFromLabel: 'From',
    calendarToLabel: 'To',
    calendarDays: [],
    calendarEmpty: 'No entries',
    departmentOptions: [],
    queue: { notAvailable: 'Not available', openEmployee: 'Open' },
  }
  const spec = leaveQueueSpec(data as never)
  const department = findFilters(spec).filter((filter) => filter.paramKey === 'department')
  assert.equal(department.length, 1, 'the calendar carries one department filter')
  assert.equal(department[0]?.allLabel, 'All departments')
})
