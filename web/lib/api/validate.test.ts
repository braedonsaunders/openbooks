import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({resolve(specifier,context,next){
  if(specifier === 'server-only')return {shortCircuit:true,url:'data:text/javascript,export {}'}
  return next(specifier,context)
}})
const { coerceScalar } = await import('./validate')

test('generic API money coercion preserves exact decimal text and refuses excess precision', () => {
  assert.deepEqual(coerceScalar('number','999999999999999.9999'), {ok:true,value:'999999999999999.9999'})
  assert.deepEqual(coerceScalar('number','-0.0001'), {ok:true,value:'-0.0001'})
  assert.deepEqual(coerceScalar('number','12.34567'), {ok:false,message:'must be a number'})
  assert.deepEqual(coerceScalar('number','1,234'), {ok:false,message:'must be a number'})
})
