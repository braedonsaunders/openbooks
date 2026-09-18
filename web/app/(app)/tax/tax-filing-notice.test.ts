import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { COUNTRY_TAX_PACKS } from '@openbooks/engine/src/country-tax-packs/index.ts'

const source = readFileSync(new URL('./TaxFilingsView.tsx', import.meta.url), 'utf8')

/**
 * F-w4-001: the generic prepare panel branched on the literal `CA_GST34`
 * form code to show a Canada filing notice, because the pack type had no
 * notice channel. Packs now declare a catalog key on the return pack, the
 * provisioned form row carries it, and the panel renders whatever the
 * selected form declares — nothing when it declares nothing. This test pins
 * the panel side: no equality branch against any pack form code may return
 * here, or the next jurisdiction with a filing caveat reintroduces the same
 * hardcoded branch this test was written to kill.
 */
test('prepare panel renders the declared form notice without a form-code branch', () => {
  const branch = source.match(/(===|!==)\s*['"][A-Z]{2}_[A-Z0-9]+['"]/)
  assert.ok(branch === null, `generic tax UI branches on a pack form code: ${branch?.[0]}`)
  assert.match(
    source,
    /notice_key/,
    'the panel must render the selected form’s declared notice key instead of a form-code branch',
  )
})

test('CA_GST34 declares the filing notice the panel used to hardcode', () => {
  const forms = COUNTRY_TAX_PACKS.flatMap((pack) => pack.returnPacks)
  const gst34 = forms.find((form) => form.code === 'CA_GST34')
  assert.equal(gst34?.noticeKey, 'submission.gst34Notice')
})
