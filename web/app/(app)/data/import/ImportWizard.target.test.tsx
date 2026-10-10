import assert from 'node:assert/strict'
import test from 'node:test'
import '../dashboard/_dashboard-render-harness'
import { act, mountDashboard, scriptFetch, tick } from '../dashboard/_dashboard-render-harness'

// Await-imports (not static imports): module hooks register while the
// harness above evaluates, so only imports that resolve after that point see
// the jsdom shims.
const { ImportWizard } = await import('./ImportWizard')
const messages = (await import('../../../messages/en')).default

// The "Import into" target picker must keep its selection: picking a target
// by click or by search+Enter selects it (not the placeholder) and drives
// the next step.

const RESOURCES = {
  resources: [
    { key: 'customers', label: 'Customers', group: 'Sales', supportsImport: true },
    { key: 'vendors', label: 'Vendors', group: 'Purchasing', supportsImport: true },
  ],
}

function stubTransfers() {
  return scriptFetch((url) => {
    if (url.includes('/api/data/resources')) return Response.json(RESOURCES)
    return null
  })
}

async function waitForResources(): Promise<void> {
  // The hidden native select mirrors the loaded options synchronously, so it
  // is the load signal — no dropdown needs opening to observe it.
  for (let i = 0; i < 60; i++) {
    if (document.querySelector('select#import-resource option[value="customers"]')) return
    await tick()
  }
  assert.fail('the resource options never loaded')
}

function trigger(): HTMLButtonElement {
  const native = document.querySelector('select#import-resource')
  assert.ok(native, 'the native select proxy must render')
  const button = native.closest('span')?.querySelector('button') as HTMLButtonElement | null
  assert.ok(button, 'the resource dropdown trigger must render')
  return button
}

async function openDropdown(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
  })
  await tick()
}

async function mountWizard(): Promise<() => Promise<void>> {
  const { unmount } = await mountDashboard(<ImportWizard backHref="/data" backLabel="Back" />, messages)
  await waitForResources()
  return unmount
}

test('clicking a target selects it and drives the next step', async () => {
  const restoreFetch = stubTransfers()
  const unmount = await mountWizard()
  try {
    await openDropdown(trigger())
    const option = [...document.querySelectorAll('[role="option"]')].find((el) =>
      (el.textContent ?? '').includes('Customers'),
    ) as HTMLElement | undefined
    assert.ok(option, 'the dropdown must offer the Customers target')
    await act(async () => {
      option.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await tick()
      await tick()
    })
    await tick()
    const text = trigger().textContent ?? ''
    assert.ok(text.includes('Customers'), `the picker must keep its selection, got ${JSON.stringify(text)}`)
    assert.ok(!text.includes('Choose an import target'), 'the placeholder must clear once selected')
    assert.ok(
      document.querySelector('a[href*="/api/data/templates/customers"]'),
      'the selection drives the next step: per-target template links appear',
    )
  } finally {
    await unmount()
    restoreFetch()
  }
})

test('search plus Enter selects the filtered target', async () => {
  const restoreFetch = stubTransfers()
  const unmount = await mountWizard()
  try {
    await openDropdown(trigger())
    const search = document.querySelector('input[aria-label="Search…"]') as HTMLInputElement | null
    assert.ok(search, 'the dropdown offers search')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(search, 'vendors')
      search.dispatchEvent(new window.Event('input', { bubbles: true }))
      await tick()
      await tick()
    })
    await act(async () => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await tick()
      await tick()
    })
    await tick()
    const text = trigger().textContent ?? ''
    assert.ok(text.includes('Vendors'), `search+Enter must keep its selection, got ${JSON.stringify(text)}`)
    assert.ok(!text.includes('Choose an import target'), 'the placeholder must clear once selected')
  } finally {
    await unmount()
    restoreFetch()
  }
})
