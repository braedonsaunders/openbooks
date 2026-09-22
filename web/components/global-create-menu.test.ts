import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./global-create-menu.tsx', import.meta.url), 'utf8')

test('master-data actions open unsaved editors instead of allocating draft rows', () => {
  assert.match(source, /key: 'item'.*directHref: '\/items\?item=new'/)
  assert.match(source, /key: 'asset'.*directHref: '\/assets\?assetNew=1'/)
  assert.match(source, /key: 'customer'.*directHref: '\/entities\/customers\?partyNew=1&role=customer'/)
  assert.match(source, /key: 'vendor'.*directHref: '\/entities\/vendors\?partyNew=1&role=vendor'/)
  assert.match(source, /key: 'employee'.*directHref: '\/entities\/employees\?partyNew=1&role=employee'/)
  assert.match(source, /key: 'project'.*directHref: '\/projects\?projectNew=1'/)
  assert.doesNotMatch(source, /key: 'item'.*endpoint: '\/api\/items\/draft'/)
  assert.doesNotMatch(source, /key: 'asset'.*endpoint: '\/api\/assets\/draft'/)
  assert.doesNotMatch(source, /key: '(customer|vendor|employee)'.*endpoint: '\/api\/parties\/draft'/)
  assert.doesNotMatch(source, /key: 'project'.*endpoint: '\/api\/projects\/draft'/)
})
