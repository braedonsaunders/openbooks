import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { mountDashboard, scriptFetch, tick } from './_dashboard-render-harness'

const { ProjectionFrame } = await import('./_projection-frame')
const messages = Object.fromEntries(['common', 'dashboard'].map((name) => [
  name, JSON.parse(readFileSync(new URL(`../../../messages/en/${name}.json`, import.meta.url), 'utf8')),
]))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('current tile figures render plainly and ask for nothing', async () => {
  const requests: string[] = []
  const restore = scriptFetch((url) => { requests.push(url); return null })
  const { host, unmount } = await mountDashboard(
    <ProjectionFrame group={['kpi-journal-lines']} observedAt="2026-10-26T15:04:00.000Z" refreshing={false}>
      <p>209 lines</p>
    </ProjectionFrame>,
    messages,
  )
  try {
    await wait(120)
    assert.equal(host.textContent, '209 lines')
    assert.deepEqual(requests, [])
  } finally { restore(); await unmount() }
})

test('refreshing tiles show their calculation time and rebuild their groups once before the page re-renders', async () => {
  const bodies: unknown[] = []
  let refreshes = 0
  const restore = scriptFetch((url, init) => {
    if (url === '/api/me/dashboard/projections') {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({ rebuilt: 2 })
    }
    return null
  })
  const { host, unmount } = await mountDashboard(
    <>
      <ProjectionFrame group={['kpi-open-ar', 'kpi-overdue-ar']} observedAt="2026-10-26T15:04:00.000Z" refreshing>
        <p>AR</p>
      </ProjectionFrame>
      <ProjectionFrame group={['kpi-open-ar', 'kpi-overdue-ar']} observedAt="2026-10-26T15:04:00.000Z" refreshing>
        <p>Overdue</p>
      </ProjectionFrame>
      <ProjectionFrame group={['kpi-cash']} observedAt="2026-10-26T15:05:00.000Z" refreshing>
        <p>Cash</p>
      </ProjectionFrame>
    </>,
    messages,
  )
  globalThis.__dashRouter.refresh = () => { refreshes += 1 }
  try {
    assert.match(host.textContent ?? '', /Updated 3:04/)
    assert.match(host.textContent ?? '', /Updated 3:05/)
    await wait(150)
    await tick()
    assert.equal(bodies.length, 1, 'one rebuild request for every stale group on the page')
    assert.deepEqual(bodies[0], { groups: [['kpi-open-ar', 'kpi-overdue-ar'], ['kpi-cash']] })
    assert.equal(refreshes, 1, 'the page re-renders once the rebuild answers')
  } finally { restore(); await unmount() }
})
