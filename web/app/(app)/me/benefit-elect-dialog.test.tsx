import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env'
import { stubModules } from '../../../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost/me/benefits?elect=1', matchMediaMatches: false, event: 'jsdom' })

// The dialog reads a legacy-listener matchMedia: keep that shape on the
// shared window (the preset installs the modern listener names only).
const benefitWindow = window as unknown as { matchMedia?: (query: string) => unknown }
benefitWindow.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() {
    return false
  },
})

stubModules({
  navigation: {
    source:
      'export function useRouter(){return {refresh(){},push(){},replace(){}}}' +
      'export function usePathname(){return "/me/benefits"}' +
      'export function useSearchParams(){return new URLSearchParams()}',
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    'next/link': 'export default function Link(p){return p.children}',
  },
})
const { NextIntlClientProvider } = await import('next-intl')
const { readFileSync } = await import('node:fs')
const { BenefitElectDialog } = await import('./islands')
// tsx compiles JSX classic: the island never imports React, so the test bridges it.
Object.assign(globalThis, { React })

// The shared Drawer reads its own copy through next-intl: serve the real catalogs.
const messages = {
  admin: JSON.parse(readFileSync(new URL('../../../messages/en/admin.json', import.meta.url), 'utf8')),
  hrm: JSON.parse(readFileSync(new URL('../../../messages/en/hrm.json', import.meta.url), 'utf8')),
  common: JSON.parse(readFileSync(new URL('../../../messages/en/common.json', import.meta.url), 'utf8')),
  ui: JSON.parse(readFileSync(new URL('../../../messages/en/ui.json', import.meta.url), 'utf8')),
}

type Dialog = Parameters<typeof BenefitElectDialog>[0]['dialog']

const dialog = {
  title: 'Elect coverage',
  description: 'Pick a plan.',
  employmentLabel: 'Employment',
  employments: [{ value: 'employment-1', label: 'Quinn Vidal' }],
  planLabel: 'Plan',
  plans: [{ value: 'plan-1', label: 'MED — Medical', classes: [], contributionRules: [] }],
  windowLabel: 'Window',
  windows: [{ value: 'window-1', label: 'Open enrollment (2026-01-01 → 2026-01-31)' }],
  fromLabel: 'From',
  lifeEventLabel: 'Life event reason (instead of a window)',
  lifeEventPlaceholder: 'Describe the life event.',
  submitLabel: 'Elect',
  cancelLabel: 'Cancel',
  submitFailed: 'Failed.',
} as unknown as Dialog

async function renderText(selectedDialog: Dialog = dialog): Promise<{ text: string; document: Document; unmount: () => Promise<void> }> {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <BenefitElectDialog dialog={selectedDialog} closeHref="/me/benefits" />
      </NextIntlClientProvider>,
    )
  })
  return {
    text: document.body.textContent ?? '',
    document,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    },
  }
}

test('the window placeholder names the window, never the life-event field', async () => {
  const m = await renderText()
  try {
    // The shared Select renders a hidden native proxy: find the select
    // holding the window option and read its empty placeholder option.
    const selects = [...m.document.querySelectorAll('select')]
    const windowed = selects.find((s) => [...s.querySelectorAll('option')].some((o) => o.value === 'window-1'))
    assert.ok(windowed, 'the window select renders')
    const placeholder = [...windowed.querySelectorAll('option')].find((o) => o.value === '')
    assert.ok(placeholder, 'the window select carries a placeholder option')
    assert.equal(placeholder.textContent, 'Window')
  } finally {
    await m.unmount()
  }
})


test('enrollment requires an explicit election and sends the exact fixed rate atomically', async (t) => {
  const bodies: Record<string, unknown>[] = []
  const previous = globalThis.fetch
  globalThis.fetch = (async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ error: 'A controlled refusal' }, { status: 422 }) }) as typeof fetch
  t.after(() => { globalThis.fetch = previous })
  const m = await renderText({ ...dialog!, plans: [{ value: 'plan-1', label: 'RRSP (CAD)', classes: [], contributionRules: [{ value: 'rrsp-rule', label: 'Employee RRSP', basis: 'per_hour', rate: '2.00', rateFormula: 'elected_rate', requiresMatchEligibility: false, effectiveFrom: '2026-01-01', effectiveTo: null }] }] })
  const { act } = await import('react')
  async function change(node: HTMLInputElement | HTMLSelectElement, value: string) {
    await act(async () => {
      const prototype = node.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value)
      node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    })
  }
  const button = () => [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === 'Elect')!
  try {
    await change([...document.querySelectorAll('select')].find((select) => [...select.options].some((option) => option.value === 'plan-1'))!, 'plan-1')
    await change(document.querySelector('input#me-elect-from')!, '2026-09-26')
    await act(async () => button().click())
    assert.equal(bodies.length, 0, 'an absent rate election must not activate enrollment')
    const election = [...document.querySelectorAll('select')].find((select) => [...select.options].some((option) => option.value === 'fixed'))
    assert.ok(election, document.body.textContent ?? '')
    await change(election, 'fixed')
    await change(document.querySelector('input[aria-label="Elected rate"]')!, '1.7300')
    await act(async () => button().click())
    assert.deepEqual(bodies[0]?.contributionTerms, [{ ruleId: 'rrsp-rule', electionMode: 'fixed', electedRate: '1.7300' }])
    assert.ok(document.body.textContent?.includes('A controlled refusal'))
  } finally { await m.unmount() }
})
