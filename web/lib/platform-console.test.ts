import assert from 'node:assert/strict'
import test from 'node:test'
import { platformListPage } from './platform-console'

test('platform console pages start on page one without a page param', () => {
  assert.equal(platformListPage({}), 1)
})

test('platform console pages honor a numeric page param', () => {
  assert.equal(platformListPage({ page: '3' }), 3)
})

test('platform console pages refuse non-numeric, zero, and negative pages as page one', () => {
  for (const page of ['abc', '0', '-5', '']) {
    assert.equal(platformListPage({ page }), 1, `?page=${page}`)
  }
})

test('platform console pages truncate fractions and clamp huge pages', () => {
  assert.equal(platformListPage({ page: '2.9' }), 2)
  assert.equal(platformListPage({ page: '999999' }), 10_000)
})

test('platform console pages read the first value of a repeated page param', () => {
  assert.equal(platformListPage({ page: ['4', '9'] }), 4)
})
