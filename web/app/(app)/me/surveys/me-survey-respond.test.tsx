import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'

const toastErrors: string[] = []
const pushes: string[] = []

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast = { success(){}, error(msg){ globalThis.__surveyToastErrors.push(msg) } }',
      }
    }
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const useRouter = () => ({ refresh(){}, push(url){ globalThis.__surveyPushes.push(url) }, replace(){} })',
      }
    }
    return next(specifier, context)
  },
})
const { MeSurveyRespond } = await import('./sections')
// tsx compiles JSX classic: the island never imports React, so the test bridges it.
Object.assign(globalThis, { React })
Object.assign(globalThis, { __surveyToastErrors: toastErrors, __surveyPushes: pushes })

const REISSUE_FAILED = 'The survey link could not be reissued — no token came back. Try responding again.'

async function mount(reissueBody: unknown): Promise<{ clickRespond: () => void; unmount: () => Promise<void> }> {
  toastErrors.length = 0
  pushes.length = 0
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/me/surveys',
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
  ;(globalThis as Record<string, unknown>).fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => reissueBody,
    clone: () => ({ json: async () => reissueBody }),
  })
  await act(async () => {
    root.render(
      <MeSurveyRespond
        invitationId="invitation-1"
        respondLabel="Respond"
        actionFailed="This action failed."
        reissueFailed={REISSUE_FAILED}
      />,
    )
  })
  return {
    clickRespond: () => {
      const { MouseEvent: RealmMouseEvent } = dom.window as unknown as { MouseEvent: typeof globalThis.MouseEvent }
      doc.querySelector('button')!.dispatchEvent(new RealmMouseEvent('click', { bubbles: true }))
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

async function flush(): Promise<void> {
  const { act } = await import('react')
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

test('F3-93: a tokenless reissue refuses by name and never navigates', async () => {
  for (const body of [{}, { token: '' }, { token: null }]) {
    const m = await mount(body)
    try {
      m.clickRespond()
      await flush()
      assert.deepEqual(pushes, [], `no navigation may happen for ${JSON.stringify(body)}`)
      assert.deepEqual(toastErrors, [REISSUE_FAILED], 'the named reissue refusal shows')
    } finally {
      await m.unmount()
    }
  }
})

test('F3-93: a tokened reissue navigates to the public survey page', async () => {
  const m = await mount({ token: 'tok-abc' })
  try {
    m.clickRespond()
    await flush()
    assert.deepEqual(pushes, ['/survey/tok-abc'])
    assert.deepEqual(toastErrors, [])
  } finally {
    await m.unmount()
  }
})
