import assert from 'node:assert/strict'
import test from 'node:test'
import { isAllowedPdfRequest } from './html'

test('allows the print document and inline visual resources only', () => {
  assert.equal(isAllowedPdfRequest('document', 'about:blank'), true)
  assert.equal(isAllowedPdfRequest('image', 'data:image/png;base64,AAAA'), true)
  assert.equal(isAllowedPdfRequest('font', 'data:font/woff2;base64,AAAA'), true)
  assert.equal(isAllowedPdfRequest('stylesheet', 'data:text/css,body%7Bcolor%3Ared%7D'), true)
})

test('blocks template-authored network and non-visual requests', () => {
  assert.equal(isAllowedPdfRequest('image', 'http://169.254.169.254/latest/meta-data/'), false)
  assert.equal(isAllowedPdfRequest('stylesheet', 'https://internal.example/admin'), false)
  assert.equal(isAllowedPdfRequest('document', 'https://example.com/redirect'), false)
  assert.equal(isAllowedPdfRequest('image', 'file:///etc/passwd'), false)
  assert.equal(isAllowedPdfRequest('script', 'data:text/javascript,alert(1)'), false)
})
