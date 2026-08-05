import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

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
