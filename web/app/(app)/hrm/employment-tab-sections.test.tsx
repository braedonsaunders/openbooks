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
const { BusinessDateProvider } = await import('../../../components/business-date-provider')
const { EmploymentTab } = await import('./EmploymentTab')
// tsx compiles JSX classic: the island never imports React, so the test bridges it.
Object.assign(globalThis, { React })

const hrmMessages = JSON.parse(readFileSync(new URL('../../../messages/en/hrm.json', import.meta.url), 'utf8'))
const commonMessages = JSON.parse(readFileSync(new URL('../../../messages/en/common.json', import.meta.url), 'utf8'))
const uiMessages = JSON.parse(readFileSync(new URL('../../../messages/en/ui.json', import.meta.url), 'utf8'))

type Responder = (url: string) => Promise<{ status: number; body: unknown }>

interface Mount {
  document: Document
  calls: string[]
  click: (el: Element) => void
  unmount: () => Promise<void>
}

async function mount(respond: Responder): Promise<Mount> {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/entities/employees?party=p-1',
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
  // next/link reads the browser `self` global for its idle callbacks.
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
  const calls: string[] = []
  ;(globalThis as Record<string, unknown>).fetch = async (input: unknown) => {
    const url = String(input)
    calls.push(url)
    const res = await respond(url)
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: async () => res.body,
    }
  }
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={{ hrm: hrmMessages, common: commonMessages, ui: uiMessages }}>
        <BusinessDateProvider today="2026-09-24">
          <EmploymentTab employmentId="emp-1" canManageHrm={false} />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    )
  })
  return {
    document: doc as unknown as Document,
    calls,
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
      Object.defineProperty(globalThis, 'self', { value: previous.self, configurable: true, writable: true })
      dom.window.close()
    },
  }
}

async function settle(times = 6): Promise<void> {
  const { act } = await import('react')
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

const RECORD = { record: { episodes: [], asOf: null, changeRequests: [] } }

function base(overrides: Record<string, { status: number; body: unknown }>): Responder {
  return async (url: string) => {
    if (url.startsWith('/api/hrm/employments/emp-1')) return { status: 200, body: RECORD }
    for (const [prefix, res] of Object.entries(overrides)) {
      if (url.startsWith(prefix)) return res
    }
    throw new Error(`unexpected fetch ${url}`)
  }
}

function retryButton(m: Mount, section: string): HTMLButtonElement | undefined {
  const heading = [...m.document.querySelectorAll('h3')].find((h) => h.textContent === section)
  const block = heading?.closest('section')
  return [...(block?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Retry') as HTMLButtonElement | undefined
}

// F3-60: a 500 on the beside-the-record APIs must read as an error with
// retry — never as no access.
test('failing benefits and qualifications sections show an error with retry instead of hiding', async () => {
  const m = await mount(
    base({
      '/api/hrm/qualifications': { status: 500, body: {} },
      '/api/hrm/enrollments': { status: 500, body: {} },
      '/api/hrm/dependents': { status: 200, body: { dependents: [] } },
      '/api/hrm/feedback': { status: 403, body: {} },
      '/api/hrm/competency-profile': { status: 403, body: {} },
    }),
  )
  try {
    await settle()
    const text = m.document.body.textContent ?? ''
    assert.match(text, /Qualifications/, 'the qualifications section stays visible on a 500')
    assert.match(text, /Qualifications could not be loaded\./, 'the qualifications failure names itself')
    assert.match(text, /Benefits/, 'the benefits section stays visible on a 500')
    assert.match(text, /Benefits could not be loaded\./, 'the benefits failure names itself')
    assert.ok(retryButton(m, 'Qualifications'), 'the qualifications error offers a retry')
    assert.ok(retryButton(m, 'Benefits'), 'the benefits error offers a retry')
  } finally {
    await m.unmount()
  }
})

// F3-60: a 403 still hides the section — the record is readable without
// the grant.
test('a forbidden beside-the-record section still hides instead of erroring', async () => {
  const m = await mount(
    base({
      '/api/hrm/qualifications': { status: 403, body: {} },
      '/api/hrm/enrollments': { status: 403, body: {} },
      '/api/hrm/dependents': { status: 403, body: {} },
      '/api/hrm/feedback': { status: 403, body: {} },
      '/api/hrm/competency-profile': { status: 403, body: {} },
    }),
  )
  try {
    await settle()
    const text = m.document.body.textContent ?? ''
    assert.doesNotMatch(text, /Qualifications could not be loaded/, 'no error without access')
    assert.doesNotMatch(text, /Benefits could not be loaded/, 'no error without access')
  } finally {
    await m.unmount()
  }
})

// F3-60: the retry refetches the section.
test('retrying a failed section refetches it', async () => {
  let attempts = 0
  const m = await mount(async (url: string) => {
    if (url.startsWith('/api/hrm/employments/emp-1')) return { status: 200, body: RECORD }
    if (url.startsWith('/api/hrm/qualifications')) {
      attempts += 1
      if (attempts === 1) return { status: 500, body: {} }
      return { status: 200, body: { qualifications: [] } }
    }
    if (url.startsWith('/api/hrm/enrollments')) return { status: 200, body: { enrollments: [] } }
    if (url.startsWith('/api/hrm/dependents')) return { status: 200, body: { dependents: [] } }
    if (url.startsWith('/api/hrm/feedback')) return { status: 403, body: {} }
    if (url.startsWith('/api/hrm/competency-profile')) return { status: 403, body: {} }
    throw new Error(`unexpected fetch ${url}`)
  })
  try {
    const { act } = await import('react')
    await settle()
    assert.match(m.document.body.textContent ?? '', /Qualifications could not be loaded\./)
    await act(async () => {
      m.click(retryButton(m, 'Qualifications')!)
    })
    await settle()
    assert.equal(attempts, 2, 'retry refetches the section')
    assert.match(m.document.body.textContent ?? '', /No qualifications recorded\./, 'the recovered section renders its empty state')
  } finally {
    await m.unmount()
  }
})
