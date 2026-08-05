import assert from 'node:assert/strict'
import test from 'node:test'
import { findActiveNavHref } from './sidebar-nav-active.ts'

const groups = [{
  items: [
    { href: '/assets' },
    { href: '/assets?tab=tax-depreciation' },
  ],
}]

test('query-addressed modules win over their shared page module', () => {
  assert.equal(findActiveNavHref('/assets', groups), '/assets')
  assert.equal(findActiveNavHref('/assets?asset=abc', groups), '/assets')
  assert.equal(
    findActiveNavHref('/assets?asset=abc&tab=tax-depreciation', groups),
    '/assets?tab=tax-depreciation',
  )
})
