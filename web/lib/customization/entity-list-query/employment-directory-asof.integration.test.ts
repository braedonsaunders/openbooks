import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    return nextResolve(specifier, context)
  },
})

const { db, withBypass } = await import('../../../../engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('../../../../engine/src/testing/fixtures.ts')
const { makeEffectiveInterval, makeRecordedRevision, resolveAsOf } = await import('../../../../engine/src/hrm/temporal.ts')
const { employeeBaseJoins } = await import('./employment-directory.ts')

const TODAY = '2026-09-24'
const TOMORROW = '2026-09-25'
const FIRST_RECORDED = '2026-01-01T00:00:00Z'
const AS_KNOWN = '2030-01-01T00:00:00Z'

type Revision = {
  status: string
  effective_from: string
  effective_to: string | null
  recorded_at: string
  recorded_until: string | null
}

async function addVersion(
  orgId: string,
  employmentId: string,
  versionNo: number,
  status: string,
  from: string,
  to: string | null,
  recordedAt: string,
): Promise<void> {
  await db.execute(sql`
    insert into worker_employment_versions
      (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, ${versionNo}, ${status}, ${from}::date, ${to}::date, ${recordedAt}::timestamptz)`)
}

async function supersedeVersion(
  orgId: string,
  employmentId: string,
  status: string,
  from: string,
  to: string | null,
  reason: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`set constraints worker_employment_versions_change_tenant_fkey deferred`)
    const nextNo = ((await tx.execute<{ n: number }>(sql`
      select coalesce(max(version_no), 0)::int as n
        from worker_employment_versions where org_id = ${orgId} and employment_id = ${employmentId}`)).rows[0]?.n ?? 0) + 1
    const recordedAt = (await tx.execute<{ at: Date }>(sql`select now() as at`)).rows[0]!.at
    const prior = (await tx.execute<{ id: string; version_no: number; before: unknown }>(sql`
      select id, version_no, to_jsonb(worker_employment_versions) as before
        from worker_employment_versions
       where org_id = ${orgId} and employment_id = ${employmentId} and recorded_until is null
       order by version_no`)).rows
    const revision = (await tx.execute<{ revision: number }>(sql`
      select revision from worker_employments where org_id = ${orgId} and id = ${employmentId}`)).rows[0]!.revision + 1
    const changeId = (await tx.execute<{ id: string }>(sql`
      insert into employment_changes
        (org_id, employment_id, revision, change_kind, prior_snapshot, reason,
         recorded_source, recorded_source_ref, closed_versions)
      values (${orgId}, ${employmentId}, ${revision}, 'corrected', '{}'::jsonb, ${reason},
              'system', 'employment-directory-asof-test',
              ${JSON.stringify(prior.map((row) => ({
                table: 'worker_employment_versions',
                identity: employmentId,
                version_no: row.version_no,
                row_id: row.id,
                before: row.before,
              })))}::jsonb)
      returning id`)).rows[0]!.id
    for (const row of prior) {
      await tx.execute(sql`
        update worker_employment_versions
           set recorded_until = ${recordedAt}, superseded_by = ${nextNo}, closed_by_change_id = ${changeId}
         where id = ${row.id}`)
    }
    await tx.execute(sql`
      insert into worker_employment_versions
        (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
      values (${orgId}, ${employmentId}, ${nextNo}, ${status}, ${from}::date, ${to}::date, ${recordedAt})`)
    await tx.execute(sql`
      update worker_employments set revision = ${revision}, updated_at = now()
       where org_id = ${orgId} and id = ${employmentId}`)
  })
}

async function revisionsFor(orgId: string, employmentId: string): Promise<Revision[]> {
  return (await db.execute<Revision>(sql`
    select status, effective_from::text, effective_to::text,
           to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at,
           case when recorded_until is null then null
                else to_char(recorded_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end as recorded_until
      from worker_employment_versions
     where org_id = ${orgId} and employment_id = ${employmentId}
     order by version_no`)).rows
}

async function directoryStatus(orgId: string, partyId: string): Promise<string | null> {
  const rows = (await db.execute<{ status: string | null }>(sql`
    select emp.employment_status as status
      from parties p
      ${employeeBaseJoins(true, TODAY, null)}
     where p.org_id = ${orgId} and p.id = ${partyId}`)).rows
  return rows[0]?.status ?? null
}

function temporalStatus(revisions: Revision[]): string | null {
  try {
    const resolved = resolveAsOf(
      revisions.map((row) => makeRecordedRevision(
        makeEffectiveInterval(row.effective_from, row.effective_to),
        row.recorded_at,
        row.recorded_until,
        row.status,
      )),
      { effective: TODAY, asKnown: AS_KNOWN },
    )
    return resolved.payload
  } catch (error) {
    if ((error as { code?: string }).code === 'NO_REVISION') return null
    throw error
  }
}

test('employee directory and temporal resolver agree at an ended, boundary, and future effective date', async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const fixture = await withBypass(async () => {
      const partyId = (await db.execute<{ id: string }>(sql`
        insert into parties (org_id, kind, display_name)
        values (${scratch.orgId}, 'person', 'Directory temporal subject') returning id`)).rows[0]!.id
      const employmentId = (await db.execute<{ id: string }>(sql`
        insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id)
        values (${scratch.orgId}, ${partyId}, ${scratch.subsidiaryId}) returning id`)).rows[0]!.id
      await db.execute(sql`
        insert into employee_roles (org_id, party_id) values (${scratch.orgId}, ${partyId})`)

      // V1 is effective through yesterday. V2 starts exactly today and is
      // open-ended. The two intervals meet at today's exclusive end/start.
      await addVersion(scratch.orgId, employmentId, 1, 'terminated', '2026-01-01', TODAY, FIRST_RECORDED)
      await supersedeVersion(scratch.orgId, employmentId, 'active', TODAY, null, 'start current version at boundary')
      return { partyId, employmentId }
    })

    const currentRevisions = await withBypass(() => revisionsFor(scratch.orgId, fixture.employmentId))
    const expectedCurrent = temporalStatus(currentRevisions)
    const actualCurrent = await withBypass(() => directoryStatus(scratch.orgId, fixture.partyId))
    assert.equal(expectedCurrent, 'active', 'the current version begins on the inclusive start boundary')
    assert.equal(actualCurrent, expectedCurrent, 'the directory returns the engine-resolved current version')

    await withBypass(() => supersedeVersion(
      scratch.orgId,
      fixture.employmentId,
      'offered',
      TOMORROW,
      null,
      'future-dated successor begins tomorrow',
    ))
    const futureRevisions = await withBypass(() => revisionsFor(scratch.orgId, fixture.employmentId))
    const expectedFuture = temporalStatus(futureRevisions)
    const actualFuture = await withBypass(() => directoryStatus(scratch.orgId, fixture.partyId))
    assert.equal(expectedFuture, null, 'the future version does not cover today')
    assert.equal(actualFuture, expectedFuture, 'the directory does not project a future-dated employment into today')
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
