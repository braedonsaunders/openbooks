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
const { NewHrmButton } = await import('./NewHrmButton')
// tsx compiles JSX classic: the button never imports React, so the test bridges it.
Object.assign(globalThis, { React })

const commonMessages = JSON.parse(readFileSync(new URL('../../../messages/en/common.json', import.meta.url), 'utf8'))
const uiMessages = JSON.parse(readFileSync(new URL('../../../messages/en/ui.json', import.meta.url), 'utf8'))

async function mount(props: { employee: boolean; change: boolean; process: boolean }): Promise<{
  document: Document
  unmount: () => Promise<void>
}> {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/hrm',
  })
  const previous = {
    window: (globalThis as Record<string, unknown>).window,
    document: (globalThis as Record<string, unknown>).document,
    navigator: (globalThis as Record<string, unknown>).navigator,
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
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={{ common: commonMessages, ui: uiMessages }}>
        <NewHrmButton
          canCreateEmployee={props.employee}
          canProposeChange={props.change}
          canCreateProcess={props.process}
          employeeLabel="Employee"
          changeLabel="Change"
          processLabel="Process"
        />
      </NextIntlClientProvider>,
    )
  })
  return {
    document: doc as unknown as Document,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      Object.defineProperty(globalThis, 'window', { value: previous.window, configurable: true, writable: true })
      Object.defineProperty(globalThis, 'document', { value: previous.document, configurable: true, writable: true })
      Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true, writable: true })
      Object.defineProperty(globalThis, 'self', { value: previous.self, configurable: true, writable: true })
    },
  }
}

test('F3-65: the New menu hides entirely when no grant applies', async () => {
  const m = await mount({ employee: false, change: false, process: false })
  try {
    assert.equal(m.document.getElementById('root')!.innerHTML.trim(), '', 'no button and no empty menu may render')
  } finally {
    await m.unmount()
  }
})

test('F3-65: the New menu renders when at least one grant applies', async () => {
  const m = await mount({ employee: true, change: false, process: false })
  try {
    assert.ok(m.document.querySelector('button'), 'the New button must render when a grant applies')
  } finally {
    await m.unmount()
  }
})
