import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const widgets = readFileSync(
  new URL('../../../components/viewspec/widgets-commerce.tsx', import.meta.url),
  'utf8',
)

test('the items header renders the New action before the tab strip', () => {
  const start = widgets.indexOf("'items-header-actions'")
  assert.ok(start >= 0, 'the items header actions widget exists')
  const block = widgets.slice(start, widgets.indexOf("'new-item'", start))
  const newIndex = block.indexOf('<NewItemButton />')
  const tabsIndex = block.indexOf('<ModuleHomeTabs')
  assert.ok(newIndex >= 0, 'the header offers the New item action')
  assert.ok(tabsIndex >= 0, 'the header carries the tab strip')
  assert.ok(newIndex < tabsIndex, 'the primary New action precedes the ModuleHomeTabs strip')
})
