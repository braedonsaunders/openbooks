import assert from 'node:assert/strict'
import test from 'node:test'
import { stubModules } from '../../testing/stub-modules.ts'

// The reader's locale the request carries.
stubModules({ navigation: false, intl: 'export async function getTranslations(){return (k)=>k};export async function getLocale(){return "de-DE"}', authz: false, features: false })

const { EquityError } = await import('@openbooks/engine/equity')
const { apiErrorResponse } = await import('./error-response')

const german = (iso: string) => new Intl.DateTimeFormat('de-DE', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`))

test('an equity refusal reaches the reader with its figures and dates in the reader locale, keeping its contract fields', async () => {
  const response = await apiErrorResponse(new EquityError('Only {ceiling} units are vested and unexercised on 2026-03-01.', {
    status: 409, code: 'equity_event_exceeds_vested', field: 'quantity',
    remedy: 'Date the exercise on or after 2027-02-25, or record no more than {ceiling} units.',
    values: { ceiling: { kind: 'shares', value: 12500n } },
  }))
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    code: 'equity_event_exceeds_vested', field: 'quantity',
    error: `Only 12.500 units are vested and unexercised on ${german('2026-03-01')}.`,
    remedy: `Date the exercise on or after ${german('2027-02-25')}, or record no more than 12.500 units.`,
  })
})

test('an equity refusal without figures still reads its dates in the reader locale', async () => {
  const response = await apiErrorResponse(new EquityError('A stock compensation run through 2026-12-31 is already posted.', {
    status: 409, code: 'equity_compensation_run_backdated', field: 'throughDate', remedy: 'Run through a date after 2026-12-31; earlier periods are already measured.',
  }))
  const body = await response.json() as { error: string; remedy: string }
  assert.equal(body.error, `A stock compensation run through ${german('2026-12-31')} is already posted.`)
  assert.equal(body.remedy, `Run through a date after ${german('2026-12-31')}; earlier periods are already measured.`)
})
