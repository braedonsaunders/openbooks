import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./[id]/RunWizard.tsx', import.meta.url), 'utf8')

test('payroll GL preview keeps exact money strings out of floating-point arithmetic', () => {
  assert.match(source, /import \{ decimalAbs, decimalCmp, decimalNeg, decimalPercentChange, decimalSum \} from/)
  assert.match(source, /total: decimalSum\(amounts\)/)
  assert.match(source, /const creditTotal = decimalNeg\(decimalSum\(credits\.map\(\(leg\) => leg\.amount\)\)\)/)
  assert.doesNotMatch(source, /Number\(leg\.amount\)/)
  assert.doesNotMatch(source, /Math\.abs\(Number\(/)
  assert.doesNotMatch(source, /Number\(entry\.amount\)/)
})

// The pay-run approval affordance: the commit refusal names submit-for-
// approval as its remedy, and the wizard is where that remedy must exist.
// The expenses drawer is the exemplar — a server-resolved boolean composed
// with status — so these tests pin the composition, not pixels.

test('the submit affordance is gated on the Flows policy, not on a flag or a permission alone', () => {
  // "No flow configured" is a configuration question the engine answers:
  // the button requires policyExists AND an unsubmitted run.
  assert.match(source, /props\.approval\.policyExists && !props\.approval\.submitted/)
  // Permission still applies (as in the exemplar), but never alone.
  assert.match(source, /const canSubmitApproval =[\s\S]{0,400}?props\.canRun/)
  assert.match(source, /const canSubmitApproval =[\s\S]{0,400}?props\.approval\.policyExists/)
})

test('submit is offered only on figures the approver can trust', () => {
  // Submission parks the document (no recalculation while pending, and no
  // recall path exists for pay runs), so an uncalculated or stale run would
  // strand with empty or superseded evidence. The boundary refuses
  // uncalculated submits too (assemblePayRunEvidence) — the UI mirrors it.
  assert.match(source, /const canSubmitApproval =[\s\S]{0,400}?calculated/)
  assert.match(source, /const canSubmitApproval =[\s\S]{0,400}?!props\.staleness\.stale/)
})

test('a submitted run never offers submit again', () => {
  assert.match(source, /approval\.policyExists && approval\.pending && !committed/)
  // The shared ApprovalActions showSubmit path is deliberately NOT wired:
  // it posts an empty body and the payroll boundary would 400.
  assert.doesNotMatch(source, /<ApprovalActions[^>]*submitApprovalHref/)
})

test('pending and history reuse the shared Flows surfaces for the pay_run subject', () => {
  assert.match(source, /import \{ ApprovalActions, refreshApprovalState \} from/)
  assert.match(source, /import \{ ApprovalHistory \} from/)
  assert.match(source, /import \{ FlowManualButtons \} from/)
  assert.match(source, /<ApprovalActions subjectKind="pay_run" subjectId=\{documentId\}/)
  assert.match(source, /<ApprovalHistory subjectKind="pay_run" subjectId=\{documentId\}/)
  assert.match(source, /<FlowManualButtons subjectKind="pay_run" subjectId=\{documentId\}/)
})

test('submit posts the named payroll action the boundary serves', () => {
  // The shared ApprovalActions showSubmit path posts an empty body, which
  // the payroll boundary answers 400 (unknown action) — so the wizard owns
  // the only submit path and it posts submit-approval (evidence assembly).
  assert.match(source, /body: JSON\.stringify\(\{ action: 'submit-approval' \}\)/)
})

test('commit stays available after the flow releases the run', () => {
  // Release flips the document to 'approved'; a draft-only commit button
  // would strand the operator one step later (approved yet
  // uncommittable). The API boundary is unchanged — this is UI enablement
  // against the same released flag the boundary refuses on.
  assert.match(source, /commitDocOpen = docDraft \|\| \(run\.document_status === 'approved' && props\.approval\.released\)/)
  assert.match(source, /props\.canRun && commitDocOpen && run\.run_status === 'calculated'/)
})
