import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

/**
 * HR-15 unified inbox page pins (text level; the loader is DB-owned and
 * covered by the integration partition).
 *
 * The page renders union decision rows through the existing approvals
 * table and the new kinds through the task list — one piece of work in
 * exactly one of them, and each on its OWN TAB. The canonical route is
 * /inbox; no /approvals route exists.
 */

test('no /approvals page route remains (rebrand: the route moved once)', () => {
  assert.throws(() => source('../approvals/page.tsx'), 'the approvals route must not exist')
})
