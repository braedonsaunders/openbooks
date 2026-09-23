import assert from 'node:assert/strict'
import test from 'node:test'
import { MOVED_FROM_PARAM, movedUrl } from './moved-redirect'

// UX-17: setup aliases must land the reader somewhere explained, with their
// own context intact. movedUrl is pure, so these pin the real function.
test('an alias target names its source', () => {
  assert.equal(
    movedUrl('/admin/setup/company', 'settings'),
    '/admin/setup/company?movedFrom=settings',
  )
  assert.equal(
    movedUrl('/admin/setup/readiness', 'setup-index'),
    '/admin/setup/readiness?movedFrom=setup-index',
  )
  assert.equal(
    movedUrl('/admin/setup/features', 'payment-providers'),
    '/admin/setup/features?movedFrom=payment-providers',
  )
})

test('reader params travel along so shared links keep their context', () => {
  assert.equal(
    movedUrl('/admin/setup/company', 'settings', { tab: 'tax', q: 'vat' }),
    '/admin/setup/company?tab=tax&q=vat&movedFrom=settings',
  )
})

test('array params survive the hop', () => {
  assert.equal(
    movedUrl('/admin/setup/company', 'settings', { tag: ['a', 'b'] }),
    '/admin/setup/company?tag=a&tag=b&movedFrom=settings',
  )
})

test('a chained alias reports the latest hop, never a stack', () => {
  assert.equal(
    movedUrl('/admin/setup/readiness', 'setup-index', { [MOVED_FROM_PARAM]: 'settings' }),
    '/admin/setup/readiness?movedFrom=setup-index',
  )
})

test('undefined params are dropped, not stringified', () => {
  assert.equal(
    movedUrl('/admin/setup/company', 'settings', { tab: undefined }),
    '/admin/setup/company?movedFrom=settings',
  )
})
