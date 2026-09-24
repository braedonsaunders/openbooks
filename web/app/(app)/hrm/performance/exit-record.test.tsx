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
const { ExitRecordForm } = await import('./ExitRecordForm')
// tsx compiles JSX classic: the form never imports React, so the test bridges it.
Object.assign(globalThis, { React })

const hrmMessages = JSON.parse(readFileSync(new URL('../../../../messages/en/hrm.json', import.meta.url), 'utf8'))
const commonMessages = JSON.parse(readFileSync(new URL('../../../../messages/en/common.json', import.meta.url), 'utf8'))
const uiMessages = JSON.parse(readFileSync(new URL('../../../../messages/en/ui.json', import.meta.url), 'utf8'))

async function mount(): Promise<{
  document: Document
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
  const doc = dom.window.document
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const root = createRoot(doc.getElementById('root')!)
  ;(globalThis as Record<string, unknown>).fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    clone: () => ({ json: async () => ({}) }),
  })
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={{ hrm: hrmMessages, common: commonMessages, ui: uiMessages }}>
        <ExitRecordForm employmentId="employment-1" existing={null} />
      </NextIntlClientProvider>,
    )
  })
  return {
    document: doc as unknown as Document,
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

test('F3-64: a successful save releases the submit button', async () => {
  const m = await mount()
  try {
    const { act } = await import('react')
    await act(async () => {
      m.submit()
      // Flush the async submit chain (fetch, refresh, busy release).
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const button = m.document.querySelector('button[type="submit"]') as HTMLButtonElement
    assert.equal(button.disabled, false, 'the submit button must re-enable after a successful save')
  } finally {
    await m.unmount()
  }
})
