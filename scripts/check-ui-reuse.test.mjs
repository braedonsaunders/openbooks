import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BESPOKE_PAGE_CEILING,
  DIALOG_WINDOW_CEILING,
  TABLE_CEILING,
  extractRegistryKeys,
  loadAllowlist,
  scanNativeDateInputs,
  scanText,
  sharedPageComposition,
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
  assert.equal(BESPOKE_PAGE_CEILING, 11)
  const allowlist = loadAllowlist()
  assert.ok(allowlist.tables.length <= TABLE_CEILING)
  assert.ok(allowlist.dialogWindow.length <= DIALOG_WINDOW_CEILING)
  assert.ok(allowlist.bespokePages.length <= BESPOKE_PAGE_CEILING)
})

test('redirect-only routes need no page shell, while a redirect import never exempts rendered UI',()=>{
  const path='web/app/(app)/templates/page.tsx';
  const entry='import {redirect} from "next/navigation";';
  assert.deepEqual(rules(path,entry+'export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|undefined>>}){await searchParams;redirect("/hrm/performance/templates")}'),[]);
  assert.deepEqual(rules(path,entry+'export default function Page(){if(false)redirect("/hrm");return <p>Template editor</p>}'),['bespoke-page']);
  assert.deepEqual(rules(path,entry+'export default function Page(){return <>Editor</>}'),['bespoke-page']);
});


test('setup catalog pages compose the actual registered list and shared layout, including aliases', () => {
  const path = 'web/app/(app)/hrm/training/page.tsx'
  const native = 'import { SetupEntitySection as Catalog } from "@/app/(app)/admin/setup/[entity]/SetupEntitySection"; import { ListPageLayout as Layout } from "@/components/page-layout";'
  assert.deepEqual(rules(path, native + 'export default function Page(){return <Layout><Catalog /></Layout>}'), [])
  assert.deepEqual(rules(path, native + 'export default function Page(){return <Layout><p>Unregistered rows</p></Layout>}'), ['bespoke-page'])
  assert.deepEqual(rules(path, native.replace('@/app/(app)/admin/setup/[entity]/SetupEntitySection', './SetupEntitySection') + 'export default function Page(){return <Layout><Catalog /></Layout>}'), ['bespoke-page'])
  assert.deepEqual(rules(path, native.replace('@/components/page-layout', './page-layout') + 'export default function Page(){return <Layout><Catalog /></Layout>}'), ['bespoke-page'])
})


test('rendered native delegates prove both shared shell and registered body without trusting import-only claims', () => {
  const files = new Map([
    ['web/app/(app)/x/Workspace.tsx', `import { ListPageLayout as Shell } from '@/components/page-layout';
      import { PagedTable as Records } from '@/components/paged-table';
      export function Workspace() { return <Shell header={null}><Records<Row> source="vendor_bill" /></Shell> }`],
  ])
  const read = path => { if (!files.has(path)) throw Error('missing'); return files.get(path) }
  const page = `import { Workspace } from './Workspace'; export default function Page(){return <Workspace/>}`
  assert.deepEqual(sharedPageComposition('web/app/(app)/x/page.tsx', page, read), {shell:true,body:true})
  assert.deepEqual(sharedPageComposition('web/app/(app)/x/page.tsx', page.replace('<Workspace/>','<p/>'), read), {shell:false,body:false})
  assert.deepEqual(sharedPageComposition('web/app/(app)/x/page.tsx', page.replace('./Workspace','./Missing'), read), {shell:false,body:false})
  const generic = `import { ListPageLayout } from '@/components/page-layout'; import { PagedTable } from '@/components/paged-table';
    export default function Page(){return <ListPageLayout header={null}><PagedTable rows={[]} /></ListPageLayout>}`
  assert.deepEqual(sharedPageComposition('web/app/(app)/x/page.tsx', generic, read), {shell:true,body:false})
  const cycle = `import { Loop } from './Loop'; export function Loop(){return <Loop/>}`
  files.set('web/app/(app)/x/Loop.tsx', cycle)
  assert.deepEqual(sharedPageComposition('web/app/(app)/x/Loop.tsx', cycle, read), {shell:false,body:false})
})

test('server-composed and server-window lists retain unknown-source refusal', () => {
  for (const props of ['prepared', 'serverWindow', 'prepared serverWindow={{ total, page, perPage }}']) {
    const violations = scanText('web/components/x.tsx', `<PagedTable ${props} source="unregistered"/>`, KEYS)
    assert.equal(violations.filter(value => value.rule === 'unknown-list-key').length, 1)
  }
})

test('native date inputs fire in every spelling and name their line', () => {
  const sites = (text) => scanNativeDateInputs('web/components/a.tsx', text).map((v) => `${v.rule}:${v.line}`)
  assert.deepEqual(sites('export const A = () => <input type="date" />'), ['native-date-input:1'])
  assert.deepEqual(sites("export const A = () => <Input\n  value={v}\n  type='date' />"), ['native-date-input:3'])
  assert.deepEqual(sites("export const A = () => <Input type={'date'} />"), ['native-date-input:1'])
  assert.deepEqual(sites("export const A = () => <Input type={kind === 'date' ? 'date' : 'text'} />"), ['native-date-input:1'])
  assert.deepEqual(sites("const el = document.createElement('input')\nel.type = 'date'"), ['native-date-input:2'])
  assert.deepEqual(sites("el.setAttribute('type', 'date')"), ['native-date-input:1'])
  assert.deepEqual(
    sites('const field = (name, type = "text") => <Input id={name} type={type} />\nreturn field("effectiveOn", "date")'),
    ['native-date-input:2'],
    'a local helper handed the date type renders a native date input',
  )
  assert.deepEqual(
    sites('export const A = () => (\n  <SchedulingProvider labels={labels} locale={locale}>\n    <ScheduleWorkspace data={data} />\n  </SchedulingProvider>\n)'),
    ['native-date-input:2'],
    'a scheduling surface left on its native date inputs',
  )
})

test('the shared date field, date-typed data and prose stay clean', () => {
  const sites = (text) => scanNativeDateInputs('web/components/a.tsx', text)
  assert.deepEqual(sites('import { DateField } from "./date-field"\nexport const A = () => <DateField value={v} onChange={set} />'), [])
  assert.deepEqual(
    sites('const components = { DateInput: DateField }\nexport const A = () => <SchedulingProvider labels={{ a: { b: 1 } }} components={components}><ScheduleWorkspace /></SchedulingProvider>'),
    [],
    'a scheduling surface handed DateField',
  )
  assert.deepEqual(sites("const column = { key: 'workFrom', type: 'date', width: '130px' }"), [], 'a grid column type is data, not an input')
  assert.deepEqual(sites('// replaces a bare <input type="date"> with the shared field\nexport const A = 1'), [])
  assert.deepEqual(sites('export const A = () => <input type="datetime-local" /><Input type="time" />'), [], 'date-time and time inputs are out of scope')
  assert.deepEqual(sites("export const A = () => <Input type={kind === 'number' ? 'number' : 'text'} />"), [])
  assert.deepEqual(sites("const v = str(props, 'date')\nexport const A = () => <Input value={v} />"), [], 'a date-named read is not an input type')
})
