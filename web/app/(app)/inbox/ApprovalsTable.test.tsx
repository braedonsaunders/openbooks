import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { registerHooks } from 'node:module'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env'
import { stubModules } from '../../../testing/stub-modules'
import type { ApprovalRow } from './ApprovalsTable'

await bootJsdomEnvironment({ url: 'http://localhost:4800/inbox' })
const notices: string[] = []
Object.assign(globalThis, { __approvalNotices: notices })
stubModules({ navigation: { pathname: '/inbox' } })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sonner')
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={error(message){globalThis.__approvalNotices.push(message)},warning(message){globalThis.__approvalNotices.push(message)},success(message){globalThis.__approvalNotices.push(message)}}',
      }
    return next(specifier, context)
  },
})
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
const { ApprovalsTable } = await import('./ApprovalsTable')

function row(
  key: string,
  gateId: string | null,
  signatureRequired = false,
): ApprovalRow {
  return {
    key,
    gateId,
    documentNumber: key,
    kind: 'vendor_bill',
    kindLabel: 'Bill',
    href: null,
    party: 'Vendor',
    amount: '$10.00',
    approvalTitle: 'Release payment',
    engineName: 'Approval flow',
    requestedAt: '2026-09-29T12:00:00Z',
    assignee: 'Approver',
    canDelegate: false,
    quorumAll: false,
    signatureRequired,
  }
}

async function mount(t: TestContext, rows: ApprovalRow[]) {
  notices.length = 0
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ApprovalsTable
          rows={rows}
          users={[]}
          bulk
          showAssignee
          actionsEnabled
        />
      </NextIntlClientProvider>,
    ),
  )
  return host
}

async function click(node: HTMLElement) {
  await act(async () => {
    node.click()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}
function approve(host: HTMLElement) {
  const button = [...host.querySelectorAll('button')].find((node) =>
    /Approve selected/i.test(node.textContent ?? ''),
  )
  assert.ok(button, 'the bulk approve action must remain available')
  return button
}

test('selection and partial results operate only on flow gates in the server window', async (t) => {
  let payload: { items: { gateId: string }[] } | undefined
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body))
      return Response.json({
        results: [
          { ok: true },
          { ok: false, error: 'The submitter cannot approve this payment.' },
        ],
      })
    },
  )
  const host = await mount(t, [
    row('gate:first', '00000000-0000-4000-8000-000000000001'),
    row('doc:invoice', null),
    row('payrun:run', null),
    row('gate:second', '00000000-0000-4000-8000-000000000002'),
  ])
  const boxes = [
    ...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]'),
  ]
  assert.equal(
    boxes.length,
    3,
    'documents and pay runs cannot enter a gate-scoped bulk decision',
  )
  await click(boxes[0]!)
  await click(approve(host))
  assert.deepEqual(
    payload?.items.map((item) => item.gateId),
    [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ],
  )
  assert.ok(
    notices.some((notice) => notice.includes('submitter cannot approve')),
  )
  assert.equal(
    boxes[1]!.checked,
    false,
    'confirmed success clears its selection',
  )
  assert.equal(boxes[2]!.checked, true, 'a refused record remains selected')
})

test('signature-required gates retain individual approval and refuse bulk approval', async (t) => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return Response.json({ results: [{ ok: true }] })
  })
  const host = await mount(t, [
    row('gate:signed', '00000000-0000-4000-8000-000000000001', true),
  ])
  await click(host.querySelector<HTMLInputElement>('input[type=checkbox]')!)
  await click(approve(host))
  assert.equal(requests, 0)
  assert.ok(notices.some((notice) => /signature/i.test(notice)))
  assert.ok(
    [...host.querySelectorAll('button')].some(
      (button) => button.textContent?.trim() === 'Approve',
    ),
    'the individual action named by the remedy must exist',
  )
})

test('an unreadable error response releases busy state and retains selection', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response('<html>Unavailable</html>', {
        status: 503,
        headers: { 'content-type': 'text/html' },
      }),
  )
  const host = await mount(t, [
    row('gate:pending', '00000000-0000-4000-8000-000000000001'),
  ])
  await click(host.querySelector<HTMLInputElement>('input[type=checkbox]')!)
  await click(approve(host))
  assert.equal(approve(host).disabled, false)
  assert.equal(
    host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[1]!.checked,
    true,
  )
  assert.ok(notices.length > 0)
  assert.ok(
    notices.every(
      (notice) => !/JSON|Unexpected token|SyntaxError/.test(notice),
    ),
  )
})

test('a missing bulk receipt never reports successful approval', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ results: [] }))
  const host = await mount(t, [
    row('gate:pending', '00000000-0000-4000-8000-000000000001'),
  ])
  await click(host.querySelector<HTMLInputElement>('input[type=checkbox]')!)
  await click(approve(host))
  assert.ok(notices.length > 0)
  assert.ok(notices.every((notice) => !/^Approved/.test(notice)))
  assert.equal(
    host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[1]!.checked,
    true,
  )
})

test('every refused gate is named with its own remedy', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      results: [
        {
          ok: false,
          error: 'Choose another approver; the submitter cannot approve.',
        },
        {
          ok: false,
          error: 'Approve the signature-required gate individually.',
        },
      ],
    }),
  )
  const host = await mount(t, [
    row('BILL-101', '00000000-0000-4000-8000-000000000001'),
    row('BILL-202', '00000000-0000-4000-8000-000000000002'),
  ])
  await click(host.querySelector<HTMLInputElement>('input[type=checkbox]')!)
  await click(approve(host))
  assert.ok(
    notices.some(
      (notice) =>
        notice.includes('BILL-101: Choose another approver') &&
        notice.includes(
          'BILL-202: Approve the signature-required gate individually',
        ),
    ),
  )
  assert.ok(
    [...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].every(
      (box) => box.checked,
    ),
  )
})

test('a null receipt shows the decision refusal rather than an internal type error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(null))
  const host = await mount(t, [
    row('gate:pending', '00000000-0000-4000-8000-000000000001'),
  ])
  await click(host.querySelector<HTMLInputElement>('input[type=checkbox]')!)
  await click(approve(host))
  assert.ok(notices.includes('Decision failed'))
  assert.equal(approve(host).disabled, false)
})
