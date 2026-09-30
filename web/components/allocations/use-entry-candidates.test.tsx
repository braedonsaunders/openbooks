import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../testing/jsdom-env'
await bootJsdomEnvironment()
const { stubModules } = await import('../../testing/stub-modules')
stubModules({})
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { useEntryCandidates } = await import('./use-entry-candidates')

test('allocation candidates fence delayed old-context replies and retry refused queries', async () => {
  const originalFetch = globalThis.fetch
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let current: ReturnType<typeof useEntryCandidates>
  const requests: Array<{ query: string; resolve: (response: Response) => void }> = []
  globalThis.fetch = (url) => new Promise((resolve) => requests.push({ query: String(url).split('?')[1]!, resolve }))
  function Probe({ context }: { context: string }) {
    const result = useEntryCandidates(context, true)
    React.useEffect(() => { current = result }, [result])
    return null
  }
  async function render(context: string) {
    await act(async () => root.render(<Probe context={context} />))
  }
  try {
    await render('documentKind=bill&documentDate=2026-09-01&subsidiaryId=A')
    const old = requests[0]!
    await render('documentKind=expense&documentDate=2026-09-29&subsidiaryId=B')
    const fresh = requests[1]!
    assert.notEqual(old.query, fresh.query)
    await act(async () => { old.resolve(Response.json({ rules: [{ ruleKey: 'old', applyPolicy: 'automatic' }] })); await Promise.resolve() })
    assert.equal(current!.cache.has(old.query), false)
    assert.equal(current!.on, false)
    await act(async () => { fresh.resolve(Response.json({ rules: [] })); await Promise.resolve() })
    assert.equal(current!.on, true)
    const query = current!.key({ accountId: 'account-1' })
    let refusal: Promise<unknown>
    await act(async () => {
      refusal = current!.load(query).catch((error) => error)
      requests.at(-1)!.resolve(Response.json({ error: 'temporary refusal' }, { status: 422 }))
      await refusal
    })
    assert.ok(current!.failed.has(query))
    await act(async () => {
      const retry = current!.load(query)
      requests.at(-1)!.resolve(Response.json({ rules: [{ ruleKey: 'new', applyPolicy: 'suggest' }] }))
      await retry
    })
    assert.equal(current!.failed.has(query), false)
    assert.equal(current!.cache.get(query)?.[0]?.ruleKey, 'new')
  } finally {
    await act(async () => root.unmount())
    host.remove()
    globalThis.fetch = originalFetch
    window.close()
  }
})
