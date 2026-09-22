import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')
const button = read('./NewItemButton.tsx')
const drawer = read('./ItemDrawer.tsx')
const view = read('./view.ts')
const widgets = read('../../../components/viewspec/widgets-commerce.tsx')
const globalCreate = read('../../../components/global-create-menu.tsx')

test('every New Item entry point opens the zero-write URL create drawer', () => {
  assert.match(button, /href="\/items\?item=new"/)
  assert.doesNotMatch(button, /fetch\s*\(/)
  assert.match(globalCreate, /key: 'item'[\s\S]{0,180}directHref: '\/items\?item=new'/)
  assert.doesNotMatch(globalCreate, /key: 'item'[\s\S]{0,180}api\/items\/draft/)
  assert.doesNotMatch(widgets, /new-item-redirect/)
  assert.doesNotMatch(view, /showNewRedirect/)
})

test('item=new is an in-memory active payload and starts the unified drawer editable', () => {
  assert.match(view, /createMode = itemId === 'new' && canManage/)
  assert.match(view, /id: 'new'[\s\S]{0,700}is_active: true/)
  assert.match(drawer, /useState<'view' \| 'edit'>\(createMode \? 'edit' : 'view'\)/)
  assert.match(drawer, /useState<boolean>\(createMode \? true : it\.is_active === true\)/)
  assert.match(drawer, /createMode\s*\? \{ kind \}/)
  assert.match(drawer, /target\.fields = \[\{ \.\.\.placedKind, visible: true \}, \.\.\.target\.fields\]/)
})

test('create opens on a descriptive type-card landing step before the form', () => {
  assert.match(drawer, /useState<'kind' \| 'form'>\(createMode \? 'kind' : 'form'\)/)
  assert.match(drawer, /kindOptions\.map\(\(option\) =>/)
  assert.match(drawer, /KIND_ICONS\[option\.value/)
  assert.match(drawer, /t\(`kindDescriptions\.\$\{option\.value\}`\)/)
  assert.match(drawer, /setKind\(option\.value\); setTab\('overview'\); setCreateStep\('form'\)/)
})

test('create Save is one idempotent POST and preserves the caller return path', () => {
  assert.match(drawer, /createMode \? '\/api\/items' : `\/api\/items\/\$\{it\.id\}`/)
  assert.match(drawer, /method: createMode \? 'POST' : 'PATCH'/)
  assert.match(drawer, /'Idempotency-Key': requestIdRef\.current!/)
  assert.match(drawer, /if \(!res\.ok\) \{[\s\S]{0,200}await res\.json\(\)\.catch/)
  assert.match(drawer, /basePath\.includes\('\?'\) \? '&' : '\?'/)
  assert.match(drawer, /router\.replace\(`\$\{basePath\}\$\{separator\}item=\$\{savedId\}`/)
})

test('cancel and close are zero-write and persisted-only editors stay out of create mode', () => {
  assert.match(drawer, /if \(createMode\) \{\s*router\.push\(basePath\)\s*return/)
  assert.match(drawer, /syncUrlOnClose/)
  assert.match(drawer, /laborPricing && !createMode/)
  assert.match(drawer, /inventoryCosting && !createMode/)
  assert.match(drawer, /fairValuePrices && !createMode/)
  assert.doesNotMatch(drawer, /if \(tabs\.length > 0[\s\S]{0,160}setTab\(/)
})
