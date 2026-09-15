import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./DrillDrawer.tsx', import.meta.url), 'utf8')

test('analytics drill keeps exact API money strings through averages and shares', () => {
  assert.match(source, /import \{ abs as absoluteMoney, cmp as compareMoney, div as divideMoney \} from ['"]@openbooks\/engine\/src\/money\.ts['"]/) 
  assert.match(source, /money\(divideMoney\(data\.total, String\(data\.count\)\)\)/)
  assert.match(source, /formatExactPercent\(divideMoney\(absoluteMoney\(b\.amount\), absoluteMoney\(data\.total\)\), 1\)/)
  assert.match(source, /amount: string/)
  assert.doesNotMatch(source, /data\.total \/ data\.count/)
  assert.doesNotMatch(source, /e\.amount < 0/)
})
