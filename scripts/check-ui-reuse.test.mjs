import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BESPOKE_PAGE_CEILING,
  DIALOG_WINDOW_CEILING,
  TABLE_CEILING,
  extractRegistryKeys,
  loadAllowlist,
  scanText,
} from './check-ui-reuse.mjs'

/**
 * The gate exists so agent-built surfaces compose the shared tables,
 * dialogs, page shell and list sources instead of hand-rolling their own.
 * These tests feed synthetic fixtures to the real scanner (never a doubled
 * one): each refusal must fire with an identifying rule and location, and
 * every compliant shape must stay clean — a guard that flags everything
 * gates nothing, and a guard that flags nothing protects nothing.
 */

const KEYS = new Set(['vendor_bill', 'customer', 'inventory_onhand'])

function rules(path, text, keys = KEYS) {
  return scanText(path, text, keys).map((v) => v.rule)
}

test('raw table fires, shared tables and prose do not', () => {
  assert.deepEqual(
    rules('web/components/a.tsx', 'export function A() { return <table><tbody /></table> }'),
    ['raw-table'],
  )
  assert.deepEqual(
    rules('web/components/a.tsx', 'import { Table } from "@openbooks/ui"\nexport function A() { return <Table><tbody /></Table> }'),
    [],
  )
  assert.deepEqual(
    rules('web/components/a.tsx', '// renders a plain `<table>` here\nconst html = "<table class=\\"x\\">";'),
    [],
  )
})

test('dialog and blocking window calls fire; bare confirm does not', () => {
  assert.deepEqual(rules('web/components/a.tsx', 'export function A() { return <dialog open /> }'), ['dialog'])
  for (const method of ['confirm', 'prompt', 'alert']) {
    assert.deepEqual(rules('web/components/a.tsx', `if (window.${method}("sure?")) save()`), ['window-dialog'])
  }
  assert.deepEqual(rules('web/components/a.tsx', 'if (confirm("sure?")) save()'), [])
})

test('bespoke page fires without a ModuleView import', () => {
  assert.deepEqual(rules('web/app/(app)/x/page.tsx', 'export default function X() { return <p>hi</p> }'), ['bespoke-page'])
  assert.deepEqual(
    rules(
      'web/app/(app)/x/page.tsx',
      'import { ModuleView } from "../../../../components/viewspec/module-view"\nexport default function X() { return <ModuleView /> }',
    ),
    [],
  )
  assert.deepEqual(rules('web/app/(app)/x/view.tsx', 'export function V() { return <p>hi</p> }'), [])
  assert.deepEqual(rules('web/app/(app)/x/page.tsx', 'import { EntityListView } from "e"; export default function X() { return <p>hi</p> }'), ['bespoke-page'])
  assert.deepEqual(rules('web/app/(app)/x/page.tsx', 'import { EntityListView } from "e"; export default function X() { return <EntityListView recordType="customer" /> }'), [])
})

test('unregistered list keys fire and name the key', () => {
  const bad = scanText(
    'web/app/(app)/x/page.tsx',
    'import { ModuleView } from "m"\nimport { EntityListView } from "e"\nexport function X() { return <EntityListView recordType="nope_not_real" /> }',
    KEYS,
  )
  const unknown = bad.filter((v) => v.rule === 'unknown-list-key')
  assert.equal(unknown.length, 1)
  assert.equal(unknown[0].key, 'nope_not_real')
  assert.deepEqual(
    rules(
      'web/app/(app)/x/page.tsx',
      'import { ModuleView } from "m"\nexport function X({ kind }) { return <><RecordListView recordType="vendor_bill" /><SendButton recordType="party_statement" /><EntityListView recordType={kind} /></> }',
    ),
    [],
  )
  assert.deepEqual(rules('web/components/a.tsx', '// <RecordListView recordType="nope" />'), [])
})

test('registered keys derive from both list registries', () => {
  const keys = extractRegistryKeys(
    'const SOURCES: Record<string, DocListSource> = {\n  vendor_bill: documentSource({}),\n}\n\nexport function listSource(recordType: string) {}',
    'const SOURCES: Record<string, EntityListSource> = {\n  customer: {},\n}\n\nexport function entityListSource(recordType: string) {}',
  )
  assert.deepEqual([...keys].sort(), ['customer', 'vendor_bill'])
})

test('allow-list sections stay within their shrink-only ceilings', () => {
  assert.equal(TABLE_CEILING, 1)
  assert.equal(DIALOG_WINDOW_CEILING, 0)
  assert.equal(BESPOKE_PAGE_CEILING, 13)
  const allowlist = loadAllowlist()
  assert.ok(allowlist.tables.length <= TABLE_CEILING)
  assert.ok(allowlist.dialogWindow.length <= DIALOG_WINDOW_CEILING)
  assert.ok(allowlist.bespokePages.length <= BESPOKE_PAGE_CEILING)
})
