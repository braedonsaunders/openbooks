import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * F7: the offer Draft form never sent employerSubsidiaryId, so every UI
 * submission failed with "expected string, received undefined". The draft
 * now inherits the requisition's legal entity deterministically, shows its
 * NAME (with an authorized picker only when the caller may genuinely
 * choose), and carries it on the POST. Scope stays server-side: the route
 * refuses an out-of-scope employer by name.
 * (Ticket in comment only; the test names state the behaviour.)
 *
 * These tests exercise the real islands: the draft body builder with
 * hand-built inputs, the create form rendered with an inherited employer
 * (name shown, id posted), and the accept action pinning a 422 refusal.
 * The loader wiring that inherits the entity into the drawer props and
 * the route's out-of-scope refusal stay covered by the offers route
 * tests, not doubled here.
 */

// jsdom first: the islands read browser globals at render.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/hrm/recruiting',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return { refresh(){ globalThis.__offerRefreshes = (globalThis.__offerRefreshes || 0) + 1 }, push(){} }}',
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
const { renderToStaticMarkup } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default

function provider(children: React.ReactNode): React.ReactNode {
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {children}
    </NextIntlClientProvider>
  )
}
// Dynamic: the islands resolve next/navigation through the stub above,
// so the module must load after the hook registers.
const { buildOfferDraftBody, OfferCreateIsland, OfferActionsIsland } = await import('./actions')

const EMPLOYER_ID = 'd726d187-0000-0000-0000-000000000001'
const OTHER_ID = 'd726d187-0000-0000-0000-000000000002'

const CREATE_LABELS = {
  employer: 'Employer',
  job: 'Job title',
  start: 'Start',
  amount: 'Amount',
  currency: 'Currency',
  basis: 'Basis',
  expires: 'Expires',
  submit: 'Draft offer',
  failed: 'Could not draft the offer',
}

const ACTION_LABELS = {
  send: 'Send',
  accept: 'Accept and hire',
  decline: 'Decline',
  withdraw: 'Withdraw',
  reason: 'Reason',
  failed: 'Could not change the offer',
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

test('the draft POST carries the requisition employer', () => {
  const body = buildOfferDraftBody({
    applicationId: 'app-1',
    employerSubsidiaryId: 'd726d187-0000-0000-0000-000000000001',
    jobTitle: '  Machinist ',
    proposedStartOn: '2026-10-01',
    compensationAmount: ' 45.5000 ',
    compensationCurrency: ' usd ',
    compensationBasis: 'hourly',
    expiresOn: null,
  })
  assert.equal(body.employerSubsidiaryId, 'd726d187-0000-0000-0000-000000000001', 'the employer rides every submission')
  assert.equal(body.jobTitle, 'Machinist', 'existing trims are preserved')
  assert.equal(body.compensationCurrency, 'USD', 'existing casing is preserved')
  assert.ok(!Object.values(body).some((value) => value === undefined), 'no field serializes as undefined')
})

test('the draft form shows the inherited employer name and posts its id', async (t) => {
  const posts: Array<{ url: string; method: string; body: unknown }> = []
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    posts.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return Response.json({ offer: { id: 'offer-1' } })
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = prior
  })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      provider(
        <OfferCreateIsland
        applicationId="app-1"
        bases={[{ value: 'hourly', label: 'Hourly' }]}
        employer={{ value: EMPLOYER_ID, label: 'Main' }}
        employers={[{ value: EMPLOYER_ID, label: 'Main' }]}
          labels={CREATE_LABELS}
        />,
      ),
    )
    await tick()
  })
  await tick()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })

  const text = document.body.textContent ?? ''
  assert.ok(text.includes('Main'), 'the fixed text is the employer NAME')
  assert.ok(!text.includes(EMPLOYER_ID), 'the raw employer id never renders as text')
  assert.deepEqual(
    [...document.querySelectorAll('option')].map((o) => o.textContent),
    ['Hourly'],
    'no employer picker for a single authorized employer — only the basis options render',
  )

  const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[]
  assert.equal(inputs.length, 5, 'job, start, amount, currency, and expiry inputs render')
  const setInput = (el: HTMLInputElement, value: string): void => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
  await act(async () => {
    setInput(inputs[0]!, 'Machinist')
    setInput(inputs[1]!, '2026-10-01')
    setInput(inputs[2]!, '45.5000')
    setInput(inputs[3]!, 'usd')
    await tick()
  })
  const submit = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Draft offer')
  assert.ok(submit, 'the form offers its submit')
  await act(async () => {
    ;(submit as HTMLElement).click()
    await tick()
  })
  await tick()

  assert.equal(posts.length, 1, 'drafting posts exactly once')
  assert.deepEqual(posts[0], {
    url: '/api/hrm/recruiting/offers',
    method: 'POST',
    body: {
      applicationId: 'app-1',
      employerSubsidiaryId: EMPLOYER_ID,
      jobTitle: 'Machinist',
      proposedStartOn: '2026-10-01',
      compensationAmount: '45.5000',
      compensationCurrency: 'USD',
      compensationBasis: 'hourly',
      expiresOn: null,
    },
  })
})

test('the picker shows only for a genuine authorized choice containing the requisition employer', () => {
  const picked = renderToStaticMarkup(
    provider(
      <OfferCreateIsland
      applicationId="app-1"
      bases={[{ value: 'hourly', label: 'Hourly' }]}
      employer={{ value: EMPLOYER_ID, label: 'Main' }}
      employers={[
        { value: EMPLOYER_ID, label: 'Main' },
        { value: OTHER_ID, label: 'Annex' },
      ]}
        labels={CREATE_LABELS}
      />,
    ),
  )
  assert.ok(picked.includes('Annex'), 'several authorized employers render the picker with every choice')
  assert.match(
    picked,
    new RegExp(`<option value="${EMPLOYER_ID}" selected`),
    'the selection defaults to the requisition employer',
  )

  const fixed = renderToStaticMarkup(
    provider(
      <OfferCreateIsland
      applicationId="app-1"
      bases={[{ value: 'hourly', label: 'Hourly' }]}
      employer={{ value: EMPLOYER_ID, label: 'Main' }}
      employers={[{ value: OTHER_ID, label: 'Annex' }]}
        labels={CREATE_LABELS}
      />,
    ),
  )
  assert.ok(!fixed.includes('Annex'), 'a choice excluding the requisition employer renders no picker')
  assert.ok(fixed.includes('>Main</p>'), 'the inherited name still renders as fixed text')
})

test('the accept action pins the refusal instead of swallowing it', async (t) => {
  const refusal = 'this offer has no approval flow to accept through — ask an HR administrator'
  const seen: Array<{ url: string; method: string; body: unknown }> = []
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return Response.json({ error: refusal }, { status: 422 })
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = prior
  })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(provider(<OfferActionsIsland offerId="offer-1" labels={ACTION_LABELS} />))
    await tick()
  })
  await tick()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })

  const accept = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Accept and hire')
  assert.ok(accept, 'the island offers Accept')
  await act(async () => {
    ;(accept as HTMLElement).click()
    await tick()
  })
  await tick()

  assert.deepEqual(seen, [
    { url: '/api/hrm/recruiting/offers/offer-1', method: 'PATCH', body: { action: 'accept' } },
  ])
  const alert = document.querySelector('[role="alert"]')
  assert.ok(alert, 'the refusal pins as an accessible alert')
  assert.ok((alert?.textContent ?? '').includes(refusal), 'the refusal message renders intact')
})

test('the employer field label ships in every locale', () => {
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh']) {
    const catalog = JSON.parse(
      readFileSync(new URL(`../../../../messages/${locale}/hrm.json`, import.meta.url), 'utf8'),
    )
    const label = catalog.recruiting?.offerCard?.employer
    assert.ok(typeof label === 'string' && label.length > 0, `${locale}: recruiting.offerCard.employer must be translated`)
  }
})
