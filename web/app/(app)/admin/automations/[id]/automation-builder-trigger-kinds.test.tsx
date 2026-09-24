// F4T-11: switching the builder's trigger kind must not discard the
// per-kind config. A schedule cron survives a round-trip through manual,
// and a fresh kind starts clean; the saved trigger carries the restored
// config, not the wiped one.

import assert from 'node:assert/strict'
import test from 'node:test'

// jsdom first: the builder reads browser globals at render.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/admin/automations/00000000-0000-4000-8000-000000000000',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Event', 'MouseEvent', 'self']) {
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

const posted: { url: string; body: unknown }[] = []
const priorFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (init?.method === 'PATCH') {
    posted.push({ url, body: JSON.parse(String(init.body)) })
    return Response.json({})
  }
  return Response.json({})
}) as typeof fetch

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return{push(){},replace(){},refresh(){}}}',
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
  trigger: { kind: 'schedule', cron: '0 9 * * MON', timezone: 'UTC' },
  rules: {},
  conditions: {},
  actions: [],
  errorMessage: null,
}

// @openbooks/ui Select renders the id on a custom trigger over a hidden
// native <select>. Drive the native control (found by its option values) so
// the genuine change event fires.
function kindSelect(host: HTMLElement): HTMLSelectElement {
  const found = [...host.querySelectorAll('select')].find((s) =>
    [...s.options].some((o) => o.value === 'manual'),
  )
  assert.ok(found, 'trigger kind select renders')
  return found as HTMLSelectElement
}

function setSelectValue(sel: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(sel),
    'value',
  )!.set!
  setter.call(sel, value)
  sel.dispatchEvent(new window.Event('change', { bubbles: true }))
}

async function mount(): Promise<HTMLElement> {
  posted.length = 0
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

function cronValue(host: HTMLElement): string {
  return (host.querySelector('#ab-cron') as HTMLInputElement).value
}

test('a schedule cron survives a round-trip through another trigger kind', async () => {
  const host = await mount()
  try {
    assert.equal(cronValue(host), '0 9 * * MON')
    const kind = kindSelect(host)
    await act(async () => {
      setSelectValue(kind, 'manual')
    })
    assert.equal(host.querySelector('#ab-cron'), null, 'manual shows no cron box')
    await act(async () => {
      setSelectValue(kind, 'schedule')
    })
    assert.equal(cronValue(host), '0 9 * * MON', 'returning to schedule lost the cron')
  } finally {
    host.remove()
  }
})

test('the saved trigger carries the restored per-kind config', async () => {
  const host = await mount()
  try {
    const kind = kindSelect(host)
    await act(async () => {
      setSelectValue(kind, 'manual')
    })
    await act(async () => {
      setSelectValue(kind, 'schedule')
    })
    const save = [...host.querySelectorAll('button')].find(
      (b) => (b.textContent ?? '').trim() === 'Save trigger',
    )
    assert.ok(save, 'save trigger button renders')
    await act(async () => {
      save.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(posted.length, 1, 'one PATCH posts the trigger')
    const trigger = (posted[0]!.body as { trigger: Record<string, unknown> }).trigger
    assert.equal(trigger.cron, '0 9 * * MON', 'posted trigger lost the cron')
    assert.equal(trigger.kind, 'schedule')
  } finally {
    host.remove()
    globalThis.fetch = priorFetch
  }
})
