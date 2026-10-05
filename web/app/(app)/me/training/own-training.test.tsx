import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../../../testing/jsdom-env'
import { stubModules } from '../../../../testing/stub-modules'
import type { TrainingParticipant, TrainingSession } from '@openbooks/engine/hrm/training'

await bootJsdomEnvironment({
  url: 'http://localhost/me/training?training=10000000-0000-4000-8000-000000000001',
  event: 'jsdom',
})
Object.assign(globalThis, { __ownTrainingRouter: { push() {}, replace() {}, refresh() {}, prefetch() {} } })
stubModules({
  navigation: `export function usePathname(){return '/me/training'}export function useSearchParams(){return new URLSearchParams(window.location.search)}export function useRouter(){return globalThis.__ownTrainingRouter}`,
  intl: false,
  authz: false,
  features: false,
})
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React,
  { createRoot } = await import('react-dom/client'),
  { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { OwnTrainingDrawer } = await import('./OwnTrainingDrawer')
const id = '10000000-0000-4000-8000-000000000001'
const participant: TrainingParticipant = {
  id,
  sessionId: id,
  employmentId: id,
  subsidiaryId: id,
  status: 'invited',
  attendanceSeconds: null,
  score: null,
  evidenceFileId: null,
  notes: null,
  qualificationTypeId: null,
  qualificationId: null,
  qualificationCreated: false,
  completionHash: null,
  revision: 1,
}
const session: TrainingSession = {
  id,
  subsidiaryId: id,
  courseId: id,
  name: 'Safety session',
  location: 'Training room',
  timeZone: 'America/Toronto',
  startsAt: '2026-11-01T06:30:00Z',
  endsAt: '2026-11-01T08:00:00Z',
  startsOn: '2026-11-01',
  endsOn: '2026-11-01',
  durationSeconds: 5400,
  capacity: 5,
  revision: 2,
  status: 'scheduled',
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 40))

test('own training drawer exposes only employee actions and retains its shell and named refusal through retry', async (t) => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host),
    prior = globalThis.fetch,
    requests: { url: string; body: unknown }[] = [],
    pending: ((response: Response) => void)[] = []
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return new Promise<Response>((resolve) => pending.push(resolve))
  }) as typeof fetch
  t.after(async () => {
    await act(() => root.unmount())
    host.remove()
    globalThis.fetch = prior
  })
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        <OwnTrainingDrawer
          detail={{ participant, session, feedback: [] }}
          canRespond
          closeHref="/me/training?q=safety"
        />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  const dialog = document.querySelector('[role=dialog]')
  assert.ok(dialog)
  const buttons = [...dialog.querySelectorAll('button')].map((button) => button.textContent?.trim())
  assert.ok(buttons.includes('Accept invitation'))
  assert.ok(buttons.includes('Decline invitation'))
  for (const name of ['Cancel', 'Record result', 'Void result', 'Approve course'])
    assert.equal(buttons.includes(name), false, name)
  assert.equal(dialog.querySelector('textarea'), null, 'An employee invitation response needs no extra form ceremony')
  const accept = [...dialog.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Accept invitation',
  )!
  assert.ok(accept)
  await act(async () => {
    accept.click()
    await tick()
  })
  assert.deepEqual(requests, [
    {
      url: `/api/me/training/participants/${id}`,
      body: { expectedRevision: 1, reason: 'Accept invitation', action: 'accept' },
    },
  ])
  await act(async () => {
    pending.shift()!(
      Response.json(
        { error: 'Training revision changed — reload the record and review its current state before saving.' },
        { status: 422 },
      ),
    )
    await tick()
  })
  assert.equal(document.querySelector('[role=dialog]'), dialog)
  assert.equal(dialog.querySelector('[role=alert]')?.textContent, 'Training revision changed — reload the record and review its current state before saving.')
  assert.equal(document.body.style.overflow, 'hidden')
  await act(async () => {
    accept.click()
    await tick()
    pending.shift()!(Response.json({ ...participant, status: 'accepted', revision: 2 }))
    await tick()
  })
  assert.equal(document.querySelector('[role=dialog]'), dialog)
  assert.equal(document.querySelectorAll('[role=dialog]').length, 1)
})
