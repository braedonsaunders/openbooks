import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { ApplicationContext } from './context'
import { ApplicationError } from './errors'
registerHooks({resolve(specifier,context,next){
  if(specifier === 'server-only')return {shortCircuit:true,url:'data:text/javascript,export {}'}
  return next(specifier,context)
}})
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
