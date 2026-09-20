import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'

// This test IMPORTS the queue island and renders it. The sibling queue.test.ts
// pins copy and contracts by reading source as text, which cannot fail on a
// broken import path or an identifier that was typed but never destructured
// — exactly the two defects the gate found in this file. A render is the
// cheapest check that reaches them.
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sonner') {
      return { shortCircuit: true, url: 'data:text/javascript,export const toast = { success(){}, error(){} }' }
    }
    if (specifier === 'next/navigation') {
      return { shortCircuit: true, url: 'data:text/javascript,export const useRouter = () => ({ refresh(){}, push(){} })' }
    }
    return next(specifier, context)
  },
})
const { renderToStaticMarkup } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const { ChangeRequestQueue } = await import('./QueueClient')
// tsx compiles JSX classic: the component never imports React (Next provides
// the automatic runtime in production), so the test bridges it.
Object.assign(globalThis, { React })
const hrmMessages = JSON.parse(readFileSync(new URL('../../../../messages/en/hrm.json', import.meta.url), 'utf8'))
const commonMessages = JSON.parse(readFileSync(new URL('../../../../messages/en/common.json', import.meta.url), 'utf8'))

function render(overrides: Partial<React.ComponentProps<typeof ChangeRequestQueue>> = {}): string {
  const props: React.ComponentProps<typeof ChangeRequestQueue> = {
    rows: [
      {
        id: 'cr-1',
        employmentId: 'emp-1',
        employeeName: 'Fixture Employee',
        partyId: 'party-1',
        kind: 'transfer',
        effectiveFrom: '2026-10-01',
        effectiveTo: null,
        status: 'submitted',
        requesterName: 'Fixture Requester',
        submittedAt: '2026-09-20T00:00:00Z',
        createdAt: '2026-09-19T00:00:00Z',
      },
    ],
    columns: { employee: 'Employee', kind: 'Kind', effective: 'Effective', requester: 'Requester', submitted: 'Submitted' },
    canManage: false,
    departmentOptions: [],
    proposeTitle: 'Propose',
    proposeButton: 'Propose a change',
    proposeEmploymentLabel: 'Employment',
    proposeEmploymentPlaceholder: 'Pick an employment',
    proposeEmpty: 'No employments',
    proposeFailed: 'Could not load',
    draftBadge: 'Draft',
    openEmployee: 'Open employee',
    notAvailable: 'n/a',
    emptyTitle: 'No requests',
    emptyDescription: 'Nothing here',
    truncated: false,
    truncatedNote: 'Showing the first 500 requests',
    ...overrides,
  }
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{ hrm: hrmMessages, common: commonMessages }}>
      <ChangeRequestQueue {...props} />
    </NextIntlClientProvider>,
  )
}

test('the queue renders its rows through the real module', () => {
  const html = render()
  assert.match(html, /Fixture Employee/)
  assert.match(html, /Fixture Requester/)
  assert.doesNotMatch(html, /Showing the first 500 requests/, 'no truncation note while the read is complete')
})

test('a truncated read renders its note (the prop must reach the JSX)', () => {
  const html = render({ truncated: true })
  assert.match(html, /Showing the first 500 requests/)
})

test('an empty queue renders the empty state', () => {
  const html = render({ rows: [] })
  assert.match(html, /No requests/)
  assert.match(html, /Nothing here/)
})
