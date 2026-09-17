import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const tabSource = readFileSync(fileURLToPath(new URL('./runs-tab.tsx', import.meta.url)), 'utf8')

test('runs list follows the departments composition', () => {
  // Blurb + Preview-run primary action row, sibling filter bar, then the
  // table — headers plus one empty row when there are no runs, never an
  // EmptyState card. Preview opens the drawer with the pickers.
  assert.ok(!tabSource.includes('<EmptyState'), 'no EmptyState card')
  assert.match(tabSource, /emptyAsRow/)
  assert.ok(tabSource.includes(`{t('empty')}`), 'empty row renders the empty copy')
  // RatesTab depth: blurb + action, no restated h2.
  assert.ok(!tabSource.includes('<h2'), 'no section h2 above the list')
  assert.match(tabSource, /previewOpen/)
  assert.ok((tabSource.match(/setPreview\(null\); setPreviewOpen\(true\)/g) ?? []).length >= 1, 'header action opens preview')
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
  // No common-namespace action labels remain un-namespaced: every tc() key
  // resolves under actions.* (a bare key renders the raw key path).
  assert.ok(!tabSource.includes(`tc('`), 'no bare common-namespace keys')
  // Sibling filter-bar chrome: inline plain labels, no `?` Fields, no bare count chip.
  assert.match(tabSource, /inline-flex items-center gap-2 text-sm/)
  assert.ok(!tabSource.includes(`<Field label={t('filterStatus')}`), 'status filter uses an inline label')
  assert.ok(!tabSource.includes('{total}'), 'no bare count chip')
  // Drawers carry their primary in the header (SetupDrawer composition).
  assert.match(tabSource, /headerActions=/)
  assert.ok(!tabSource.includes('footer={'), 'no footer button rows')
})

test('preview failures render inside the preview drawer, not behind it (F-t06-017)', () => {
  // runPreview stores server failures in `notice`, but the preview drawer
  // body rendered only the computation — a 422/500 left the dialog exactly
  // as-is with the message behind it. The drawer must render the notice.
  const drawerOpen = tabSource.indexOf('open={previewOpen}')
  assert.ok(drawerOpen >= 0, 'preview drawer must exist')
  const after = tabSource.slice(drawerOpen)
  const drawerEnd = after.indexOf('</Drawer>')
  assert.ok(drawerEnd > 0, 'preview drawer must close')
  assert.match(
    after.slice(0, drawerEnd),
    /\{notice /,
    'the preview drawer body must render the failure notice inline',
  )
})
