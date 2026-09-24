import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sonner') {
      return { shortCircuit: true, url: 'data:text/javascript,export const toast = { success(){}, error(){} }' }
    }
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
const { BusinessDateProvider } = await import('../../../../components/business-date-provider')
const { QualificationDrawer } = await import('./QualificationDrawer')
// tsx compiles JSX classic: the island never imports React, so the test bridges it.
Object.assign(globalThis, { React })

const hrmMessages = JSON.parse(readFileSync(new URL('../../../../messages/en/hrm.json', import.meta.url), 'utf8'))
const commonMessages = JSON.parse(readFileSync(new URL('../../../../messages/en/common.json', import.meta.url), 'utf8'))

interface FetchCall {
  url: string
  method: string
  body: Record<string, unknown> | null
}

interface Mount {
  document: Document
  calls: FetchCall[]
  setInput: (el: HTMLInputElement, value: string) => void
  setSelect: (el: HTMLSelectElement, value: string) => void
  click: (el: Element) => void
  unmount: () => Promise<void>
}

async function mount(respond: (url: string, method: string) => Promise<{ ok: boolean; body: unknown }>): Promise<Mount> {
  const { JSDOM } = await import('jsdom')
  // A real URL: drawers resolve hrefs against the address bar.
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/hrm/qualifications?record=1',
  })
  const previous = {
    window: (globalThis as Record<string, unknown>).window,
    document: (globalThis as Record<string, unknown>).document,
    navigator: (globalThis as Record<string, unknown>).navigator,
    fetch: (globalThis as Record<string, unknown>).fetch,
  }
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom ships no matchMedia; the UI kit only asks it for responsive tweaks.
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
  const calls: FetchCall[] = []
  ;(globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null })
    const res = await respond(url, method)
    return {
      ok: res.ok,
      status: res.ok ? 200 : 403,
      json: async () => res.body,
    }
  }
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={{ hrm: hrmMessages, common: commonMessages }}>
        <BusinessDateProvider today="2026-09-24">
          <QualificationDrawer qualificationId={null} recordOpen onClose={() => {}} />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    )
  })
  const fire = (el: Element, event: string): void => {
    const { Event: RealmEvent } = dom.window as unknown as { Event: typeof globalThis.Event }
    el.dispatchEvent(new RealmEvent(event, { bubbles: true }))
  }
  return {
    document: doc as unknown as Document,
    calls,
    setInput: (el, value) => {
      const { HTMLInputElement: RealmInput } = dom.window as unknown as {
        HTMLInputElement: typeof globalThis.HTMLInputElement
      }
      const setter = Object.getOwnPropertyDescriptor(RealmInput.prototype, 'value')!.set!
      setter.call(el, value)
      fire(el, 'input')
    },
    setSelect: (el, value) => {
      el.value = value
      fire(el, 'change')
    },
    click: (el) => {
      const { MouseEvent: RealmMouseEvent } = dom.window as unknown as { MouseEvent: typeof globalThis.MouseEvent }
      el.dispatchEvent(new RealmMouseEvent('click', { bubbles: true }))
    },
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      Object.defineProperty(globalThis, 'window', { value: previous.window, configurable: true, writable: true })
      Object.defineProperty(globalThis, 'document', { value: previous.document, configurable: true, writable: true })
      Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true, writable: true })
      Object.defineProperty(globalThis, 'fetch', { value: previous.fetch, configurable: true, writable: true })
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

const TYPES = {
  types: [{ id: 'type-1', code: 'FIRST-AID', name: 'First aid', category: 'safety', validityMonths: 12, requiresEvidence: false, isActive: true }],
}
const EMPLOYMENTS = {
  options: [
    { employmentId: 'emp-1', label: 'Ada Lovelace' },
    { employmentId: 'emp-2', label: 'Alan Turing' },
  ],
}

// F3-59: the record form names the worker through the employments picker —
// no free-text uuid — and posts the picked id.
test('the record form picks the worker from employments and posts the picked id', async () => {
  const m = await mount(async (url, method) => {
    if (url.includes('/api/hrm/qualification-types')) return { ok: true, body: TYPES }
    if (url.includes('/api/hrm/options?source=employments')) return { ok: true, body: EMPLOYMENTS }
    if (url === '/api/hrm/qualifications' && method === 'POST') return { ok: true, body: {} }
    throw new Error(`unexpected fetch ${method} ${url}`)
  })
  try {
    const { act } = await import('react')
    await flushAsync()
    // The house Select renders a trigger button plus a visually-hidden REAL
    // select carrying the value: the id sits on the trigger, the options on
    // the native control.
    const trigger = m.document.getElementById('q-employment')
    assert.ok(trigger, 'the employment picker renders')
    assert.notEqual(trigger?.tagName, 'INPUT', 'the worker is picked from a list, never typed as a uuid')
    assert.match(trigger?.textContent ?? '', /Select an employee/, 'the empty picker names its action')
    const natives = [...m.document.querySelectorAll('select')]
    assert.ok(natives.length >= 2, 'employment and type carry native select controls')
    const employment = natives[0] as HTMLSelectElement
    const type = natives[1] as HTMLSelectElement
    assert.match(employment.textContent ?? '', /Ada Lovelace/, 'picker options name people')
    assert.match(employment.textContent ?? '', /Alan Turing/, 'picker options name people')
    assert.ok(!employment.querySelector('option[value="emp-1"]')?.textContent?.includes('emp-1'), 'options show names, not uuids')
    await act(async () => {
      m.setSelect(employment, 'emp-1')
      m.setSelect(type, 'type-1')
      m.setInput(m.document.getElementById('q-issued') as HTMLInputElement, '2026-09-01')
    })
    await act(async () => {
      const record = [...m.document.querySelectorAll('button')].find((b) => b.textContent === 'Record qualification')
      assert.ok(record, 'the record button renders')
      m.click(record!)
    })
    await flushAsync()
    const posts = m.calls.filter((c) => c.url === '/api/hrm/qualifications' && c.method === 'POST')
    assert.equal(posts.length, 1, 'the form posts once')
    assert.equal(posts[0]?.body?.employmentId, 'emp-1', 'the posted id is the picked employment')
    assert.equal(posts[0]?.body?.typeId, 'type-1')
  } finally {
    await m.unmount()
  }
})

// F3-59: a picker failure is an error with retry, never a silent empty list.
test('a picker failure renders the translated error with retry', async () => {
  let attempts = 0
  const m = await mount(async (url) => {
    if (url.includes('/api/hrm/qualification-types')) return { ok: true, body: TYPES }
    if (url.includes('/api/hrm/options?source=employments')) {
      attempts += 1
      // No named refusal in the body: the picker falls back to its
      // translated message with the status attached.
      if (attempts === 1) return { ok: false, body: {} }
      return { ok: true, body: EMPLOYMENTS }
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  try {
    const { act } = await import('react')
    await flushAsync()
    assert.match(m.document.body.textContent ?? '', /Employees could not be loaded/, 'the picker failure names itself')
    const retry = [...m.document.querySelectorAll('button')].find((b) => b.textContent === 'Retry')
    assert.ok(retry, 'the failure offers a retry')
    await act(async () => {
      m.click(retry!)
    })
    await flushAsync()
    assert.equal(attempts, 2, 'retry reloads the picker')
    assert.match(m.document.body.textContent ?? '', /Ada Lovelace/, 'the reloaded picker names people')
  } finally {
    await m.unmount()
  }
})
