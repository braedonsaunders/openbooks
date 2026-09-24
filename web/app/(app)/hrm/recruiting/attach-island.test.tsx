import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'

const toastInfos: string[] = []
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast = { success(){}, error(){}, info(msg){ globalThis.__attachToastInfos.push(msg) } }',
      }
    }
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const useRouter = () => ({ refresh(){ globalThis.__attachRefreshes += 1 }, push(){}, replace(){} })',
      }
    }
    if (specifier.endsWith('/lib/prompt')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function promptDialog(){return null}',
      }
    }
    return next(specifier, context)
  },
})
const { NextIntlClientProvider } = await import('next-intl')
const { ApplicationAttachIsland } = await import('./actions')
// tsx compiles JSX classic: the island never imports React, so the test bridges it.
Object.assign(globalThis, { React })
Object.assign(globalThis, { __attachToastInfos: toastInfos, __attachRefreshes: 0 })

const hrmMessages = JSON.parse(readFileSync(new URL('../../../../messages/en/hrm.json', import.meta.url), 'utf8'))
const commonMessages = JSON.parse(readFileSync(new URL('../../../../messages/en/common.json', import.meta.url), 'utf8'))
const uiMessages = JSON.parse(readFileSync(new URL('../../../../messages/en/ui.json', import.meta.url), 'utf8'))

const labels = {
  name: 'Name',
  email: 'Email',
  phone: 'Phone',
  submit: 'Attach candidate',
  failed: 'The candidate could not be attached.',
  mergedNote: 'Attached to the existing candidate with this email.',
}

interface Call {
  url: string
  method: string
  body: Record<string, unknown> | null
}

type Responder = (call: Call) => Promise<{ status: number; body: unknown }>

interface Mount {
  document: Document
  calls: Call[]
  setInput: (el: HTMLInputElement, value: string) => void
  click: (el: Element) => void
  unmount: () => Promise<void>
}

async function mount(respond: Responder): Promise<Mount> {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/hrm/recruiting?requisition=req-1',
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
  const calls: Call[] = []
  ;(globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
    const call = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null }
    calls.push(call)
    const res = await respond(call)
    const payload = res.body
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: async () => payload,
      clone: () => ({ json: async () => payload }),
    }
  }
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={{ hrm: hrmMessages, common: commonMessages, ui: uiMessages }}>
        <ApplicationAttachIsland requisitionId="req-1" labels={labels} />
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

async function flushAsync(): Promise<void> {
  const { act } = await import('react')
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function fillAndSubmit(m: Mount, name: string, email: string): Promise<void> {
  const { act } = await import('react')
  await act(async () => {
    m.setInput(m.document.getElementById('attach-name-req-1') as HTMLInputElement, name)
    m.setInput(m.document.getElementById('attach-email-req-1') as HTMLInputElement, email)
  })
  await act(async () => {
    const submit = [...m.document.querySelectorAll('button')].find((b) => b.textContent === 'Attach candidate')
    assert.ok(submit, 'the attach button renders')
    m.click(submit!)
  })
  await flushAsync()
}

// F3-62: the island attaches through ONE server call — the prospect and
// the candidacy are never split across POSTs, so a failure cannot orphan
// the prospect.
test('attaching posts once to the combined endpoint and clears the form', async () => {
  (globalThis as Record<string, unknown>).__attachRefreshes = 0
  const m = await mount(async (call) => {
    assert.equal(call.url, '/api/hrm/recruiting/attachments', 'the island posts only to the combined endpoint')
    assert.equal(call.method, 'POST')
    return { status: 201, body: { attached: { candidate: { id: 'cand-1' }, mergedInto: null } } }
  })
  try {
    await fillAndSubmit(m, 'Ada Candidate', 'ada@example.test')
    assert.equal(m.calls.length, 1, 'exactly one POST attaches both rows')
    assert.deepEqual(m.calls[0]?.body, {
      requisitionId: 'req-1',
      displayName: 'Ada Candidate',
      email: 'ada@example.test',
    })
    assert.equal((m.document.getElementById('attach-name-req-1') as HTMLInputElement).value, '', 'the form clears on success')
    assert.equal((globalThis as Record<string, unknown>).__attachRefreshes, 1, 'success refreshes the drawer')
  } finally {
    await m.unmount()
  }
})

// F3-62: a same-name duplicate retries once with mergeInto on the same
// combined endpoint — each attempt atomic, the survivor named in the UI.
test('a same-name duplicate merges into the survivor with one atomic retry', async () => {
  toastInfos.length = 0
  const m = await mount(async (call) => {
    if (!call.body?.mergeInto) {
      return { status: 409, body: { error: 'duplicate-email', candidate: { id: 'cand-9', displayName: 'Ada Candidate' } } }
    }
    assert.equal(call.body.mergeInto, 'cand-9')
    return { status: 201, body: { attached: { candidate: { id: 'cand-9' }, mergedInto: { id: 'cand-9' } } } }
  })
  try {
    await fillAndSubmit(m, 'Ada Candidate', 'ada@example.test')
    assert.equal(m.calls.length, 2, 'the duplicate retries once with mergeInto')
    assert.ok(
      m.calls.every((call) => call.url === '/api/hrm/recruiting/attachments'),
      'both attempts ride the combined endpoint',
    )
    assert.deepEqual(toastInfos, ['Attached to the existing candidate with this email.'])
  } finally {
    await m.unmount()
  }
})

// F3-62: a different-name duplicate stays refused — no silent absorption.
test('a different-name duplicate refuses without retrying', async () => {
  const m = await mount(async () => {
    return { status: 409, body: { error: 'duplicate-email', candidate: { id: 'cand-9', displayName: 'Somebody Else' } } }
  })
  try {
    await fillAndSubmit(m, 'Ada Candidate', 'ada@example.test')
    assert.equal(m.calls.length, 1, 'no retry on a name mismatch')
    assert.match(m.document.body.textContent ?? '', /duplicate-email/, 'the refusal surfaces')
  } finally {
    await m.unmount()
  }
})
