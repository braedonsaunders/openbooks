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

type ExitExisting = {
  id: string
  reasonKind: string
  isVoluntary: boolean
  interviewHeldOn: string | null
  interviewerPartyId: string | null
  destination: string | null
  notes: string | null
  revision: number
}

async function mount(opts?: {
  existing?: ExitExisting | null
  people?: { partyId: string; label: string }[]
  posts?: { url: string; body: Record<string, unknown> }[]
}): Promise<{
  document: Document
  submit: () => void
  setInput: (el: HTMLInputElement, value: string) => void
  setSelect: (el: HTMLSelectElement, value: string) => void
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
  const people = opts?.people ?? []
  const posts = opts?.posts ?? []
  ;(globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.includes('/api/hrm/options?source=people')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ options: people.map((p) => ({ partyId: p.partyId, label: p.label })) }),
      }
    }
    if (method === 'POST' || method === 'PATCH') {
      posts.push({ url, body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {} })
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      clone: () => ({ json: async () => ({}) }),
    }
  }
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={{ hrm: hrmMessages, common: commonMessages, ui: uiMessages }}>
        <ExitRecordForm employmentId="employment-1" existing={opts?.existing ?? null} />
      </NextIntlClientProvider>,
    )
  })
  const fire = (el: Element, event: string): void => {
    const { Event: RealmEvent } = dom.window as unknown as { Event: typeof globalThis.Event }
    el.dispatchEvent(new RealmEvent(event, { bubbles: true }))
  }
  return {
    document: doc as unknown as Document,
    submit: () => {
      const { MouseEvent: RealmMouseEvent } = dom.window as unknown as { MouseEvent: typeof globalThis.MouseEvent }
      doc.querySelector('form')!.querySelector('button[type="submit"]')!.dispatchEvent(
        new RealmMouseEvent('click', { bubbles: true }),
      )
    },
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

// F3-40: the form records the interview as a pair — held date with
// interviewer — posting both together, or neither.
test('the interview posts the held date with the picked interviewer', async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = []
  const m = await mount({
    people: [
      { partyId: 'party-hr', label: 'Helen Hr' },
      { partyId: 'party-mgr', label: 'Marta Manager' },
    ],
    posts,
  })
  try {
    const { act } = await import('react')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const text = m.document.body.textContent ?? ''
    assert.match(text, /Interview date/, 'the interview date field renders')
    assert.match(text, /Interviewer/, 'the interviewer picker renders')
    const date = m.document.getElementById('exit-interview-date') as HTMLInputElement
    assert.ok(date, 'the date input renders')
    const natives = [...m.document.querySelectorAll('select')] as HTMLSelectElement[]
    const interviewer = natives.find((s) => (s.textContent ?? '').includes('Helen Hr'))
    assert.ok(interviewer, 'the picker names directory people')
    await act(async () => {
      m.setInput(date, '2026-07-01')
      m.setSelect(interviewer!, 'party-hr')
    })
    await act(async () => {
      m.submit()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.equal(posts.length, 1, 'the form posts once')
    assert.equal(posts[0]?.body?.interviewHeldOn, '2026-07-01', 'the held date posts')
    assert.equal(posts[0]?.body?.interviewerPartyId, 'party-hr', 'the picked interviewer posts by party id')
  } finally {
    await m.unmount()
  }
})

test('an empty interview posts nulls for both halves of the pair', async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = []
  const m = await mount({ people: [{ partyId: 'party-hr', label: 'Helen Hr' }], posts })
  try {
    const { act } = await import('react')
    await act(async () => {
      m.submit()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.equal(posts.length, 1, 'the form posts once')
    assert.equal(posts[0]?.body?.interviewHeldOn, null, 'no date posts null')
    assert.equal(posts[0]?.body?.interviewerPartyId, null, 'no interviewer posts null')
  } finally {
    await m.unmount()
  }
})
