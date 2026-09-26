import assert from 'node:assert/strict'
import test from 'node:test'
import type { ApplicationContext } from './context'
import { ApplicationError } from './errors'
const { listApplicationUsers } = await import('./admin-read')

const context = {
  authz:{user:{orgId:'admin-read-unit-test'},permissions:new Set(),allowedSubsidiaryIds:null},
  source:'api',requestId:'admin-read-unit-request',apiKeyId:null,
} as unknown as ApplicationContext

test('admin user reads refuse before database access without the management permission', async () => {
  await assert.rejects(
    listApplicationUsers(context,{}),
    (error: unknown) => error instanceof ApplicationError
      && error.code === 'forbidden'
      && error.status === 403
      && error.details?.permission === 'admin.users.manage',
  )
})
