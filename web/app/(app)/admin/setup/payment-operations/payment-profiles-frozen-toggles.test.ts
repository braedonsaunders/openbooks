import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// F-t11-007: the bank-profile drawer checkboxes ignored clicks in both
// directions. The edit row arrives as raw snake_case (`select *`), every
// Toggle/Select reads the snake key first
// (`form.require_run_approval ?? form.requireRunApproval`), but onChange
// wrote the camelCase twin (`set('requireRunApproval', v)`). The snake value
// is never undefined on a loaded row, so the freshly written camel value was
// shadowed forever: the control displayed (and saved) its creation value.
// The same split froze every snake-backed control in all four setup drawers,
// not just the four profile checkboxes — so this pins every pair, not only
// the reported ones.
const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'PaymentOperationsSetup.tsx'),
  'utf8',
)

// [read-pattern, forbidden camel write, required snake write]
const PAIRS: Array<[RegExp, string, string]> = [
  [/checked=\{form\.require_run_approval/, 'requireRunApproval', 'require_run_approval'],
  [/checked=\{form\.require_file_approval/, 'requireFileApproval', 'require_file_approval'],
  [/checked=\{form\.auto_remittance/, 'autoRemittance', 'auto_remittance'],
  [/checked=\{form\.is_active/, 'isActive', 'is_active'],
  [/value=\{form\.bank_account_id/, 'bankAccountId', 'bank_account_id'],
  [/form\.payment_format_id \?\? form\.paymentFormatId/, 'paymentFormatId', 'payment_format_id'],
  [/value=\{form\.subsidiary_id/, 'subsidiaryId', 'subsidiary_id'],
  [/value=\{form\.sftp_server_id/, 'sftpServerId', 'sftp_server_id'],
  [/value=\{form\.sftp_folder/, 'sftpFolder', 'sftp_folder'],
  [/value=\{form\.file_extension/, 'fileExtension', 'file_extension'],
  [/value=\{form\.content_type/, 'contentType', 'content_type'],
  [/value=\{form\.formatter_script/, 'formatterScript', 'formatter_script'],
  [/value=\{form\.payment_bank_profile_id/, 'paymentBankProfileId', 'payment_bank_profile_id'],
  [/value=\{form\.signed_on/, 'signedOn', 'signed_on'],
  [/value=\{form\.valid_from/, 'validFrom', 'valid_from'],
  [/value=\{form\.expires_on/, 'expiresOn', 'expires_on'],
]

for (const [read, camelWrite, snakeWrite] of PAIRS) {
  test(`snake-backed reads pair with snake writes: ${snakeWrite} (F-t11-007)`, () => {
    assert.match(source, read, `expected a control reading form.${snakeWrite} first`)
    assert.doesNotMatch(
      source,
      new RegExp(`set\\('${camelWrite}'`),
      `set('${camelWrite}', …) is shadowed by form.${snakeWrite} — the control can never move`,
    )
    assert.match(
      source,
      new RegExp(`set\\('${snakeWrite}'`),
      `onChange must write set('${snakeWrite}', …) so the control reads its own edit`,
    )
  })
}

test('schedule criteria edits write the key the drawer reads (F-t11-007)', () => {
  assert.match(
    source,
    /const criteria = form\.selection_criteria \?\? form\.selectionCriteria/,
    'expected the snake-first criteria read',
  )
  assert.doesNotMatch(
    source,
    /set\('selectionCriteria',/,
    `set('selectionCriteria', …) is shadowed by form.selection_criteria — criteria edits can never move`,
  )
  assert.match(source, /set\('selection_criteria',/, 'criteria edits must write the snake key')
})
