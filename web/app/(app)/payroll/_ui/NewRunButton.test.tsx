import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { nextPeriod, runPayload, type RunSchedule } from './NewRunButton'

const schedule = (overrides: Partial<RunSchedule> = {}): RunSchedule => ({
  id: 'schedule-1',
  name: 'Monthly month-end',
  frequency: 'monthly',
  pay_date_offset_days: 5,
  next_period_start: '2026-02-01',
  next_period_end: '2026-02-28',
  next_pay_date: '2026-03-05',
  ...overrides,
})

interface LoaderState {
  responses: { rows: Record<string, unknown>[] }[]
}
const loaderState: LoaderState = { responses: [] }
const loaderStateKey = Symbol.for('openbooks.pay-runs-preview-test')
;(globalThis as typeof globalThis & Record<symbol, unknown>)[loaderStateKey] = loaderState

const mockModules = new Map<string, string>([
  ['mock:db', `const state = globalThis[Symbol.for('openbooks.pay-runs-preview-test')]; export const db = { async execute() { return state.responses.shift() ?? { rows: [] } } }`],
  ['mock:authz', `export async function requirePermission() { return { user: { orgId: 'org-1' }, allowedSubsidiaryIds: null } } export function can() { return true }`],
  ['mock:intl', `export async function getTranslations() { return (key) => key }`],
  ['mock:feature', `export async function requireFeatureEnabled() {}`],
  ['mock:tabs', `export async function groupTabs() { return [] }`],
  ['mock:today', `export async function businessToday() { return '2026-03-01' }`],
  ['mock:viewspec', `export function page(value) { return value } export function pageHeader(value) { return value } export function ref() { return () => false } export function widget(widget, props, when) { return { widget, props, when } } export function widgetBlock(widget, props) { return { widget, props } }`],
])
const testHooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (specifier === '@openbooks/engine/src/platform/db.ts') return { shortCircuit: true, url: 'mock:db' }
    if (specifier === '@openbooks/engine/src/platform/business-date.ts') return { shortCircuit: true, url: 'mock:today' }
    if (specifier === 'next-intl/server') return { shortCircuit: true, url: 'mock:intl' }
    if (specifier === '../../../../lib/authz' && context.parentURL?.includes('/payroll/runs/view.ts')) return { shortCircuit: true, url: 'mock:authz' }
    if (specifier === '../../../../lib/feature-gates' && context.parentURL?.includes('/payroll/runs/view.ts')) return { shortCircuit: true, url: 'mock:feature' }
    if (specifier === '../../../../components/module-home/group-tabs' && context.parentURL?.includes('/payroll/runs/view.ts')) return { shortCircuit: true, url: 'mock:tabs' }
    if (specifier === '@braedonsaunders/appkit-viewspec') return { shortCircuit: true, url: 'mock:viewspec' }
    return next(specifier, context)
  },
  load(url, context, next) {
    const source = mockModules.get(url)
    return source === undefined ? next(url, context) : { format: 'module', source, shortCircuit: true }
  },
})
const { loadPayRuns } = (await import('../runs/view')) as typeof import('../runs/view.ts')
testHooks.deregister()

test('a January 31 monthly anchor previews February 1 through February 28', () => {
  assert.deepEqual(
    nextPeriod(schedule()),
    { start: '2026-02-01', end: '2026-02-28', payDate: '2026-03-05' },
  )
})

test('an untouched dialog lets the server derive the period canonically', () => {
  const shown = { start: '2026-02-01', end: '2026-02-28', payDate: '2026-03-05' }
  assert.deepEqual(runPayload('schedule-1', shown, 'regular', [], false), {
    payScheduleId: 'schedule-1',
    runType: 'regular',
    employeePartyIds: [],
  })
})

test('editing a date keeps the explicit off-cycle window', () => {
  const shown = { start: '2026-02-03', end: '2026-02-28', payDate: '2026-03-05' }
  assert.deepEqual(runPayload('schedule-1', shown, 'bonus', [], true), {
    payScheduleId: 'schedule-1',
    periodStart: '2026-02-03',
    periodEnd: '2026-02-28',
    payDate: '2026-03-05',
    runType: 'bonus',
    employeePartyIds: [],
  })
})

test('the schedule preview advances from the most recent regular run', async () => {
  loaderState.responses = [
    {
      rows: [{
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Monthly month-end',
        frequency: 'monthly',
        pay_date_offset_days: 5,
        anchor_period_end: '2026-01-31',
        last_end: '2026-02-28',
      }],
    },
    { rows: [] },
  ]

  const data = await loadPayRuns({})
  assert.deepEqual(data.newRun.schedules, [{
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Monthly month-end',
    frequency: 'monthly',
    pay_date_offset_days: 5,
    next_period_start: '2026-03-01',
    next_period_end: '2026-03-31',
    next_pay_date: '2026-04-05',
  }])
})
