import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import type { PackProfileDeclaration, StoredCertificateRow } from './EmployeesPanel'

// All module setup — including every top-level await — completes before the
// first test() registration below (canonical registration order).
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sonner') {
      return { shortCircuit: true, url: 'data:text/javascript,export const toast = { success(){}, error(){} }' }
    }
    return next(specifier, context)
  },
})
const { renderToStaticMarkup } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const { ProfileEditor } = await import('./EmployeesPanel')
// tsx compiles JSX classic: the component under test never imports React
// (Next provides the automatic runtime in production), so the test bridges it.
Object.assign(globalThis, { React })
const { PAYROLL_COUNTRY_PACKS } = await import('@openbooks/engine/src/payroll/packs.ts')
const { packCertificates } = await import('@openbooks/engine/src/payroll/certificates.ts')

const source = readFileSync(new URL('./EmployeesPanel.tsx', import.meta.url), 'utf8')
// Comments explain history; only code can branch.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/.*$/gm, '$1')
const messages = JSON.parse(readFileSync(new URL('../../../../messages/en/payroll.json', import.meta.url), 'utf8'))
const commonMessages = JSON.parse(readFileSync(new URL('../../../../messages/en/common.json', import.meta.url), 'utf8'))

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

// The renderer binds declared columns through its binding maps plus a
// generic extra-column path. A pack that declares a column nobody binds
// would render nothing and save null — silently dropping the operator's
// answer — so every column every pack declares must resolve through one of
// the two, and the build (this test) refuses the gap. The generic path is
// proved live by the unknown-column render test below; this test pins that
// the real packs' columns each have a binding and that the generic path
// still exists (its removal would orphan every future pack's first fact).
test('profile editor binds every column the packs declare', () => {
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
  // The generic extra-column path: comments were stripped above, so these
  // markers prove the mechanism is code, not prose.
  assert.match(code, /extraColumns\[column\]/, 'the generic extra-column read is gone')
  assert.match(code, /setExtraValue\(column\)/, 'the generic extra-column write is gone')
  assert.match(code, /\.\.\.extraFactSave/, 'the generic extra-column save is gone')
  for (const column of [...columns].sort()) {
    // Binding-map key syntax (`federal_claim_code: [...]`) or the generic
    // path (which binds by column at render time) — a passing mention in a
    // comment is not a binding, and comments were stripped above.
    const literal = new RegExp(`(^|[^\\w])${column}\\s*:`).test(code)
    const generic = /extraValue\(column\)/.test(code) && /\.\.\.extraFactSave/.test(code)
    assert.ok(literal || generic, `no editor binding for declared column ${column}`)
  }
})

// Exercise the real editor against a country that does not exist: subdivisions,
// bands, forms and flags must all come from the served declaration.
const xxPack: PackProfileDeclaration = {
  countryName: 'Exemplia',
  subdivisionLabel: 'canton',
  subdivisions: ['ZH', 'AG'],
  subdivisionNames: { ZH: 'Zurich', AG: 'Aargau' },
  supportedSubdivisions: ['ZH'],
  unsupportedReason: 'withholding for {region} is not implemented by the XX pack',
  unsupportedReasons: {},
  certificates: [
    {
      key: 'xx_form',
      form: 'XX-1',
      label: 'Fixture withholding certificate',
      citation: 'Fixture revenue authority, Fixture Form XX-1 (2026)',
      storage: 'profile_columns' as const,
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
  identifier: {
    label: 'Fixture payroll number',
    formatHelp: '6 digits',
    example: '123456',
    required: true,
    neededFor: null,
    numericEntry: true,
  },
}

function render(
  overrides: Record<string, unknown> = {},
  packProfiles: Record<string, PackProfileDeclaration> = { XX: xxPack },
  countries: string[] = ['XX'],
  storedCertificates: StoredCertificateRow[] = [],
  derivedColumns: Record<string, string> = {},
  editor: { readOnly?: boolean; section?: 'general' | 'tax' } = {},
): string {
  const profileCountry = (overrides.country as string | undefined) ?? countries[0]!
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{ 'payroll': messages, 'common': commonMessages }}>
      <ProfileEditor
        inline
        readOnly={editor.readOnly}
        section={editor.section}
        profile={{
          id: '',
          employee_party_id: 'emp',
          employee_name: 'Fixture Hire',
          pay_schedule_id: 'sched',
          schedule_name: null,
          country: profileCountry,
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
          pl_rok_urodzenia: null,
          es_ano_nacimiento: null,
          es_grupo_cotizacion: null,
          es_situacion_laboral: null,
          jp_hyojun_hoshu: null,
          jp_kaigo_dainigou: null,
          br_dependentes: null,
          br_pensao_mensal: null,
          vacation_percent: null,
          vacation_method: 'accrue',
          filing_account_id: null,
          stub_delivery: 'email',
          payment_method: null,
          paid_on_commission: null,
          is_active: true,
          ...overrides,
        }}
        schedules={[{ id: 'sched', name: 'Monthly', frequency: 'monthly' }]}
        filingAccounts={[]}
        labourJurisdictions={{}}
        countries={countries}
        packProfiles={packProfiles}
        storedCertificates={storedCertificates}
        derivedColumns={derivedColumns}
        onClose={() => {}}
        onSaved={() => {}}
      />
    </NextIntlClientProvider>,
  )
}

test('profile editor renders a pack it has never heard of', () => {
  const html = render({})
  // The country picker offers the served pack under its SERVED NAME — no
  // locale key exists for XX, so the pack's own name reads as written,
  // never the bare code.
  assert.match(html, /<option value="XX"[^>]*>Exemplia<\/option>/)
  assert.doesNotMatch(html, /value="CA"/)
  assert.doesNotMatch(html, /value="US"/)
  // Subdivisions and their label come from the declaration, unsupported codes
  // disabled with the pack's own reason.
  assert.match(html, /canton/)
  assert.match(html, /<option value="ZH"[^>]*>Zurich<\/option>/)
  assert.match(html, /<option value="AG"[^>]*disabled[^>]*>Aargau<\/option>/)
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

// A pack whose certificates store in rows: every kind renders from the same
// declaration the column path reads, with the pack's own labels, help,
// citation and required-ness — and a region-scoped form stays hidden until
// the employee works in its region.
const yyPack: PackProfileDeclaration = {
  countryName: 'Whyland',
  subdivisionLabel: 'region',
  subdivisions: ['AA', 'ZZ'],
  subdivisionNames: { AA: 'Aland', ZZ: 'Zanzibar' },
  supportedSubdivisions: ['AA', 'ZZ'],
  unsupportedReason: 'withholding for {region} is not implemented by the YY pack',
  unsupportedReasons: {},
  certificates: [
    {
      key: 'yy_notice',
      form: 'YY-9',
      label: 'Fixture coding notice',
      citation: 'Fixture revenue authority, Coding notices (2026)',
      storage: 'certificate_rows',
      scope: { level: 'country' },
      fields: [
        {
          key: 'tax_code',
          label: 'Tax code',
          kind: 'code',
          required: true,
          help: 'The code exactly as issued.',
        },
        {
          key: 'plan',
          label: 'Plan choice',
          kind: 'choice',
          choices: [
            { value: 'a', label: 'Plan A' },
            { value: 'b', label: 'Plan B' },
          ],
          help: 'Pick a plan.',
        },
        {
          key: 'allowances',
          label: 'Allowances',
          kind: 'count',
          min: '0',
          max: '3',
          help: 'How many.',
        },
        {
          key: 'extra',
          label: 'Extra amount',
          kind: 'amount',
          decimals: 2,
          help: 'Withheld on top.',
        },
        {
          key: 'marker',
          label: 'Special marker',
          kind: 'flag',
          help: 'A fixture checkbox.',
        },
      ],
    },
    {
      key: 'yy_regional',
      form: 'YY-R',
      label: 'Fixture regional form',
      citation: 'Fixture revenue authority, Regional form (2026)',
      storage: 'certificate_rows',
      scope: { level: 'region', region: 'ZZ' },
      fields: [
        {
          key: 'regional_code',
          label: 'Regional code',
          kind: 'code',
          help: 'Only for ZZ employees.',
        },
      ],
    },
  ],
  exemptionFlags: [],
  identifier: {
    label: 'Fixture payroll number',
    formatHelp: '6 digits',
    example: '123456',
    required: true,
    neededFor: null,
    numericEntry: true,
  },
}

test('profile editor renders row-backed certificate fields generically', () => {
  const html = render({}, { YY: yyPack }, ['YY'])
  // Form heading plus the pack's citation, exactly as declared.
  assert.match(html, /YY-9 · Fixture coding notice/)
  assert.match(html, /Fixture revenue authority, Coding notices \(2026\)/)
  // Every kind renders with its declared label and an id carrying the pack's
  // own certificate and field keys; the required code field is marked.
  assert.match(html, /id="pp-yy_notice-tax_code"/)
  assert.match(html, /Tax code \*/)
  assert.match(html, /id="pp-yy_notice-plan"/)
  assert.match(html, /<option value="a"[^>]*>Plan A<\/option>/)
  assert.match(html, /<option value="b"[^>]*>Plan B<\/option>/)
  assert.match(html, /id="pp-yy_notice-allowances"/)
  assert.match(html, /<option value="3"[^>]*>3<\/option>/)
  assert.doesNotMatch(html, /<option value="4"[^>]*>4<\/option>/)
  assert.match(html, /id="pp-yy_notice-extra"/)
  assert.match(html, /id="pp-yy_notice-marker"/)
  // The region-scoped form does NOT offer itself: the employee works nowhere.
  assert.doesNotMatch(html, /YY-R · Fixture regional form/)
  assert.doesNotMatch(html, /id="pp-yy_regional-regional_code"/)
})

test('a region-scoped certificate offers itself only in its own region', () => {
  const elsewhere = render({ province: 'AA' }, { YY: yyPack }, ['YY'])
  assert.doesNotMatch(elsewhere, /YY-R · Fixture regional form/)
  const home = render({ province: 'ZZ' }, { YY: yyPack }, ['YY'])
  assert.match(home, /YY-R · Fixture regional form/)
  assert.match(home, /id="pp-yy_regional-regional_code"/)
  // …and the country-level form renders in both.
  assert.match(elsewhere, /YY-9 · Fixture coding notice/)
  assert.match(home, /YY-9 · Fixture coding notice/)
})

test('row-backed answers prefill from the current filing', () => {
  const html = render({}, { YY: yyPack }, ['YY'], [
    {
      certificateKey: 'yy_notice',
      answers: { tax_code: '1257L', marker: 'true' },
      effectiveFrom: '2026-04-06',
    },
  ])
  assert.match(html, /value="1257L"/)
  assert.match(html, /id="pp-yy_notice-marker"[^>]*checked/)
})

test('the sealed identifier field renders the pack declaration', () => {
  // Label, placeholder and keyboard come from the served pack declaration —
  // never a hardcoded "SIN / SSN" with a numeric keypad.
  const html = render({}, { XX: xxPack }, ['XX'])
  assert.match(html, /Fixture payroll number/)
  assert.match(html, /placeholder="123456"/)
  assert.match(html, /id="pp-sin"[^>]*inputmode="numeric"/i)
  const alpha = {
    ...xxPack,
    identifier: { ...xxPack.identifier, label: 'NINO-like', example: 'QQ 12 34 56 C', numericEntry: false },
  }
  const alphaHtml = render({}, { XX: alpha }, ['XX'])
  assert.match(alphaHtml, /NINO-like/)
  assert.match(alphaHtml, /placeholder="QQ 12 34 56 C"/)
  assert.match(alphaHtml, /id="pp-sin"[^>]*inputmode="text"/i)
})

// A column no binding map knows: the generic extra-column path renders it
// from the declaration alone — the proof the next pack's fact appears with
// no UI change. Neither column below is bound in the editor source; both
// must still render, seed from the row, and accept the derived hint.
const zzPack: PackProfileDeclaration = {
  countryName: 'Zetland',
  subdivisionLabel: 'canton',
  subdivisions: ['ZH'],
  subdivisionNames: { ZH: 'Zurich' },
  supportedSubdivisions: ['ZH'],
  unsupportedReason: 'withholding for {region} is not implemented by the ZZ pack',
  unsupportedReasons: {},
  certificates: [
    {
      key: 'zz_bio',
      form: 'ZZ-B',
      label: 'Fixture life facts',
      citation: 'Fixture revenue authority, Life facts (2026)',
      storage: 'profile_columns' as const,
      scope: { level: 'country' },
      fields: [
        {
          key: 'birth_year',
          label: 'Fixture birth year',
          kind: 'count',
          min: '1900',
          max: '2026',
          storage: { kind: 'column', column: 'zz_birth_year' },
          required: true,
          help: 'The fixture birth year.',
        },
        {
          key: 'standing',
          label: 'Fixture standing',
          kind: 'flag',
          storage: { kind: 'column', column: 'zz_standing' },
          help: 'The fixture standing.',
        },
      ],
    },
  ],
  exemptionFlags: [],
  identifier: {
    label: 'Fixture payroll number',
    formatHelp: '6 digits',
    example: '123456',
    required: true,
    neededFor: null,
    numericEntry: true,
  },
}

test('profile editor renders a column it has never bound', () => {
  // The row seeds the unbound count; the derived hint answers the unbound
  // flag — neither column appears in any binding map in the editor source.
  const html = render(
    { province: 'ZH', zz_birth_year: 1990 },
    { ZZ: zzPack },
    ['ZZ'],
    [],
    { zz_standing: 'true' },
  )
  assert.match(html, /ZZ-B · Fixture life facts/)
  // Required count with a wide band: a typed input carrying the row value,
  // marked required — not a codeset dropdown.
  assert.match(html, /id="pp-zz_bio-birth_year"/)
  assert.match(html, /Fixture birth year \*/)
  assert.match(html, /value="1990"/)
  // The unbound flag renders as a checkbox, checked from the derived hint.
  assert.match(html, /id="pp-zz_bio-standing"/)
  assert.match(html, /id="pp-zz_bio-standing"[^>]*checked/)
})

// The employee drawer honours its edit mode exactly like its Overview tab:
// read mode renders values, never inputs, and offers no Save.
test('read mode renders values with no form controls and no save', () => {
  const html = render(
    { federal_claim_code: 3, tax_exempt: true },
    { XX: xxPack },
    ['XX'],
    [],
    {},
    { readOnly: true },
  )
  assert.doesNotMatch(html, /<input/)
  assert.doesNotMatch(html, /<select/)
  assert.doesNotMatch(html, /<textarea/)
  // No Save offer. (The shared Label's help affordance is a button, exactly
  // as on the Overview tab's read mode — it opens help, it edits nothing.)
  assert.doesNotMatch(html, />Save</)
  // Generic facts read as values: the schedule and country names, not ids.
  assert.match(html, /Monthly/)
  assert.match(html, /Exemplia/)
  // Pack-declared withholding reads back the stored answers: labels resolve
  // through the locale for the data concept (like edit mode), answered Yes.
  assert.match(html, /Federal claim code/)
  assert.match(html, />3</)
  assert.match(html, /Income tax exempt/)
  assert.match(html, />Yes</)
  // The identifier never leaks: with nothing on file only the pack's label
  // and an em dash render.
  assert.match(html, /Fixture payroll number/)
  assert.doesNotMatch(html, /id="pp-sin"/)
})

test('edit mode renders the inputs and the save button', () => {
  const html = render({ federal_claim_code: 3, tax_exempt: true })
  assert.match(html, /<select/)
  assert.match(html, /<input/)
  assert.match(html, /id="pp-schedule"/)
  assert.match(html, />Save</)
})

// One mounted editor serves both sub-tabs: the section prop decides which
// half renders, so typed values in state survive the switch.
test('the general section edits generic facts without withholding', () => {
  const html = render({}, { XX: xxPack }, ['XX'], [], {}, { section: 'general' })
  assert.match(html, /id="pp-schedule"/)
  assert.match(html, /id="pp-vac-pct"/)
  assert.match(html, /id="pp-active"/)
  assert.doesNotMatch(html, /XX-1 · Fixture withholding certificate/)
  assert.doesNotMatch(html, /id="pp-sin"/)
  assert.doesNotMatch(html, /id="pp-xx_form-codes"/)
})

test('the tax section edits withholding without generic facts', () => {
  const html = render({}, { XX: xxPack }, ['XX'], [], {}, { section: 'tax' })
  assert.match(html, /id="pp-sin"/)
  assert.match(html, /XX-1 · Fixture withholding certificate/)
  assert.match(html, /id="pp-xx_form-codes"/)
  assert.match(html, /id="pp-xx_form-free"/)
  assert.doesNotMatch(html, /id="pp-schedule"/)
  assert.doesNotMatch(html, /id="pp-vac-pct"/)
  assert.doesNotMatch(html, /id="pp-active"/)
})

test('read mode respects the section split', () => {
  const general = render({}, { XX: xxPack }, ['XX'], [], {}, { readOnly: true, section: 'general' })
  assert.match(general, /Monthly/)
  assert.doesNotMatch(general, /<select/)
  assert.doesNotMatch(general, /XX-1 · Fixture withholding certificate/)
  const tax = render({}, { XX: xxPack }, ['XX'], [], {}, { readOnly: true, section: 'tax' })
  assert.match(tax, /XX-1 · Fixture withholding certificate/)
  assert.doesNotMatch(tax, /<select/)
  assert.doesNotMatch(tax, /Monthly/)
})

// F3-10: a pack amount the classifier cannot read names its cause and
// remedy under the field instead of posting raw text for the server to
// refuse. A decimal comma reads as twelve-thirty-four (never as a
// thousands separator to strip — that remedy would store 1234).
test('an unreadable pack amount names its cause and remedy', () => {
  const pack: PackProfileDeclaration = {
    ...xxPack,
    certificates: [
      ...xxPack.certificates,
      {
        key: 'xx_bonus',
        form: 'XX-2',
        label: 'Fixture bonus certificate',
        citation: 'Fixture revenue authority, Fixture Form XX-2 (2026)',
        storage: 'profile_columns' as const,
        scope: { level: 'country' },
        fields: [
          {
            key: 'bonus',
            label: 'Fixture bonus',
            kind: 'amount',
            storage: { kind: 'column', column: 'xx_bonus' },
            help: 'The fixture bonus amount.',
          },
        ],
      },
    ],
  }
  const html = render({}, { XX: pack }, ['XX'], [], { xx_bonus: '12,34' })
  assert.match(html, /id="pp-xx_bonus-bonus"/)
  // Static markup escapes the quotes around the readings (&quot;), so the
  // assertions name the remedy without pinning the serializer's escaping.
  assert.match(html, /must use .* as the decimal point/)
  assert.match(html, /12\.34/)
})
