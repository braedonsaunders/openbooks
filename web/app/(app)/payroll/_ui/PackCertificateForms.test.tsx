import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'

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
// tsx compiles JSX classic: the component under test never imports React
// (Next provides the automatic runtime in production), so the test bridges it.
Object.assign(globalThis, { React })
const { NextIntlClientProvider } = await import('next-intl')
const { CertificateForm } = await import('./PackCertificateForms')
const commonMessages = JSON.parse(readFileSync(new URL('../../../../messages/en/common.json', import.meta.url), 'utf8'))

// The read-only form renders values through the shared catalog, so it needs
// the same provider the drawer gives it in production.
function renderReadOnly(element: React.ReactElement): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{ common: commonMessages }}>{element}</NextIntlClientProvider>,
  )
}
// Side effect: publishes the built-in packs' certificate sources, the same
// way any production importer of the pack registry does.
await import('@openbooks/engine/src/payroll/packs.ts')
const { packCertificates } = await import('@openbooks/engine/src/payroll/certificates.ts')

const source = readFileSync(new URL('./PackCertificateForms.tsx', import.meta.url), 'utf8')
// Comments explain history; only code can branch.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/.*$/gm, '$1')

// The renderer serves whatever row-backed certificates the packs declare.
// A country, form number or field key in code would be a second,
// hardcoded copy of a pack's declaration — the defect this surface removes.
test('certificate forms name no country, form or field in code', () => {
  assert.doesNotMatch(code, /['"]NL['"]/)
  assert.doesNotMatch(code, /['"]nl_/)
  assert.doesNotMatch(code, /nl_loonheffingen/)
  assert.doesNotMatch(code, /nl_premies/)
  assert.doesNotMatch(code, /country\s*===?\s*['"][A-Z]/)
  assert.doesNotMatch(code, /certificateKey\s*===?\s*['"]/)
})

// The declared NL certificates render every field kind the packs use, with
// the stored answers prefilled — the entry surface the pay-run proof fills
// through the API.
test('declared NL certificates render their fields with stored answers', () => {
  const declared = packCertificates('NL').certificates
  assert.equal(declared.length, 2)
  for (const certificate of declared) {
    const html = renderReadOnly(
      React.createElement(CertificateForm, {
        partyId: 'employee',
        country: 'NL',
        certificate: {
          key: certificate.key,
          form: certificate.form,
          label: certificate.label,
          scope: certificate.scope,
          citation: certificate.citation,
          summary: certificate.summary,
          fields: certificate.fields,
        },
        stored: [
          {
            certificate_key: certificate.key,
            country: 'NL',
            region: null,
            sub_region: null,
            answers: Object.fromEntries(certificate.fields.map((field) => [field.key, 'true'])),
            effective_from: '2026-01-01',
            superseded_on: null,
          },
        ],
        onSaved: () => {},
      }),
    )
    assert.ok(html.includes(certificate.label), certificate.key)
    for (const field of certificate.fields) {
      assert.ok(html.includes(field.label), field.key)
    }
  }
})

// The drawer read mode serves the latest filing as values: pack labels with
// stored answers, no inputs, and no save button.
test('read mode renders the latest filing with no form controls', () => {
  const declared = packCertificates('NL').certificates
  assert.ok(declared.length > 0)
  for (const certificate of declared) {
    const field = certificate.fields[0]!
    const storedAnswer = field.kind === 'flag' ? 'true' : field.kind === 'choice'
      ? (field.choices?.[0]?.value ?? 'x')
      : 'filed-value'
    const html = renderReadOnly(
      React.createElement(CertificateForm, {
        partyId: 'employee',
        country: 'NL',
        certificate: {
          key: certificate.key,
          form: certificate.form,
          label: certificate.label,
          scope: certificate.scope,
          citation: certificate.citation,
          summary: certificate.summary,
          fields: certificate.fields,
        },
        stored: [
          {
            certificate_key: certificate.key,
            country: 'NL',
            region: null,
            sub_region: null,
            answers: { [field.key]: storedAnswer },
            effective_from: '2026-01-01',
            superseded_on: null,
          },
        ],
        readOnly: true,
      }),
    )
    assert.ok(html.includes(certificate.label), certificate.key)
    assert.ok(html.includes(field.label), field.key)
    assert.doesNotMatch(html, /<input/)
    assert.doesNotMatch(html, /<select/)
    assert.doesNotMatch(html, /<textarea/)
    assert.doesNotMatch(html, /<button/)
    assert.doesNotMatch(html, /Save certificate/)
    if (field.kind === 'flag') assert.ok(html.includes('Yes'), field.key)
    else if (field.kind === 'choice') {
      const expected = field.choices?.[0]?.label ?? storedAnswer
      assert.ok(html.includes(expected), field.key)
    } else assert.ok(html.includes('filed-value'), field.key)
    assert.ok(html.includes('2026-01-01'), certificate.key)
  }
})

test('edit mode keeps the inputs and the save button', () => {
  const declared = packCertificates('NL').certificates
  const certificate = declared[0]!
  const html = renderReadOnly(
    React.createElement(CertificateForm, {
      partyId: 'employee',
      country: 'NL',
      certificate: {
        key: certificate.key,
        form: certificate.form,
        label: certificate.label,
        scope: certificate.scope,
        citation: certificate.citation,
        summary: certificate.summary,
        fields: certificate.fields,
      },
      stored: [],
      onSaved: () => {},
    }),
  )
  assert.match(html, /<input|<select/)
  assert.match(html, /Save certificate/)
})

// F3-11: a certificate amount the classifier cannot read names its cause
// and remedy under the field, and the save stays disabled until every
// amount reads. Seeded from the stored filing, so the refusal renders with
// no interaction — a static render that passed before the fix cannot name
// a remedy the old input never computed.
test('an unreadable certificate amount names its remedy and blocks the save', () => {
  const declared = packCertificates('NL').certificates
  const certificate = declared.find((entry) => entry.key === 'nl_premies')!
  const html = renderReadOnly(
    React.createElement(CertificateForm, {
      partyId: 'employee',
      country: 'NL',
      certificate: {
        key: certificate.key,
        form: certificate.form,
        label: certificate.label,
        scope: certificate.scope,
        citation: certificate.citation,
        summary: certificate.summary,
        fields: certificate.fields,
      },
      stored: [
        {
          certificate_key: certificate.key,
          country: 'NL',
          region: null,
          sub_region: null,
          answers: { whk_percent: '12,34' },
          effective_from: '2026-01-01',
          superseded_on: null,
        },
      ],
      onSaved: () => {},
    }),
  )
  assert.match(html, /must use .* as the decimal point/)
  assert.match(html, /12\.34/)
  assert.match(html, /<button[^>]*disabled[^>]*>Save certificate<\/button>/)
})
