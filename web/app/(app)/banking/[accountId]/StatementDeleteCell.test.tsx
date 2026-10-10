import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import '../../dashboard/_dashboard-render-harness'
import { act, click, mountDashboard, scriptFetch } from '../../dashboard/_dashboard-render-harness'

// Await-imports (not static imports): module hooks register while the
// harness above evaluates, so only imports that resolve after that point see
// the jsdom shims.
const { StatementDeleteCell } = await import('./StatementDeleteCell')
const { ConfirmRoot } = await import('@/lib/confirm')

const dir = dirname(fileURLToPath(import.meta.url));
const messages = {
  banking: JSON.parse(readFileSync(join(dir, '..', '..', '..', 'messages', 'en', 'banking.json'), 'utf8')),
  common: JSON.parse(readFileSync(join(dir, '..', '..', '..', 'messages', 'en', 'common.json'), 'utf8')),
  ui: JSON.parse(readFileSync(join(dir, '..', '..', '..', 'messages', 'en', 'ui.json'), 'utf8')),
};

const STATEMENT_ID = '11111111-0000-4000-8000-000000000001'

// Import History offers delete per import: a blocked import names its reason
// on the disabled control, and deleting confirms first, then toasts the
// engine's result and refreshes the history.

function deleteButton(): HTMLButtonElement | null {
  return document.querySelector('button[aria-label="Delete import"]')
}

function toasts(): { kind: string; message: string }[] {
  return (globalThis as unknown as { __dashToasts: { kind: string; message: string }[] }).__dashToasts
}

test('a blocked import names its reason on the disabled control', async () => {
  const { unmount } = await mountDashboard(
    <>
      <StatementDeleteCell
        statementId={STATEMENT_ID}
        lineCount={2}
        blockedReason="Has 1 matched line — unmatch it first"
        confirmMessage="Delete?"
        showDelete
      />
      <ConfirmRoot />
    </>,
    messages,
  )
  try {
    const button = deleteButton()
    assert.ok(button, 'the blocked import still shows its delete control')
    assert.equal(button.disabled, true, 'the blocked delete cannot run')
    assert.equal(button.title, 'Has 1 matched line — unmatch it first', 'the reason names the remedy')
  } finally {
    await unmount()
  }
})

test('deleting confirms first, then toasts and refreshes', async () => {
  const calls: { url: string; method?: string }[] = []
  let refreshed = 0
  const restoreFetch = scriptFetch((url, init) => {
    if (url.includes(`/api/banking/statements/${STATEMENT_ID}`)) {
      calls.push({ url, method: init?.method })
      return Response.json({ ok: true, deletedLines: 3 })
    }
    return null
  })
  const { unmount } = await mountDashboard(
    <>
      <StatementDeleteCell
        statementId={STATEMENT_ID}
        lineCount={3}
        blockedReason={null}
        confirmMessage="Delete this import and its 3 lines?"
        showDelete
      />
      <ConfirmRoot />
    </>,
    messages,
  )
  try {
    const router = (globalThis as unknown as { __dashRouter: { refresh(): void } }).__dashRouter
    router.refresh = () => { refreshed += 1 }
    await click(deleteButton()!)
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find(
      (b) => b.textContent?.trim() === 'Delete import',
    ) as HTMLButtonElement | undefined
    assert.ok(confirm, 'the delete asks for confirmation first')
    await click(confirm)
    await act(async () => {})
    assert.ok(
      calls.some((c) => c.method === 'DELETE'),
      `the confirm must send DELETE, got ${JSON.stringify(calls)}`,
    )
    assert.ok(
      toasts().some((t) => t.kind === 'success' && t.message.includes('Import deleted (3 lines removed)')),
      `the delete must toast its result, got ${JSON.stringify(toasts())}`,
    )
    assert.equal(refreshed, 1, 'the history refreshes after the delete')
  } finally {
    await unmount()
    restoreFetch()
  }
})

test('a refused delete toasts the named remedy', async () => {
  const restoreFetch = scriptFetch((url) =>
    url.includes('/api/banking/statements/')
      ? Response.json({ error: 'This import has 1 matched line — unmatch it first' }, { status: 422 })
      : null,
  )
  const { unmount } = await mountDashboard(
    <>
      <StatementDeleteCell
        statementId={STATEMENT_ID}
        lineCount={1}
        blockedReason={null}
        confirmMessage="Delete this import and its 1 line?"
        showDelete
      />
      <ConfirmRoot />
    </>,
    messages,
  )
  try {
    await click(deleteButton()!)
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find(
      (b) => b.textContent?.trim() === 'Delete import',
    ) as HTMLButtonElement | undefined
    assert.ok(confirm, 'the delete asks for confirmation first')
    await click(confirm)
    await act(async () => {})
    assert.ok(
      toasts().some((t) => t.kind === 'error' && t.message.includes('unmatch it first')),
      `the refusal must surface its remedy, got ${JSON.stringify(toasts())}`,
    )
  } finally {
    await unmount()
    restoreFetch()
  }
})
