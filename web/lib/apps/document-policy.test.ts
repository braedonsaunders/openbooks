import assert from 'node:assert/strict'
import test from 'node:test'
import { APP_DOCUMENT_CSP, isAppDocumentRequest } from './document-policy'
import { buildContentSecurityPolicy } from '../content-security-policy'

test('app execution policy is restricted to exact document GETs and enforces opaque origin even when opened directly',()=>{
  assert.equal(isAppDocumentRequest('/api/apps/my-app/sandbox','GET'),true)
  for(const path of ['/api/apps/my-app/sandbox/other','/api/apps/my-app/bridge','/admin/apps','/apps/my-app','/api/apps/../sandbox','/api/apps/%2e%2e/sandbox']) assert.equal(isAppDocumentRequest(path,'GET'),false,path)
  assert.equal(isAppDocumentRequest('/api/apps/my-app/sandbox','POST'),false)
  assert.match(APP_DOCUMENT_CSP,/sandbox allow-scripts;/)
  assert.doesNotMatch(APP_DOCUMENT_CSP,/allow-same-origin|allow-top-navigation|allow-forms/)
  assert.match(APP_DOCUMENT_CSP,/connect-src 'none'/)
  assert.match(APP_DOCUMENT_CSP,/frame-ancestors 'self'/)
  const host=buildContentSecurityPolicy('abcdefghijklmnop',false)
  assert.match(host,/frame-ancestors 'none'/)
  assert.match(host,/script-src 'self' 'nonce-abcdefghijklmnop' 'strict-dynamic'/)
})
