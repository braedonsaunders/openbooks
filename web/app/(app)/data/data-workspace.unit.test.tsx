import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { dataWorkspaceNavigation } from '../../../lib/setup/data-workspace'

let permissions = new Set<string>()
Object.assign(globalThis, { __dataWorkspaceAuthz: () => ({ permissions }) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('/lib/authz')) {
      return { shortCircuit: true, url: 'data:text/javascript,export async function getAuthz(){return globalThis.__dataWorkspaceAuthz()}' }
    }
    if (specifier.endsWith('/SetupWorkspace')) {
      return { shortCircuit: true, url: 'data:text/javascript,export function SetupWorkspace(p){return globalThis.React.createElement("section",{"data-content-layout":p.contentLayout},p.children)}' }
    }
    if (specifier === 'next/navigation') {
      return { shortCircuit: true, url: 'data:text/javascript,export function redirect(href){throw new Error("REDIRECT:"+href)}' }
    }
    return next(specifier, context)
  },
})
const React = await import('react')
Object.assign(globalThis, { React })
const { renderToStaticMarkup } = await import('react-dom/server')
const { default: DataLayout } = await import('./layout')

test('company administrators return to Company Settings, including wildcard grants', () => {
  for (const grant of ['admin.setup.manage', 'admin.*', '*']) {
    const destination = dataWorkspaceNavigation(new Set([grant, 'data.import']))
    assert.equal(destination.showSetup, true)
    assert.equal(destination.backHref, '/admin/setup/company')
    assert.equal(destination.backLabelKey, 'admin.setup.entities.company.title')
  }
})

test('CRM setup managers return to their accessible Setup tab', () => {
  const destination = dataWorkspaceNavigation(new Set(['crm.setup.manage', 'data.import']))
  assert.equal(destination.showSetup, true)
  assert.equal(destination.backHref, '/admin/setup/crm')
})

test('import-only operators return to the dashboard without being gated by Setup', async () => {
  permissions = new Set(['data.import'])
  assert.deepEqual(dataWorkspaceNavigation(permissions), {
    showSetup: false, backHref: '/', backLabelKey: 'nav.modules.dashboard',
  })
  const child = <div>Import wizard</div>
  assert.equal(await DataLayout({ children: child }), child)
})

test('data pages use the shared Setup workspace as embedded sections', async () => {
  for (const grant of ['admin.setup.manage', 'crm.setup.manage']) {
    permissions = new Set([grant, 'data.import'])
    const html = renderToStaticMarkup(await DataLayout({ children: <div>Import history</div> }))
    assert.match(html, /data-content-layout="section"/)
    assert.match(html, /Import history/)
  }
})
