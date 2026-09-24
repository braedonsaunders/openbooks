import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { Authz } from './authz'

// `report-execution-context` is a server module; the suite loads the REAL gate
// after stubbing the marker, so the payroll refusal below exercises the
// production check rather than a copy of it.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

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
const payrollOwner = () => reader(['reports.read', 'payroll.read'])

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
  // The scheduled render stamped the content permission set; the statement
  // kind itself passes the definition gate (reports feature only), so the
  // record is what stands between this viewer and per-employee payroll lines.
  const snapshot = glSnapshot({ requiredPermissions: ['payroll.read'] })

  const detail = await reportArtifactAccessDetail(reportsOnly(), snapshot)
  assert.equal(detail.ok, false)
  assert.deepEqual(detail.missingPermissions, ['payroll.read'])
  assert.equal(await canAccessReportArtifact(reportsOnly(), snapshot), false)
})

test('the payroll owner can download the same artifact', async () => {
  const snapshot = glSnapshot({ requiredPermissions: ['payroll.read'] })

  const detail = await reportArtifactAccessDetail(payrollOwner(), snapshot)
  assert.deepEqual(detail, { ok: true, missingPermissions: [] })
  assert.equal(await canAccessReportArtifact(payrollOwner(), snapshot), true)
})

test('snapshots that predate recording keep the definition-level gate', async () => {
  // Artifacts rendered before render-time recording carry no permission set;
  // the GL kind gate (reports.read) is the whole check, as before.
  assert.equal(await canAccessReportArtifact(reportsOnly(), glSnapshot()), true)
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
