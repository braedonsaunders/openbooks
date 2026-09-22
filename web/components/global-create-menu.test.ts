import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./global-create-menu.tsx', import.meta.url), 'utf8')

test('master-data actions open unsaved editors instead of allocating draft rows', () => {
  assert.match(source, /key: 'item'.*directHref: '\/items\?item=new'/)
  assert.match(source, /key: 'asset'.*directHref: '\/assets\?assetNew=1'/)
  assert.doesNotMatch(source, /key: 'item'.*endpoint: '\/api\/items\/draft'/)
  assert.doesNotMatch(source, /key: 'asset'.*endpoint: '\/api\/assets\/draft'/)
})
