import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const ui = readFileSync('web/app/(app)/payroll/_ui/filing-amendments.tsx', 'utf8')
const route = readFileSync('web/app/api/payroll/year-end/amendments/route.ts', 'utf8')
const engine = readFileSync('engine/src/payroll-yearend-amendments.ts', 'utf8')

test('cancellation cannot issue from an accidental click without reviewed evidence', () => {
  assert.match(ui, /import \{ confirmDialog \} from .*lib\/confirm/)
  assert.match(ui, /preview\.revision === 'cancelled'/)
  assert.match(ui, /preview\.rowId === review\.rowId/)
  assert.match(ui, /cancelPreviewRequired/)
  assert.match(ui, /if \(!cancellationPreviewLoaded\)/)
  assert.match(ui, /disabled=\{busy != null \|\| !cancellationPreviewLoaded \|\| !cancellationReason\.trim\(\)\}/)
  assert.match(ui, /tone: 'danger'/)
})

test('cancellation reason and preview state are reset when their evidence context changes', () => {
  assert.match(
    ui,
    /return <FilingCorrectionSectionBody key=\{`\$\{review\.rowId\}:\$\{review\.lastRevision \?\? 'none'\}`\} \{\.\.\.props\} \/>/,
  )
  assert.match(ui, /setCancellationReason\(''\)[\s\S]*try \{[\s\S]*fetch\(correctionHref\(revision, 'json'\)/)
  assert.match(ui, /const reason = cancellationReason\.trim\(\)/)
  assert.match(ui, /cancelReasonRequired/)
})

test('the destructive path confirms explicitly and sends its reason as evidence', () => {
  assert.match(ui, /const confirmed = await confirmDialog\(/)
  assert.match(ui, /if \(!confirmed\) return/)
  assert.match(ui, /payload\.confirmedCancellation = true/)
  assert.match(ui, /payload\.reason = reason/)
  assert.match(route, /body\.confirmedCancellation !== true/)
  assert.match(route, /body\.reason\.trim\(\) === ''/)
  assert.match(route, /note: revision === 'cancelled' \? body\.reason!\.trim\(\)/)
  assert.match(engine, /revision === "cancelled" && !cancellationReason/)
})
