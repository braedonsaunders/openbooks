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
const { CertificateForm } = await import('./PackCertificateForms')
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
    const html = renderToStaticMarkup(
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
