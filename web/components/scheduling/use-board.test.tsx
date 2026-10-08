import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../testing/jsdom-env'
import { scheduleWindow } from '../../testing/schedule-window'
await bootJsdomEnvironment({ event: 'jsdom' })
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client'),
  { act } = React
const { NextIntlClientProvider } = await import('next-intl')
const messages = (
  await import('../../messages/en/scheduling.json', { with: { type: 'json' } })
).default
const { useBoard } = await import('./use-board')

test('matching server snapshots avoid duplicate initial work, stale windows stay hidden, and superseded requests cannot replace native updates', async (t) => {
  const original = globalThis.fetch,
    requests: {
      signal: AbortSignal | null
      resolve: (r: Response) => void
      url: string
    }[] = []
  globalThis.fetch = async (input, init) =>
    new Promise<Response>((resolve) =>
      requests.push({
        url: String(input),
        signal: init?.signal ?? null,
        resolve,
      }),
    )
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let latest: ReturnType<typeof useBoard> | null = null
  const initial = scheduleWindow()
  function Probe({ from }: { from: string }) {
    latest = useBoard(initial.board.id, initial, { from, through: from })
    return (
      <div>{latest.window?.rows.map((r) => r.name).join(',') ?? 'loading'}</div>
    )
  }
  const render = async (from: string) =>
    act(async () =>
      root.render(
        <React.StrictMode>
          <NextIntlClientProvider
            locale="en"
            messages={{ scheduling: messages }}
          >
            <Probe from={from} />
          </NextIntlClientProvider>
        </React.StrictMode>,
      ),
    )
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
    globalThis.fetch = original
  })
  await render(initial.from)
  assert.equal(requests.length, 0)
  assert.match(host.textContent ?? '', /Alex,Blair/)
  await render('2026-10-13')
  assert.equal(requests.length, 1)
  assert.equal(latest!.window, null)
  await render('2026-10-14')
  assert.equal(requests.length, 2)
  assert.equal(requests[0]!.signal!.aborted, true)
  const stale = {
    ...scheduleWindow('2026-10-13'),
    rows: [{ ...initial.rows[0]!, name: 'Stale' }, initial.rows[1]!],
  }
  await act(async () => requests[0]!.resolve(Response.json(stale)))
  assert.equal(latest!.window, null)
  const current = {
    ...scheduleWindow('2026-10-14'),
    rows: [{ ...initial.rows[0]!, name: 'Current' }, initial.rows[1]!],
  }
  await act(async () => requests[1]!.resolve(Response.json(current)))
  assert.match(host.textContent ?? '', /Current,Blair/)
  assert.equal(latest!.loading, false)
  let refresh: Promise<void>
  await act(async () => {
    refresh = latest!.reload()
  })
  assert.equal(requests.length, 3)
  const updated = {
    ...scheduleWindow('2026-10-14'),
    rows: [
      { ...initial.rows[0]!, name: 'Authoritative update' },
      initial.rows[1]!,
    ],
  }
  await act(async () => {
    requests[2]!.resolve(Response.json(updated))
    await refresh!
  })
  assert.match(host.textContent ?? '', /Authoritative update/)
  await render('2026-10-15')
  const last = requests.at(-1)!
  await act(async () => root.unmount())
  assert.equal(last.signal!.aborted, true)
  await act(async () =>
    last.resolve(Response.json(scheduleWindow('2026-10-15'))),
  )
})
