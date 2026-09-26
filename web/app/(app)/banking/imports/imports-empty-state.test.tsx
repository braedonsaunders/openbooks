import assert from 'node:assert/strict'
import test from 'node:test'

// UX-08b: with no reconcilable account /banking/imports showed a bare
// "Nothing here yet" list with no Import action and no named prerequisite.
// The empty state must name the reconcilable prerequisite and offer the
// Chart-of-Accounts setup path; once an account is configured the Import
// statement action shows as before.
const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/banking/imports', scrollIntoView: false })
const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return globalThis.__importEmptyRouter} export function useSearchParams(){return new URLSearchParams()} export function usePathname(){return "/banking/imports"} export function useParams(){return {}} export function redirect(){throw new Error("redirect")} export function notFound(){throw new Error("notFound")} export function useSelectedLayoutSegment(){return null}' })

Object.assign(globalThis, {
  __importEmptyRouter: {
    push() {},
    refresh() {},
    replace() {},
    back() {},
    prefetch() {},
  },
})
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { MoneyProvider } = await import('../../../../components/money-provider')
const { EmptyState } = await import('@openbooks/ui')
const { BANKING_WIDGETS } = await import('../../../../components/viewspec/widgets-banking')
const { BankFeedPanel } = await import('./sections')

const banking = messages.banking

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
  const feed = { name: 'Operating', provider: 'plaid', accountNumber: null, accountName: 'Operating', status: 'connected', statusConnected: true, showPaused: true, lastSyncAt: null, lastAttemptAt: null, lastError: null }
  const { host, root } = await mount(<>{picker}<BankFeedPanel title="Bank feeds" manageLabel="Manage" emptyMessage="None" lastSyncLabel="Last sync" lastAttemptLabel="Last attempt" neverLabel="Never" feeds={[feed]} /></>)
  try {
    const options = [...host.querySelectorAll('select option')].map((o) => o.textContent?.trim())
    assert.deepEqual(options, ['1000 · Operating Cash'])
    const importButton = [...host.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('Import statement'),
    )
    assert.ok(importButton, 'the canonical import dialog trigger must render once an account is configured')
    assert.ok(['Plaid', 'Connected', '(paused)'].every((label) => host.textContent?.includes(label)) && !host.textContent?.includes('plaid') && !host.textContent?.includes('connected'))
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
