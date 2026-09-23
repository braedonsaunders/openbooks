import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Subject-kind detail is server-only and database-backed; stub the module
// boundary so the real resolver loads under plain node, against the real
// test database like every other integration test here.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return next(specifier, context)
  },
})

const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { resolveApprovalSubjects } = await import('./approval-subjects.ts')

// A pending hire approval must show WHO the approver decides about and
// WHAT the proposal carries — never an opaque id with a blank party.
// Labels resolve through the same catalog maps the HR queue renders
// (kind labels, the effective column), so no second copy of the words.
const text = Object.assign(
  (key: string): string =>
    ({
      'me.requestKinds.hire': 'Hire',
      'queue.columns.effective': 'Effective',
    })[key] ?? key,
  {
    has: (key: string): boolean =>
      key === 'me.requestKinds.hire' || key === 'queue.columns.effective',
  },
)

const KIND = 'hrm_employment_change_request'

async function seedHire(orgId: string, subsidiaryId: string) {
  const partyId = randomUUID()
  const employmentId = randomUUID()
  const requestId = randomUUID()
  await withBypass(() => db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active)
    values (${partyId}, ${orgId}, 'person', 'Dana Employee', true)`))
  await withBypass(() => db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id)
    values (${employmentId}, ${orgId}, ${partyId}, ${subsidiaryId})`))
  await withBypass(() => db.execute(sql`
    insert into hrm_employment_change_requests
      (id, org_id, employment_id, expected_employment_revision, payload, payload_digest, payload_schema_version, status)
    values (${requestId}, ${orgId}, ${employmentId}, 1,
      '{"kind":"hire","status":"active","effectiveFrom":"2026-10-01","effectiveTo":null}'::jsonb,
      repeat('0', 64), '1', 'draft')`))
  return { partyId, employmentId, requestId }
}

test('a change-request gate resolves the employee and the decision summary', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const { requestId } = await seedHire(org.orgId, org.subsidiaryId)
    const details = await withBypass(() =>
      resolveApprovalSubjects(org.orgId, [{ kind: KIND, subjectId: requestId }], text),
    )
    const detail = details.get(`${KIND}:${requestId}`)
    assert.ok(detail, 'the seeded request must resolve')
    assert.equal(detail.partyName, 'Dana Employee')
    assert.equal(detail.summary, 'Hire · Effective 2026-10-01')
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('unresolvable subjects stay absent instead of throwing', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const details = await withBypass(() =>
      resolveApprovalSubjects(
        org.orgId,
        [
          { kind: 'close_run', subjectId: randomUUID() },
          { kind: KIND, subjectId: 'not-a-uuid' },
          { kind: KIND, subjectId: randomUUID() },
        ],
        text,
      ),
    )
    assert.equal(details.size, 0, 'kinds without a resolver, malformed ids and missing rows resolve to nothing')
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
