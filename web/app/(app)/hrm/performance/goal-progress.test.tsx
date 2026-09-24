import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const useRouter = () => ({ refresh(){}, push(){}, replace(){} })',
      }
    }
    return next(specifier, context)
  },
})
const { NextIntlClientProvider } = await import('next-intl')
const { GoalProgressForm } = await import('./GoalForm')
// tsx compiles JSX classic: the form never imports React, so the test bridges it.
Object.assign(globalThis, { React })

const hrmMessages = JSON.parse(readFileSync(new URL('../../../../messages/en/hrm.json', import.meta.url), 'utf8'))
const commonMessages = JSON.parse(readFileSync(new URL('../../../../messages/en/common.json', import.meta.url), 'utf8'))
const uiMessages = JSON.parse(readFileSync(new URL('../../../../messages/en/ui.json', import.meta.url), 'utf8'))

interface Call {
  url: string
  method: string
  body: Record<string, unknown> | null
}

async function mount(): Promise<{
  document: Document
  calls: Call[]
  setInput: (el: HTMLInputElement, value: string) => void
  submit: () => void
  unmount: () => Promise<void>
}> {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/hrm/performance',
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
  const doc = dom.window.document
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const root = createRoot(doc.getElementById('root')!)
  const calls: Call[] = []
  ;(globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    })
    return { ok: true, status: 200, json: async () => ({}), clone: () => ({ json: async () => ({}) }) }
  }
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={{ hrm: hrmMessages, common: commonMessages, ui: uiMessages }}>
        <GoalProgressForm goalId="goal-1" failed="Save failed." />
      </NextIntlClientProvider>,
    )
  })
  return {
    document: doc as unknown as Document,
    calls,
    setInput: (el, value) => {
      const { HTMLInputElement: RealmInput } = dom.window as unknown as {
        HTMLInputElement: typeof globalThis.HTMLInputElement
      }
      const setter = Object.getOwnPropertyDescriptor(RealmInput.prototype, 'value')!.set!
      setter.call(el, value)
      const { Event: RealmEvent } = dom.window as unknown as { Event: typeof globalThis.Event }
      el.dispatchEvent(new RealmEvent('input', { bubbles: true }))
    },
    submit: () => {
      const { MouseEvent: RealmMouseEvent } = dom.window as unknown as { MouseEvent: typeof globalThis.MouseEvent }
      doc.querySelector('form')!.querySelector('button[type="submit"]')!.dispatchEvent(
        new RealmMouseEvent('click', { bubbles: true }),
      )
    },
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      Object.defineProperty(globalThis, 'window', { value: previous.window, configurable: true, writable: true })
      Object.defineProperty(globalThis, 'document', { value: previous.document, configurable: true, writable: true })
      Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true, writable: true })
      Object.defineProperty(globalThis, 'self', { value: previous.self, configurable: true, writable: true })
      Object.defineProperty(globalThis, 'fetch', { value: previous.fetch, configurable: true, writable: true })
    },
  }
}

test('F3-63: out-of-range progress refuses by name without posting', async () => {
  const m = await mount()
  try {
    const { act } = await import('react')
    await act(async () => {
      m.setInput(m.document.querySelector('input')!, '150')
    })
    await act(async () => {
      m.submit()
    })
    assert.equal(m.calls.length, 0, 'no PATCH may be posted for out-of-range progress')
    const alert = m.document.querySelector('[role="alert"]')
    assert.ok(alert, 'a named refusal must render')
    assert.equal(alert!.textContent, 'Progress must be a whole number from 0 to 100.')
  } finally {
    await m.unmount()
  }
})

test('F3-63: non-numeric progress refuses by name without posting', async () => {
  const m = await mount()
  try {
    const { act } = await import('react')
    await act(async () => {
      m.setInput(m.document.querySelector('input')!, 'abc')
    })
    await act(async () => {
      m.submit()
    })
    assert.equal(m.calls.length, 0, 'no PATCH may be posted for non-numeric progress')
    assert.match(m.document.querySelector('[role="alert"]')!.textContent ?? '', /whole number/)
  } finally {
    await m.unmount()
  }
})

test('F3-63: valid progress posts an integer percent', async () => {
  const m = await mount()
  try {
    const { act } = await import('react')
    await act(async () => {
      m.setInput(m.document.querySelector('input')!, '50')
    })
    await act(async () => {
      m.submit()
    })
    assert.equal(m.calls.length, 1)
    assert.deepEqual(m.calls[0]?.body, { action: 'progress', progressPercent: 50 })
  } finally {
    await m.unmount()
  }
})
