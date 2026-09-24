import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * The English myComp.notLinked is pinned word-for-word to the engine
 * SelfServiceError NO_LINK remedy
 * (engine/src/hrm/self-service/actor.ts): one remedy, and a second
 * rendering of it would drift. Per-locale presence and translation of the
 * myComp keys is covered by the catalog parity verbatim rule.
 */

const ROOT = process.cwd()

type Dict = Record<string, unknown>

function load(locale: string): Dict {
  return JSON.parse(readFileSync(join(ROOT, 'web', 'messages', locale, 'hrm.json'), 'utf8')) as Dict
}

function at(obj: Dict, path: string): unknown {
  let node: unknown = obj
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in node)) return undefined
    node = (node as Dict)[part]
  }
  return node
}

test('the English no-link remedy matches the engine refusal word for word', async () => {
  // One remedy: the engine throws it, the page renders it. Drive the real
  // actorPartyOf against an empty users read (a stubbed database, not a
  // stubbed module) and compare the thrown message with the catalog.
  const { actorPartyOf, SelfServiceError } = await import(
    '../../engine/src/hrm/self-service/actor.ts'
  )
  // Hand-rolled database double in the house style (engine hrm tests fake
  // the executor the same way); import type is erased, so no pool is built.
  type Executor = Pick<
    import('../../engine/src/platform/db.ts').SqlExecutor,
    'execute'
  >
  const exec = {
    execute: async () => ({ rows: [] as { partyId: string | null }[] }),
  } as unknown as Executor
  const thrown: unknown = await actorPartyOf(exec, 'org-1', 'user-1').then(
    () => null,
    (error: unknown) => error,
  )
  assert.ok(thrown instanceof SelfServiceError, 'an unlinked login must throw SelfServiceError')
  assert.equal(thrown.code, 'NO_LINK')
  assert.equal(
    at(load('en'), 'myComp.notLinked'),
    thrown.message,
    'en myComp.notLinked drifted from the engine NO_LINK remedy — one remedy, keep them identical',
  )
})
