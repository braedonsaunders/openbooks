import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'
import { stubModules } from '../testing/stub-modules.ts'

// QA-056: the produced-item picker must say WHY nothing matches when the
// whole eligible collection is empty (no profiled items), instead of the
// picker's bare no-matches note — and it must not blame the query when a
// filtered search simply matches nothing.
await bootJsdomEnvironment({ url: 'http://localhost/manufacturing/work-orders?record=new' })

stubModules({
  navigation: true,
  intl: false,
  authz: false,
  features: false,
  extra: {
    'next-intl': 'const t = (key) => key; t.rich = (key) => key; t.has = () => false; export function useTranslations() { return t } export function useLocale() { return "en" }',
    sonner: 'export const toast = { success() {}, error() {} }',
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { RemoteRecordChoice } = await import('./remote-record-choice.tsx')

const labels = {
  choose: 'Choose a produced item',
  searchPlaceholder: 'Number, code or name',
  loadFailed: 'The choices could not be loaded.',
  retry: 'Retry',
}

function stubFetch(rows: unknown, ok = true, status = 200) {
  ;(globalThis as Record<string, unknown>).fetch = (async () => ({
    ok,
    status,
    json: async () => rows,
  })) as typeof fetch
}

async function renderChoice(
  emptyHint: React.ReactNode,
  options: { value: string; label: string }[] = [],
) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <RemoteRecordChoice
        id="produced-item"
        value=""
        options={options}
        endpoint="/api/manufacturing/options?kind=items"
        onChange={() => {}}
        labels={labels}
        emptyHint={emptyHint}
      />,
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
  })
  return { host, root }
}

test('an empty eligible collection names the prerequisite with its remedy link', async () => {
  stubFetch([])
  const { host, root } = await renderChoice(
    <span>
      No items with an inventory costing profile. <a href="/items">Configure costing on the item</a> first.
    </span>,
  )
  try {
    const hint = host.querySelector('p')?.textContent ?? ''
    assert.ok(
      hint.includes('No items with an inventory costing profile'),
      `the picker must name the missing costing profile, saw: ${hint}`,
    )
    const link = host.querySelector('a[href="/items"]')
    assert.ok(link, 'the hint must link to the items catalog where costing is configured')
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

test('a filtered search that matches nothing keeps the generic no-matches note', async () => {
  stubFetch([])
  const { host, root } = await renderChoice(<span>prerequisite hint</span>)
  try {
    const trigger = host.querySelector('button[aria-label="Choose a produced item"]') as HTMLButtonElement | null
    assert.ok(trigger, 'the picker trigger must render')
    await act(async () => {
      trigger.click()
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    const input = document.querySelector('input[placeholder="Number, code or name"]') as HTMLInputElement | null
    assert.ok(input, 'the remote search box must render once the picker opens')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'zzz-no-such-item')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    const body = host.textContent ?? ''
    assert.ok(!body.includes('prerequisite hint'), 'a filtered search must not blame the empty catalog')
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    for (const portal of [...document.body.children]) {
      if (portal !== host && portal.tagName !== 'SCRIPT') portal.remove()
    }
  }
})

test('options on offer never show the empty-collection hint', async () => {
  // The offered option rides the initial options (not the debounced fetch),
  // so the assertion holds however the lookup timing behaves.
  const offered = [{ value: 'item-1', label: 'WIDGET · Finished widget' }]
  stubFetch(offered)
  const { host, root } = await renderChoice(<span>prerequisite hint</span>, offered)
  try {
    const body = host.textContent ?? ''
    assert.ok(!body.includes('prerequisite hint'), 'offered options must not carry the empty hint')
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})
