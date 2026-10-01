import assert from 'node:assert/strict'
import test from 'node:test'
import { LIST_DRAWER_ROUTES, isListDrawerHrefChange, listDrawerRoute } from './drawer-routes'

const id = '019f0000-0000-4000-8000-000000000003'
test('native record opening and closing preserve every list filter without server navigation', () => {
  for (const route of Object.values(LIST_DRAWER_ROUTES)) {
    const base = route.path + '?q=invoice&page=3&status=posted&sort=amount'
    const selected = base + '&' + route.param + '=' + id
    assert.equal(isListDrawerHrefChange(base, selected), true, route.path)
    assert.equal(isListDrawerHrefChange(selected, base), true, route.path)
    assert.equal(isListDrawerHrefChange(selected, selected + '&mode=edit&transactionTab=lines'), true)
    assert.equal(isListDrawerHrefChange(selected, selected.replace('page=3', 'page=4')), false, 'a filter change must refresh rows')
    assert.equal(isListDrawerHrefChange(base, base + '&' + route.param + '=new'), false, 'create uses the native page loader')
    assert.equal(isListDrawerHrefChange(base, base + '&' + route.param + '=invalid'), false)
    assert.equal(isListDrawerHrefChange('https://example.test' + base, 'https://other.test' + selected), false)
  }
  assert.equal(isListDrawerHrefChange('/payroll/runs', '/payroll/runs/' + id), false, 'pay runs retain their full-page wizard')
  assert.equal(isListDrawerHrefChange('/ap/bills', '/ar/invoices?doc=' + id), false)
  assert.equal(listDrawerRoute('__proto__'), null)
})
