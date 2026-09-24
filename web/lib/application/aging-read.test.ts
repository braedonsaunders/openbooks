import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { ApplicationContext } from './context'
import { ApplicationError } from './errors'
registerHooks({resolve(specifier,context,next){
  if(specifier === 'server-only')return {shortCircuit:true,url:'data:text/javascript,export {}'}
  return next(specifier,context)
}})
const { getApplicationPartnerStatement, listApplicationAging, listApplicationAgingDetail } = await import('./aging-read')

const context = {
  authz:{user:{orgId:'aging-test-org'},permissions:new Set(['ar.read','ap.read']),allowedSubsidiaryIds:null},
  source:'api',requestId:'aging-test-request',apiKeyId:null,
} as unknown as ApplicationContext

test('aging application reads refuse an unsupported ledger side before querying', async () => {
  for (const read of [
    () => listApplicationAging(context,{side:'cash'}),
    () => listApplicationAgingDetail(context,{side:'cash'}),
    () => getApplicationPartnerStatement(context,{partyId:'00000000-0000-4000-8000-000000000001',side:'cash',from:'2026-01-01',to:'2026-01-31'}),
  ]) {
    await assert.rejects(read(), (error: unknown) => error instanceof ApplicationError
      && error.code === 'invalid_input'
      && error.status === 422
      && error.message === 'side is required; use ar or ap')
  }
})

test('partner statements reject malformed party references before reading', async () => {
  await assert.rejects(
    getApplicationPartnerStatement(context,{partyId:'not-a-uuid',side:'ar',from:'2026-01-01',to:'2026-01-31'}),
    (error: unknown) => error instanceof ApplicationError
      && error.code === 'invalid_input'
      && error.status === 422
      && error.message === 'partyId must be a UUID',
  )
})
