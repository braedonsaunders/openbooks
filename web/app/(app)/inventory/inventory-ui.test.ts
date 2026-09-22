import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('inventory uses one house list header for every subtab and puts its action before the tabs', () => {
  const page = read('./page.tsx')
  assert.match(page, /<ListPageLayout/)
  assert.match(page, /actions=\{<>\{headerAction\}<ModuleHomeTabs tabs=\{tabs\} \/><\/>\}/)
  assert.match(page, /inventoryView=counts/)
  assert.match(page, /key=\{pickString\(sp\.countId\)/)
  assert.match(page, /key=\{pickString\(sp\.bom\)/)
  assert.match(page, /hideHeader/)
  assert.doesNotMatch(page, /back=\{/)
})

test('the shared subtab strip structurally stays after primary header actions', () => {
  const tabs = read('../../../components/module-home/tabs.tsx')
  assert.match(tabs, /data-subtabs[\s\S]*?order-last/)
})

test('bill of materials edits one assembly with the shared wide drawer and line grid', () => {
  const workspace = read('./BomWorkspace.tsx')
  assert.match(workspace, /<LineGrid/)
  assert.match(workspace, /size="2xl"/)
  assert.match(workspace, /expectedVersion: assembly\?\.version \?\? null/)
  assert.match(workspace, /if \(!res\.ok\)[\s\S]*await res\.json/)
  assert.doesNotMatch(workspace, /dispatchEvent|OPEN_NEW_BOM|setClientSelected/)
})

test('bill of materials replacement is atomic, build-safe, observable, and audited', () => {
  const route = read('../../api/inventory/bom/route.ts')
  assert.match(route, /db\.transaction/)
  assert.match(route, /lock table bom_components in row exclusive mode/i)
  assert.match(route, /currentVersion !== expectedVersion/)
  assert.match(route, /deleted\.rows\.length !== beforeResult\.rows\.length/)
  assert.match(route, /inserted\.rows\.length !== 1/)
  assert.match(route, /insert into audit_log/i)
  assert.match(route, /audited\.rows\.length !== 1/)
  assert.match(route, /reason,\s*before: beforeResult\.rows,\s*after: components/)
})

test('stock locations reuse the setup table without duplicate empty copy or a plural create title', () => {
  const section = read('../admin/setup/[entity]/SetupEntitySection.tsx')
  const registry = read('../../../lib/setup/registry.ts')
  const messages = read('../../../messages/en/admin.json')
  assert.match(section, /total > 0 \? \([\s\S]*?<Pagination/)
  assert.match(registry, /key: 'stock-locations',[\s\S]*?singularTitleKey: 'entities\.stock-locations\.singular'/)
  assert.match(messages, /"stock-locations": \{[\s\S]*?"singular": "Stock Location"/)
})
