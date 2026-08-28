import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function source(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), 'utf8')
}

function count(haystack: string, needle: string): number {
  let n = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    n += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return n
}

/**
 * Subsidiary restriction is a visibility POLICY inside the tenant: the lists
 * narrow every query through allowedSubsidiaryIds (documentWhere's
 * `d.subsidiary_id = any(...)`; the party lists' `is null or = any(...)`).
 *
 * That promise only holds if a restricted caller cannot reach the very same
 * records by guessing an id. This file pins the CAUSAL chain for every direct
 * record boundary: the route loads the record's subsidiary alongside its org
 * scope, consults the shared gate BEFORE anything about the record is
 * disclosed or written, and fails closed — out-of-scope reads exactly like
 * nonexistent, writes to out-of-scope subsidiaries (including allocation /
 * selection targets) are refused, and global search applies the identical
 * predicates its lists apply.
 */

// ---------------------------------------------------------------------------
// The shared gate keeps the rule (source-level semantics, fail closed)
// ---------------------------------------------------------------------------

test('subsidiaryScopeAllows fails closed on every unknown subsidiary', () => {
  const src = source('lib/authz.ts')
  // Unrestricted callers (null set) pass — there is no policy to violate.
  assert.match(src, /export function subsidiaryScopeAllows\(/)
  assert.ok(src.includes('if (scope === null) return true'))
  // Restricted callers: a record whose subsidiary cannot be resolved (null/'')
  // is denied unless the boundary explicitly declares org-wide rows.
  assert.ok(src.includes('return opts.orgWideNull === true'))
  // Everything else must be an explicit member of the allowed set.
  assert.ok(src.includes('return scope.has(subsidiaryId)'))
})

test('guardSubsidiaryScope denies with the same response as a missing record', () => {
  const src = source('lib/authz.ts')
  assert.match(src, /export function guardSubsidiaryScope\(/)
  assert.match(src, /status: 404/)
  assert.match(src, /error: "not found"/)
})

test('subsidiariesInScope refuses assigning records outside the visible set', () => {
  const src = source('lib/authz.ts')
  assert.match(src, /export function subsidiariesInScope\(/)
  assert.match(src, /ids\.every\(\(id\) => id !== null && id !== undefined && id !== "" && scope\.has\(id\)\)/)
})

test('the shared documents filter degrades to deny-all for an empty scope', () => {
  const src = source('lib/subsidiaries.ts')
  assert.match(src, /export function subsidiaryVisibleFilter\(/)
  assert.match(src, /sql` and \$\{column\} = any\(/)
  assert.match(src, /: sql` and false`/)
})

// ---------------------------------------------------------------------------
// Documents: every verb of every document boundary gates the loaded record
// ---------------------------------------------------------------------------

const DOCUMENT_BOUNDARIES: ReadonlyArray<{ file: string; calls: number }> = [
  { file: 'app/api/documents/[id]/route.ts', calls: 3 },
  { file: 'app/api/documents/[id]/correct/route.ts', calls: 1 },
  { file: 'app/api/documents/[id]/void/route.ts', calls: 1 },
  { file: 'app/api/documents/actions/route.ts', calls: 1 },
  { file: 'app/api/expenses/[id]/route.ts', calls: 3 },
  { file: 'app/api/expenses/actions/route.ts', calls: 1 },
]

for (const { file, calls } of DOCUMENT_BOUNDARIES) {
  test(`document boundary gates subsidiary scope before disclosure: ${file}`, () => {
    const src = source(file)
    assert.ok(src.includes('guardSubsidiaryScope'), `${file} must import and use the shared gate`)
    assert.ok(
      count(src, 'guardSubsidiaryScope(') >= calls,
      `${file} must consult the gate ${calls}× (one per record-loading handler)`,
    )
    // The org-scoped probe must carry the subsidiary out of the row,
    // otherwise the gate would be checking an unresolved value.
    assert.ok(
      src.includes('subsidiary_id as "subsidiaryId"') || src.includes('doc.subsidiaryId'),
      `${file} must resolve the record's subsidiary alongside org scope`,
    )
  })
}

test('documents/[id] keeps its existence probes subsidiary-resolving', () => {
  const src = source('app/api/documents/[id]/route.ts')
  assert.match(src, /select kind, subsidiary_id as "subsidiaryId" from documents/)
  assert.doesNotMatch(
    src,
    /select kind from documents/,
    'the old un-scoped existence probe must not come back',
  )
})

test('document edits may not re-home a record outside the caller scope', () => {
  const patch = source('app/api/documents/[id]/route.ts')
  assert.match(patch, /body\.subsidiaryId !== undefined && !subsidiariesInScope\(authz, \[body\.subsidiaryId\]\)/)
  const correct = source('app/api/documents/[id]/correct/route.ts')
  assert.match(correct, /!subsidiariesInScope\(authz, \[body\.subsidiaryId\]\)/)
})

test('documents/actions resolves the full document row including its subsidiary', () => {
  const src = source('app/api/documents/actions/route.ts')
  assert.ok(src.includes('.from(schema.documents)'), 'must load the document row')
  assert.match(src, /guardSubsidiaryScope\(authz, doc\.subsidiaryId\)/)
})

test('expense reports are kind-pinned fail-closed on read, autosave, delete and lifecycle', () => {
  const detail = source('app/api/expenses/[id]/route.ts')
  assert.match(detail, /select subsidiary_id as "subsidiaryId" from documents where id = \$\{id\} and kind = 'expense_report'/)
  assert.match(detail, /select status, document_date, subsidiary_id as "subsidiaryId" from documents where id = \$\{id\} and kind = 'expense_report'/)
  const actions = source('app/api/expenses/actions/route.ts')
  assert.match(actions, /select id, status, subsidiary_id as "subsidiaryId" from documents where id = \$\{id\} and kind = 'expense_report'/)
  // Both submit and post resolve through the helper: an out-of-scope report
  // is indistinguishable from a missing one, so it can never reach the GL.
  assert.match(actions, /guardSubsidiaryScope\(authz, row\.subsidiaryId\) \? null : row/)
})

// ---------------------------------------------------------------------------
// Audit trail: existence, kind, creator metadata, and history are disclosures
// ---------------------------------------------------------------------------

test('audit/record resolves the record subsidiary before disclosing anything', () => {
  const src = source('app/api/audit/record/route.ts')
  assert.ok(
    count(src, 'subsidiary_id as "subsidiaryId"') >= 2,
    'both the documents and parties probes must carry the subsidiary',
  )
  assert.ok(
    src.includes("table !== 'item_rate_versions'"),
    'the rate-version branch has no subsidiary dimension and stays permission-gated only',
  )
  assert.ok(
    src.includes("table === 'parties' ? { orgWideNull: true } : {}"),
    'documents follow documentWhere semantics, parties follow the party-list rule',
  )
  assert.ok(
    src.indexOf('guardSubsidiaryScope(authz, metadata.subsidiaryId')
      < src.indexOf('from audit_log a'),
    'the scope decision precedes the first trail query',
  )
})

// ---------------------------------------------------------------------------
// Journals: header AND line-level subsidiary assignments stay inside scope
// ---------------------------------------------------------------------------

test('journal boundary gates read, autosave, and delete', () => {
  const src = source('app/api/journals/[id]/route.ts')
  assert.ok(count(src, 'guardSubsidiaryScope(') >= 3, 'GET, PATCH and DELETE each gate the record')
  assert.match(src, /select subsidiary_id as "subsidiaryId" from documents where id = \$\{id\} and kind = 'journal'/)
})

test('journal autosave rejects out-of-scope header and line subsidiaries', () => {
  const src = source('app/api/journals/[id]/route.ts')
  assert.match(src, /!subsidiariesInScope\(gate, requestedSubsidiaries\)/)
})

test('journal post action gates the locked record inside the transaction', () => {
  const src = source('app/api/journals/actions/route.ts')
  assert.match(src, /select id, status, subsidiary_id as "subsidiaryId" from documents/)
  assert.match(src, /guardSubsidiaryScope\(gate, owned\.rows\[0\]\.subsidiaryId\)/)
  assert.match(src, /outcome\.kind === 'scope_denied'/)
})

// ---------------------------------------------------------------------------
// Payments: the payment document, its allocation targets, and its party
// ---------------------------------------------------------------------------

test('payment boundary resolves subsidiary once for GET, PATCH and DELETE', () => {
  const src = source('app/api/payments/[id]/route.ts')
  assert.match(src, /select kind, subsidiary_id as "subsidiaryId" from documents/)
  assert.match(src, /guardSubsidiaryScope\(authz, r\.rows\[0\]\.subsidiaryId\)/)
  // Causal order: the scope gate fires before the per-kind permission check
  // discloses anything about the payment's kind family.
  assert.ok(
    src.indexOf('guardSubsidiaryScope(authz, r.rows[0].subsidiaryId)')
      < src.indexOf('paymentPermission(kind)'),
  )
})

test('open-item allocation targets are record boundaries of their own', () => {
  const single = source('app/api/payments/[id]/route.ts')
  assert.match(single, /assertAllocationTargetsInScope/)
  assert.ok(
    single.indexOf('assertAllocationTargetsInScope(') > single.indexOf('async function assertAllocationTargetsInScope'),
    'PATCH must invoke the shared target check',
  )
  const batched = source('app/api/payments/post-with-applications/route.ts')
  assert.match(batched, /select dl\.id, d\.subsidiary_id as "subsidiaryId"/)
  assert.match(batched, /guardSubsidiaryScope\(authz, byId\.get\(lineId\)\)/)
})

test('post-with-applications gates the payment document itself', () => {
  const src = source('app/api/payments/post-with-applications/route.ts')
  assert.match(src, /select kind, status, subsidiary_id as "subsidiaryId" from documents/)
  assert.match(src, /guardSubsidiaryScope\(authz, r\.rows\[0\]\.subsidiaryId\)/)
})

for (const route of ['app/api/payments/suggest/route.ts', 'app/api/payments/open-items/route.ts']) {
  test(`party-scoped payment disclosure gates the party: ${route}`, () => {
    const src = source(route)
    assert.match(src, /select subsidiary_id as "subsidiaryId" from parties/)
    assert.match(src, /guardSubsidiaryScope\(gate, .*subsidiaryId, \{ orgWideNull: true \}\)/)
  })
}

// ---------------------------------------------------------------------------
// Payment runs: a run is reachable only through the bills it pays
// ---------------------------------------------------------------------------

test('every run-scoped verb inherits the source-bill scope gate', () => {
  const lib = source('app/api/payments/lib.ts')
  assert.match(lib, /from payment_run_items ri/)
  assert.match(lib, /join documents d on d\.id = ri\.source_document_id and d\.org_id = ri\.org_id/)
  assert.match(lib, /ri\.status <> 'cancelled'/)
  assert.match(lib, /d0?\.?subsidiary_id is null/)
  for (const route of [
    'app/api/payments/runs/[id]/route.ts',
    'app/api/payments/runs/[id]/decision/route.ts',
    'app/api/payments/runs/[id]/deliver/route.ts',
    'app/api/payments/runs/[id]/file/route.ts',
    'app/api/payments/runs/[id]/files/[fileId]/decision/route.ts',
    'app/api/payments/runs/[id]/files/[fileId]/reprocess/route.ts',
    'app/api/payments/runs/[id]/instructions/[instructionId]/settlement/route.ts',
    'app/api/payments/runs/[id]/post/route.ts',
    'app/api/payments/runs/[id]/rollback/route.ts',
    'app/api/payments/runs/[id]/submit/route.ts',
  ]) {
    const src = source(route)
    assert.ok(src.includes('guardPaymentRunPermission'), `${route} must authorize through the shared run gate`)
    assert.doesNotMatch(src, /allowedSubsidiaryIds/, `${route} must not re-implement scope ad hoc`)
  }
})

test('the run list hides runs that pay out-of-scope bills', () => {
  const src = source('app/api/payments/runs/route.ts')
  assert.match(src, /if \(gate\.allowedSubsidiaryIds\) \{/)
  assert.match(src, /not exists \(/)
  assert.match(src, /d0\.subsidiary_id is null or not \(d0\.subsidiary_id = any\(/)
})

test('run creation validates every selected bill against the caller scope', () => {
  const src = source('app/api/payments/runs/route.ts')
  assert.match(src, /select id, subsidiary_id as "subsidiaryId" from documents/)
  assert.match(src, /inScope\.length !== selected\.length/)
  // Fail closed: unresolved ids are treated exactly like out-of-scope ones.
  assert.doesNotMatch(src, /inScope\.length === selected\.length\)\s*\n\s*return NextResponse\.json\(\{ error: 'not found' \}/)
})

// ---------------------------------------------------------------------------
// Orders (quote / sales order / purchase order share one handler surface)
// ---------------------------------------------------------------------------

test('order handlers gate the loaded record on get, patch, delete and convert', () => {
  const src = source('app/api/_order/handlers.ts')
  assert.ok(count(src, 'guardSubsidiaryScope(') >= 4, 'GET, PATCH, DELETE and convertPOST each gate the record')
  assert.ok(count(src, 'subsidiary_id as "subsidiaryId"') >= 3)
  assert.match(src, /body\.subsidiaryId === null && gate\.allowedSubsidiaryIds/,
    'clearing the header subsidiary is denied for restricted callers too')
})

// ---------------------------------------------------------------------------
// Parties: org-wide rows pass, everything else must be inside the set
// ---------------------------------------------------------------------------

const PARTY_ORG_WIDE_ROUTES = [
  'app/api/parties/[id]/route.ts',
  'app/api/parties/[id]/drawer/route.ts',
  'app/api/parties/[id]/transactions/route.ts',
  'app/api/parties/[id]/transaction-drawer/route.ts',
  'app/api/parties/[id]/activities/route.ts',
]

for (const file of PARTY_ORG_WIDE_ROUTES) {
  test(`party boundary uses the org-wide-null party semantics: ${file}`, () => {
    const src = source(file)
    assert.match(src, /select subsidiary_id as "subsidiaryId" from parties/)
    assert.match(src, /guardSubsidiaryScope\(/)
    assert.match(src, /orgWideNull:\s*true/,
      `${file} must treat null-subsidiary parties exactly like the party lists do`)
  })
}

test('party edits may not assign primary or additional subsidiaries outside scope', () => {
  const src = source('app/api/parties/[id]/route.ts')
  assert.match(src, /!subsidiariesInScope\(gate, requestedSubsidiaries\)/)
})

test('bank-account verbs share one party scope gate', () => {
  const src = source('app/api/parties/[id]/bank-accounts/route.ts')
  assert.match(src, /async function denyOutsidePartyScope\(/)
  assert.ok(count(src, 'await denyOutsidePartyScope(gate, partyId)') >= 3,
    'POST, PATCH and DELETE each gate the owning party')
})

test('party transaction sublists also narrow the documents themselves', () => {
  const src = source('app/api/parties/[id]/transactions/route.ts')
  assert.match(src, /subsidiaryVisibleFilter\(sql`d\.subsidiary_id`, gate\.allowedSubsidiaryIds\)/)
  assert.match(src, /\$\{documentScope\}/)
})

// ---------------------------------------------------------------------------
// Field tickets: the signed labor/material evidence is a document boundary
// ---------------------------------------------------------------------------

test('field-ticket detail, drawer, and every mutation enforce subsidiary scope', () => {
  const route = source('app/api/field-tickets/[id]/route.ts')
  const drawer = source('lib/field-ticket-drawer-data.ts')
  const service = source('lib/field-tickets.ts')

  // GET/PATCH/POST all resolve the ticket's canonical document subsidiary and
  // pass the shared fail-closed 404 gate before loading or mutating anything.
  assert.match(route, /d\.subsidiary_id as "subsidiaryId"/)
  assert.ok(count(route, 'guardSubsidiaryScope(') >= 2)
  assert.match(route, /allowedSubsidiaryIds: gate\.allowedSubsidiaryIds/)
  assert.match(drawer, /allowedSubsidiaryIds: authz\.allowedSubsidiaryIds/)

  // A restricted ticket's detail and picker queries stay in its legal entity;
  // this catches regressions that gate only the header but leak related rows.
  assert.match(service, /p\.subsidiary_id/)
  assert.match(service, /eu\.subsidiary_id/)
  assert.match(drawer, /p\.subsidiary_id/)
  assert.match(drawer, /subsidiary_id/)
})

test('field-ticket add/remove lines require exact revisions and lock the parent', () => {
  const route = source('app/api/field-tickets/[id]/route.ts')
  const service = source('lib/field-tickets.ts')
  assert.match(route, /action === 'add-line'[\s\S]*preflightRevision/)
  assert.match(route, /action === 'remove-line'[\s\S]*preflightRevision/)
  assert.ok(count(service, 'for update of d, ft') >= 2)
  assert.ok(count(service, 'expectedRevision,') >= 4)
  assert.match(service, /updated_at = greatest\(clock_timestamp\(\), d\.updated_at \+ interval '1 microsecond'\)/)
})

test('Accounting home scopes close and ledger metrics by the authz allowlist', () => {
  const home = source('lib/module-home/accounting.ts')
  assert.match(home, /type AccountingSubsidiaryScope = ReadonlySet<string> \| null/)
  assert.match(home, /allowedSubsidiaryIds\?: AccountingSubsidiaryScope/)
  assert.match(home, /subsidiaryVisibleFilter\(sql`je\.subsidiary_id`, scope\)/)
  assert.match(home, /subsidiaryVisibleFilter\(sql`f\.subsidiary_id`, scope\)/)
  assert.match(home, /jsonb_array_elements_text\(coalesce\(r\.scope->'subsidiaryIds'/)
  assert.match(home, /from budget_lines bl/)
  assert.match(home, /from ai_work_items w/)
  assert.match(home, /allowed === null\) return sql``/)
  assert.match(home, /if \(ids\.length === 0\) return sql` and false`/)
})

// ---------------------------------------------------------------------------
// PDFs: printing or emailing IS the disclosure
// ---------------------------------------------------------------------------

test('pdf rendering resolves the record subsidiary before any template work', () => {
  const lib = source('app/api/record-pdf/lib.ts')
  assert.match(lib, /export async function loadRecordSubsidiaryScope\(/)
  assert.match(lib, /from journal_entries where id = \$\{id\} and org_id = \$\{orgId\}/)
  assert.match(lib, /kind = \$\{meta\.docKind\}/)

  const render = source('app/api/record-pdf/[recordType]/[id]/route.ts')
  assert.match(render, /loadRecordSubsidiaryScope\(recordType, user\.orgId, id\)/)
  assert.match(render, /guardSubsidiaryScope\(gate, owned\.subsidiaryId\)/)
  assert.ok(
    render.indexOf('guardSubsidiaryScope(gate, owned.subsidiaryId)')
      < render.indexOf('mergeAndPrintPdf('),
    'scope must be settled before the PDF body is produced',
  )

  const send = source('app/api/record-pdf/[recordType]/[id]/send/route.ts')
  assert.ok(count(send, 'loadRecordSubsidiaryScope(recordType') >= 2, 'GET and POST both resolve scope')
  assert.ok(count(send, 'guardSubsidiaryScope(gate, owned.subsidiaryId)') >= 2)
  assert.ok(
    send.indexOf('guardSubsidiaryScope(gate, owned.subsidiaryId)') < send.indexOf('resolveRecordRecipient('),
    'recipient resolution must not precede the scope decision',
  )
  assert.ok(
    send.lastIndexOf('guardSubsidiaryScope(gate, owned.subsidiaryId)') < send.indexOf('sendRecordPdfEmail('),
    'no email leaves before the scope decision',
  )
})

// ---------------------------------------------------------------------------
// Global search: the same predicates the lists apply
// ---------------------------------------------------------------------------

test('global search threads allowedSubsidiaryIds into contacts and transactions', () => {
  const src = source('lib/search.ts')
  assert.match(src, /const scope = authz\.allowedSubsidiaryIds/)
  assert.match(src, /searchContacts\(orgId, q, like, scope\)/)
  assert.match(src, /searchTransactions\(orgId, q, like, num, transactionKinds, scope\)/)
})

test('transaction hits obey the documents visibility predicate on every leg', () => {
  const src = source('lib/search.ts')
  assert.match(src, /const documentSubsidiaryFilter = subsidiaryVisibleFilter\(sql`d\.subsidiary_id`, scope\)/)
  // Amount leg, text leg, party leg, and the final projection all filter —
  // a leak through any single leg discloses the record.
  assert.ok(count(src, '${visibleKindFilter}${documentSubsidiaryFilter}') >= 4,
    'candidate legs and final select must each carry the scope filter')
})

test('contact hits use the party lists\u2019 own org-wide predicate', () => {
  const src = source('lib/search.ts')
  assert.match(src, /const subsidiaryFilter = masterDataSubsidiaryFilter\(sql`p\.subsidiary_id`, scope\)/,
    'contact search must invoke the master-data scope helper')
  assert.match(src, /\(\$\{column\} is null or \$\{column\} = any\(/,
    'null-subsidiary parties stay searchable exactly like the party lists render them')
  assert.match(src, /if \(ids\.length === 0\) return sql`and false`/,
    'an empty scope fails closed before the party query runs')
})

// ---------------------------------------------------------------------------
// Payroll: every route is a subsidiary boundary, including artifact and
// year-end output surfaces. The route-specific tests above pin the detailed
// query ordering; this inventory prevents a newly added payroll endpoint from
// silently becoming an org-only escape hatch.
// ---------------------------------------------------------------------------

const PAYROLL_ROUTE_FILES = [
  'app/api/payroll/entitlements/route.ts',
  'app/api/payroll/opening-balances/entitlements/route.ts',
  'app/api/payroll/opening-balances/route.ts',
  'app/api/payroll/parallel-run/comparisons/[id]/route.ts',
  'app/api/payroll/parallel-run/registers/[id]/route.ts',
  'app/api/payroll/parallel-run/route.ts',
  'app/api/payroll/parallel-run/tolerances/route.ts',
  'app/api/payroll/profiles/route.ts',
  'app/api/payroll/remittances/route.ts',
  'app/api/payroll/retro/route.ts',
  'app/api/payroll/runs/[id]/bank-file/[fileId]/route.ts',
  'app/api/payroll/runs/[id]/bank-file/route.ts',
  'app/api/payroll/runs/[id]/cheques-pdf/route.ts',
  'app/api/payroll/runs/[id]/route.ts',
  'app/api/payroll/runs/[id]/stubs-pdf/route.ts',
  'app/api/payroll/runs/route.ts',
  'app/api/payroll/settings/rates/route.ts',
  'app/api/payroll/settings/route.ts',
  'app/api/payroll/year-end/amendments/artifact/route.ts',
  'app/api/payroll/year-end/amendments/route.ts',
  'app/api/payroll/year-end/amendments/slip/route.ts',
  'app/api/payroll/year-end/file/route.ts',
  'app/api/payroll/year-end/route.ts',
  'app/api/payroll/year-end/slip/route.ts',
] as const

test('every payroll API route carries a subsidiary scope boundary', () => {
  assert.equal(PAYROLL_ROUTE_FILES.length, 24)
  for (const file of PAYROLL_ROUTE_FILES) {
    const src = source(file)
    assert.match(src, /guardFeaturePermission\(/, `${file} must retain the payroll permission gate`)
    assert.match(
      src,
      /guardSubsidiaryScope\(|guardRootSubsidiaryScope\(|guardPayroll[A-Za-z]+\(|subsidiaryVisibleFilter\(|subsidiaryScopeAllows\(|subsidiariesInScope\(/,
      `${file} must enforce subsidiary visibility before its payroll service call`,
    )
  }
})

test('payroll read, write, artifact, and year-end paths pass scope before service work', () => {
  const representative = [
    ['app/api/payroll/runs/[id]/route.ts', 'guardSubsidiaryScope'],
    ['app/api/payroll/profiles/route.ts', 'guardSubsidiaryScope'],
    ['app/api/payroll/runs/[id]/bank-file/route.ts', 'guardSubsidiaryScope'],
    ['app/api/payroll/year-end/slip/route.ts', 'guardPayrollFilingRowIds'],
  ] as const
  for (const [file, primitive] of representative) {
    const src = source(file)
    assert.ok(src.includes(primitive), `${file} must call ${primitive}`)
  }
})

test('payroll scope decisions precede representative service and artifact calls', () => {
  const run = source('app/api/payroll/runs/[id]/route.ts')
  assert.ok(
    run.indexOf('guardSubsidiaryScope(gate, owned.subsidiaryId)')
      < run.indexOf('calculatePayRun('),
    'run mutation scope must settle before calculation',
  )

  const profile = source('app/api/payroll/profiles/route.ts')
  assert.ok(
    profile.indexOf('guardSubsidiaryScope(gate, (refs[0].rows[0]')
      < profile.indexOf('insert into employee_payroll_profiles'),
    'profile write scope must settle before the upsert',
  )

  const bank = source('app/api/payroll/runs/[id]/bank-file/route.ts')
  assert.ok(
    bank.indexOf('guardSubsidiaryScope(gate, owned.subsidiaryId)')
      < bank.indexOf('generatePayRunBankFile('),
    'bank-file generation must settle scope before producing an artifact',
  )

  const yearEnd = source('app/api/payroll/year-end/slip/route.ts')
  assert.ok(
    yearEnd.indexOf('guardPayrollFilingRowIds(')
      < yearEnd.indexOf('filing.slip.build('),
    'year-end slip scope must settle before rendering payroll output',
  )

  const remittance = source('app/api/payroll/remittances/route.ts')
  assert.ok(
    remittance.indexOf('guardRemittancePeriod(')
      < remittance.indexOf('payrollRemittanceSummary('),
    'remittance aggregate scope must settle before summary generation',
  )
})
