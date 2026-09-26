import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { bootJsdomEnvironment } from '../../../../testing/jsdom-env'
import { stubModules } from '../../../../testing/stub-modules'

const toastErrors: string[] = []
const pushes: string[] = []

await bootJsdomEnvironment({ url: 'http://localhost/me/surveys' })

stubModules({
  navigation: {
    source:
      'export const useRouter = () => ({ refresh(){}, push(url){ globalThis.__surveyPushes.push(url) }, replace(){} })',
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    sonner:
      'export const toast = { success(){}, error(msg){ globalThis.__surveyToastErrors.push(msg) } }',
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
  const previousFetch = (globalThis as Record<string, unknown>).fetch
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
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
      host.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    },
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      host.remove()
      Object.defineProperty(globalThis, 'fetch', { value: previousFetch, configurable: true, writable: true })
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

test('a tokenless reissue refuses by name and never navigates', async () => {
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

test('a tokened reissue navigates to the public survey page', async () => {
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
