import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AmbiguousListViewDefaultError,
  InactiveListViewDefaultError,
  assertActiveListViewDefault,
  assertSingleListViewDefault,
  listViewDefaultLockKey,
  type ListViewDefaultExecutor,
} from './list-view-default.ts'

test('personal default lock keys are per owner, not per org', () => {
  assert.equal(
    listViewDefaultLockKey({ orgId: 'org-1', recordType: 'employee', scope: 'user', ownerId: 'user-1' }),
    'list-view-default:org-1:user:user-1:employee',
  )
  assert.notEqual(
    listViewDefaultLockKey({ orgId: 'org-1', recordType: 'employee', scope: 'user', ownerId: 'user-1' }),
    listViewDefaultLockKey({ orgId: 'org-1', recordType: 'employee', scope: 'user', ownerId: 'user-2' }),
  )
  assert.equal(
    listViewDefaultLockKey({ orgId: 'org-1', recordType: 'employee', scope: 'org', ownerId: null }),
    'list-view-default:org-1:org:employee',
  )
})

test('assertSingleListViewDefault refuses overlapping defaults by name', async () => {
  const tx = {
    execute: (async () => ({ rows: [{ n: 2 }] })) as unknown as ListViewDefaultExecutor['execute'],
  }
  await assert.rejects(
    () =>
      assertSingleListViewDefault(tx, {
        orgId: 'org-1',
        recordType: 'employee',
        scope: 'user',
        ownerId: 'user-1',
      }),
    (error: unknown) => {
      assert.ok(error instanceof AmbiguousListViewDefaultError)
      assert.match(error.message, /Clear the extra default/)
      return true
    },
  )
})

test('assertActiveListViewDefault refuses default+inactive by name', () => {
  assert.doesNotThrow(() => assertActiveListViewDefault(true, true))
  assert.doesNotThrow(() => assertActiveListViewDefault(false, false))
  assert.throws(
    () => assertActiveListViewDefault(true, false),
    (error: unknown) => {
      assert.ok(error instanceof InactiveListViewDefaultError)
      assert.match(error.message, /activate it, or unset default before deactivating/)
      return true
    },
  )
})
