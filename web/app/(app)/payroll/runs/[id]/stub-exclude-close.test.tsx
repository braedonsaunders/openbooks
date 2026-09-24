import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F3-15: excluding a stub closed the drawer even when the exclusion
// FAILED, stranding the typed adjustments with the stub that still holds
// them. The drawer closes only on a successful exclusion now. Mounts the
// real drawer under jsdom with an onAdjust that reports success or failure
// and asserts the close follows the outcome, not the click.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/payroll/runs/doc-1',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof dom.window.requestAnimationFrame !== 'function') {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
  dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame
}
if (globals.requestAnimationFrame === undefined) {
  globals.requestAnimationFrame = dom.window.requestAnimationFrame
  globals.cancelAnimationFrame = dom.window.cancelAnimationFrame
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../../messages/en')).default
const { StubDrawer } = await import('./RunWizard')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

type StubDrawerProps = Parameters<typeof StubDrawer>[0]

const stub = {
  id: 'stub-1',
  employee_party_id: 'e1',
  employee_name: 'Ada',
  country: 'CA',
  lines: [],
  factors: {},
} as unknown as StubDrawerProps['stub']

async function mount(
  t: TestContext,
  outcome: boolean,
  closed: { count: number },
): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const rootHandle = createRoot(host)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    host.remove()
    for (const child of [...document.body.children]) child.remove()
  })
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StubDrawer
          stub={stub}
          variance={null}
          change={null}
          onClose={() => {
            closed.count += 1
          }}
          fmt={(v) => String(v ?? '')}
          adjustments={[]}
          components={[]}
          canAdjust
          busy={false}
          onAdjust={async () => outcome}
          buckets={[]}
          regionLabel=""
          traceEngines={{}}
          factorLabels={{}}
        />
      </NextIntlClientProvider>,
    )
    for (let i = 0; i < 8; i++) await tick()
  })
}

function excludeButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes('Exclude from this run'),
  ) as HTMLButtonElement | undefined
  assert.ok(button, 'the Exclude control must render')
  return button
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    for (let i = 0; i < 10; i++) await tick()
  })
}

test('a refused exclusion keeps the drawer open', async (t) => {
  const closed = { count: 0 }
  await mount(t, false, closed)
  await click(excludeButton())
  assert.equal(closed.count, 0, 'the drawer must stay open over a failed exclusion')
})

test('a successful exclusion closes the drawer', async (t) => {
  const closed = { count: 0 }
  await mount(t, true, closed)
  await click(excludeButton())
  assert.equal(closed.count, 1, 'the drawer must close once the exclusion succeeds')
})
