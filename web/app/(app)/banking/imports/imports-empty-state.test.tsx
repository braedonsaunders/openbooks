import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// UX-08b: with no reconcilable account /banking/imports showed a bare
// "Nothing here yet" list with no Import action and no named prerequisite.
// The empty state must name the reconcilable prerequisite and offer the
// Chart-of-Accounts setup path; once an account is configured the Import
// statement action shows as before.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/banking/imports',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({
    matches: true,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}
if (typeof (globalThis as Record<string, unknown>).ResizeObserver !== 'function') {
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

Object.assign(globalThis, {
  __importEmptyRouter: {
    push() {},
    refresh() {},
    replace() {},
    back() {},
    prefetch() {},
  },
})
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,export default {}' }
    }
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return globalThis.__importEmptyRouter} export function useSearchParams(){return new URLSearchParams()} export function usePathname(){return "/banking/imports"} export function useParams(){return {}} export function redirect(){throw new Error("redirect")} export function notFound(){throw new Error("notFound")} export function useSelectedLayoutSegment(){return null}',
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
const messages = (await import('../../../../messages/en')).default
const { MoneyProvider } = await import('../../../../components/money-provider')
const { EmptyState } = await import('@openbooks/ui')
const { BANKING_WIDGETS } = await import('../../../../components/viewspec/widgets-banking')

// The actual loader-resolved copy, read from the real catalog — the test
// fails if the guidance ever stops naming the prerequisite or the path.
const banking = JSON.parse(
  readFileSync(new URL('../../../../messages/en/banking.json', import.meta.url), 'utf8'),
) as {
  imports: {
    noAccountsTitle: string
    noAccountsDescription: string
    noAccountsLink: string
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mount(node: React.ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">{node}</MoneyProvider>
      </NextIntlClientProvider>,
    )
  })
  await tick()
  return { host, root }
}

test('the zero-account empty state names the prerequisite and links to setup', async () => {
  const setupAction = BANKING_WIDGETS['open-chart-of-accounts']({
    href: '/accounts',
    label: banking.imports.noAccountsLink,
  })
  const { host, root } = await mount(
    <EmptyState
      title={banking.imports.noAccountsTitle}
      description={banking.imports.noAccountsDescription}
      action={setupAction}
    />,
  )
  try {
    const text = host.textContent ?? ''
    assert.ok(
      text.includes(banking.imports.noAccountsTitle),
      'the empty title must name the missing reconcilable accounts',
    )
    assert.ok(
      text.includes('reconcilable'),
      'the empty description must say the account has to be marked reconcilable',
    )
    assert.ok(
      text.includes('Chart of Accounts'),
      'the empty description must name the Chart of Accounts as the setup location',
    )
    const setupLink = [...host.querySelectorAll('a')].find(
      (a) => (a.textContent ?? '').trim() === banking.imports.noAccountsLink,
    )
    assert.ok(setupLink, 'the setup action must render as a link with the setup label')
    assert.equal(
      setupLink.getAttribute('href'),
      '/accounts',
      'the setup action must go to the Chart of Accounts, never a second path',
    )
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

test('the configured state still offers the import picker beside the import action', async () => {
  // The same registry entry the spec resolves for the header CTA and the
  // empty-state action: an account select beside the canonical per-account
  // import dialog.
  const picker = BANKING_WIDGETS['import-statement-picker']({
    accounts: [{ id: 'acc-1', label: '1000 · Operating Cash' }],
    selectLabel: 'Account',
    placeholder: 'Select an account…',
  })
  const { host, root } = await mount(<>{picker}</>)
  try {
    const options = [...host.querySelectorAll('select option')].map((o) => o.textContent?.trim())
    assert.deepEqual(options, ['1000 · Operating Cash'])
    const importButton = [...host.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('Import statement'),
    )
    assert.ok(importButton, 'the canonical import dialog trigger must render once an account is configured')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
