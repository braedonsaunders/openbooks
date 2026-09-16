import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const tabSource = readFileSync(fileURLToPath(new URL('./runs-tab.tsx', import.meta.url)), 'utf8')

test('runs header carries the preview action and empty tenants get an EmptyState', () => {
  // Preview run is the primary action in the section header — always
  // visible — opening a drawer with the rule/period/book/subsidiary
  // pickers. Empty tenants get the shared EmptyState with the same action.
  assert.match(tabSource, /<EmptyState/)
  assert.match(tabSource, /emptyTitle/)
  assert.match(tabSource, /runs\.length === 0/)
  assert.match(tabSource, /previewOpen/)
  const previews = tabSource.match(/setPreview\(null\); setPreviewOpen\(true\)/g) ?? []
  assert.ok(previews.length >= 2, 'header and empty-state actions must both open preview')
})

test('run detail keeps summary, computation, lineage and house actions', () => {
  // Summary, sources, driver vector, targets, lines and lineage sections;
  // Post/Reverse/Re-run house buttons with reason prompts; the
  // pending-approval state and its Approvals link are preserved.
  for (const fragment of [
    'ComputationView',
    'LineagePanel',
    'postReasonPrompt',
    'reverseReasonPrompt',
    'promptDialog',
    'confirmDialog',
    'pendingApprovalNotice',
    'viewApproval',
    '/approvals',
  ]) {
    assert.ok(tabSource.includes(fragment), `${fragment} must be wired`)
  }
  assert.match(tabSource, /<StatusBadge/)
  assert.match(tabSource, /STATUS_VARIANTS/)
  // Shared tables only; labelled filters; namespaced common actions.
  assert.match(tabSource, /<Table>/)
  assert.ok(!tabSource.includes('<table'), 'no hand-rolled tables')
  assert.ok(!tabSource.includes(`tc('close')`), 'close resolves through actions.*')
  assert.ok(tabSource.includes(`tc('actions.close')`), 'close resolves through actions.*')
})
