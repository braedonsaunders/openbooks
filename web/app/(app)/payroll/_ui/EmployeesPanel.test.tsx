import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./EmployeesPanel.tsx', import.meta.url), 'utf8')
// Comments explain history; only code can branch.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/.*$/gm, '$1')

// Country packs DECLARE; the generic layer branches on NOTHING. A third pack
// must be expressible through the served declarations with no edit here, so no
// existing country's literal may remain in code — not in a union, a list, a
// branch, or a label key.
test('profile editor names no country in code', () => {
  assert.doesNotMatch(code, /['"]CA['"]/)
  assert.doesNotMatch(code, /['"]US['"]/)
  assert.doesNotMatch(code, /\bPROVINCES\b/)
  assert.doesNotMatch(code, /\bUS_STATES\b/)
  assert.doesNotMatch(code, /\bFILING_STATUSES\b/)
  assert.doesNotMatch(code, /country\s*===?\s*['"][A-Z]/)
  assert.doesNotMatch(code, /fields\.province\b/)
  assert.doesNotMatch(code, /fields\.state\b/)
  assert.doesNotMatch(code, /fields\.fitExempt\b/)
  assert.doesNotMatch(code, /country\.CA\b/)
  assert.doesNotMatch(code, /country\.US\b/)
})

// The renderer binds declared columns through its binding maps. A pack that
// declares a column nobody binds would render nothing and save null —
// silently dropping the operator's answer — so the binding set must cover
// every column every pack declares, and the build (this test) refuses the gap.
test('profile editor binds every column the packs declare', async () => {
  const { PAYROLL_COUNTRY_PACKS } = await import('@openbooks/engine/src/payroll/packs.ts')
  const { packCertificates } = await import('@openbooks/engine/src/payroll/certificates.ts')
  const columns = new Set<string>()
  for (const country of Object.keys(PAYROLL_COUNTRY_PACKS)) {
    const pack = PAYROLL_COUNTRY_PACKS[country]!
    for (const certificate of packCertificates(country).certificates) {
      if (certificate.storage !== 'profile_columns') continue
      for (const field of certificate.fields) {
        if (field.storage?.kind === 'column') columns.add(field.storage.column)
      }
    }
    for (const flag of pack.profileExemptionFlags ?? []) columns.add(flag.column)
  }
  assert.ok(columns.size > 0, 'expected the packs to declare profile columns')
  for (const column of [...columns].sort()) {
    // Binding-map key syntax (`federal_claim_code: [...]`), not a passing
    // mention in a comment — comments were stripped above.
    assert.match(code, new RegExp(`(^|[^\\w])${column}\\s*:`), `no editor binding for declared column ${column}`)
  }
})

// Exercise the real editor against a country that does not exist: subdivisions,
// bands, forms and flags must all come from the served declaration.
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sonner') {
      return { shortCircuit: true, url: 'data:text/javascript,export const toast = { success(){}, error(){} }' }
    }
    return next(specifier, context)
  },
})
const React = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const { ProfileEditor } = await import('./EmployeesPanel')
import type { PackProfileDeclaration } from './EmployeesPanel'
const messages = JSON.parse(readFileSync(new URL('../../../../messages/en/payroll.json', import.meta.url), 'utf8'))
Object.assign(globalThis, { React })

const xxPack: PackProfileDeclaration = {
  subdivisionLabel: 'canton',
  subdivisions: ['ZH', 'AG'],
  supportedSubdivisions: ['ZH'],
  unsupportedReason: 'withholding for {region} is not implemented by the XX pack',
  unsupportedReasons: {},
  certificates: [
    {
      key: 'xx_form',
      form: 'XX-1',
      label: 'Fixture withholding certificate',
      scope: { level: 'country' },
      fields: [
        {
          key: 'codes',
          label: 'Claim codes',
          kind: 'count',
          min: '0',
          max: '5',
          storage: { kind: 'column', column: 'federal_claim_code' },
          help: 'How many fixture credits are claimed.',
        },
        {
          key: 'free',
          label: 'No income tax is to be withheld',
          kind: 'flag',
          storage: { kind: 'column', column: 'tax_exempt' },
          help: 'The fixture exempt claim.',
        },
      ],
    },
  ],
  exemptionFlags: [],
}

function render(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{ 'payroll': messages }}>
      <ProfileEditor
        inline
        profile={{
          id: '',
          employee_party_id: 'emp',
          employee_name: 'Fixture Hire',
          pay_schedule_id: 'sched',
          schedule_name: null,
          country: 'XX',
          province: '',
          labour_jurisdiction: null,
          pay_basis: 'hourly',
          federal_claim_code: null,
          federal_claim_amount: null,
          provincial_claim_code: null,
          provincial_claim_amount: null,
          additional_tax_per_period: null,
          prescribed_zone_deduction: null,
          authorized_annual_deductions: null,
          authorized_federal_credits: null,
          authorized_provincial_credits: null,
          cpp_exempt: false,
          ei_exempt: false,
          tax_exempt: false,
          filing_status: null,
          multiple_jobs: false,
          dependent_credits: null,
          other_income_annual: null,
          deductions_annual: null,
          w4_pre_2020: false,
          w4_allowances: null,
          fica_exempt: false,
          futa_exempt: false,
          vacation_percent: null,
          vacation_method: 'accrue',
          filing_account_id: null,
          stub_delivery: 'email',
          payment_method: null,
          is_active: true,
          ...overrides,
        }}
        schedules={[{ id: 'sched', name: 'Monthly', frequency: 'monthly' }]}
        filingAccounts={[]}
        labourJurisdictions={{}}
        countries={['XX']}
        packProfiles={{ XX: xxPack }}
        onClose={() => {}}
        onSaved={() => {}}
      />
    </NextIntlClientProvider>,
  )
}

test('profile editor renders a pack it has never heard of', () => {
  const html = render({})
  // The country picker offers the served pack under its own code — no locale
  // key exists for XX, so the code reads as written.
  assert.match(html, /<option value="XX"[^>]*>XX<\/option>/)
  assert.doesNotMatch(html, /value="CA"/)
  assert.doesNotMatch(html, /value="US"/)
  // Subdivisions and their label come from the declaration, unsupported codes
  // disabled with the pack's own reason.
  assert.match(html, /canton/)
  assert.match(html, /<option value="ZH"[^>]*>ZH<\/option>/)
  assert.match(html, /<option value="AG"[^>]*disabled[^>]*>AG<\/option>/)
  assert.match(html, /withholding for AG is not implemented by the XX pack/)
  // The count band is declared 0–5, not the TD1's 0–10: the dropdown proves
  // the band is read, and the form heading proves the certificate is.
  assert.match(html, /XX-1 · Fixture withholding certificate/)
  assert.match(html, /<option value="5"[^>]*>5<\/option>/)
  assert.doesNotMatch(html, /<option value="6"[^>]*>6<\/option>/)
  assert.doesNotMatch(html, /<option value="10"[^>]*>10<\/option>/)
  // The pack's flag field renders as a checkbox beside the generic toggle: the
  // row id carries the pack's own certificate and field keys, while the label
  // resolves through the existing locale key for the data concept.
  assert.match(html, /id="pp-xx_form-free"/)
  assert.match(html, /Income tax exempt/)
})
