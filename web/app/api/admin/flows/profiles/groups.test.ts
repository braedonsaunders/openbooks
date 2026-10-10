import assert from 'node:assert/strict'
import test from 'node:test'
import { DOCUMENT_FLOW_KINDS, listFlowSubjectProfiles } from '@openbooks/engine/src/flows/index.ts'
import { PAY_RUN_SUBJECT_KIND } from '@openbooks/engine/src/flows/pay-runs-adapter.ts'
import { FLOW_SUBJECT_GROUPS, flowSubjectGroup } from './groups.ts'

// QA-057: the New Flow record-type picker groups every subject kind under a
// product-area header. A new subject that lands in `other` renders without a
// meaningful header, so the taxonomy stays closed: classify the kind here
// instead of shipping it defaulted.
test('every known flow subject kind maps to a deliberate picker group', () => {
  const kinds = listFlowSubjectProfiles().map((profile) => profile.subjectKind)
  assert.ok(kinds.length > 0)
  const ungrouped = kinds.filter((kind) => flowSubjectGroup(kind) === 'other')
  assert.deepEqual(
    ungrouped,
    [],
    `classify these subject kinds in ./groups.ts: ${ungrouped.join(', ')}`,
  )
  for (const kind of kinds) {
    assert.ok(
      (FLOW_SUBJECT_GROUPS as readonly string[]).includes(flowSubjectGroup(kind)),
      `${kind} must map to a declared group`,
    )
  }
})

test('pay runs group with payroll, not documents', () => {
  assert.ok(DOCUMENT_FLOW_KINDS.includes(PAY_RUN_SUBJECT_KIND))
  assert.equal(flowSubjectGroup(PAY_RUN_SUBJECT_KIND), 'payroll')
})
