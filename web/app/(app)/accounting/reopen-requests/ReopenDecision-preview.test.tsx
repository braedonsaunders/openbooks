import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { registerHooks } from 'node:module'

const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost/accounting/reopen-requests' })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') return {
      shortCircuit: true,
      url: 'data:text/javascript,export function useRouter(){return {refresh(){}}}',
    }
    return next(specifier, context)
  },
})
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const accounting = (await import('../../../../messages/en/accounting.json')).default
const { ReopenDecision } = await import('./ReopenDecision')
const preview = {
  conflicts: [], ownRequest: false, independenceRequired: true,
  selfApprovalAllowed: false, eligibleApprovers: ['Reviewer'],
  unconflictedApprovers: ['Reviewer'], conflictAcknowledgementAllowed: false,
}
const settle = () => new Promise(resolve => setTimeout(resolve, 40))
async function mount(t: TestContext, requestId = 'request-a') {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  t.after(async () => { await act(async () => root.unmount()); host.remove() })
  const render = (id: string) => act(async () => root.render(
    <NextIntlClientProvider locale="en" messages={{ accounting }}>
      <ReopenDecision requestId={id} ownRequest={false} />
    </NextIntlClientProvider>,
  ))
  await render(requestId)
  return { host, render }
}
function button(host: HTMLElement, text: string) {
  return [...host.querySelectorAll('button')].find(item => item.textContent === text)
}
test('failed conflict review keeps decisions unavailable until a successful native retry', async t => {
  const previous = globalThis.fetch
  const actions: string[] = []
  let successful = false
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { action: string }
    actions.push(body.action)
    if (body.action === 'reopen-conflicts') return successful
      ? Response.json(preview)
      : Response.json({ error: 'Conflict review is unavailable; retry when the service recovers.' }, { status: 503 })
    return Response.json({ ok: true })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = previous })
  const { host } = await mount(t)
  await act(settle)
  assert.equal(button(host, 'Approve'), undefined)
  assert.equal(button(host, 'Reject'), undefined)
  assert.match(host.textContent ?? '', /Conflict review is unavailable/)
  assert.deepEqual(actions, ['reopen-conflicts'])
  successful = true
  const retry = button(host, 'Retry review')
  assert.ok(retry)
  await act(async () => retry.click()); await act(settle)
  const approve = button(host, 'Approve')
  assert.ok(approve && !approve.disabled)
  assert.match(host.querySelector('[role="status"]')?.textContent ?? '', /Conflict review complete: no conflicting records found/)
  await act(async () => approve.click()); await act(settle)
  assert.deepEqual(actions, ['reopen-conflicts', 'reopen-conflicts', 'decide-reopen'])
})
test('malformed conflict evidence cannot become an unconflicted approval', async t => {
  const previous = globalThis.fetch
  let complete = false
  globalThis.fetch = (async () => Response.json(complete ? {
    ...preview, conflicts: [{ kind: 'journal', count: 2, examples: ['JE-1'] }],
    unconflictedApprovers: ['Other reviewer'],
  } : { conflicts: [] })) as typeof fetch
  t.after(() => { globalThis.fetch = previous })
  const { host } = await mount(t)
  await act(settle)
  assert.equal(button(host, 'Approve'), undefined)
  assert.match(host.textContent ?? '', /conflict review could not be loaded/i)
  complete = true
  const retry = button(host, 'Retry review')
  assert.ok(retry)
  await act(async () => retry.click()); await act(settle)
  assert.equal(button(host, 'Approve')?.disabled, true)
  assert.doesNotMatch(host.textContent ?? '', /no conflicting records found/)
  assert.match(host.textContent ?? '', /JE-1/)
  assert.match(host.textContent ?? '', /Other reviewer/)
})
test('a replaced request cannot use the preceding request conflict review', async t => {
  const previous = globalThis.fetch
  const pending = new Map<string, (value: Response) => void>()
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => new Promise<Response>(resolve => {
    const body = JSON.parse(String(init?.body)) as { requestId: string }
    pending.set(body.requestId, resolve)
  })) as typeof fetch
  t.after(() => { globalThis.fetch = previous })
  const { host, render } = await mount(t)
  await render('request-b')
  pending.get('request-a')!(Response.json(preview))
  await act(settle)
  assert.equal(button(host, 'Approve'), undefined)
  pending.get('request-b')!(Response.json({ ...preview, conflicts: [{ kind: 'journal', count: 1, examples: ['JE-2'] }] }))
  await act(settle)
  assert.equal(button(host, 'Approve')?.disabled, true)
  assert.match(host.textContent ?? '', /JE-2/)
})
