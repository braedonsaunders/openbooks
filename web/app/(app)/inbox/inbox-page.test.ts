import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const page = source('./view.ts')
const spec = source('./page.tsx')

/**
 * HR-15 unified inbox page pins (text level; the loader is DB-owned and
 * covered by the integration partition).
 *
 * The page renders union decision rows through the existing approvals
 * table and the new kinds through the task list — one piece of work in
 * exactly one of them — with the unified filter chips above both. The
 * canonical route is /inbox; no /approvals route exists.
 */
test('the inbox spec carries the unified filters and both row treatments', () => {
  // Six filters, one chips row, above the union table and the task list.
  assert.match(page, /'all',\n\s*'approvals',\n\s*'my_tasks',\n\s*'signatures',\n\s*'notices',\n\s*'overdue'/)
  assert.match(page, /widgetBlock\('kind-chips', \{\n\s+chips: data\.filters,/)
  // Decision rows keep the approvals table; new kinds get the task list.
  assert.match(page, /widgetBlock\('approvals-table', \{/)
  assert.match(page, /widgetBlock\('inbox-task-list', \{/)
  // The task list never renders union-owned kinds (dedupe contract).
  assert.match(page, /Union-owned kinds never render here/)
  assert.match(page, /INBOX_TASK_KINDS/)
  assert.doesNotMatch(page, /flows_approval.*inbox-task-list|inbox-task-list.*flows_approval/)
})

test('the inbox route is canonical and the task actions post in place', () => {
  assert.match(page, /route: '\/inbox'/)
  assert.doesNotMatch(page, /route: '\/approvals'/)
  assert.match(spec, /loadApprovals/)
  const island = source('./InboxTaskList.tsx')
  assert.match(island, /fetch\('\/api\/inbox\/act'/)
  assert.match(island, /promptDialog\(/)
  // Error bodies are checked before they are parsed.
  assert.match(island, /if \(!res\.ok\)/)
})

test('no /approvals page route remains (rebrand: the route moved once)', () => {
  assert.throws(() => source('../approvals/page.tsx'), 'the approvals route must not exist')
})
