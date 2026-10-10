import assert from 'node:assert/strict'
import test from 'node:test'
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

// An open picker owns the next outside press. A missed option click, on the
// picker's own panel or out on the drawer backdrop, closes at most the
// picker; the drawer and everything typed into it stay. Only a backdrop
// press with no picker open dismisses the drawer.
await bootJsdomEnvironment({ url: 'http://localhost:4800/estimates?doc=q-1' })
stubModules({ navigation: { pathname: '/estimates' }, intl: false, authz: false, features: false })

const React = await import('react')
Object.assign(globalThis, { React })
const { act, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
// The shared sources directly, so Drawer and Select share one module graph.
const { Drawer } = await import('../../packages/ui/src/drawer')
const { Select } = await import('../../packages/ui/src/select')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const closes: string[] = []

function AwardDrawer() {
  const [open, setOpen] = useState(true)
  const [name, setName] = useState('Harbour Tower')
  const [typeId, setTypeId] = useState('')
  return (
    <Drawer open={open} onClose={() => { closes.push('award'); setOpen(false) }} title="Award quote">
      <input aria-label="Project name" value={name} onChange={(event) => setName(event.target.value)} />
      <Select aria-label="Project type" value={typeId} onChange={(event) => setTypeId(event.target.value)}>
        <option value="">Choose a project type</option>
        <option value="fixed">Fixed price</option>
        <option value="tm">Time and materials</option>
      </Select>
    </Drawer>
  )
}

async function mount(t: test.TestContext) {
  document.body.innerHTML = ''
  closes.length = 0
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><AwardDrawer /></NextIntlClientProvider>)
    await tick()
    await tick()
  })
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
}

async function press(target: Element) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
  })
}

const picker = () => document.querySelector('[data-ui-overlay]')
const backdrop = () => document.querySelector('[data-drawer-depth="0"] > [aria-hidden="true"]')
const drawerOpen = () => document.querySelector('[role="dialog"]') !== null
const nameValue = () => (document.querySelector('input[aria-label="Project name"]') as HTMLInputElement | null)?.value

async function openPicker() {
  const trigger = [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').includes('Choose a project type'))
  assert.ok(trigger, 'the project type picker renders')
  await press(trigger)
  assert.ok(picker(), 'the picker opens')
}

test('a press on the open picker panel between options keeps the drawer and its values', async (t) => {
  await mount(t)
  await openPicker()
  await press(picker()!)
  assert.deepEqual(closes, [], 'the drawer never dismisses')
  assert.ok(drawerOpen())
  assert.equal(nameValue(), 'Harbour Tower')
  assert.ok(picker(), 'a press inside the picker panel keeps the picker open')
})

test('a missed press on the backdrop closes only the open picker', async (t) => {
  await mount(t)
  await openPicker()
  const sheet = backdrop()
  assert.ok(sheet, 'the drawer backdrop renders')
  await press(sheet)
  assert.deepEqual(closes, [], 'the picker consumed the outside press')
  assert.equal(picker(), null, 'the picker closed')
  assert.ok(drawerOpen(), 'the drawer stays open')
  assert.equal(nameValue(), 'Harbour Tower', 'entered values survive')

  await press(backdrop()!)
  assert.deepEqual(closes, ['award'], 'with no picker open, the backdrop dismisses the drawer')
})
