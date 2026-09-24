import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'

const confirmCalls: unknown[] = []
const toastErrors: string[] = []
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast = { success(){}, error(msg){ globalThis.__templateToastErrors.push(msg) } }',
      }
    }
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const useRouter = () => ({ refresh(){}, push(){}, replace(){} })',
      }
    }
    if (specifier.endsWith('/lib/confirm')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function confirmDialog(options){ globalThis.__templateConfirmCalls.push(options); return true }',
      }
    }
    return next(specifier, context)
  },
})
const { NextIntlClientProvider } = await import('next-intl')
const { ProcessTemplateDrawer } = await import('./ProcessTemplateDrawer')
// tsx compiles JSX classic: the island never imports React, so the test bridges it.
Object.assign(globalThis, { React })
Object.assign(globalThis, { __templateConfirmCalls: confirmCalls, __templateToastErrors: toastErrors })

const hrmMessages = JSON.parse(readFileSync(new URL('../../../../../messages/en/hrm.json', import.meta.url), 'utf8'))
const commonMessages = JSON.parse(readFileSync(new URL('../../../../../messages/en/common.json', import.meta.url), 'utf8'))
const uiMessages = JSON.parse(readFileSync(new URL('../../../../../messages/en/ui.json', import.meta.url), 'utf8'))

const template = {
  id: 'tpl-1',
  kind: 'onboarding' as const,
  name: 'Onboarding',
  appliesTo: { employerSubsidiaryId: null, departmentId: null },
  isActive: true,
  steps: [
    {
      id: 'step-1',
      position: 0,
      title: 'Collect documents',
      description: null,
      ownerKind: 'manager',
      ownerPartyId: null,
      dueOffsetDays: 3,
      required: true,
      evidenceKind: 'none',
    },
  ],
}

interface Mount {
  document: Document
  calls: { url: string; method: string; body: Record<string, unknown> | null }[]
  nativeConfirmCalls: number
  setInput: (el: HTMLInputElement, value: string) => void
  click: (el: Element) => void
  unmount: () => Promise<void>
}

async function mount(): Promise<Mount> {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/hrm/processes/templates?template=tpl-1',
  })
  const previous = {
    window: (globalThis as Record<string, unknown>).window,
    document: (globalThis as Record<string, unknown>).document,
    navigator: (globalThis as Record<string, unknown>).navigator,
    fetch: (globalThis as Record<string, unknown>).fetch,
    self: (globalThis as Record<string, unknown>).self,
  }
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'self', { value: dom.window, configurable: true, writable: true })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const win = dom.window as unknown as { matchMedia?: (query: string) => unknown }
  if (typeof win.matchMedia !== 'function') {
    win.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false
      },
    })
  }
  // The native confirm must never fire: deletes go through the house dialog.
  let nativeConfirmCalls = 0
  const winRec = dom.window as unknown as Record<string, unknown>
  const prevConfirm = winRec.confirm
  winRec.confirm = () => {
    nativeConfirmCalls += 1
    return false
  }
  const doc = dom.window.document
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const root = createRoot(doc.getElementById('root')!)
  const calls: Mount['calls'] = []
  ;(globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null })
    return { ok: true, json: async () => ({}) }
  }
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={{ hrm: hrmMessages, common: commonMessages, ui: uiMessages }}>
        <ProcessTemplateDrawer
          template={template}
          creating={false}
          closeHref="/hrm/processes/templates"
          subsidiaries={[]}
          departments={[]}
          employees={[]}
        />
      </NextIntlClientProvider>,
    )
  })
  const fireInput = (el: Element): void => {
    const { Event: RealmEvent } = dom.window as unknown as { Event: typeof globalThis.Event }
    el.dispatchEvent(new RealmEvent('input', { bubbles: true }))
  }
  return {
    document: doc as unknown as Document,
    calls,
    get nativeConfirmCalls() {
      return nativeConfirmCalls
    },
    setInput: (el, value) => {
      const { HTMLInputElement: RealmInput } = dom.window as unknown as {
        HTMLInputElement: typeof globalThis.HTMLInputElement
      }
      const setter = Object.getOwnPropertyDescriptor(RealmInput.prototype, 'value')!.set!
      setter.call(el, value)
      fireInput(el)
    },
    click: (el) => {
      const { MouseEvent: RealmMouseEvent } = dom.window as unknown as { MouseEvent: typeof globalThis.MouseEvent }
      el.dispatchEvent(new RealmMouseEvent('click', { bubbles: true }))
    },
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      winRec.confirm = prevConfirm
      Object.defineProperty(globalThis, 'window', { value: previous.window, configurable: true, writable: true })
      Object.defineProperty(globalThis, 'document', { value: previous.document, configurable: true, writable: true })
      Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true, writable: true })
      Object.defineProperty(globalThis, 'fetch', { value: previous.fetch, configurable: true, writable: true })
      Object.defineProperty(globalThis, 'self', { value: previous.self, configurable: true, writable: true })
      dom.window.close()
    },
  }
}

async function flushAsync(): Promise<void> {
  const { act } = await import('react')
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

// F3-61: step deletion goes through the house confirm dialog — the native
// confirm must never fire.
test('deleting a step asks the house confirm dialog, never the native confirm', async () => {
  confirmCalls.length = 0
  const m = await mount()
  try {
    const { act } = await import('react')
    await act(async () => {
      const del = m.document.querySelector('button[aria-label="Delete step"]')
      assert.ok(del, 'the step delete button renders')
      m.click(del!)
    })
    await flushAsync()
    assert.equal(m.nativeConfirmCalls, 0, 'the native confirm never fires')
    assert.equal(confirmCalls.length, 1, 'the house dialog gates the delete')
    const deletes = m.calls.filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'confirming deletes the step')
    assert.match(deletes[0]?.url ?? '', /process-templates\/tpl-1\/steps\/step-1/)
  } finally {
    await m.unmount()
  }
})

// F3-61: an out-of-range due offset refuses by name — nothing is posted.
test('an out-of-range due offset refuses by name and posts nothing', async () => {
  toastErrors.length = 0
  const m = await mount()
  try {
    const { act } = await import('react')
    await act(async () => {
      // Open the step editor from the step row.
      const row = [...m.document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Collect documents'))
      assert.ok(row, 'the step row renders')
      m.click(row!)
    })
    await act(async () => {
      const offset = m.document.getElementById('step-offset') as HTMLInputElement
      assert.ok(offset, 'the offset field renders')
      m.setInput(offset, '99999')
    })
    await act(async () => {
      // The header carries its own Save for the template: scope to the step
      // editor opened above.
      const editor = [...m.document.querySelectorAll('h4')]
        .find((h) => h.textContent === 'Edit step')
        ?.closest('div')
      const save = [...(editor?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Save')
      assert.ok(save, 'the step save button renders')
      m.click(save!)
    })
    await flushAsync()
    assert.ok(
      m.calls.every((c) => c.method === 'GET' || !c.url.includes('/steps')),
      'no step create or update is posted on an invalid offset',
    )
    assert.ok(
      toastErrors.some((message) => message.includes('whole number of days between -3650 and 3650')),
      'the refusal names the valid range',
    )
  } finally {
    await m.unmount()
  }
})
