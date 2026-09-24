// F4T-12: a save over a moved recipe writes nothing and parks the named
// refusal as a notice with a Reload path. Local edits stay until the editor
// reloads; the next save carries the loaded version.

import assert from 'node:assert/strict'
import test from 'node:test'

// jsdom first: the builder reads browser globals at render.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/admin/automations/00000000-0000-4000-8000-000000000000',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {}
}

const posted: { url: string; body: Record<string, unknown> }[] = []
let patchStatus = 200
let patchBody: unknown = { automation: { version: 4 } }
const priorFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (init?.method === 'PATCH') {
    posted.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
    return new Response(JSON.stringify(patchBody), {
      status: patchStatus,
      headers: { 'content-type': 'application/json' },
    })
  }
  return Response.json({})
}) as typeof fetch

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return globalThis.__builderConflictRouter}export function usePathname(){return "/admin/automations/x"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return p.children}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(){},warning(){},info(){}}',
      }
    }
    return next(specifier, context)
  },
})

Object.assign(globalThis, {
  __builderConflictRouter: { push() {}, replace() {}, refresh() {} },
})
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../../messages/en')).default
const { AutomationBuilder } = await import('./AutomationBuilder')

const AUTOMATION = {
  id: '00000000-0000-4000-8000-000000000000',
  name: 'Overdue notifier',
  description: null,
  status: 'enabled',
  version: 3,
  trigger: { kind: 'manual' },
  rules: {},
  conditions: {},
  actions: [],
  errorMessage: null,
}

async function mount(): Promise<HTMLElement> {
  posted.length = 0
  patchStatus = 200
  patchBody = { automation: { version: 4 } }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AutomationBuilder
          automation={AUTOMATION}
          runs={[]}
          canSimulate={false}
          canManage={true}
          saveFailed="Save failed"
          backHref="/admin/automations"
          backLabel="Back"
        />
      </NextIntlClientProvider>,
    )
  })
  return host
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

async function clickSaveName(host: HTMLElement) {
  const save = [...host.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === 'Save name',
  )
  assert.ok(save, 'save name button renders')
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  // Let the mocked PATCH promise settle.
  await act(async () => {
    await Promise.resolve()
  })
}

test('a save carries the loaded version and advances on success', async () => {
  const host = await mount()
  try {
    await clickSaveName(host)
    assert.equal(posted.length, 1, 'one PATCH posts the save')
    assert.equal(posted[0]!.body.expectedVersion, 3, 'the save carries the loaded version')
    assert.ok(
      (host.textContent ?? '').includes('v4'),
      'the header advances to the saved version',
    )
  } finally {
    host.remove()
  }
})

test('a 409 parks the named refusal, keeps the typed edits, and offers Reload', async () => {
  const host = await mount()
  try {
    patchStatus = 409
    patchBody = { error: 'the automation changed since it was loaded (now at version 5)', code: 'automation_stale_version', version: 5 }
    const name = host.querySelector('#ab-name') as HTMLInputElement
    await act(async () => {
      setInputValue(name, 'Renamed by the second editor')
    })
    await clickSaveName(host)
    const text = host.textContent ?? ''
    assert.ok(
      text.includes('now at version 5'),
      'the refusal names the stored version',
    )
    assert.ok(text.includes('Refresh'), 'the refusal offers a Reload path')
    assert.equal(
      (host.querySelector('#ab-name') as HTMLInputElement).value,
      'Renamed by the second editor',
      'the typed edits survive the refusal',
    )
  } finally {
    host.remove()
    globalThis.fetch = priorFetch
  }
})
