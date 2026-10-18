import assert from 'node:assert/strict'
import test from 'node:test'
import type { Authz } from './authz'

// `report-execution-context` is a server module; the suite loads the REAL gate
// after stubbing the marker, so the payroll refusal below exercises the
// production check rather than a copy of it.
const { canAccessReportArtifact, reportArtifactAccessDetail, snapshotReportAuthorization } = await import(
  './report-execution-context.ts'
)

function reader(permissions: string[]): Authz {
  return {
    user: {
      id: 'user-1',
      email: 'reader@example.com',
      name: 'Reader',
      roles: [],
      orgId: 'org-1',
      envKind: 'production',
      productionOrgId: 'org-1',
      isSuperAdmin: false,
      homeUserId: 'user-1',
      homeOrgId: 'org-1',
    },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  }
}

const reportsOnly = () => reader(['reports.read'])
// The general ledger statement is gated by gl.read on top of reports.read.
const glReader = () => reader(['reports.read', 'gl.read'])
const payrollOwner = () => reader(['reports.read', 'gl.read', 'payroll.read'])

function glSnapshot(extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    userId: 'owner-1',
    allowedSubsidiaryIds: null,
    definition: {
      report_type: 'statement',
      query: null,
      statement: { kind: 'general-ledger', params: {} },
      name: 'General ledger',
      slug: 'general-ledger',
      kind: 'general-ledger',
    },
    ...extra,
  }
}

test('a reports-only viewer is refused a payroll-bearing GL artifact by name', async () => {
  // The scheduled render stamped the content permission set; a viewer who
  // may open the general ledger passes the definition gate, so the record is
  // what stands between this viewer and per-employee payroll lines.
  const snapshot = glSnapshot({ requiredPermissions: ['payroll.read'] })

  const detail = await reportArtifactAccessDetail(glReader(), snapshot)
  assert.equal(detail.ok, false)
  assert.deepEqual(detail.missingPermissions, ['payroll.read'])
  assert.equal(await canAccessReportArtifact(glReader(), snapshot), false)
})

test('the payroll owner can download the same artifact', async () => {
  const snapshot = glSnapshot({ requiredPermissions: ['payroll.read'] })

  const detail = await reportArtifactAccessDetail(payrollOwner(), snapshot)
  assert.deepEqual(detail, { ok: true, missingPermissions: [] })
  assert.equal(await canAccessReportArtifact(payrollOwner(), snapshot), true)
})

test('snapshots that predate recording keep the definition-level gate', async () => {
  // Artifacts rendered before render-time recording carry no permission set;
  // the GL kind gate (reports.read and gl.read) is the whole check, as before.
  assert.equal(await canAccessReportArtifact(glReader(), glSnapshot()), true)
})

test('a malformed permission record fails closed without names to give', async () => {
  const detail = await reportArtifactAccessDetail(
    payrollOwner(),
    glSnapshot({ requiredPermissions: 'payroll.read' }),
  )
  assert.equal(detail.ok, false)
  assert.deepEqual(detail.missingPermissions, [])
})

test('schedule snapshots record the entity permission for query definitions', () => {
  const payrollRegister = snapshotReportAuthorization(payrollOwner(), {
    report_type: 'query',
    query: { entity: 'pay_stubs' },
    statement: null,
    name: 'Pay stubs',
    slug: 'pay-stubs',
    kind: 'custom',
  })
  assert.deepEqual(payrollRegister.requiredPermissions, ['payroll.read'])

  const openRegister = snapshotReportAuthorization(reportsOnly(), {
    report_type: 'query',
    query: { entity: 'documents' },
    statement: null,
    name: 'Documents',
    slug: 'documents',
    kind: 'custom',
  })
  assert.equal(openRegister.requiredPermissions, undefined)

  // Statement content is data-dependent: nothing is recorded at schedule
  // time; the render stamps it.
  const statement = snapshotReportAuthorization(payrollOwner(), {
    report_type: 'statement',
    query: null,
    statement: { kind: 'general-ledger', params: {} },
    name: 'General ledger',
    slug: 'general-ledger',
    kind: 'general-ledger',
  })
  assert.equal(statement.requiredPermissions, undefined)
})

function documentsSnapshot(extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    userId: 'owner-1',
    allowedSubsidiaryIds: null,
    definition: { report_type: 'query' as const, query: { entity: 'documents' }, statement: null, name: 'Documents', slug: 'documents', kind: 'custom' },
    ...extra,
  }
}

const selfService = (id: string) => ({ ...reader(['reports.read', 'expenses.self']), user: { ...reader([]).user, id, homeUserId: id } })

test('a stored report over expense-bearing rows records the expense reports it holds', () => {
  const definition = documentsSnapshot().definition
  assert.deepEqual(snapshotReportAuthorization(reader(['reports.read', 'expenses.read']), definition).expenseRows, { scope: 'all' })
  assert.deepEqual(snapshotReportAuthorization(selfService('user-7'), definition).expenseRows, { scope: 'own', userId: 'user-7' })
  assert.deepEqual(snapshotReportAuthorization(reportsOnly(), definition).expenseRows, { scope: 'none' })
  // Entities without expense report rows record nothing.
  assert.equal(snapshotReportAuthorization(reader(['reports.read', 'expenses.read']), { ...definition, query: { entity: 'accounts' } }).expenseRows, undefined)
})

test('stored expense report rows reach only readers with the same expense reach', async () => {
  const everyReport = documentsSnapshot({ expenseRows: { scope: 'all' } })
  assert.deepEqual(await reportArtifactAccessDetail(reportsOnly(), everyReport), { ok: false, missingPermissions: ['expenses.read'] })
  assert.deepEqual(await reportArtifactAccessDetail(selfService('user-7'), everyReport), { ok: false, missingPermissions: ['expenses.read'] })
  assert.deepEqual(await reportArtifactAccessDetail(reader(['reports.read', 'expenses.read']), everyReport), { ok: true, missingPermissions: [] })

  const ownReports = documentsSnapshot({ expenseRows: { scope: 'own', userId: 'user-7' } })
  assert.equal(await canAccessReportArtifact(selfService('user-7'), ownReports), true, 'the self-service author reads their own run')
  assert.equal(await canAccessReportArtifact(selfService('user-8'), ownReports), false, "another employee's reports stay with them")
  assert.equal(await canAccessReportArtifact(reportsOnly(), ownReports), false)
  assert.equal(await canAccessReportArtifact(reader(['reports.read', 'expenses.read']), ownReports), true)

  const noReports = documentsSnapshot({ expenseRows: { scope: 'none' } })
  assert.equal(await canAccessReportArtifact(reportsOnly(), noReports), true, 'output that excluded expense reports stays open to report readers')
})

test('an expense-bearing artifact with no recorded reach is treated as holding every report', async () => {
  assert.deepEqual(await reportArtifactAccessDetail(reportsOnly(), documentsSnapshot()), { ok: false, missingPermissions: ['expenses.read'] })
  assert.equal(await canAccessReportArtifact(reader(['reports.read', 'expenses.read']), documentsSnapshot()), true)
  // The principal behind a background render is re-authorized without it:
  // that render's rows are clamped by the principal's current expense read.
  assert.deepEqual(await reportArtifactAccessDetail(reportsOnly(), documentsSnapshot(), { expenseReach: false }), { ok: true, missingPermissions: [] })
})

test('a render whose expense reach exceeds its recorded authorization is not delivered', async () => {
  const { expenseRowsWithin } = await import('./report-execution-context.ts')
  assert.equal(expenseRowsWithin(undefined, { scope: 'none' }), true, 'content without expense rows')
  assert.equal(expenseRowsWithin({ scope: 'none' }, { scope: 'own', userId: 'user-7' }), true)
  assert.equal(expenseRowsWithin({ scope: 'own', userId: 'user-7' }, { scope: 'own', userId: 'user-7' }), true)
  assert.equal(expenseRowsWithin({ scope: 'all' }, { scope: 'own', userId: 'user-7' }), false)
  assert.equal(expenseRowsWithin({ scope: 'own', userId: 'user-7' }, { scope: 'none' }), false)
  assert.equal(expenseRowsWithin({ scope: 'all' }, undefined), true, 'evidence that predates recording covers every report')
})
