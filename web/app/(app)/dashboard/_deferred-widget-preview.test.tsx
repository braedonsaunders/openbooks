import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { act, click, mountDashboard, tick } from './_dashboard-render-harness'
import type { DashboardMetrics } from './_metrics'

const { DeferredWidgetPreview } = await import('./_deferred-widget-preview')
const messages = Object.fromEntries(['common', 'dashboard'].map((name) => [
  name, JSON.parse(readFileSync(new URL(`../../../messages/en/${name}.json`, import.meta.url), 'utf8')),
]))
const success = (count: number) => ({ ok: true as const, data: { journalLineCount: count } as DashboardMetrics })

test('a draft preview preserves its tile through a transport refusal and a successful retry', async () => {
  let calls = 0
  const ids: unknown[] = []
  const { host, unmount } = await mountDashboard(<DeferredWidgetPreview widgetId="kpi-journal-lines" loadPreview={async (id) => {
    ids.push(id)
    if (++calls === 1) throw new Error('Transport unavailable')
    return success(209)
  }} />, messages)
  try {
    assert.match(host.textContent ?? '', /Couldn't load this widget/)
    assert.equal(host.querySelectorAll('h3').length, 1)
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry')
    assert.ok(retry)
    await click(retry)
    assert.match(host.textContent ?? '', /209/)
    assert.doesNotMatch(host.textContent ?? '', /Couldn't load/)
    assert.deepEqual(ids, ['kpi-journal-lines', 'kpi-journal-lines'])
  } finally { await unmount() }
})

test('a denied preview names the configuration remedy and retries through a fresh read', async () => {
  let allowed = false
  let calls = 0
  const { host, unmount } = await mountDashboard(<DeferredWidgetPreview widgetId="kpi-journal-lines" loadPreview={async () => {
    calls++
    return allowed ? success(310) : { ok: false }
  }} />, messages)
  try {
    assert.match(host.textContent ?? '', /Review its feature and permission settings/)
    assert.doesNotMatch(host.textContent ?? '', /310/)
    allowed = true
    await click(host.querySelector('button')!)
    assert.match(host.textContent ?? '', /310/)
    assert.equal(calls, 2)
  } finally { await unmount() }
})

test('a removed preview cannot publish its delayed result into a later preview', async () => {
  let finish!: (result: ReturnType<typeof success>) => void
  const first = await mountDashboard(<DeferredWidgetPreview widgetId="kpi-journal-lines" loadPreview={() => new Promise((resolve) => { finish = resolve })} />, messages)
  assert.match(first.host.textContent ?? '', /Loading/)
  await first.unmount()
  const second = await mountDashboard(<DeferredWidgetPreview widgetId="kpi-journal-lines" loadPreview={async () => success(412)} />, messages)
  try {
    await act(async () => { finish(success(999)); await tick() })
    assert.match(second.host.textContent ?? '', /412/)
    assert.doesNotMatch(second.host.textContent ?? '', /999/)
  } finally { await second.unmount() }
})
