import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env'
import { stubModules } from '../../../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost:4800/parties', matchMediaMatches: false })

Object.assign(globalThis, {
  __rateBookAssignmentRouter: {},
})

stubModules({
  navigation: {
    source:
      'export function usePathname(){return "/parties"};' +
      'export function useSearchParams(){return new URLSearchParams()}',
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    'next/link': 'export default function Link(p){return p.children}',
    sonner: 'export const toast={success(){},error(){}}',
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
const { RateBookAssignmentSection } = await import('./RateBookAssignmentSection')

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
const assignment = (name: string) => ({
  id: name,
  rate_book_id: `${name}-id`,
  rate_book_name: name,
  currency: 'USD',
  effective_from: null,
  effective_to: null,
  date_basis: 'usage_date',
  is_active: true,
  rate_version_id: null,
})
const response = (name: string) => new Response(JSON.stringify({
  rateBooks: [],
  assignments: [assignment(name)],
  total: 1,
  page: 1,
  perPage: 5,
  canManage: false,
  canOpenPricing: false,
}), { status: 200, headers: { 'content-type': 'application/json' } })

test('a late assignment-list response cannot replace data for the newly selected party', async (t) => {
  const pending: { url: string; resolve: (value: Response) => void }[] = []
  const priorFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL) => new Promise<Response>((resolve) => {
    pending.push({ url: String(input), resolve })
  })) as typeof fetch

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  let scopeId = 'party-a'
  const render = () => <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
    <RateBookAssignmentSection scope="customer" scopeId={scopeId} />
  </NextIntlClientProvider>
  t.after(async () => {
    globalThis.fetch = priorFetch
    await act(async () => root.unmount())
    host.remove()
  })

  await act(async () => {
    root.render(render())
  })
  await tick()
  assert.equal(pending.length, 1)
  assert.match(pending[0]!.url, /customerId=party-a/)

  scopeId = 'party-b'
  await act(async () => {
    root.render(render())
  })
  await tick()
  assert.equal(pending.length, 2)
  assert.match(pending[1]!.url, /customerId=party-b/)

  await act(async () => {
    pending[1]!.resolve(response('Party B rate book'))
    await tick()
  })
  assert.match(host.textContent ?? '', /Party B rate book/)

  await act(async () => {
    pending[0]!.resolve(response('Party A rate book'))
    await tick()
  })
  assert.match(host.textContent ?? '', /Party B rate book/)
  assert.doesNotMatch(host.textContent ?? '', /Party A rate book/)
})
