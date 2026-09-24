import assert from 'node:assert/strict'
import test from 'node:test'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4800/hrm/performance' })
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}

declare global {
  var __aiDraftRouter: { push(path: string): void } | undefined
}

const script = { pushes: [] as string[] }
globalThis.__aiDraftRouter = { push(path) { script.pushes.push(path) } }
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return { shortCircuit: true, url: 'data:text/javascript,export function useRouter(){return globalThis.__aiDraftRouter}' }
    }
    if (specifier === '@openbooks/ui') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function Button(p){return globalThis.React.createElement("button",p,p.children)}export function UrlDrawer(p){return globalThis.React.createElement("section",{role:"dialog"},p.children)}',
      }
    }
    return next(specifier, context)
  },
})

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { AiDraftDrawer } = await import('./AiDraftDrawer')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

test('a refused outcome audit stays open and shows the server refusal', async (t) => {
  const priorFetch = globalThis.fetch
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      return Response.json({ error: 'The decision could not be recorded.' }, { status: 503 })
    }
    return Response.json({
      draft: {
        text: 'Draft response',
        sources: [],
        biasFlags: [],
        decisionId: 'decision-1',
      },
    })
  }) as typeof fetch
  script.pushes.length = 0
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
    globalThis.fetch = priorFetch
  })

  await act(async () => {
    root.render(
      <AiDraftDrawer
        draftParam="hrm_review:review-1"
        closeHref="/hrm/performance"
        fieldId="answer"
        title="AI draft"
        insertLabel="Insert"
        discardLabel="Discard"
        failedLabel="Draft action failed"
        sourcesTitle="Sources"
        biasTitle="Bias flags"
        loadingLabel="Loading"
        copiedLabel="Copied"
      />,
    )
    await tick()
  })
  const discard = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Discard')
  assert.ok(discard)
  await act(async () => {
    discard.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
  })
  assert.deepEqual(script.pushes, [], 'the drawer must not navigate away when the outcome audit is refused')
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /The decision could not be recorded/)
})
