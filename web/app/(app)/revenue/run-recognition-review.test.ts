import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

/**
 * Run recognition is a REVIEW, not a fire-and-forget button.
 *
 * Opening it writes nothing; the preview is read-only; Confirm carries the
 * fingerprint of exactly what was reviewed and the server refuses a stale
 * one. These are the structural facts behind that contract — the ones a
 * future edit could quietly undo.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const button = read('./RunRecognitionButton.tsx')
const drawer = read('./RunRecognitionDrawer.tsx')
const view = read('./view.ts')
const previewRoute = read('../../api/revenue/recognition-preview/route.ts')
const runRoute = read('../../api/revenue/run-recognition/route.ts')
const engine = read('../../../../engine/src/revenue/recognition.ts')

test('the button opens the review drawer and writes nothing itself', () => {
  assert.doesNotMatch(button, /fetch\(/, 'the button performs no request')
  assert.match(button, /<RunRecognitionDrawer/)
  assert.match(button, /setOpen\(true\)/)
  // The contract drawer's per-obligation launch fixes the scope rather than
  // running that obligation immediately.
  assert.match(button, /lockObligation=\{/)
  assert.match(read('./ContractDrawer.tsx'), /<RunRecognitionButton\s+obligationId=\{o\.id\}/)
})

test('the drawer offers scope, preview and an explicit confirm', () => {
  for (const control of [
    'recognition-as-of',
    'recognition-book',
    'recognition-period',
    'recognition-contract',
    'recognition-obligation',
  ]) {
    assert.match(drawer, new RegExp(`id="${control}"`), `${control} is offered`)
  }
  assert.match(drawer, /'\/api\/revenue\/recognition-preview'/)
  assert.match(drawer, /'\/api\/revenue\/run-recognition'/)
  // Confirm posts the reviewed fingerprint, never a bare re-run.
  assert.match(drawer, /fingerprint: preview\.fingerprint/)
  // A scope edited after the preview disables Confirm until it is refreshed.
  assert.match(drawer, /const scopeChanged = preview !== null && previewScopeKey !== scopeKey/)
  assert.match(drawer, /const confirmBlocked = busy \|\| scopeChanged/)
  // Results are journal links, not a count in a toast.
  assert.match(drawer, /<JournalEntryLink entryId=\{entry\.entryId\}>/)
})

test('the preview boundary is read-only and refuses a scope it does not own', () => {
  assert.doesNotMatch(previewRoute, /insert into|update |delete from/i)
  assert.doesNotMatch(previewRoute, /db\.transaction|for update/i)
  for (const refusal of [
    'book_not_found',
    'period_not_found',
    'obligation_not_found',
    'contract_not_found',
    'invalid_as_of_date',
  ]) {
    assert.match(previewRoute, new RegExp(refusal), `${refusal} is named`)
    assert.match(drawer, new RegExp(`'${refusal}'`), `the drawer names ${refusal}`)
  }
  // A restricted caller with no permitted entity previews nothing — never the
  // unrestricted set, exactly as the run route decides it.
  assert.match(previewRoute, /allowedSubsidiaryIds\?\.length === 0/)
})

test('a confirmed run refuses a stale review before it writes anything', () => {
  assert.match(runRoute, /StaleRecognitionPreviewError/)
  assert.match(runRoute, /'stale_preview'[\s\S]{0,40}status: 409/)
  assert.match(runRoute, /body\.fingerprint\s*\?\s*\{/)
  assert.match(drawer, /case 'stale_preview'/)
  // The fence resolves BEFORE the posting loop: the comparison and its throw
  // both sit above the first write.
  const fence = engine.indexOf('const current = await previewRevenueRecognition(orgId, confirm.scope)')
  const loop = engine.indexOf('for (const candidate of due)')
  assert.ok(fence > 0 && loop > fence, 'the fingerprint compare precedes the posting loop')
  assert.match(engine, /throw new StaleRecognitionPreviewError\(/)
})

test('every refusal the run can reach is evaluated in the preview and named in the drawer', () => {
  // The preview must decide the same refusals the posting loop does;
  // otherwise the operator reviews a total the run will not post.
  for (const reason of ['period_closed', 'not_configured', 'credit_capped', 'negative_floor', 'zero']) {
    assert.match(engine, new RegExp(`skipReason = "${reason}"`), `the preview evaluates ${reason}`)
    assert.match(drawer, new RegExp(`case '${reason}'`), `the drawer names ${reason}`)
  }
  // The hidden project re-measurement is disclosed rather than silent.
  assert.match(engine, /projectSyncPending/)
  assert.match(drawer, /preview\.warnings\.map/)
})

test('the loader supplies the scope options and the spec passes them through', () => {
  assert.match(view, /books: RunRecognitionDrawerProps\["books"\]/)
  assert.match(view, /candidates: RunRecognitionDrawerProps\["candidates"\]/)
  // Only a caller who can run recognition pays for the scope queries.
  assert.match(view, /const \[books, periods, candidates\] = canRun/)
  assert.match(view, /props: \{ books: data\.books, periods: data\.periods, candidates: data\.candidates \}/)
  assert.match(
    read('../../../components/viewspec/widget-contracts.ts'),
    /'run-recognition': \{ props: \['books', 'candidates', 'periods'\] \}/,
  )
})

test('the review catalog is translated in every locale', () => {
  const messages = new URL('../../../messages/', import.meta.url)
  const locales = readdirSync(messages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  assert.ok(locales.length >= 7, 'every shipped locale is covered')
  const base = Object.keys(
    JSON.parse(readFileSync(new URL('en/revenue.json', messages), 'utf8')).review,
  ).sort()
  assert.ok(base.length > 0, 'the review catalog exists')
  for (const locale of locales) {
    const catalog = JSON.parse(readFileSync(new URL(`${locale}/revenue.json`, messages), 'utf8'))
    assert.deepEqual(Object.keys(catalog.review ?? {}).sort(), base, `${locale} carries every review key`)
  }
})
