import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'

const uiMessages = JSON.parse(readFileSync(new URL('../../../../messages/en/ui.json', import.meta.url), 'utf8'))
const commonMessages = JSON.parse(readFileSync(new URL('../../../../messages/en/common.json', import.meta.url), 'utf8'))

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
const { TalentDialog } = await import('./continuous-islands')
// tsx compiles JSX classic: the island never imports React, so the test bridges it.
Object.assign(globalThis, { React })

interface Post {
  url: string
  body: Record<string, unknown>
}

async function mount(posts: Post[]): Promise<{
  document: Document
  click: (el: Element) => void
  setSelect: (el: HTMLSelectElement, value: string) => void
  setText: (el: HTMLTextAreaElement, value: string) => void
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
  const { NextIntlClientProvider } = await import('next-intl')
  const root = createRoot(doc.getElementById('root')!)
  ;(globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
    if ((init?.method ?? 'GET') === 'POST') {
      posts.push({ url: String(input), body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {} })
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }
  const labels = {
    perfLabel: 'Performance',
    potLabel: 'Potential',
    impactLabel: 'Impact',
    riskLabel: 'Risk',
    promotionLabel: 'Ready now',
    notesLabel: 'Notes',
    submitLabel: 'Save',
    cancelLabel: 'Cancel',
    closeHref: '/hrm/performance',
    failed: 'Failed.',
    openLabel: 'Record talent',
    modeLabel: 'Mode',
    modeTalentLabel: 'Talent review',
    modeSuccessionLabel: 'Succession plan',
    employeeLabel: 'Employee',
    positionLabel: 'Position',
  }
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={{ ui: uiMessages, common: commonMessages }}>
        <TalentDialog
          employments={[{ value: 'emp-1', label: 'Ada Lovelace' }]}
          positions={[{ value: 'pos-1', label: 'ENG · Engineer' }]}
          perfOptions={['exceeds']}
          potOptions={['high']}
          lossOptions={[{ value: 'medium', label: 'Medium' }]}
          {...labels}
        />
      </NextIntlClientProvider>,
    )
  })
  const fire = (el: Element, event: string): void => {
    const { Event: RealmEvent } = dom.window as unknown as { Event: typeof globalThis.Event }
    el.dispatchEvent(new RealmEvent(event, { bubbles: true }))
  }
  return {
    document: doc as unknown as Document,
    click: (el) => {
      const { MouseEvent: RealmMouseEvent } = dom.window as unknown as { MouseEvent: typeof globalThis.MouseEvent }
      el.dispatchEvent(new RealmMouseEvent('click', { bubbles: true }))
    },
    setSelect: (el, value) => {
      const { HTMLSelectElement: RealmSelect } = dom.window as unknown as {
        HTMLSelectElement: typeof globalThis.HTMLSelectElement
      }
      const setter = Object.getOwnPropertyDescriptor(RealmSelect.prototype, 'value')!.set!
      setter.call(el, value)
      fire(el, 'change')
    },
    setText: (el, value) => {
      const { HTMLTextAreaElement: RealmArea } = dom.window as unknown as {
        HTMLTextAreaElement: typeof globalThis.HTMLTextAreaElement
      }
      const setter = Object.getOwnPropertyDescriptor(RealmArea.prototype, 'value')!.set!
      setter.call(el, value)
      fire(el, 'input')
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
      dom.window.close()
    },
  }
}

async function openDialog(m: Awaited<ReturnType<typeof mount>>) {
  const { act } = await import('react')
  await act(async () => {
    const open = [...m.document.querySelectorAll('button')].find((b) => b.textContent === 'Record talent')
    assert.ok(open, 'the open button renders')
    m.click(open!)
  })
}

// F3-41: succession plan notes belong to the plan and travel with its create request.
test('succession mode posts its notes with the plan', async () => {
  const posts: Post[] = []
  const m = await mount(posts)
  try {
    const { act } = await import('react')
    await openDialog(m)
    assert.ok(m.document.getElementById('tal-notes'), 'talent mode renders the notes field')
    await act(async () => {
      const mode = m.document.querySelector('select[aria-hidden]') as HTMLSelectElement
      m.setSelect(mode, 'succession')
    })
    assert.equal((m.document.querySelector('select[aria-hidden]') as HTMLSelectElement).value, 'succession')
    assert.ok(m.document.getElementById('tal-notes'), 'succession mode keeps the notes field available')
    await act(async () => {
      m.setText(m.document.getElementById('tal-notes') as HTMLTextAreaElement, 'interim coverage plan')
    })
    await act(async () => {
      const save = [...m.document.querySelectorAll('button')].find((b) => b.textContent === 'Save')
      m.click(save!)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.equal(posts.length, 1, 'the succession plan posts once')
    assert.equal(posts[0]?.body?.notes, 'interim coverage plan', 'the succession payload carries its notes')
    assert.equal(posts[0]?.body?.positionId, 'pos-1', 'the plan still names its position')
  } finally {
    await m.unmount()
  }
})

test('talent mode still posts its notes with the review', async () => {
  const posts: Post[] = []
  const m = await mount(posts)
  try {
    const { act } = await import('react')
    await openDialog(m)
    await act(async () => {
      m.setText(m.document.getElementById('tal-notes') as HTMLTextAreaElement, 'flight risk')
    })
    await act(async () => {
      const save = [...m.document.querySelectorAll('button')].find((b) => b.textContent === 'Save')
      m.click(save!)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.equal(posts.length, 1, 'the talent review posts once')
    assert.equal(posts[0]?.body?.notes, 'flight risk', 'talent notes still persist')
  } finally {
    await m.unmount()
  }
})
