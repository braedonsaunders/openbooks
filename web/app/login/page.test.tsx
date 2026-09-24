import assert from 'node:assert/strict'
import test from 'node:test'
import { safeNextPath } from '../../lib/login-return-path'

test('safeNextPath preserves same-origin relative destinations', () => {
  assert.equal(safeNextPath('/reports?view=profit-and-loss#totals'), '/reports?view=profit-and-loss#totals')
  assert.equal(safeNextPath('/'), '/')
})

test('safeNextPath fails closed for unsafe, malformed, empty, and oversized values', () => {
  for (const value of [
    'https://evil.example/phishing',
    '//evil.example/phishing',
    '/\\evil.example/phishing',
    '/\\[malformed',
    'not a URL',
    '',
    null,
    'x'.repeat(2049),
  ]) {
    assert.equal(safeNextPath(value), '/', `expected fallback for ${JSON.stringify(value)}`)
  }
})

// Password, MFA, and OIDC navigation must all share the validated
// destination: the page defers to safeNextPath instead of a local helper,
// so an evil ?next= can never become a navigation target or a start-link
// href. Proved through the real Login page with scripted search params,
// fetch, and router — the pushed hrefs must equal the shared validator's
// own verdicts (literals asserted first, validator agreement second, so a
// shadow helper with divergent semantics fails here).
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/login',
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
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {}
}
if (typeof window.requestAnimationFrame !== 'function') {
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = ((_id: number) => setTimeout(() => {}, 0)) as unknown as typeof window.cancelAnimationFrame
}

const loginScript = {
  params: new URLSearchParams(),
  pushes: [] as string[],
  loginResponses: [] as Response[],
  methodsResponse: {} as unknown,
}
Object.assign(globalThis, { __loginScript: loginScript })

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){const s=globalThis.__loginScript;return {push(h){s.pushes.push(h)},replace(){},refresh(){}}}export function usePathname(){return '/login'}export function useSearchParams(){return globalThis.__loginScript.params}",
      }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return p.children}',
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
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../messages/en')).default
const Login = (await import('./page.tsx')).default

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

async function mount(query: string, loginResponses: Response[], methodsResponse: unknown = {}): Promise<() => Promise<void>> {
  loginScript.params = new URLSearchParams(query)
  loginScript.pushes = []
  loginScript.loginResponses = [...loginResponses]
  loginScript.methodsResponse = methodsResponse
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url === '/api/auth/methods') return Response.json(loginScript.methodsResponse)
    if (url === '/api/login') {
      const next = loginScript.loginResponses.shift()
      assert.ok(next, 'the form posted more logins than scripted')
      return next
    }
    throw new Error(`unexpected fetch to ${url}`)
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <Login />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  await tick(60)
  return async () => {
    globalThis.fetch = prior
    await act(async () => {
      root.unmount()
    })
    host.remove()
    for (const node of [...document.body.children]) node.remove()
  }
}

async function typeEmailPassword(email: string, password: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    const emailInput = document.querySelector('input[type="email"]') as HTMLInputElement | null
    const passwordInput = document.querySelector('input[type="password"]#password, input#password') as HTMLInputElement | null
    assert.ok(emailInput && passwordInput, 'the sign-in form offers email and password fields')
    setter?.call(emailInput, email)
    emailInput.dispatchEvent(new window.Event('input', { bubbles: true }))
    setter?.call(passwordInput, password)
    passwordInput.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
  })
}

async function submit(): Promise<void> {
  const button = document.querySelector('button[type="submit"]') as HTMLButtonElement | null
  assert.ok(button, 'the form offers a submit button')
  await act(async () => {
    button.click()
    await tick(60)
  })
  await tick(60)
}

test('a password sign-in navigates to the validated destination', async () => {
  const rawNext = '/reports?view=profit-and-loss'
  const cleanup = await mount(`next=${encodeURIComponent(rawNext)}`, [Response.json({ ok: true })])
  try {
    await typeEmailPassword('operator@example.com', 'correct horse battery staple')
    await submit()
    assert.deepEqual(loginScript.pushes, ['/reports?view=profit-and-loss'], 'a safe destination is preserved')
    assert.equal(loginScript.pushes[0], safeNextPath(rawNext), 'navigation matches the shared validator')
  } finally {
    await cleanup()
  }
})

test('an evil next never becomes a navigation target after sign-in', async () => {
  for (const evil of ['https://evil.example/phishing', '//evil.example/phishing', '/\\evil.example/phishing']) {
    const cleanup = await mount(`next=${encodeURIComponent(evil)}`, [Response.json({ ok: true })])
    try {
      await typeEmailPassword('operator@example.com', 'correct horse battery staple')
      await submit()
      assert.deepEqual(loginScript.pushes, ['/'], `evil destination falls back to / (saw ${evil})`)
      assert.equal(loginScript.pushes[0], safeNextPath(evil), 'the fallback matches the shared validator')
    } finally {
      await cleanup()
    }
  }
})

test('an MFA sign-in navigates to the validated destination', async () => {
  const rawNext = '/hrm/my-leave'
  const cleanup = await mount(`next=${encodeURIComponent(rawNext)}`, [
    new Response(JSON.stringify({ mfa: true }), { status: 202 }),
    Response.json({ ok: true }),
  ])
  try {
    await typeEmailPassword('operator@example.com', 'correct horse battery staple')
    await submit()
    const mfaInput = document.querySelector('input#mfa-code') as HTMLInputElement | null
    assert.ok(mfaInput, 'a 202 challenge swaps the form to the MFA code field')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(mfaInput, '123456')
      mfaInput.dispatchEvent(new window.Event('input', { bubbles: true }))
      await tick()
    })
    await submit()
    assert.deepEqual(loginScript.pushes, [rawNext], 'MFA completion navigates to the validated destination')
    assert.equal(loginScript.pushes[0], safeNextPath(rawNext), 'MFA navigation matches the shared validator')
  } finally {
    await cleanup()
  }
})

test('the OIDC start link carries the validated destination', async () => {
  const goodNext = '/reports?view=profit-and-loss'
  const goodCleanup = await mount(`next=${encodeURIComponent(goodNext)}`, [], { oidc: true, oidcLabel: 'Test SSO' })
  try {
    const link = document.querySelector('a[href^="/api/auth/oidc/start"]') as HTMLAnchorElement | null
    assert.ok(link, 'an enabled OIDC method renders a start link')
    assert.equal(
      link.getAttribute('href'),
      `/api/auth/oidc/start?next=${encodeURIComponent(goodNext)}`,
      'a safe destination is preserved through the start link',
    )
  } finally {
    await goodCleanup()
  }
  const evil = 'https://evil.example/phishing'
  const evilCleanup = await mount(`next=${encodeURIComponent(evil)}`, [], { oidc: true, oidcLabel: 'Test SSO' })
  try {
    const link = document.querySelector('a[href^="/api/auth/oidc/start"]') as HTMLAnchorElement | null
    assert.ok(link, 'an enabled OIDC method renders a start link')
    assert.equal(link.getAttribute('href'), '/api/auth/oidc/start?next=%2F', 'an evil destination is neutralized in the start link')
    assert.equal(
      link.getAttribute('href'),
      `/api/auth/oidc/start?next=${encodeURIComponent(safeNextPath(evil))}`,
      'the start link matches the shared validator',
    )
  } finally {
    await evilCleanup()
  }
})
