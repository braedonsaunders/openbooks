import assert from 'node:assert/strict'
import test from 'node:test'
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

// Stacked drawers own their own clicks and Escape. A drawer launched from a
// record's Actions menu must survive the menu closing, so its primary
// action fires; Escape closes only the topmost open drawer; and an open menu
// or picker takes Escape before any drawer does.
await bootJsdomEnvironment({ url: 'http://localhost:4800/estimates?doc=q-1', matchMediaMatches: false })
stubModules({ navigation: { pathname: '/estimates' }, intl: false, authz: false, features: false })

const React = await import('react')
Object.assign(globalThis, { React })
const { act, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
// The shared sources directly, so Drawer and Popover share one module graph.
const { Drawer } = await import('../../packages/ui/src/drawer')
const { Popover } = await import('../../packages/ui/src/popover')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const events: string[] = []

function AwardItem() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Award</button>
      <Drawer open={open} stacked onClose={() => { events.push('award:close'); setOpen(false) }} title="Award quote">
        <input aria-label="Project name" />
        <button type="button" onClick={() => events.push('award:submit')}>Award and create project</button>
      </Drawer>
    </>
  )
}

function RecordDrawer() {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <Drawer
      open
      onClose={() => events.push('record:close')}
      title="Quote Q-1"
      headerActions={
        <Popover
          open={menuOpen}
          onOpenChange={(next) => { events.push(`menu:${next ? 'open' : 'close'}`); setMenuOpen(next) }}
          trigger={<button type="button" onClick={() => setMenuOpen((value) => !value)}>Actions</button>}
        >
          <AwardItem />
        </Popover>
      }
    >
      <p>Quote body</p>
    </Drawer>
  )
}

async function mount(t: test.TestContext, node: React.ReactElement) {
  document.body.innerHTML = ''
  events.length = 0
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">{node}</NextIntlClientProvider>)
    await tick()
    await tick()
  })
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent === label)
  assert.ok(found, `button "${label}" must render`)
  return found as HTMLButtonElement
}

async function press(target: Element) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    ;(target as HTMLElement).click()
    await tick()
  })
}

async function escape() {
  await act(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await tick()
  })
}

test('a drawer opened from the Actions menu receives its own clicks', async (t) => {
  await mount(t, <RecordDrawer />)
  await press(button('Actions'))
  await act(async () => { await tick() })
  await press(button('Award'))

  assert.ok(events.includes('menu:close'), 'opening the drawer closes the menu')
  const award = document.querySelector('[data-drawer-depth="1"]')
  assert.ok(award, 'the stacked drawer stays mounted after the menu closes')
  const retained = document.querySelector('[data-popover-retained]')
  assert.ok(retained, 'the closed menu keeps its content mounted for the drawer')
  assert.equal(retained.hasAttribute('data-ui-overlay'), false, 'a retained menu is not an open overlay')

  await press(button('Award and create project'))
  assert.ok(events.includes('award:submit'), 'the in-drawer action fires')
  assert.ok(document.querySelector('[data-drawer-depth="1"]'), 'pressing inside the drawer never dismisses it')
  assert.ok(!events.includes('record:close'), 'the record drawer beneath stays open')
})

test('Escape closes only the topmost drawer', async (t) => {
  await mount(t, <RecordDrawer />)
  await press(button('Actions'))
  await act(async () => { await tick() })
  await press(button('Award'))
  events.length = 0

  await escape()
  assert.deepEqual(events, ['award:close'], 'the stacked drawer closes and the record drawer does not')
})

test('an open menu takes Escape before the drawer', async (t) => {
  await mount(t, <RecordDrawer />)
  await press(button('Actions'))
  await act(async () => { await tick() })
  events.length = 0

  await escape()
  assert.ok(events.includes('menu:close'), 'the menu closes')
  assert.ok(!events.includes('record:close'), 'the drawer stays open under its menu')
})

test('a closing overlay never strands the drawer: Escape still closes it', async (t) => {
  await mount(t, <RecordDrawer />)
  const lingering = document.createElement('div')
  lingering.setAttribute('data-ui-overlay', '')
  lingering.setAttribute('data-overlay-exiting', 'true')
  document.body.appendChild(lingering)
  events.length = 0

  await escape()
  assert.deepEqual(events, ['record:close'])
})
