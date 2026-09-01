import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { initialDrawerMode } from './drawer-mode.ts'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string) => readFileSync(join(webRoot, path), 'utf8')

test('journal approval UX is Flow-driven and does not reserve a drawer tab', () => {
  const drawer = source('app/(app)/journal/JournalDrawer.tsx')
  const action = source('app/api/journals/actions/route.ts')
  const history = source('components/approval-history.tsx')

  assert.match(action, /submitAndReleaseIfUngated\(\s*'journal'/)
  assert.match(drawer, /<ApprovalActions subjectKind="journal" subjectId=\{String\(doc\.id\)\} \/>/)
  assert.match(drawer, /<ApprovalHistory subjectKind="journal" subjectId=\{String\(doc\.id\)\} \/>/)
  assert.doesNotMatch(drawer, /detailTabs=\{\[[\s\S]*?key: 'approvals'/)
  assert.match(history, /if \(history\.length === 0\) return null/)
})

test('journal drawer keeps immutable lifecycle states out of edit mode', () => {
  const drawer = source('app/(app)/journal/JournalDrawer.tsx')
  const lifecycle = drawer.slice(
    drawer.indexOf('const doc = journal.doc'),
    drawer.indexOf('const [partyId', drawer.indexOf('const doc = journal.doc')),
  )
  const editControl = drawer.slice(drawer.indexOf('primaryAction={'), drawer.indexOf('actions={'))
  const actions = drawer.slice(drawer.indexOf('actions={'), drawer.indexOf('footer='))
  const voidWorkflow = drawer.slice(drawer.indexOf('async function voidJournal'), drawer.indexOf('// -- grid columns'))

  // This table is the drawer's lifecycle contract: only a draft may honor an
  // edit intent; approval, posting, and voiding preserve the journal evidence.
  for (const status of ['draft', 'pending_approval', 'approved', 'posted', 'voided']) {
    const canEdit = status === 'draft'
    assert.equal(
      initialDrawerMode('edit', canEdit),
      canEdit ? 'edit' : 'view',
      `${status} journals must ${canEdit ? '' : 'not '}enter edit mode`,
    )
  }

  assert.match(lifecycle, /const canEditStatus = doc\.status === 'draft'/)
  assert.match(lifecycle, /initialDrawerMode\(initialMode, canEditStatus\)/)
  assert.match(lifecycle, /const editable = mode === 'edit' && canEditStatus/)
  assert.doesNotMatch(lifecycle, /doc\.status === 'posted'/)
  assert.doesNotMatch(drawer, /Draft and POSTED journals are both editable/)
  assert.match(drawer, /Only draft journals are editable\.[\s\S]*controlled[\s\S]*correction\/void workflows/)

  // The edit affordance is itself gated, while immutable records retain the
  // approval/flow controls and the reasoned, audited void workflow.
  assert.match(editControl, /canEditStatus \?/)
  assert.match(editControl, /mode === 'edit' \? cancel\(\) : setMode\('edit'\)/)
  assert.match(actions, /<FlowManualButtons subjectKind="journal" subjectId=/)
  assert.match(actions, /<ApprovalActions subjectKind="journal" subjectId=/)
  assert.match(actions, /doc\.status === 'approved' \|\| doc\.status === 'posted'/)
  assert.match(actions, /onClick=\{voidJournal\}/)
  assert.match(voidWorkflow, /promptDialog\(/)
  assert.match(voidWorkflow, /fetch\(\s*`\/api\/documents\/\$\{doc\.id\}\/void`/)
  assert.match(voidWorkflow, /body: JSON\.stringify\(\{ reason \}\)/)
})
