import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import '../dashboard/_dashboard-render-harness'
import { act, click, mountDashboard } from '../dashboard/_dashboard-render-harness'

// Await-imports (not static imports): module hooks register while the
// harness above evaluates, so only imports that resolve after that point see
// the jsdom shims.
const { ReportFilterBar } = await import('./ReportFilterBar')

const dir = dirname(fileURLToPath(import.meta.url));
const messages = {
  reports: JSON.parse(readFileSync(join(dir, '..', '..', '..', 'messages', 'en', 'reports.json'), 'utf8')),
  common: JSON.parse(readFileSync(join(dir, '..', '..', '..', 'messages', 'en', 'common.json'), 'utf8')),
  ui: JSON.parse(readFileSync(join(dir, '..', '..', '..', 'messages', 'en', 'ui.json'), 'utf8')),
};

// Typed custom ranges stage until the operator applies them: typing must not
// navigate, and Apply (or Enter) commits period=custom with both bounds.

function recordReplaces(): { replaces: string[] } {
  const replaces: string[] = []
  const router = (globalThis as unknown as { __dashRouter: Record<string, unknown> }).__dashRouter
  router.replace = (href: string) => { replaces.push(href) }
  return { replaces }
}

function dateInputs(): HTMLInputElement[] {
  return [...document.querySelectorAll('input[type="date"]')] as HTMLInputElement[]
}

async function typeDate(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

async function pressEnter(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

function applyButton(): HTMLButtonElement | null {
  return [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Apply',
  ) as HTMLButtonElement | null
}

test('typing a custom bound stages it without navigating until Apply', async () => {
  const { unmount } = await mountDashboard(
    <ReportFilterBar controls={{ period: false }} defaultPeriod="custom" />,
    messages,
  )
  const { replaces } = recordReplaces()
  try {
    const [from] = dateInputs()
    assert.ok(from, 'the custom From field renders')
    await typeDate(from!, '2026-02-01')
    assert.equal(replaces.length, 0, 'typing alone must not re-run the report')
    const apply = applyButton()
    assert.ok(apply, 'an explicit Apply is offered')
    assert.equal(apply.disabled, false, 'Apply enables with a staged range')
    await click(apply)
    assert.equal(replaces.length, 1, 'Apply commits exactly once')
    const href = replaces[0]!
    assert.ok(href.includes('period=custom'), 'the commit selects the custom period')
    assert.ok(href.includes('from=2026-02-01'), 'the commit carries the typed From')
  } finally {
    await unmount()
  }
})

test('Enter in a custom bound applies the staged range', async () => {
  const { unmount } = await mountDashboard(
    <ReportFilterBar controls={{ period: false }} defaultPeriod="custom" />,
    messages,
  )
  const { replaces } = recordReplaces()
  try {
    const [, to] = dateInputs()
    assert.ok(to, 'the custom To field renders')
    await typeDate(to!, '2026-02-28')
    await pressEnter(to!)
    assert.equal(replaces.length, 1, 'Enter commits the staged range')
    assert.ok(replaces[0]!.includes('to=2026-02-28'), 'the commit carries the typed To')
  } finally {
    await unmount()
  }
})

test('always-visible From/To apply together with the resolved defaults', async () => {
  const { unmount } = await mountDashboard(
    <ReportFilterBar
      controls={{ period: false, dateRange: true }}
      dateRange={{ from: '2026-01-01', to: '2026-01-31' }}
    />,
    messages,
  )
  const { replaces } = recordReplaces()
  try {
    assert.equal(applyButton()?.disabled, true, 'Apply rests disabled with nothing staged')
    const [from] = dateInputs()
    await typeDate(from!, '2026-02-01')
    assert.equal(replaces.length, 0, 'typing alone must not re-run the report')
    await click(applyButton()!)
    assert.equal(replaces.length, 1, 'Apply commits exactly once')
    const href = replaces[0]!
    assert.ok(href.includes('period=custom'), 'the commit selects the custom period')
    assert.ok(href.includes('from=2026-02-01'), 'the commit carries the typed From')
    assert.ok(href.includes('to=2026-01-31'), 'the untouched To keeps its resolved default')
  } finally {
    await unmount()
  }
})
