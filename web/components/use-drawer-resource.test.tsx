import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { bootJsdomEnvironment } from '../testing/jsdom-env'
import { useDrawerResource } from './use-drawer-resource'

await bootJsdomEnvironment()
Object.assign(globalThis, { React })

test('record request identity ignores callback changes, aborts stale results and delivers refusals', async (t) => {
  const requests: { url: string; signal: AbortSignal; resolve: (response: Response) => void }[] = []
  const errors: string[] = []
  const prior = globalThis.fetch
  globalThis.fetch = ((url: unknown, options: RequestInit) => new Promise<Response>((resolve) => {
    requests.push({ url: String(url), signal: options.signal!, resolve })
  })) as typeof fetch
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  t.after(async () => { await act(() => root.unmount()); host.remove(); globalThis.fetch = prior })
  function Probe({ url, label }: { url: string | null; label: string }) {
    const data = useDrawerResource<{ name: string }>(url, (error) => errors.push(label + ':' + error.message))
    return <output>{data?.name ?? 'pending'}</output>
  }
  const render = async (url: string | null, label: string) => act(() => root.render(<Probe url={url} label={label} />))
  await render('/records/a', 'first')
  await render('/records/a', 'latest')
  assert.equal(requests.length, 1, 'a new callback is not a new record request')
  await render('/records/b', 'latest')
  assert.equal(requests[0]!.signal.aborted, true)
  await act(async () => requests[0]!.resolve(Response.json({ name: 'stale' })))
  assert.equal(host.textContent, 'pending', 'a network ignoring abort cannot expose stale data')
  await act(async () => requests[1]!.resolve(Response.json({ name: 'current' })))
  assert.equal(host.textContent, 'current')
  const output = host.querySelector('output')
  await render('/records/b', 'new callback')
  assert.equal(host.querySelector('output'), output)
  assert.equal(requests.length, 2)
  await render(null, 'closed')
  await render('/records/b', 'reopened')
  assert.equal(host.textContent, 'pending', 'reopening reauthorizes without displaying cached evidence')
  await act(async () => requests[2]!.resolve(Response.json({ error: 'Select an accessible subsidiary.' }, { status: 403 })))
  assert.deepEqual(errors, ['reopened:Select an accessible subsidiary.'])
  assert.equal(host.textContent, 'pending')
  await render('/records/c', 'html refusal')
  await act(async () => requests[3]!.resolve(new Response('<html>unavailable</html>', { status: 503 })))
  assert.equal(errors[1], 'html refusal:Unable to load the record (503).')
})
