import assert from 'node:assert/strict'
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
const { SurveysAuthorDialog } = await import('./sections')
// tsx compiles JSX classic: the island never imports React, so the test bridges it.
Object.assign(globalThis, { React })

const labels = {
  title: 'Author survey',
  name: 'Name',
  kind: 'Kind',
  anonymity: 'Anonymity',
  minGroup: 'Minimum group size',
  minGroupInvalid: 'Minimum group size must be a whole number from 2 to 1000.',
  questions: 'Questions',
  addQuestion: 'Add question',
  prompt: 'Prompt',
  driver: 'Driver key',
  options: 'Options',
  optionsHint: 'One option per line.',
  remove: 'Remove',
  submit: 'Save survey',
  failed: 'Saving failed.',
}

type SurveyKind = 'engagement' | 'pulse' | 'onboarding' | 'exit' | 'custom'
type Anonymity = 'anonymous' | 'confidential' | 'named'
type QuestionKind = 'scale' | 'enps' | 'text' | 'single' | 'multi'
const author = {
  closeHref: '/hrm/surveys',
  kinds: [{ value: 'engagement', label: 'Engagement' }] as { value: SurveyKind; label: string }[],
  anonymity: [{ value: 'anonymous', label: 'Anonymous' }] as { value: Anonymity; label: string }[],
  questionKinds: [
    { value: 'scale', label: 'Scale' },
    { value: 'single', label: 'Single choice' },
    { value: 'multi', label: 'Multiple choice' },
  ] as { value: QuestionKind; label: string }[],
  labels,
}

interface Posted {
  url: unknown
  body: {
    name: string
    kind: string
    anonymity: string
    minGroupSize: number
    questions: { kind: string; prompt: string; options?: string[] }[]
  } | null
}

interface Mount {
  document: Document
  posted: Posted[]
  setInput: (el: HTMLInputElement, value: string) => void
  setSelect: (el: HTMLSelectElement, value: string) => void
  setTextarea: (el: HTMLTextAreaElement, value: string) => void
  click: (el: Element) => void
  unmount: () => Promise<void>
}

async function mount(): Promise<Mount> {
  const { JSDOM } = await import('jsdom')
  // A real URL: UrlDrawer resolves its close href against the address bar.
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/hrm/surveys?author=1',
  })
  const previous = {
    window: (globalThis as Record<string, unknown>).window,
    document: (globalThis as Record<string, unknown>).document,
    navigator: (globalThis as Record<string, unknown>).navigator,
    fetch: (globalThis as Record<string, unknown>).fetch,
  }
  const posted: Posted[] = []
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
  ;(globalThis as Record<string, unknown>).fetch = async (url: unknown, init?: { body?: string }) => {
    posted.push({ url, body: init?.body ? (JSON.parse(init.body) as Posted['body']) : null })
    return { ok: true, json: async () => ({}) }
  }
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={{}}>
        <SurveysAuthorDialog author={author} />
      </NextIntlClientProvider>,
    )
  })
  const fire = (el: Element, event: string): void => {
    const { Event: RealmEvent } = dom.window as unknown as { Event: typeof globalThis.Event }
    el.dispatchEvent(new RealmEvent(event, { bubbles: true }))
  }
  const flush = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  return {
    document: doc as unknown as Document,
    posted,
    setInput: (el, value) => {
      // jsdom's window is typed as the bare DOM `Window`, and constructors
      // live on `typeof globalThis` rather than on that interface — so
      // `dom.window.HTMLInputElement` is a type error under `tsc --noEmit`
      // run from web/ (which is what CI runs). Reach them from THIS realm's
      // ambient global instead (the drawer-tab-strip test's pattern).
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
    setTextarea: (el, value) => {
      const { HTMLTextAreaElement: RealmArea } = dom.window as unknown as {
        HTMLTextAreaElement: typeof globalThis.HTMLTextAreaElement
      }
      const setter = Object.getOwnPropertyDescriptor(RealmArea.prototype, 'value')!.set!
      setter.call(el, value)
      fire(el, 'input')
    },
    click: (el) => {
      const { MouseEvent: RealmMouseEvent } = dom.window as unknown as { MouseEvent: typeof globalThis.MouseEvent }
      el.dispatchEvent(new RealmMouseEvent('click', { bubbles: true }))
    },
    unmount: async () => {
      await flush()
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

async function fillValidNameAndPrompt(m: Mount): Promise<void> {
  const { act } = await import('react')
  await act(async () => {
    // Text inputs in order: survey name, question prompt, driver key.
    const texts = [...m.document.querySelectorAll('input[type="text"], input:not([type])')]
    m.setInput(texts[0] as HTMLInputElement, 'Pulse')
    m.setInput(texts[1] as HTMLInputElement, 'How are you?')
  })
}

function saveButton(m: Mount): HTMLButtonElement {
  const buttons = [...m.document.querySelectorAll('button')]
  const save = buttons.find((b) => b.textContent === 'Save survey')
  assert.ok(save, 'the save button renders')
  return save as HTMLButtonElement
}

async function flushAsync(): Promise<void> {
  const { act } = await import('react')
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

// F3-54: the options editor must accept several lines — a single-line input
// can only ever post one option.
test('choice options are edited multi-line and every line is posted', async () => {
  const m = await mount()
  try {
    const { act } = await import('react')
    await fillValidNameAndPrompt(m)
    await act(async () => {
      // Selects in order: survey kind, anonymity, question kind.
      const selects = [...m.document.querySelectorAll('select')]
      m.setSelect(selects[2] as HTMLSelectElement, 'single')
    })
    const area = m.document.querySelector('textarea')
    assert.ok(area, 'choice options render as a multi-line field')
    assert.match(m.document.body.textContent ?? '', /One option per line\./)
    await act(async () => {
      m.setTextarea(area as HTMLTextAreaElement, 'red\ngreen\nblue')
      m.click(saveButton(m))
    })
    await flushAsync()
    assert.equal(m.posted.length, 1, 'the dialog posts once')
    assert.deepEqual(m.posted[0]?.body?.questions[0]?.options, ['red', 'green', 'blue'])
  } finally {
    await m.unmount()
  }
})

// F3-68: an unparseable anonymity threshold refuses by name — nothing is
// posted, and the dialog names the valid range.
test('an unparseable group size refuses by name and posts nothing', async () => {
  const m = await mount()
  try {
    const { act } = await import('react')
    await fillValidNameAndPrompt(m)
    await act(async () => {
      const minGroup = m.document.querySelector('input[type="number"]') as HTMLInputElement
      assert.ok(minGroup, 'the threshold field renders')
      m.setInput(minGroup, 'abc')
      m.click(saveButton(m))
    })
    await flushAsync()
    assert.equal(m.posted.length, 0, 'nothing is posted on an unparseable threshold')
    assert.match(
      m.document.body.textContent ?? '',
      /Minimum group size must be a whole number from 2 to 1000\./,
      'the dialog names the valid range',
    )
  } finally {
    await m.unmount()
  }
})
