import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import nodeTest from 'node:test'
import { fileURLToPath } from 'node:url'
import { allocationPortionFromInput } from './SplitLinesEditor.tsx'

const ruleDrawerSource = readFileSync(
  fileURLToPath(new URL('../../app/(app)/banking/rules/RuleDrawer.tsx', import.meta.url)),
  'utf8',
)

// The repository's normal suite uses node:test, while the focused scheduler
// check invokes Vitest. Select the active runner without making Vitest a
// production dependency or changing the package manifest.
const runnerModule = 'vitest'
const runTest = process.env.VITEST ? (await import(runnerModule)).test : nodeTest

runTest('fixed input preserves exact decimal text while percent input remains numeric', () => {
  const precise = '9007199254740993.123456789'

  assert.deepEqual(
    allocationPortionFromInput({ kind: 'fixed', value: '0' }, precise),
    { kind: 'fixed', value: precise },
  )
  assert.deepEqual(
    allocationPortionFromInput({ kind: 'percent', value: 0 }, '12.5'),
    { kind: 'percent', value: 12.5 },
  )
})

runTest('rule split serialization retains project coding and the portion object', () => {
  // The consumer must pass the editor's exact portion object through
  // unchanged; source-level assertions keep this focused without booting the
  // Next client.
  assert.match(ruleDrawerSource, /projectId: l\.projectId \?\? undefined/)
  assert.match(ruleDrawerSource, /portion: l\.portion/)
})

runTest('limited bank-rule scope needs an account before save', () => {
  assert.match(ruleDrawerSource, /accountScope: scopeOpen \? scope : undefined/)
  assert.match(ruleDrawerSource, /!scopeOpen \|\| scope\.length > 0/)
  assert.match(ruleDrawerSource, /if \(!canSave\) return/)
})
