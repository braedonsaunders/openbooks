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
        url: 'data:text/javascript,export function useRouter(){return {refresh(){},push(){},replace(){}}}export function usePathname(){return "/hrm/surveys"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return p.children}',
      }
    }
    return next(specifier, context)
  },
})
const { NextIntlClientProvider } = await import('next-intl')
const { readFileSync } = await import('node:fs')
const { SurveysDrawer } = await import('./sections')
// tsx compiles JSX classic: the island never imports React, so the test bridges it.
Object.assign(globalThis, { React })

// The shared Drawer reads its own copy through next-intl: serve the real catalogs.
const messages = {
  hrm: JSON.parse(readFileSync(new URL('../../../../messages/en/hrm.json', import.meta.url), 'utf8')),
  common: JSON.parse(readFileSync(new URL('../../../../messages/en/common.json', import.meta.url), 'utf8')),
  ui: JSON.parse(readFileSync(new URL('../../../../messages/en/ui.json', import.meta.url), 'utf8')),
}

type Drawer = Parameters<typeof SurveysDrawer>[0]['drawer']

const drawer = {
  closeHref: '/hrm/surveys',
  title: 'Pulse',
  survey: {
    id: 'survey-1',
    status: 'closed',
    questions: [
      { id: 'q1', prompt: 'How are you?', kind: 'scale' },
      { id: 'q2', prompt: 'Tell us more.', kind: 'mystery_kind' },
    ],
  },
  results: {
    participationPct: null,
    responded: 0,
    invitations: 0,
    enps: null,
    drivers: [],
    heat: { drivers: [], segments: [], cells: {} },
    comments: [],
    trend: [],
  },
  people: [],
  questionKinds: [
    { value: 'scale', label: 'Scale' },
    { value: 'enps', label: 'eNPS' },
    { value: 'text', label: 'Text' },
    { value: 'single', label: 'Single choice' },
    { value: 'multi', label: 'Multiple choice' },
  ],
  missingDetail: null,
  labels: {
    results: 'Results',
    participation: 'Participation',
    enps: 'eNPS',
    drivers: 'Drivers',
    heatmap: 'Heatmap',
    suppressed: 'Suppressed',
    comments: 'Comments',
    trend: 'Trend',
    questions: 'Questions',
    open: 'Open',
    close: 'Close',
    actionFailed: 'Failed.',
    invite: 'Invite',
    cancel: 'Cancel',
  },
} as unknown as Drawer

async function renderText(): Promise<{ text: string; unmount: () => Promise<void> }> {
  const { JSDOM } = await import('jsdom')
  // A real URL: UrlDrawer resolves its close href against the address bar.
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/hrm/surveys?survey=survey-1',
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
      <NextIntlClientProvider locale="en" messages={messages}>
        <SurveysDrawer drawer={drawer} />
      </NextIntlClientProvider>,
    )
  })
  return {
    text: doc.body.textContent ?? '',
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

test('F3-67: result question kinds render the translated option label', async () => {
  const m = await renderText()
  try {
    assert.match(m.text, /Scale/, 'the scale question renders its translated kind')
    assert.ok(!/(^|[^_a-z])scale([^_a-z]|$)/.test(m.text), 'no raw scale code leaks into the display')
  } finally {
    await m.unmount()
  }
})

test('F3-67: an unrecognized question kind falls back to its code, never blank', async () => {
  const m = await renderText()
  try {
    assert.match(m.text, /mystery_kind/, 'an unknown kind stays visible as its code')
  } finally {
    await m.unmount()
  }
})
