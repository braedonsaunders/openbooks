import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import type { ScratchOrg } from '../../engine/src/testing/fixtures.ts'
import type { Authz } from './authz.ts'

// Static imports hoist past the shim below, so every module that (even
// transitively) imports the RSC `server-only` marker loads dynamically after
// it — the same seam as web/lib/custom-reports-open-ar.integration.test.ts.
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(s, c)
  },
})
const { db, pool, withBypass, withOrgContext } = await import('../../engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg, seedApprovalFlow } = await import(
  '../../engine/src/testing/fixtures.ts'
)
const { REPORT_ENTITY_MAP } = await import('../../packages/reports/src/entities.ts')
const { runCustomQuery } = await import('../../packages/reports/src/run.ts')
const { BUILT_IN_REPORT_DEFINITION_MAP } = await import('../../packages/reports/src/built-ins.ts')
const { canRunReportEntity, hiddenReportEntityKeys } = await import('./report-authz.ts')
const { createChangeRequestDraft, submitChangeRequest } = await import(
  '../../engine/src/hrm/change-requests.ts'
)
const { HRM_CHANGE_REQUEST_SUBJECT_KIND } = await import('../../schema/src/hrm-change-requests.ts')
const { decideGate } = await import('../../engine/src/flows/gates.ts')

/**
 * Slice G DB coverage (integration partition): the three workforce report
 * entities execute against real 0184/0185 fixtures — headcount as-of across
 * a superseded version with FTE from the effective primary assignment,
 * full version history with closure evidence, and the change-request
 * register across draft/pending/decided states; subsidiary scope clamps rows
 * and the shared run-path gate refuses without the permission or the hrm
 * feature. Runs against the reviewer's own database; never touches shared
 * fixtures.
 */

const DB = !!process.env.OPENBOOKS_DB_URL
const T0 = '2026-01-01T00:00:00Z'

async function enableHrm(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${orgId}`)
}

async function grantPermissions(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `)
  }
}

async function linkPerson(orgId: string, userId: string, name: string): Promise<string> {
  const person = (await db.execute<{ id: string }>(sql`
    insert into parties (org_id, kind, display_name) values (${orgId}, 'person', ${name}) returning id`)).rows[0]!.id
  await db.execute(sql`update users set party_id = ${person} where id = ${userId} and org_id = ${orgId}`)
  return person
}

async function mkDepartment(orgId: string, name: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into departments (org_id, name) values (${orgId}, ${name}) returning id`)).rows[0]!.id
}

async function mkSubsidiary(orgId: string, name: string, parentId: string): Promise<string> {
  // One root per org (subsidiaries_org_root): further legal entities hang
  // under the scratch root, exactly like a real subsidiary tree.
  return (await db.execute<{ id: string }>(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (gen_random_uuid(), ${orgId}, ${parentId}, ${name}, 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
    returning id`)).rows[0]!.id
}

async function mkWorker(orgId: string, name: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into parties (org_id, kind, display_name) values (${orgId}, 'person', ${name}) returning id`)).rows[0]!.id
}

async function mkEmployment(orgId: string, workerId: string, subsidiaryId: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id)
    values (${orgId}, ${workerId}, ${subsidiaryId}) returning id`)).rows[0]!.id
}

/** One live version, no predecessor (test-only canonical writer). */
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

/**
 * Close the live version with a superseding successor plus the ONE aggregate
 * employment_changes event evidencing the closure (same shape as the apply
 * path: close, successor and event commit together for the deferred guards).
 */
async function supersedeVersion(
  orgId: string,
  employmentId: string,
  args: { status: string; from: string; to: string | null; reason: string; kind: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`set constraints worker_employment_versions_change_tenant_fkey deferred`)
    const maxRow = (await tx.execute<{ n: number }>(sql`
      select coalesce(max(version_no), 0)::int as n from worker_employment_versions
       where org_id = ${orgId} and employment_id = ${employmentId}`)).rows[0]
    const versionNo = (maxRow?.n ?? 0) + 1
    const now = (await tx.execute<{ now: Date }>(sql`select now() as now`)).rows[0]!.now
    const prior = (await tx.execute<{ id: string; version_no: number; before: unknown }>(sql`
      select id, version_no, to_jsonb(worker_employment_versions) as before
        from worker_employment_versions
       where org_id = ${orgId} and employment_id = ${employmentId} and recorded_until is null
       order by version_no`)).rows
    const newRevision = (await tx.execute<{ revision: number }>(sql`
      select revision from worker_employments where org_id = ${orgId} and id = ${employmentId}`)).rows[0]!.revision + 1
    const changeId = (await tx.execute<{ id: string }>(sql`
      insert into employment_changes
        (org_id, employment_id, revision, change_kind, prior_snapshot, reason,
         recorded_source, recorded_source_ref, closed_versions)
      values (${orgId}, ${employmentId}, ${newRevision},
              ${args.kind}, '{}'::jsonb, ${args.reason},
              'system', 'slice-g-seed',
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
           set recorded_until = ${now}, superseded_by = ${versionNo}, closed_by_change_id = ${changeId}
         where id = ${row.id}`)
    }
    await tx.execute(sql`
      insert into worker_employment_versions
        (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
      values (${orgId}, ${employmentId}, ${versionNo}, ${args.status}, ${args.from}::date, ${args.to}::date, ${now})`)
    await tx.execute(sql`
      update worker_employments set revision = ${newRevision}, updated_at = now()
       where org_id = ${orgId} and id = ${employmentId}`)
  })
}

async function mkPrimaryAssignment(
  orgId: string,
  employmentId: string,
  departmentId: string,
  fte: string,
): Promise<void> {
  const slot = (await db.execute<{ id: string }>(sql`
    insert into employment_assignments (org_id, employment_id, assignment_key)
    values (${orgId}, ${employmentId}, 'primary') returning id`)).rows[0]!.id
  await db.execute(sql`
    insert into employment_assignment_versions
      (org_id, assignment_id, employment_id, version_no, job_title, department_id, fte, is_primary,
       effective_from, recorded_at)
    values (${orgId}, ${slot}, ${employmentId}, 1, 'Cashier', ${departmentId}, ${fte}, true,
      '2026-01-01'::date, ${T0}::timestamptz)`)
}

function rowByHeadings(result: { groups: { columns: string[]; rows: unknown[][] }[] }, index = 0): Record<string, unknown> {
  const group = result.groups[index]!
  return Object.fromEntries(group.rows[0]!.map((cell, i) => [group.columns[i], cell]))
}

function fakeAuthz(orgId: string, permissions: string[], allowedSubsidiaryIds: string[] | null): Authz {
  return {
    user: {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'slice-g@example.test',
      name: 'Slice G',
      roles: [],
      orgId,
      envKind: 'sandbox',
      productionOrgId: orgId,
      isSuperAdmin: false,
      homeUserId: '00000000-0000-4000-8000-000000000001',
      homeOrgId: orgId,
    },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: allowedSubsidiaryIds === null ? null : new Set(allowedSubsidiaryIds),
  }
}

test('headcount counts in-service employments at the as-of day across a superseded version', { skip: !DB }, async () => {
  const scratch: ScratchOrg = await withBypass(() => createScratchOrg())
  try {
    await withBypass(async () => {
      await enableHrm(scratch.orgId)
      const front = await mkDepartment(scratch.orgId, 'Front')
      const back = await mkDepartment(scratch.orgId, 'Back')
      const second = await mkSubsidiary(scratch.orgId, 'Second Co', scratch.subsidiaryId)
      // A: same-window correction — v1 superseded with evidence, v2 live over
      // the same span. The closed version must never double-count.
      const empA = await mkEmployment(scratch.orgId, await mkWorker(scratch.orgId, 'Worker Ada'), scratch.subsidiaryId)
      await addVersion(scratch.orgId, empA, 1, 'active', '2026-01-01', null, T0)
      await supersedeVersion(scratch.orgId, empA, {
        status: 'active', from: '2026-01-01', to: null, reason: 'correct start date', kind: 'corrected',
      })
      await mkPrimaryAssignment(scratch.orgId, empA, front, '1.0000')
      // B: active from Mar, half-time, same subsidiary and department.
      const empB = await mkEmployment(scratch.orgId, await mkWorker(scratch.orgId, 'Worker Bo'), scratch.subsidiaryId)
      await addVersion(scratch.orgId, empB, 1, 'active', '2026-03-01', null, T0)
      await mkPrimaryAssignment(scratch.orgId, empB, front, '0.5000')
      // C: on leave from Feb at the second subsidiary (still in service).
      const empC = await mkEmployment(scratch.orgId, await mkWorker(scratch.orgId, 'Worker Cy'), second)
      await addVersion(scratch.orgId, empC, 1, 'on_leave', '2026-02-01', null, T0)
      await mkPrimaryAssignment(scratch.orgId, empC, back, '1.0000')
      // D: fixed stint Apr–May with no assignment (unattributed, no FTE).
      const empD = await mkEmployment(scratch.orgId, await mkWorker(scratch.orgId, 'Worker Di'), scratch.subsidiaryId)
      await addVersion(scratch.orgId, empD, 1, 'active', '2026-04-01', '2026-06-01', T0)
      // E: terminated as the latest version — out at every as-of under
      // current knowledge, exactly like the read service skipping a
      // NoRevisionError rather than counting a row.
      const empE = await mkEmployment(scratch.orgId, await mkWorker(scratch.orgId, 'Worker Ed'), scratch.subsidiaryId)
      await addVersion(scratch.orgId, empE, 1, 'active', '2026-01-01', '2026-02-01', T0)
      await supersedeVersion(scratch.orgId, empE, {
        status: 'terminated', from: '2026-02-01', to: null, reason: 'resigned — relocation', kind: 'terminated',
      })
      await mkPrimaryAssignment(scratch.orgId, empE, front, '1.0000')
    })

    await withOrgContext(scratch.orgId, async () => {
      const run = (asOf: string) => runCustomQuery(pool, {
        entity: 'hrm_headcount',
        mode: 'rows',
        columns: ['subsidiary', 'department', 'headcount', 'fte_total'],
      }, { orgId: scratch.orgId, entityMap: REPORT_ENTITY_MAP, asOf })

      // Before anyone is effective: a resolved zero, not a failure.
      assert.equal((await run('2025-12-01')).rowCount, 0)

      // Ada alone, full-time, before the June succession.
      const jan = await run('2026-01-15')
      assert.equal(jan.rowCount, 1)
      assert.deepEqual(rowByHeadings(jan), {
        Subsidiary: 'Main Co',
        Department: 'Front',
        Headcount: '1',
        'FTE total': '1.00',
      })

      // May: Ada + Bo in Front (FTE sums), Di unattributed with no FTE, Cy on leave at Second.
      const may = await run('2026-05-01')
      assert.equal(may.rowCount, 3)
      const byDept = new Map(
        may.groups[0]!.rows.map((cells) => [String(cells[1] ?? '(none)'), cells]),
      )
      assert.deepEqual(byDept.get('Front')?.slice(2), ['2', '1.50'])
      assert.deepEqual(byDept.get('(none)')?.slice(0, 3), ['Main Co', null, '1'])
      assert.equal(byDept.get('(none)')?.[3], null)
      assert.deepEqual(byDept.get('Back'), ['Second Co', 'Back', '1', '1.00'])

      // July: Di's stint has ended and Ed's terminated latest version stays
      // out — the count follows the effective version in service at the
      // as-of day, never the row count.
      const jul = await run('2026-07-15')
      assert.equal(jul.rowCount, 2)
      const julFront = jul.groups[0]!.rows.find((cells) => cells[1] === 'Front')!
      assert.deepEqual(julFront.slice(2), ['2', '1.50'])

      // The seeded statement preset runs verbatim: one row per group, and
      // the org total rides the shared summary band into ExportData.
      const statement = await runCustomQuery(
        pool, BUILT_IN_REPORT_DEFINITION_MAP['headcount-statement']!.query,
        { orgId: scratch.orgId, entityMap: REPORT_ENTITY_MAP, asOf: '2026-05-01' },
      )
      assert.equal(statement.rowCount, 3)
      assert.deepEqual(
        statement.summary.map((item) => [item.label, item.value]),
        [['Groups', 3], ['Total headcount', '4'], ['Total full-time equivalents', '2.50']],
      )
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

test('employment history reads every version with its closure evidence', { skip: !DB }, async () => {
  const scratch: ScratchOrg = await withBypass(() => createScratchOrg())
  try {
    await withBypass(async () => {
      await enableHrm(scratch.orgId)
      const front = await mkDepartment(scratch.orgId, 'Front')
      const empA = await mkEmployment(scratch.orgId, await mkWorker(scratch.orgId, 'Worker Ada'), scratch.subsidiaryId)
      await addVersion(scratch.orgId, empA, 1, 'active', '2026-01-01', '2026-06-01', T0)
      await supersedeVersion(scratch.orgId, empA, {
        status: 'terminated', from: '2026-06-01', to: null, reason: 'resigned — relocation', kind: 'terminated',
      })
      await mkPrimaryAssignment(scratch.orgId, empA, front, '1.0000')
    })

    await withOrgContext(scratch.orgId, async () => {
      const history = await runCustomQuery(pool, {
        entity: 'hrm_employment_history',
        mode: 'rows',
        columns: ['person', 'employer', 'status', 'effective_from', 'effective_to', 'recorded_at', 'version_no', 'change_reason'],
      }, { orgId: scratch.orgId, entityMap: REPORT_ENTITY_MAP })
      assert.equal(history.rowCount, 2)
      const headings = history.groups[0]!.columns
      const rows = history.groups[0]!.rows.map(
        (cells) => Object.fromEntries(cells.map((cell, i) => [headings[i], cell])),
      )
      const closed = rows.find((r) => r['Version'] === '1')!
      assert.equal(closed['Person'], 'Worker Ada')
      assert.equal(closed['Employer'], 'Main Co')
      assert.equal(closed['Status'], 'active')
      assert.equal(closed['Change reason'], 'resigned — relocation')
      const live = rows.find((r) => r['Version'] === '2')!
      assert.equal(live['Status'], 'terminated')
      assert.equal(live['Change reason'], null)

      // Filterable by status: only the superseded active version matches.
      const active = await runCustomQuery(pool, {
        entity: 'hrm_employment_history',
        mode: 'rows',
        columns: ['person', 'status'],
        filters: { combinator: 'and', rules: [{ field: 'status', op: 'eq', value: 'active' }] },
      }, { orgId: scratch.orgId, entityMap: REPORT_ENTITY_MAP })
      assert.equal(active.rowCount, 1)
      assert.equal(rowByHeadings(active)['Person'], 'Worker Ada')
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

test('change-request register reads drafts, pending and decided requests', { skip: !DB }, async () => {
  const scratch: ScratchOrg = await withBypass(() => createScratchOrg())
  try {
    // Fixtures commit first: the services below run in their own tenant
    // transactions on separate connections, so they can only read committed
    // rows — seeding and calling in one transaction would hide the grants.
    const ids = await withBypass(async () => {
      await enableHrm(scratch.orgId)
      const submitterId = await createScratchUser(scratch.orgId, 'Slice G Submitter', 'slice_g_submitter')
      const approverId = await createScratchUser(scratch.orgId, 'Slice G Approver', 'slice_g_approver')
      await grantPermissions(scratch.orgId, submitterId, ['hrm.employment.read', 'hrm.employment.manage'])
      await grantPermissions(scratch.orgId, approverId, ['hrm.employment.read', 'hrm.employment.approve'])
      await linkPerson(scratch.orgId, submitterId, 'Submitter Sue')
      await linkPerson(scratch.orgId, approverId, 'Approver Al')
      await seedApprovalFlow(scratch.orgId, {
        subjectKind: HRM_CHANGE_REQUEST_SUBJECT_KIND,
        assignees: [{ type: 'user', userId: approverId }],
        mode: 'any',
      })
      const reserve = async (name: string): Promise<string> =>
        mkEmployment(scratch.orgId, await mkWorker(scratch.orgId, name), scratch.subsidiaryId)
      const empDraft = await reserve('Worker Draft')
      const empPending = await reserve('Worker Pending')
      await addVersion(scratch.orgId, empPending, 1, 'active', '2026-01-01', null, T0)
      const empApplied = await reserve('Worker Applied')
      return { submitterId, approverId, empDraft, empPending, empApplied }
    })
    // Service calls at top level like the engine suites: ambient bypass for
    // their autocommit reads, tenant transactions inside.
    // Draft hire: never submitted, so no submission evidence is fabricated.
    await createChangeRequestDraft({
      orgId: scratch.orgId, actorId: ids.submitterId, employmentId: ids.empDraft,
      payload: { kind: 'hire', status: 'active', effectiveFrom: '2026-09-01' },
    })
    // Pending status change on a versioned employment.
    const pending = await createChangeRequestDraft({
      orgId: scratch.orgId, actorId: ids.submitterId, employmentId: ids.empPending,
      payload: { kind: 'status_change', status: 'on_leave', effectiveFrom: '2026-10-01' },
    })
    await submitChangeRequest({
      orgId: scratch.orgId, actorId: ids.submitterId, requestId: pending.id, reason: 'parental leave',
    })
    // Decided hire: submit then approve, so the snapshot binds the decision.
    const decided = await createChangeRequestDraft({
      orgId: scratch.orgId, actorId: ids.submitterId, employmentId: ids.empApplied,
      payload: { kind: 'hire', status: 'active', effectiveFrom: '2026-09-01' },
    })
    await submitChangeRequest({
      orgId: scratch.orgId, actorId: ids.submitterId, requestId: decided.id, reason: 'backfill the cohort',
    })
    // Explicitly scoped: RLS denies context-free reads with zero rows (never
    // an error), so this must not ride on ambient test bypass.
    const gate = await withOrgContext(scratch.orgId, async () => (await db.execute<{ id: string }>(sql`
      select id from flow_gates where subject_id = ${decided.id} order by created_at`)).rows[0]!.id)
    // decideGate reads the gate under tenant RLS as well; scope the decision like the lookup.
    const outcome = await withOrgContext(scratch.orgId, () =>
      decideGate({ gateId: gate, decision: 'approved', userId: ids.approverId }))
    assert.equal(outcome.ok, true)

    await withOrgContext(scratch.orgId, async () => {
      const register = await runCustomQuery(pool, {
        entity: 'hrm_change_requests',
        mode: 'rows',
        columns: ['status', 'kind', 'employment', 'employer', 'requested_by', 'submitted_at',
          'decided_at', 'flow_run_id', 'request_revision', 'expected_employment_revision', 'reason'],
      }, { orgId: scratch.orgId, entityMap: REPORT_ENTITY_MAP })
      assert.equal(register.rowCount, 3)
      const rows = register.groups[0]!.rows.map(
        (cells) => Object.fromEntries(cells.map((cell, i) => [register.groups[0]!.columns[i], cell])),
      )
      const byWorker = new Map(rows.map((r) => [r['Employment'], r]))

      const draft = byWorker.get('Worker Draft')!
      assert.equal(draft['Status'], 'draft')
      assert.equal(draft['Kind'], 'hire')
      assert.equal(draft['Requested by'], null)
      assert.equal(draft['Submitted at'], null)
      assert.equal(draft['Decided at'], null)
      assert.equal(draft['Approval run (id)'], null)

      const pending = byWorker.get('Worker Pending')!
      assert.equal(pending['Status'], 'pending approval')
      assert.equal(pending['Kind'], 'status change')
      assert.equal(pending['Requested by'], 'Slice G Submitter')
      assert.ok(pending['Submitted at'])
      assert.equal(pending['Decided at'], null)
      assert.ok(pending['Approval run (id)'])
      assert.equal(pending['Expected employment revision'], '1')

      const applied = byWorker.get('Worker Applied')!
      assert.equal(applied['Status'], 'applied')
      assert.equal(applied['Requested by'], 'Slice G Submitter')
      assert.ok(applied['Submitted at'])
      assert.ok(applied['Decided at'], 'the decided stamp comes from the decision snapshot')
      assert.ok(applied['Approval run (id)'])

      // Filterable by status and date range.
      const onlyPending = await runCustomQuery(pool, {
        entity: 'hrm_change_requests',
        mode: 'rows',
        columns: ['employment', 'status'],
        filters: { combinator: 'and', rules: [{ field: 'status', op: 'eq', value: 'pending_approval' }] },
      }, { orgId: scratch.orgId, entityMap: REPORT_ENTITY_MAP })
      assert.equal(onlyPending.rowCount, 1)
      assert.equal(rowByHeadings(onlyPending)['Employment'], 'Worker Pending')

      const ranged = await runCustomQuery(pool, {
        entity: 'hrm_change_requests',
        mode: 'rows',
        columns: ['employment'],
        filters: { combinator: 'and', rules: [{ field: 'created_at', op: 'gte', value: '2026-01-01' }] },
      }, { orgId: scratch.orgId, entityMap: REPORT_ENTITY_MAP })
      assert.equal(ranged.rowCount, 3)
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

test('subsidiary scope clamps workforce rows and the shared gate refuses', { skip: !DB }, async () => {
  const scratch: ScratchOrg = await withBypass(() => createScratchOrg())
  const dark: ScratchOrg = await withBypass(() => createScratchOrg())
  try {
    let second = ''
    await withBypass(async () => {
      await enableHrm(scratch.orgId)
      // HR-13 begin: the construction switch needs its payroll, projects
      // and time-tracking requirements resolved before the new entities
      // run for the permitted reader below.
      await db.execute(sql`
        update orgs set settings = coalesce(settings, '{}'::jsonb)
          || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb)
            || '{"payroll": true, "projects": true, "timeTracking": true, "hrmConstructionCompliance": true}'::jsonb)
         where id = ${scratch.orgId}
      `)
      // HR-13 end
      second = await mkSubsidiary(scratch.orgId, 'Second Co', scratch.subsidiaryId)
      const empA = await mkEmployment(scratch.orgId, await mkWorker(scratch.orgId, 'Worker Ada'), scratch.subsidiaryId)
      await addVersion(scratch.orgId, empA, 1, 'active', '2026-01-01', null, T0)
      const empC = await mkEmployment(scratch.orgId, await mkWorker(scratch.orgId, 'Worker Cy'), second)
      await addVersion(scratch.orgId, empC, 1, 'active', '2026-01-01', null, T0)
    })

    await withOrgContext(scratch.orgId, async () => {
      // Unrestricted: both subsidiaries count.
      const all = await runCustomQuery(pool, {
        entity: 'hrm_headcount',
        mode: 'rows',
        columns: ['subsidiary', 'headcount'],
      }, { orgId: scratch.orgId, entityMap: REPORT_ENTITY_MAP, asOf: '2026-05-01' })
      assert.equal(all.rowCount, 2)
      // Restricted to the main subsidiary: the second subsidiary's row is
      // fenced out by the scope predicate, not merely hidden.
      const main = await runCustomQuery(pool, {
        entity: 'hrm_headcount',
        mode: 'rows',
        columns: ['subsidiary', 'headcount'],
      }, {
        orgId: scratch.orgId,
        entityMap: REPORT_ENTITY_MAP,
        asOf: '2026-05-01',
        allowedSubsidiaryIds: [scratch.subsidiaryId],
      })
      assert.equal(main.rowCount, 1)
      assert.equal(rowByHeadings(main)['Subsidiary'], 'Main Co')
      // An employment scoped to nothing visible counts nothing.
      const none = await runCustomQuery(pool, {
        entity: 'hrm_headcount',
        mode: 'rows',
        columns: ['subsidiary', 'headcount'],
      }, {
        orgId: scratch.orgId,
        entityMap: REPORT_ENTITY_MAP,
        asOf: '2026-05-01',
        allowedSubsidiaryIds: [],
      })
      assert.equal(none.rowCount, 0)
    })

    // The run-path gate: permission + feature, never empty rows. Each
    // principal reads under its own org scope — RLS denies context-free
    // reads with zero rows (never an error), so these must not ride on
    // ambient test bypass.
    // A reader holding every HRM read grant sees every HRM entity: scope
    // clamping bounds ROWS, never the catalogue.
    const reader = fakeAuthz(scratch.orgId, ['reports.read', 'hrm.employment.read', 'hrm.position.read', 'hrm.process.read', 'hrm.leave.read', 'hrm.recruiting.read', 'hrm.performance.read', 'hrm.retention.read', 'hrm.benefits.read',
      // HR-13 begin: the construction grant, so the five new entities run.
      'hrm.construction.read',
      // HR-13 end
    ], null)
    await withOrgContext(scratch.orgId, async () => {
      for (const key of ['hrm_headcount', 'hrm_employment_history', 'hrm_change_requests', 'hrm_positions', 'hrm_processes', 'hrm_leave_absences', 'hrm_requisitions', 'hrm_applications', 'hrm_reviews', 'hrm_goals', 'hrm_turnover', 'hrm_benefit_enrollments',
        // HR-13 begin
        'hrm_rate_schedule_lines', 'hrm_per_diem_entries', 'hrm_comp_class_split', 'hrm_certified_runs', 'hrm_compliance_findings',
        // HR-13 end
      ] as const) {
        assert.equal(await canRunReportEntity(reader, { entity: key }), true, `${key} runs for a permitted reader`)
      }
      assert.ok(!(await hiddenReportEntityKeys(reader)).some((key) => key.startsWith('hrm_')), 'hrm entities stay listed')
    })
    // Hiding is by PERMISSION, entity by entity: without the headcount-plan
    // grant exactly the positions entity hides, and the employment ones stay.
    const employmentOnly = fakeAuthz(scratch.orgId, ['reports.read', 'hrm.employment.read'], null)
    await withOrgContext(scratch.orgId, async () => {
      const hiddenHrm = (await hiddenReportEntityKeys(employmentOnly)).filter((key) => key.startsWith('hrm_')).sort()
      assert.deepEqual(hiddenHrm, ['hrm_applications', 'hrm_benefit_enrollments',
        // HR-13 begin: construction entities hide without their grant.
        'hrm_certified_runs', 'hrm_comp_class_split', 'hrm_compliance_findings',
        // HR-13 end
        'hrm_goals', 'hrm_leave_absences', 'hrm_per_diem_entries', 'hrm_positions', 'hrm_processes',
        // HR-13 begin
        'hrm_rate_schedule_lines',
        // HR-13 end
        'hrm_requisitions', 'hrm_reviews', 'hrm_turnover'], 'only the entities whose grants are missing hide')
    })

    const noPerm = fakeAuthz(scratch.orgId, ['reports.read'], null)
    await withOrgContext(scratch.orgId, async () => {
      for (const key of ['hrm_headcount', 'hrm_employment_history', 'hrm_change_requests', 'hrm_positions'] as const) {
        assert.equal(await canRunReportEntity(noPerm, { entity: key }), false, `${key} refuses without the permission`)
      }
      // Every HRM entity hides for a reader holding no HRM grant (each one
      // names its own permission); the list grows with each HRM entity.
      assert.deepEqual(
        (await hiddenReportEntityKeys(noPerm)).filter((key) => key.startsWith('hrm_')).sort(),
        ['hrm_action_reasons', 'hrm_applications', 'hrm_benefit_enrollments', 'hrm_change_requests', 'hrm_employment_history', 'hrm_goals', 'hrm_headcount', 'hrm_leave_absences', 'hrm_positions', 'hrm_processes', 'hrm_requisitions', 'hrm_reviews', 'hrm_turnover'],
        ['hrm_applications', 'hrm_benefit_enrollments', 'hrm_certified_runs', 'hrm_change_requests', 'hrm_comp_class_split', 'hrm_compliance_findings', 'hrm_employment_history', 'hrm_goals', 'hrm_headcount', 'hrm_leave_absences', 'hrm_per_diem_entries', 'hrm_positions', 'hrm_processes', 'hrm_rate_schedule_lines', 'hrm_requisitions', 'hrm_reviews', 'hrm_turnover'],
      )
    })

    // Feature off (never enabled on this org): every execution path refuses.
    const darkReader = fakeAuthz(dark.orgId, ['reports.read', 'hrm.employment.read'], null)
    await withOrgContext(dark.orgId, async () => {
      for (const key of ['hrm_headcount', 'hrm_employment_history', 'hrm_change_requests'] as const) {
        assert.equal(await canRunReportEntity(darkReader, { entity: key }), false, `${key} refuses with the feature off`)
      }
      assert.deepEqual(
        (await hiddenReportEntityKeys(darkReader)).filter((key) => key.startsWith('hrm_')).sort(),
        ['hrm_action_reasons', 'hrm_applications', 'hrm_benefit_enrollments', 'hrm_change_requests', 'hrm_employment_history', 'hrm_goals', 'hrm_headcount', 'hrm_leave_absences', 'hrm_positions', 'hrm_processes', 'hrm_requisitions', 'hrm_reviews', 'hrm_turnover'],
        ['hrm_applications', 'hrm_benefit_enrollments', 'hrm_certified_runs', 'hrm_change_requests', 'hrm_comp_class_split', 'hrm_compliance_findings', 'hrm_employment_history', 'hrm_goals', 'hrm_headcount', 'hrm_leave_absences', 'hrm_per_diem_entries', 'hrm_positions', 'hrm_processes', 'hrm_rate_schedule_lines', 'hrm_requisitions', 'hrm_reviews', 'hrm_turnover'],
      )
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
    await withBypass(() => dropScratchOrg(dark.orgId))
  }
})
