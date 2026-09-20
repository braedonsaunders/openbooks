import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

// PartyDrawer is a client component, but its exact decimal formatter is pure.
// Resolve the app's @/ alias so this focused test can exercise that production
// helper without requiring a browser or a Next.js runtime.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}`, import.meta.url).href, context)
    }
    return nextResolve(specifier, context)
  },
})

const React = await import('react')
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const { formatCreditLimit, rememberDrawerTab } = await import('./PartyDrawer.tsx')
const drawerSource = readFileSync(new URL('./PartyDrawer.tsx', import.meta.url), 'utf8')

test('credit-limit display preserves large persisted numeric values exactly', () => {
  assert.equal(formatCreditLimit('9007199254740993.0000'), '9007199254740993.00')
})

test('credit-limit display rounds fractional cents with exact decimal arithmetic', () => {
  assert.equal(formatCreditLimit('86.6150'), '86.62')
  assert.equal(formatCreditLimit(null), '')
})

// F-t08-003: switching employee drawer tabs unmounted the payroll/wage
// panels, silently discarding unsaved profile edits. Visited compensation
// tabs must stay mounted (hidden) so their local edits survive a switch.
test('remembering a visited drawer tab keeps it without mutating the set', () => {
  const kept = rememberDrawerTab(new Set(['overview']), 'payroll')
  assert.ok(kept.has('overview'))
  assert.ok(kept.has('payroll'))
})

test('remembering an already kept tab returns the same set', () => {
  const kept = new Set(['overview', 'payroll'] as const)
  assert.equal(rememberDrawerTab(kept, 'payroll'), kept)
})

test('the drawer routes tab switches through the visit-recording helper', () => {
  assert.match(drawerSource, /rememberDrawerTab\(/)
  // The rail is the shared flyout shell's, driven as a CONTROLLED tab, so the
  // party owns one strip instead of nesting its own under the shell's
  // Details / Attachments / Audit trail. Every switch still lands on showTab.
  assert.match(drawerSource, /onActiveTabChange=\{\(key\) => showTab\(fromShellTab\(key\)\)\}/)
  assert.match(drawerSource, /activeTab=\{toShellTab\(tab\)\}/)
  assert.doesNotMatch(drawerSource, /aria-label=\{t\('tabs\.ariaLabel'\)\}/)
})

test('the flyout rail is one level: attachments and audit are peers, not a parent', () => {
  // The shell appends its own Attachments / Audit trail buttons, so listing
  // them in `tabs` would duplicate them; the party supplies everything else
  // as detailTabs and renames the leading Details slot to Overview.
  assert.match(drawerSource, /detailsLabel=\{t\('tabs\.overview'\)\}/)
  assert.match(drawerSource, /detailTabs=\{tabs\n\s*\.filter\(\(item\) => item\.key !== 'overview'\)/)
  assert.doesNotMatch(drawerSource, /\{ key: 'attachments', label:/)
  assert.doesNotMatch(drawerSource, /\{ key: 'audit', label:/)
})

test('the wage and payroll panels stay mounted once visited instead of unmounting', () => {
  assert.match(drawerSource, /keptTabs\.has\('wages'\)/)
  assert.match(drawerSource, /keptTabs\.has\('payroll'\)/)
  assert.match(drawerSource, /hidden=\{tab !== 'wages'\}/)
  assert.match(drawerSource, /hidden=\{tab !== 'payroll'\}/)
  assert.doesNotMatch(drawerSource, /\{tab === 'wages' &&/)
  assert.doesNotMatch(drawerSource, /\{tab === 'payroll' &&/)
})

// F-t05-002: the Kind control offered only company|person while parties store
// customer/vendor/employee kinds, so the control misread the record and the
// PATCH it echoed back 422'd. The control must offer the stored vocabulary,
// the view label must render it, and a refused save must pin its reason on
// the record (staying in edit mode) instead of reporting success.
// Fleet-8 m1: the pin moved onto the shared action path (useAppAction +
// ActionAlert) — the hand-rolled saveError state is gone, but the contract
// is unchanged: refusal pins until the next action or cancel, and the render
// test in party-drawer.test.tsx proves it behaviourally.
test('the kind control covers the stored vocabulary and save refusals stay visible', () => {
  for (const kind of ['company', 'person', 'customer', 'vendor', 'employee']) {
    assert.match(drawerSource, new RegExp(`<option value="${kind}">`))
  }
  assert.doesNotMatch(drawerSource, /kind === 'person' \? t\('kindPerson'\) : t\('kindCompany'\)/)
  assert.match(drawerSource, /const \{ busy, refusal, execute, clearRefusal, refuse \} = useAppAction\(\)/)
  assert.match(drawerSource, /<ActionAlert error=\{refusal\}/)
  assert.match(drawerSource, /clearRefusal\(\)/)
  assert.doesNotMatch(drawerSource, /setSaveError/)
})

// F-t02-015: the blank-name guard and the statement link rendered raw
// `parties.drawer.drawer.*` keys in every locale, because the drawer called
// t('drawer.nameRequired') / t('drawer.viewStatement') under the
// parties.drawer namespace instead of the bare keys that exist in all 7
// catalogs. Every static t('…') key in this file must resolve through the
// real locale indexes — a locale-file grep cannot catch a wrong nesting.
test('every static drawer key resolves in all locales (no doubled namespace)', async () => {
  const { createTranslator } = await import('next-intl')
  const keys = new Set<string>()
  for (const match of drawerSource.matchAll(/(?<![A-Za-z])t\('([^']+)'\)/g)) keys.add(match[1]!)
  assert.ok(keys.size > 0, 'expected static translation keys in the drawer')
  assert.ok(
    ![...keys].some((key) => key.startsWith('drawer.')),
    `drawer-namespace keys must not re-prefix 'drawer.': ${[...keys].filter((key) => key.startsWith('drawer.')).join(', ')}`,
  )
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh'] as const) {
    const messages = (await import(`../../../messages/${locale}/index.ts`)).default as Record<string, unknown>
    const t = createTranslator({ locale, namespace: 'parties.drawer', messages: messages as never } as never) as unknown as (
      lookup: string,
    ) => string
    for (const key of keys) {
      // A miss renders the full key path (parties.drawer.<key>), never throws.
      const missPaths = new Set([key, `parties.drawer.${key}`])
      let rendered: string | undefined
      try {
        rendered = t(key)
      } catch {
        assert.fail(`drawer key ${JSON.stringify(key)} misses in the ${locale} catalog`)
      }
      assert.ok(
        typeof rendered === 'string' && rendered.length > 0 && !missPaths.has(rendered),
        `drawer key ${JSON.stringify(key)} must render translated text in ${locale}, got ${JSON.stringify(rendered)}`,
      )
    }
  }
})

// HR-1 defect 2: the Payroll tab honours the drawer edit mode exactly like
// Overview (editable = mode === 'edit' && canManage). Read mode renders
// values; only edit mode renders the editors.
test('the payroll tab passes the overview edit gate to every section', () => {
  assert.match(drawerSource, /const editable = mode === 'edit' && canManage/)
  assert.match(drawerSource, /<PayrollProfileTab[\s\S]*?readOnly=\{!editable\}/)
  assert.match(drawerSource, /<EmployeeEntitlementBalances partyId=\{String\(p\.id\)\} readOnly=\{!editable\} \/>/)
  assert.match(drawerSource, /<BankAccountsPanel[\s\S]*?readOnly=\{!editable\}/)
})

// The Payroll tab splits into sub-tabs on the shared drawer strip — the same
// primitive as the rail, not a second tab style — with every section staying
// mounted (hidden) so unsaved edits survive sub-tab switches.
test('the payroll tab splits into four sub-tabs on the shared strip', () => {
  assert.match(drawerSource, /import \{ DrawerTabStrip \} from '\.\.\/\.\.\/\.\.\/components\/drawer-tab-strip'/)
  for (const key of ['general', 'tax', 'banks', 'accounts']) {
    assert.match(drawerSource, new RegExp(`\\{ key: '${key}', label: t\\('payrollTabs\\.${key}'\\) \\}`))
  }
  assert.match(drawerSource, /ariaLabel=\{t\('payrollTabs\.ariaLabel'\)\}/)
  assert.match(drawerSource, /const \[payrollSubTab, setPayrollSubTab\] = useState<PayrollSubTab>\('general'\)/)
  assert.match(drawerSource, /<div hidden=\{payrollSubTab !== 'banks'\}>/)
  assert.match(drawerSource, /<div hidden=\{payrollSubTab !== 'accounts'\}>/)
})

// Pay banks are values on a ledger: the movement search box is an edit-mode
// affordance, so read mode renders the table without it.
test('the entitlement balances hide their search input in read mode', () => {
  const balancesSource = readFileSync(new URL('./EmployeeEntitlementBalances.tsx', import.meta.url), 'utf8')
  assert.match(balancesSource, /searchable=\{!readOnly\}/)
})

// One editor instance serves General and Tax: PayrollProfileTab keeps the
// single ProfileEditor mounted and switches its half by prop, so typed values
// survive the switch; the certificate drafts stay mounted the same way.
test('one profile editor serves both halves without unmounting', () => {
  const payrollSource = readFileSync(new URL('../payroll/_ui/PayrollProfileTab.tsx', import.meta.url), 'utf8')
  assert.equal(payrollSource.match(/<ProfileEditor/g)?.length, 1)
  assert.match(payrollSource, /const editorSection = section === 'tax' \? 'tax' : 'general'/)
  assert.match(payrollSource, /section=\{editorSection\}/)
  assert.match(payrollSource, /<div hidden=\{section === 'banks' \|\| section === 'accounts'\}>/)
  assert.match(payrollSource, /<div hidden=\{section !== 'tax'\}>/)
  assert.match(payrollSource, /<PackCertificateForms partyId=\{partyId\} country=\{profile\.country\} readOnly=\{readOnly\} \/>/)
})

// Read mode is values only: the bank panel hides its add/search/edit/retire
// and approval/flow actions behind the edit gate, while history (which reads)
// stays. The accounting-tab usage is untouched: readOnly defaults to false.
test('the bank panel hides mutations in read mode but keeps history', () => {
  assert.match(drawerSource, /const canEditAccounts = canManage && !readOnly/)
  assert.match(drawerSource, /\{canEditAccounts \? <Button variant="outline" size="sm" onClick=\{\(\) => setDraft\(emptyBankDraft\(\)\)\}>/)
  assert.match(drawerSource, /\{!readOnly \? \(\n          <div className="relative max-w-sm">/)
  assert.match(drawerSource, /\{canEditAccounts \? <FlowManualButtons/)
  assert.match(drawerSource, /\{canEditAccounts \? \(\n                      <ApprovalActions/)
  assert.match(drawerSource, /\{canEditAccounts && !account\.retired_at \? <Button variant="ghost" size="sm" onClick=\{\(\) => edit\(account\)\}>/)
  assert.match(drawerSource, /\{canEditAccounts && !account\.retired_at \? <Button variant="ghost" size="sm" onClick=\{\(\) => retire\(account\)\}>/)
  // History is a read, not a mutation: it stays in both modes.
  assert.match(drawerSource, /onClick=\{\(\) => setHistoryAccount\(account\)\}>/)
  assert.match(drawerSource, /\{tab === 'accounting' && \(!role \|\| role === 'vendor'\) \? \(\n          <BankAccountsPanel partyId=\{String\(p\.id\)\} initialAccounts=\{payload\.bankAccounts\} canManage=\{canManage\} multiCurrency=\{multiCurrency\} \/>\n        \) : null\}/)
})
