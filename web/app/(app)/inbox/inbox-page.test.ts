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
 * exactly one of them, and each on its OWN TAB. The canonical route is
 * /inbox; no /approvals route exists.
 */
test('the inbox spec carries the unified filters and both row treatments', () => {
  // Five task scopes, exposed through the shared list toolbar dropdown.
  assert.match(page, /'all',\n\s*'my_tasks',\n\s*'signatures',\n\s*'notices',\n\s*'overdue'/)
  assert.match(page, /widgetBlock\('list-toolbar', \{/)
  assert.match(page, /search: \{ paramKey: 'q'/, 'every inbox tab has the house search control')
  assert.doesNotMatch(page, /widgetBlock\('kind-chips'/, 'no extra pill row remains below the tabs')
  // Decision rows keep the approvals table; new kinds get the task list.
  assert.match(page, /widgetBlock\('approvals-table', \{/)
  assert.match(page, /widgetBlock\('inbox-task-list', \{/)
  // The task list never renders union-owned kinds (dedupe contract).
  assert.match(page, /Union-owned kinds never render here/)
  assert.match(page, /INBOX_TASK_KINDS/)
  assert.doesNotMatch(page, /flows_approval.*inbox-task-list|inbox-task-list.*flows_approval/)

  const taskList = source('./InboxTaskList.tsx')
  assert.match(taskList, /<Table>/, 'tasks use the regular table treatment, not stacked cards')
  assert.doesNotMatch(taskList, /<ul className="space-y-2">/, 'the card-list treatment is removed')
})

test('tasks are a TAB on the shared subtab strip, never a panel under the table', () => {
  // The hub drew its own tab strip (ApprovalTabs — teal, under the header)
  // and then stacked a titled "My tasks" panel below the approvals table, so
  // one page showed two unrelated worklists down the screen.
  assert.match(page, /widget\('module-home-tabs', \{ tabs: data\.tabs \}\)/,
    'the tabs are the shared subtab strip, in the page header')
  assert.doesNotMatch(page, /'approval-tabs'/, 'the hub has no tab strip of its own')
  assert.match(page, /key: 'tasks'/, 'my tasks is one of the tabs')
  assert.match(page, /showTasks = tab === 'tasks'/, 'the task list renders only on its own tab')
  assert.match(page, /const showUnion = onApprovals/, 'the approvals table renders only on the approvals tabs')
  assert.doesNotMatch(page, /panel\(\{\n\s+title: f\('tasksTitle'\)/, 'no titled tasks panel remains')

  const sections = source('./sections.tsx')
  assert.doesNotMatch(sections, /export function ApprovalTabs/, 'the second tab component is deleted')
})

test('a refusal from the task API reaches the operator as a message', () => {
  const island = source('./InboxTaskList.tsx')
  // `inbox.refused` carries an ICU argument. Resolved server-side without it
  // next-intl threw FORMATTING_ERROR and returned the key path, and the
  // client then ran .replace('{message}', …) over a string with no
  // placeholder — so every refusal rendered as the literal `inbox.refused`.
  assert.match(island, /t\('refused', \{ message:/, 'the message is composed where its argument exists')
  assert.doesNotMatch(island, /labels\.refused/, 'no pre-resolved refusal template is passed in')
  assert.doesNotMatch(page, /taskRefusedLabel/, 'the loader no longer resolves it')
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

test('one failing source names itself beside the surviving rows (OM-10)', () => {
  // The leave own leg used to throw for actors without hrm.leave.request
  // and the throw blanked the whole inbox. Each task read now collects its
  // failed sources while the healthy legs still list, and the loader
  // renders them as small named notices — never a crash, never silence.
  assert.match(page, /notices: collected/, 'each task read collects its failed sources')
  assert.match(page, /taskNoticeByKind/, 'the parallel reads dedupe notices by kind')
  assert.match(
    page,
    /ti\('sourceUnavailable', \{ source: ti\(`kinds\./,
    'the notice names the area through its kinds label',
  )
  assert.match(page, /notices: data\.taskNotices/, 'the task list carries the notices')
  assert.match(
    page,
    /tasksPresent: showTasks && \(taskRows\.length > 0 \|\| failedSourceNotices\.length > 0\)/,
    'the list block stays mounted so a notice renders even with no rows',
  )
  assert.match(
    page,
    /taskRows\.length === 0 && failedSourceNotices\.length === 0/,
    'a failed source is not "all clear"',
  )
  const island = source('./InboxTaskList.tsx')
  assert.match(island, /notes\.length === 0/, 'notices render even when no rows remain')
  assert.match(island, /role="status"/, 'the notice is a status region, not a second table')
})
