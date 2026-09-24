import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

// The feedback page rendered its settings form bare: no scroll container, no
// page padding, no header. Its siblings (access, users, tenants, email log)
// render inside the shared operator shell — PageContainer (the scroll
// container) plus a PageHeader with a back link — so the form must mount
// inside that same shell, not beside it. These assertions are semantic
// (heading, navigation, form copy), never class names.
const ACTION_STUB = `
  export async function saveFeedbackSettingsAction() { return { ok: false, message: 'stubbed' } }
  export async function clearFeedbackTokenAction() { return { ok: false, message: 'stubbed' } }
`

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './actions') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,' + encodeURIComponent(ACTION_STUB) }
    }
    return nextResolve(specifier, context)
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { renderToString } = await import('react-dom/server')
const { PlatformFeedbackClient } = await import('./PlatformFeedbackClient.tsx')
hooks.deregister()

function htmlFor(settings: {
  enabled: boolean
  owner: string
  repo: string
  labels: string
  searchDuplicates: boolean
  hasToken: boolean
  ready: boolean
}): string {
  return renderToString(React.createElement(PlatformFeedbackClient, { settings }))
}

const BASE = {
  enabled: false,
  owner: '',
  repo: '',
  labels: '',
  searchDuplicates: true,
  hasToken: false,
  ready: false,
}

test('feedback mounts inside the shared shell: titled header with a back link', () => {
  const html = htmlFor(BASE)
  assert.match(html, /Issue reporting/, 'the shared header names the page the way the nav does')
  assert.match(html, /Back to platform/, 'the shared header links back to the platform hub')
  assert.match(html, /href="\/platform"/, 'the back link returns to the platform hub')
})

test('feedback settings form renders inside that shell', () => {
  const html = htmlFor(BASE)
  assert.match(
    html,
    /One destination for the whole deployment/,
    'the destination form must mount inside the shell, not replace it',
  )
  // The shell wraps the content: header and back link precede the form, so
  // the form inherits the shell's page margins instead of running
  // edge-to-edge beside it.
  assert.ok(
    html.indexOf('Back to platform') < html.indexOf('One destination for the whole deployment'),
    'the shell header must wrap the form, not sit beside it',
  )
})

test('the stored-token card follows the token state', () => {
  assert.doesNotMatch(htmlFor(BASE), /Stored access token/, 'no token card without a stored token')
  assert.match(
    htmlFor({ ...BASE, hasToken: true }),
    /Stored access token/,
    'the removal control appears once a token exists',
  )
})
