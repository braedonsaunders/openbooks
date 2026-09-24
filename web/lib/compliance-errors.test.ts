import assert from 'node:assert/strict'
import test from 'node:test'
import { complianceWriteFailure } from './compliance-errors.ts'

/**
 * C-39: compliance write verbs surfaced raw Postgres driver text —
 * constraint names, table names, parameter values — to the operator.
 * Every write catch now funnels through complianceWriteFailure: known
 * constraint violations become named refusals, and anything else becomes a
 * generic 500 with a correlation id. The property under test is what the
 * OPERATOR sees: a status they can act on, and never driver internals.
 */
function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

async function bodyText(res: Response): Promise<{ status: number; json: Record<string, unknown> }> {
  const json = (await res.json()) as Record<string, unknown>
  return { status: res.status, json }
}

test('a unique violation refuses as 409 without driver internals', async () => {
  const { status, json } = await bodyText(
    complianceWriteFailure(
      pgError('23505', 'duplicate key value violates unique constraint "compliance_waivers_party_requirement"'),
    ),
  )
  assert.equal(status, 409)
  assert.match(String(json.error), /existing record/i)
  assert.ok(!String(json.error).includes('compliance_waivers'), 'table name leaked into the refusal')
})

test('a foreign-key violation refuses as 422 without driver internals', async () => {
  const { status, json } = await bodyText(
    complianceWriteFailure(
      pgError('23503', 'insert or update on table "lien_waivers" violates foreign key constraint "fk_project"'),
    ),
  )
  assert.equal(status, 422)
  assert.match(String(json.error), /no longer exists|reread/i)
  assert.ok(!String(json.error).includes('lien_waivers'), 'table name leaked into the refusal')
})

for (const code of ['22P02', '22001']) {
  test(`a data-shape violation (${code}) refuses as 400 without driver internals`, async () => {
    const { status, json } = await bodyText(
      complianceWriteFailure(pgError(code, `invalid input syntax for type uuid: "not-a-uuid" (${code})`)),
    )
    assert.equal(status, 400)
    assert.match(String(json.error), /invalid shape/i)
    assert.ok(!String(json.error).includes('not-a-uuid'), 'the offending value leaked into the refusal')
  })
}

test('an unclassified driver failure is a generic 500 with a correlation id', async () => {
  // No `code`: even a realistic connection message must not reach the body.
  const { status, json } = await bodyText(
    complianceWriteFailure(new Error('remaining connection slots are reserved for superusers')),
  )
  assert.equal(status, 500)
  assert.equal(json.error, 'save failed')
  assert.match(
    String(json.correlationId),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'expected a uuid correlation id',
  )
})

test('a non-Error throw is a generic 500 with a correlation id', async () => {
  const { status, json } = await bodyText(complianceWriteFailure('bang'))
  assert.equal(status, 500)
  assert.equal(json.error, 'save failed')
  assert.ok(typeof json.correlationId === 'string' && json.correlationId.length > 0)
})
