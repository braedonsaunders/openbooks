import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bootJsdomEnvironment } from '../testing/jsdom-env'
import { stubModules } from '../testing/stub-modules'
import type { DocumentDrawerPickersScope } from './document-drawer-pickers'
import type { LineRow } from './document-drawer-types'
import type { PartyLineDefault, RecentPartyDocument } from './document-drawer-entry'

await bootJsdomEnvironment({ url: 'http://localhost:4800/ap/bills', matchMediaMatches: true })
stubModules({ navigation: { pathname: '/ap/bills' } })
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
const { useDocumentDrawerEntry } = await import('./document-drawer-entry')
const { EntryPreferencesProvider } = await import('../lib/entry-preferences-context')
const { DEFAULT_ENTRY_PREFERENCES } = await import('../lib/entry-preferences')
const { emptyLine } = await import('./document-drawer-lines')
const { stashEntryCarry } = await import('../lib/entry-carry')
const tick = () => new Promise((resolve) => setTimeout(resolve, 35))
const accounts = [{ id: 'rent' }, { id: 'utilities' }]
const taxProfiles = [{ value: 'code:taxA' }, { value: 'code:taxB' }]
const items = [{ id: 'item' }]
const parties = [{ id: 'A' }, { id: 'B' }]
const config = { kind: 'vendor_bill', lineDefaults: 'expense', hasTax: true }
const defaultLine: PartyLineDefault = { accountId: 'rent', accountSource: 'party_default', taxCodeId: 'taxA', taxSource: 'party' }
const recent: RecentPartyDocument = { id: 'bill', documentNumber: 'BILL-1', documentDate: '2026-10-01', referenceNumber: null,
  memo: null, total: '300.0000', currency: 'USD', lines: [
    { accountId: 'rent', itemId: null, description: 'Rent', quantity: null, unitPrice: null, amount: '200.0000',
      departmentId: null, projectId: null, locationId: null, classId: null, taxCodeId: 'taxA' },
    { accountId: 'utilities', itemId: 'item', description: 'Power', quantity: '1', unitPrice: '100.0000', amount: '100.0000',
      departmentId: null, projectId: null, locationId: null, classId: null, taxCodeId: 'taxB' },
  ] }
const latest: { rows: LineRow[]; recallAvailable: boolean } = { rows: [], recallAvailable: false }

async function mount(t: TestContext, options: { recall?: boolean; currency?: string } = {}) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const party = new URL(String(input), 'http://localhost').searchParams.get('partyId')
    return Response.json({ party: { line: party === 'B' ? { ...defaultLine, accountId: null, taxCodeId: null } : defaultLine,
      recent: options.recall ? { ...recent, currency: options.currency ?? 'USD' } : null } })
  }
  function Harness({ partyId }: { partyId: string }) {
    const [rows, setRows] = React.useState<LineRow[]>(() => [emptyLine()])
    const [memo, setMemo] = React.useState('')
    const [party, setParty] = React.useState(partyId)
    React.useEffect(() => setParty(partyId), [partyId])
    const result = useDocumentDrawerEntry({ config, isCreate: true, editable: true, partyId: party, changeParty: setParty,
      rows, setRows, accounts, taxProfiles, referenceNumber: '', memo, setMemo, documentDate: '2026-10-01', setDocumentDate() {},
      doc: { currency: 'USD' }, effectiveTotals: { total: '0' }, items, parties } as unknown as DocumentDrawerPickersScope)
    latest.rows = rows
    latest.recallAvailable = result.recallAvailable
    return null
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const render = async (partyId: string) => {
    await act(async () => { root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <EntryPreferencesProvider initial={{ ...DEFAULT_ENTRY_PREFERENCES, recallLastDocument: options.recall ? 'apply' : 'off' }}>
          <Harness partyId={partyId} />
        </EntryPreferencesProvider>
      </NextIntlClientProvider>,
    ); await tick() })
    await act(async () => { await tick() })
  }
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; window.sessionStorage.clear() })
  await render('A')
  return render
}

test('automatic recall preserves each account, item and tax code from the source document', async (t) => {
  await mount(t, { recall: true })
  assert.deepEqual(latest.rows.map((row) => [row.accountId, row.itemId, row.taxProfileId]),
    [['rent', '', 'code:taxA'], ['utilities', 'item', 'code:taxB']])
})

test('switching to a vendor with no defaults releases the prior vendor defaults', async (t) => {
  const render = await mount(t)
  assert.equal(latest.rows[0]!.accountId, 'rent')
  await render('B')
  assert.equal(latest.rows[0]!.accountId, '')
  assert.equal(latest.rows[0]!.taxProfileId, '')
})

test('recall never reinterprets a source amount in another currency', async (t) => {
  await mount(t, { recall: true, currency: 'EUR' })
  assert.equal(latest.rows[0]!.amount, '')
  assert.equal(latest.recallAvailable, false)
})

test('a party carried by Save and new offers recall without automatically duplicating the saved bill', async (t) => {
  stashEntryCarry('vendor_bill', { documentDate: '2026-10-01', partyId: 'A' })
  await mount(t, { recall: true })
  assert.equal(latest.rows[0]!.amount, '')
  assert.equal(latest.recallAvailable, true)
})
