import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { ComponentProps } from 'react'
import { readFile } from 'node:fs/promises'

const { bootJsdomEnvironment } = await import('../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost/timesheets', matchMediaMatches: false })
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = Object.fromEntries(await Promise.all(['common', 'ui', 'timesheets'].map(async name =>
  [name, JSON.parse(await readFile(new URL(`../../../messages/en/${name}.json`, import.meta.url), 'utf8'))],
)))
const { AdditionalTimeReview } = await import('./AdditionalTimeReview')
type Props = ComponentProps<typeof AdditionalTimeReview>
const pickers: Props['pickers'] = {
  employees: [], projects: [{ value: 'project', label: 'Service project' }], internalProjectIds: [],
  items: [{ value: 'labor', label: 'Service labor' }], timeTypes: [], departments: [],
}
const revision = '2026-04-12T10:00:00.000000Z'
const rows: Props['entries'] = [
  { id: 'reviewed', updatedAt: revision, workedOn: '2026-04-06', hours: '1.5000', status: 'draft',
    projectId: 'project', itemId: 'labor', fieldTicketId: 'ticket1', fieldTicketNumber: 'FT-101', fieldTicketStatus: 'approved' },
  { id: 'unreviewed', updatedAt: revision, workedOn: '2026-04-07', hours: '2.0000', status: 'draft',
    projectId: 'project', itemId: 'labor', fieldTicketId: 'ticket2', fieldTicketNumber: 'FT-102', fieldTicketStatus: 'draft' },
]

async function mount(t: TestContext) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const submitted: { selections: Parameters<Props['onSubmit']>[0]; reason: string }[] = []
  let props: Props = { entries: rows, pickers, busy: false, refusal: null, onBack() {},
    async onSubmit(selections, reason) { submitted.push({ selections, reason }) } }
  t.after(async () => { await act(async () => root.unmount()); host.remove() })
  const render = async (change: Partial<Props> = {}) => {
    props = { ...props, ...change }
    await act(async () => root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <AdditionalTimeReview {...props} />
    </NextIntlClientProvider>))
  }
  await render()
  return { host, submitted, render }
}

function submitButton(host: HTMLElement) {
  const button = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Submit'))
  assert.ok(Boolean(button), 'the selective submission action is present')
  return button!
}
async function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!
  await act(async () => { setter.call(input, value); input.dispatchEvent(new window.Event('input', { bubbles: true })) })
}

test('search selection submits reviewed source time and leaves unrelated draft sources unselected', async t => {
  const f = await mount(t)
  assert.equal(submitButton(f.host).disabled, true, 'nothing is selected by default')
  await setValue(f.host.querySelector<HTMLInputElement>('input[aria-label="Search"]')!, 'Approved')
  const boxes = f.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  assert.equal(boxes.length, 2, 'the filtered source has one row and its select-all control')
  await act(async () => boxes[0]!.click())
  await setValue(f.host.querySelector('textarea')!, 'Submit the independently reviewed service time')
  await act(async () => submitButton(f.host).click())
  assert.deepEqual(f.submitted, [{ selections: [{ id: 'reviewed', updatedAt: revision }],
    reason: 'Submit the independently reviewed service time' }])
})

test('a refreshed entry must be reviewed again while a refused submission retains the reason and choice', async t => {
  const f = await mount(t)
  await act(async () => f.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.click())
  await setValue(f.host.querySelector('textarea')!, 'Reviewed after the service ticket approval')
  await f.render({ refusal: { message: 'The approval workflow could not start.', remedy: 'Correct its approver configuration.' } })
  assert.equal(f.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.checked, true)
  assert.equal(f.host.querySelector('textarea')!.value, 'Reviewed after the service ticket approval')
  assert.match(f.host.querySelector('[role="alert"]')?.textContent ?? '', /approver configuration/)
  const newer = '2026-04-12T11:00:00.000000Z'
  await f.render({ entries: rows.map(row => row.id === 'reviewed' ? { ...row, updatedAt: newer, hours: '2.5000' } : row) })
  assert.equal(submitButton(f.host).disabled, true, 'a changed revision is not silently selected')
  await act(async () => f.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.click())
  await f.render({ busy: true })
  assert.equal(submitButton(f.host).disabled, true)
  assert.equal(f.host.querySelector('textarea')!.disabled, true)
  await f.render({ busy: false, refusal: null })
  await act(async () => submitButton(f.host).click())
  assert.deepEqual(f.submitted[0]?.selections, [{ id: 'reviewed', updatedAt: newer }])
})
