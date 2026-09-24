// F4T-13: the automation builder must render read-only without
// automations.manage. A reader gets the full recipe, the runs tab, and
// Simulate (a read-guarded POST), but no mutating control: every input
// disabled, every Save/Add/Remove button gone, and a notice naming the
// missing permission path.

import assert from 'node:assert/strict'
import test from 'node:test'

// jsdom first: the builder reads browser globals at render.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/admin/automations/00000000-0000-4000-8000-000000000000',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
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
  actions: [{ kind: 'send_notification', to: 'manager', body: 'hi' }],
  errorMessage: null,
}

const SAVE_LABELS = ['Save name', 'Save trigger', 'Save who and when', 'Save actions']
const ADD_LABELS = ['Add action', 'Add condition', 'Remove']

function buttons(host: HTMLElement): string[] {
  return [...host.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim())
}

async function mount(canManage: boolean): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AutomationBuilder
          automation={AUTOMATION}
          runs={[]}
          canSimulate={true}
          canManage={canManage}
          saveFailed="Save failed"
          backHref="/admin/automations"
          backLabel="Back"
        />
      </NextIntlClientProvider>,
    )
  })
  return host
}

test('the builder offers every save control to a manager', async () => {
  const host = await mount(true)
  try {
    const labels = buttons(host)
    for (const label of SAVE_LABELS) {
      assert.ok(labels.includes(label), `managing builder is missing ${label}`)
    }
    const enabled = [...host.querySelectorAll('input,select,textarea')].filter(
      (el) => !(el as HTMLInputElement).disabled,
    )
    assert.ok(enabled.length > 0, 'managing builder has no enabled input')
  } finally {
    host.remove()
  }
})

test('the builder hides every mutating control from a reader', async () => {
  const host = await mount(false)
  try {
    const labels = buttons(host)
    for (const label of [...SAVE_LABELS, ...ADD_LABELS]) {
      assert.ok(!labels.includes(label), `read-only builder still offers ${label}`)
    }
    const enabled = [...host.querySelectorAll('input,select,textarea')].filter(
      (el) => !(el as HTMLInputElement).disabled,
    )
    // Simulate is read-guarded server-side, so its subject box is the only
    // control a reader may touch.
    assert.deepEqual(
      enabled.map((el) => (el as HTMLElement).id),
      ['ab-sim-subject'],
      'read-only builder leaves recipe inputs enabled',
    )
    // Simulate is read-guarded server-side, so it stays; the recipe,
    // the runs tab, and the back link stay readable.
    assert.ok(labels.includes('Simulate'), 'read-only builder lost Simulate')
    assert.ok(labels.includes('Runs'), 'read-only builder lost the runs tab')
    assert.ok(
      (host.textContent ?? '').includes('Read-only'),
      'read-only builder names no read-only notice',
    )
  } finally {
    host.remove()
  }
})
