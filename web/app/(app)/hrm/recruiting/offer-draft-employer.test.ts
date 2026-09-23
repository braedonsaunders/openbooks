import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildOfferDraftBody } from './actions'

/**
 * F7: the offer Draft form never sent employerSubsidiaryId, so every UI
 * submission failed with "expected string, received undefined". The draft
 * now inherits the requisition's legal entity deterministically, shows its
 * NAME (with an authorized picker only when the caller may genuinely
 * choose), and carries it on the POST. Scope stays server-side: the route
 * refuses an out-of-scope employer by name.
 */

const actions = readFileSync(new URL('./actions.tsx', import.meta.url), 'utf8')
const sections = readFileSync(new URL('./sections.tsx', import.meta.url), 'utf8')
const view = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')

test('the draft POST carries the requisition employer', () => {
  const body = buildOfferDraftBody({
    applicationId: 'app-1',
    employerSubsidiaryId: 'd726d187-0000-0000-0000-000000000001',
    jobTitle: '  Machinist ',
    proposedStartOn: '2026-10-01',
    compensationAmount: ' 45.5000 ',
    compensationCurrency: ' usd ',
    compensationBasis: 'hourly',
    expiresOn: null,
  })
  assert.equal(body.employerSubsidiaryId, 'd726d187-0000-0000-0000-000000000001', 'the employer rides every submission')
  assert.equal(body.jobTitle, 'Machinist', 'existing trims are preserved')
  assert.equal(body.compensationCurrency, 'USD', 'existing casing is preserved')
  assert.ok(!Object.values(body).some((value) => value === undefined), 'no field serializes as undefined')
})

test('the island defaults the employer to the requisition entity and posts it', () => {
  assert.match(actions, /employerSubsidiaryId: employerId/, 'the POST body sends the selected employer')
  assert.match(actions, /useState\(employer\.value\)/, 'the selection defaults to the requisition employer')
  assert.match(
    actions,
    /employers\.length > 1 && employers\.some\(\(option\) => option\.value === employer\.value\)/,
    'the picker shows only for a genuine authorized choice containing the requisition employer',
  )
  assert.match(actions, /\{employer\.label\}/, 'the fixed text is the employer NAME')
  assert.ok(!/\{employer\.value\}/.test(actions.split('OfferCreateIsland')[1]!.split('InterviewScheduleIsland')[0]!),
    'the raw employer id never renders as text in the offer form',
  )
})

test('the loader resolves the employer name and wires it through the drawer', () => {
  assert.match(view, /select name from subsidiaries/, 'the loader resolves the employer display name')
  assert.match(view, /offerEmployer: \{ value: detail\.employerSubsidiaryId, label: offerEmployerName \}/,
    'the drawer inherits the opening legal entity with its name',
  )
  assert.match(view, /offerEmployerOptions/, 'the drawer carries the authorized employer choice')
  assert.match(view, /recruiting\.offerCard\.employer/, 'the employer field label resolves through the locale')
  assert.match(sections, /employer=\{detail\.offerEmployer\}/, 'the drawer passes the inherited employer to the form')
  assert.match(sections, /employers=\{detail\.offerEmployerOptions\}/, 'the drawer passes the authorized choice')
  assert.match(sections, /employer: labels\.offerEmployer/, 'the employer label reaches the island')
})

test('the accept dialog pins the refusal instead of swallowing it', () => {
  // Accept rides the shared act(): the 422 NO_FLOW body renders through
  // readApiErrorMessage into the role=alert slot — the operator reads the
  // remedy, never a parse error or a silent toast.
  const island = actions.split('OfferActionsIsland')[1]!.split('HR-18 depth islands')[0]!
  assert.match(island, /action: 'accept'/, 'Accept and hire posts through the shared path')
  assert.match(island, /readApiErrorMessage\(res, labels\.failed\)/, 'the refusal message renders intact')
  assert.match(island, /role="alert"/, 'the pinned refusal is an accessible alert')
})

test('the employer field label ships in every locale', () => {
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh']) {
    const catalog = JSON.parse(
      readFileSync(new URL(`../../../../messages/${locale}/hrm.json`, import.meta.url), 'utf8'),
    )
    const label = catalog.recruiting?.offerCard?.employer
    assert.ok(typeof label === 'string' && label.length > 0, `${locale}: recruiting.offerCard.employer must be translated`)
  }
})
