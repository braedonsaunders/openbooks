import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'

// These tests IMPORT the dialog and row-actions islands and render them. The
// sibling queue.test.ts pins copy and contracts by reading source as text,
// which cannot fail on a broken import path or an identifier that was typed
// but never destructured — exactly the defects the gate found in this file's
// predecessor. A render is the cheapest check that reaches them.
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
const { ProposeChangeDialog } = await import('./ProposeChangeDialog')
const { ChangeRequestRowActions } = await import('./ChangeRequestRowActions')
// tsx compiles JSX classic: the components never import React (Next provides
// the automatic runtime in production), so the test bridges it.
Object.assign(globalThis, { React })
const hrmMessages = JSON.parse(readFileSync(new URL('../../../../messages/en/hrm.json', import.meta.url), 'utf8'))
const commonMessages = JSON.parse(readFileSync(new URL('../../../../messages/en/common.json', import.meta.url), 'utf8'))

function provider(children: React.ReactNode): React.ReactNode {
  return (
    <NextIntlClientProvider locale="en" messages={{ hrm: hrmMessages, common: commonMessages }}>
      {children}
    </NextIntlClientProvider>
  )
}

test('the propose dialog renders its employment picker shell without fetching', () => {
  const html = renderToStaticMarkup(
    provider(
      <ProposeChangeDialog
        departmentOptions={[]}
        employmentLabel="Employment"
        employmentPlaceholder="Search employments…"
        emptyLabel="No employments match."
        requestFailed="Could not load"
        closeHref="/hrm/change-requests"
      />,
    ),
  )
  assert.match(html, /Employment/)
  assert.match(html, /role="dialog"/, 'the picker is exposed as a dialog')
})

test('a terminal row renders no lifecycle actions', () => {
  const html = renderToStaticMarkup(
    provider(
      <ChangeRequestRowActions
        canManage
        requestId="cr-1"
        requestStatus="approved"
        employmentId="emp-1"
        departmentOptions={[]}
      />,
    ),
  )
  assert.equal(html, '', 'an approved request shows no actions')
})

test('a draft row renders its lifecycle actions through the real module', () => {
  const html = renderToStaticMarkup(
    provider(
      <ChangeRequestRowActions
        canManage
        requestId="cr-1"
        requestStatus="draft"
        employmentId="emp-1"
        departmentOptions={[]}
      />,
    ),
  )
  assert.match(html, /button/i, 'a draft request offers actions')
})
