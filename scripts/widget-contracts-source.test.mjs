import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { registryContracts } from './widget-contracts-source.mjs'

function fixture(t, family) {
  const dir = mkdtempSync(join(tmpdir(), 'widget-contracts-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'payroll.tsx'), family)
  const source = `import { PAYROLL_WIDGETS as payroll } from './payroll'
    export const WIDGET_REGISTRY = {
      'remittance-cockpit': payroll['remittance-cockpit'],
      'save-view': () => <SaveViewButton />,
    }`
  return { source, filename: join(dir, 'widgets.tsx') }
}

const payroll = `export const PAYROLL_WIDGETS = {
  'remittance-cockpit': (props) => <RemittancesView
    groups={props.groups ?? []} populationRefusal={str(props, 'populationRefusal')}
    canCreate={props.canCreate === true} />,
}`

test('imported adapters retain exact prop contracts, including refusal evidence', t => {
  const { source, filename } = fixture(t, payroll)
  assert.deepEqual(registryContracts(source, 'WIDGET_REGISTRY', filename), {
    'remittance-cockpit': { props: ['canCreate', 'groups', 'populationRefusal'], open: false },
    'save-view': { props: [], open: false },
  })
})

test('removing a real refusal prop from an extracted adapter is visible to the drift guard', t => {
  const { source, filename } = fixture(t, payroll.replace(" populationRefusal={str(props, 'populationRefusal')}", ''))
  const derived = registryContracts(source, 'WIDGET_REGISTRY', filename)
  assert.deepEqual(derived['remittance-cockpit'], { props: ['canCreate', 'groups'], open: false })
  // This is the drift assertion used by widget-contracts.test.ts. Its red
  // must identify the affected widget and the dropped refusal prop.
  assert.throws(() => assert.deepEqual(derived['remittance-cockpit'].props,
    ['canCreate', 'groups', 'populationRefusal'], 'remittance-cockpit'), error => {
    assert.match(error.message, /remittance-cockpit/)
    assert.match(error.message, /populationRefusal/)
    return true
  })
})

test('a missing extracted renderer refuses by registry and widget name', t => {
  const { source, filename } = fixture(t, 'export const PAYROLL_WIDGETS = {}')
  assert.throws(() => registryContracts(source, 'WIDGET_REGISTRY', filename),
    /missing widget adapter payroll\['remittance-cockpit'\]/)
})

test('duplicate keys across composed registries refuse instead of overwriting contracts', () => {
  assert.throws(() => registryContracts(`
    const BANKING = { 'cash-cockpit': props => <CashCockpit accounts={props.accounts} /> }
    const WIDGET_REGISTRY = { ...BANKING, 'cash-cockpit': () => null }
  `, 'WIDGET_REGISTRY'), /duplicate widget registry key: cash-cockpit/)
})

test('cyclic composition refuses rather than recursing indefinitely', () => {
  assert.throws(() => registryContracts(`
    const BANKING = { ...WIDGET_REGISTRY }
    const WIDGET_REGISTRY = { ...BANKING }
  `, 'WIDGET_REGISTRY'), /circular widget registry reference/)
})

test('unresolved or dynamic adapters never silently become open contracts', () => {
  for (const renderer of ["missing['cash-cockpit']", 'externalRenderer', 'family[selection]']) {
    assert.throws(() => registryContracts(`const WIDGET_REGISTRY = { 'cash-cockpit': ${renderer} }`, 'WIDGET_REGISTRY'),
      /cannot resolve widget registry|cannot statically read widget renderer|computed name/)
  }
})

test('whole-props forwarding remains explicitly open after extraction', t => {
  const { source, filename } = fixture(t, `export const PAYROLL_WIDGETS = {
    'remittance-cockpit': props => <RemittancesView {...props} />
  }`)
  assert.deepEqual(registryContracts(source, 'WIDGET_REGISTRY', filename)['remittance-cockpit'],
    { props: [], open: true })
})
