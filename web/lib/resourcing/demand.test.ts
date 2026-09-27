import assert from 'node:assert/strict'
import test from 'node:test'
import { weighDemandLine } from './demand.ts'

const live = { inScope: true, inPipeline: true, isActive: true, isClosed: false, isWon: false, forecastCategory: 'upside', probability: 40 }
const expected = (basis: 'manual' | 'pipeline' | 'excluded', weightedHours: string, probability: number | null, excludedReason: 'out_of_scope' | 'won' | 'closed' | 'omitted' | 'inactive' | null) => ({ basis, weightedHours, probability, excludedReason })

test('demand weights and exclusions follow the live CRM pipeline', () => {
  const cases: { name: string; line: Parameters<typeof weighDemandLine>[0]; result: ReturnType<typeof weighDemandLine> | 'throws' }[] = [
    { name: 'manual', line: { hoursPerWeek: '10.0000', opportunity: null }, result: expected('manual', '10.0000', null, null) },
    { name: 'pipeline', line: { hoursPerWeek: '10.0000', opportunity: live }, result: expected('pipeline', '4.0000', 40, null) },
    { name: 'rounds half away at four decimals', line: { hoursPerWeek: '7.3333', opportunity: { ...live, probability: 33 } }, result: expected('pipeline', '2.4200', 33, null) },
    { name: 'outside scope', line: { hoursPerWeek: '10.0000', opportunity: { ...live, inScope: false } }, result: expected('excluded', '0.0000', null, 'out_of_scope') },
    { name: 'won', line: { hoursPerWeek: '10.0000', opportunity: { ...live, inPipeline: false, isWon: true } }, result: expected('excluded', '0.0000', 40, 'won') },
    { name: 'closed', line: { hoursPerWeek: '10.0000', opportunity: { ...live, inPipeline: false, isClosed: true } }, result: expected('excluded', '0.0000', 40, 'closed') },
    { name: 'omitted', line: { hoursPerWeek: '10.0000', opportunity: { ...live, inPipeline: false, forecastCategory: 'omitted' } }, result: expected('excluded', '0.0000', 40, 'omitted') },
    { name: 'inactive', line: { hoursPerWeek: '10.0000', opportunity: { ...live, inPipeline: false, isActive: false } }, result: expected('excluded', '0.0000', 40, 'inactive') },
    { name: 'won precedes omitted', line: { hoursPerWeek: '10.0000', opportunity: { ...live, inPipeline: false, isWon: true, forecastCategory: 'omitted' } }, result: expected('excluded', '0.0000', 40, 'won') },
    { name: 'pipeline predicate and closed status disagree', line: { hoursPerWeek: '10.0000', opportunity: { ...live, isClosed: true } }, result: 'throws' },
  ]
  for (const entry of cases) {
    if (entry.result === 'throws') {
      assert.throws(() => weighDemandLine(entry.line), (error: unknown) => error instanceof Error && error.constructor === Error, entry.name)
    } else {
      assert.deepEqual(weighDemandLine(entry.line), entry.result, entry.name)
    }
  }
})
