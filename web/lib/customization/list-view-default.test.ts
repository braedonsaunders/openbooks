import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AmbiguousListViewDefaultError,
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
