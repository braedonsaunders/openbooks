import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { lockBankMatchRuleSet } from './banking-rule-set-lock'

const DB = !!process.env.OPENBOOKS_DB_URL

const tryLock = (orgId: string) => db.transaction(async (tx) =>
  (await tx.execute<{ got: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'bank-match-rule-set:' + orgId}, 0)) as got`)).rows[0]!.got)

test('the rule-set lock is refused on the pool, where it would release before the edit', async () => {
  await assert.rejects(lockBankMatchRuleSet(db, randomUUID()), /must be taken on the transaction that performs the edit or apply/)
})

test('a rule edit holds the rule-set lock until its transaction ends', { skip: !DB }, async () => {
  const orgId = randomUUID()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let taken!: () => void
  const lockTaken = new Promise<void>((resolve) => { taken = resolve })
  const editing = db.transaction(async (tx) => {
    await lockBankMatchRuleSet(tx, orgId)
    taken()
    await held
  })
  await lockTaken
  assert.equal(await tryLock(orgId), false, 'a concurrent apply must wait for the editing transaction')
  release()
  await editing
  assert.equal(await tryLock(orgId), true)
})
