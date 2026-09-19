import { REPORT_AS_OF } from './report-as-of'
import type { ReportEntity } from './entities'

// Workforce reports over the HRM employment foundation (0184) and the
// employment change-request ledger (0185).
//
// The three entities below are the report-catalog face of the engine HRM
// read path (engine/src/hrm/employment-read.ts, temporal.ts,
// authorization.ts), which they never call and never re-implement: the
// catalog carries the same temporal predicates as SQL so the shared
// executor, the builder, saved views and the insights card studio all read
// governed employment state through one list. Permission and the Features
// switch ride on the catalog fields every run path already enforces
// (web/lib/report-authz.ts): `hrm.employment.read` refuses with 403 and a
// switched-off `hrm` feature 404s — a refusal, never empty rows.
//
// Temporal contract (mirrors temporal.ts containsDate and the
// assembleEmploymentAsOf resolution the headcount service applies in JS):
// effective intervals are half-open [from, to), so "in service at as-of"
// is `effective_from <= asOf AND (effective_to IS NULL OR effective_to >
// asOf)`, and "currently known" is `recorded_until IS NULL`. Storage makes
// the SQL exact rather than approximate: worker_employment_versions_no_overlap
// and employment_assignment_versions_single_primary exclude overlapping live
// rows per identity, so at most one live version (and at most one live
// primary assignment) can cover the as-of point — no silent choice between
// revisions. The as-of day itself is the catalog sentinel REPORT_AS_OF,
// bound server-side to the org business day exactly like the entitlement
// limit resolution; it is never CURRENT_DATE.

export const HRM_EMPLOYMENT_READ_PERMISSION = 'hrm.employment.read'
export const HRM_FEATURE_KEY = 'hrm'

const HRM_EMPLOYMENT_STATUSES = ['offered', 'active', 'on_leave', 'suspended', 'terminated'] as const
const HRM_REQUEST_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'withdrawn',
  'applied',
] as const
const HRM_REQUEST_KINDS = ['hire', 'status_change', 'assignment_change', 'termination'] as const

export const HRM_REPORT_ENTITIES: ReportEntity[] = [
  {
    key: 'hrm_headcount',
    label: 'Headcount',
    category: 'hrm',
    description:
      'One row per employer subsidiary and department: employments in service at the report as-of date, with full-time-equivalent totals from the effective primary assignment. Requires the HRM employment permission.',
    // One row per in-service employment, grouped by employer subsidiary and
    // the effective primary assignment's department. The status predicate is
    // HEADCOUNT_STATUSES from the headcount service (active, on_leave):
    // employments in any other status are not in service and never count.
    // A NULL department is an employment with no effective primary
    // assignment (or a primary with no department) — an unattributed bucket,
    // never dropped and never misattributed. FTE is NULL (not zero) when no
    // primary assignment is effective: SUM ignores it while the head still
    // counts, so a missing assignment can never deflate the FTE total into
    // a precise-looking wrong number.
    from: `(SELECT e.org_id,
        e.employer_subsidiary_id,
        pa.department_id,
        count(*)::integer AS headcount,
        sum(pa.fte) AS fte_total
   FROM worker_employments e
   JOIN worker_employment_versions ev
     ON ev.employment_id = e.id AND ev.org_id = e.org_id
    AND ev.recorded_until IS NULL
    AND ev.effective_from <= ${REPORT_AS_OF}
    AND (ev.effective_to IS NULL OR ev.effective_to > ${REPORT_AS_OF})
    AND ev.status IN ('active', 'on_leave')
   LEFT JOIN employment_assignment_versions pa
     ON pa.employment_id = e.id AND pa.org_id = e.org_id
    AND pa.is_primary
    AND pa.recorded_until IS NULL
    AND pa.effective_from <= ${REPORT_AS_OF}
    AND (pa.effective_to IS NULL OR pa.effective_to > ${REPORT_AS_OF})
  GROUP BY e.org_id, e.employer_subsidiary_id, pa.department_id) hc
  JOIN subsidiaries sub ON sub.id = hc.employer_subsidiary_id AND sub.org_id = hc.org_id
  LEFT JOIN departments dep ON dep.id = hc.department_id AND dep.org_id = hc.org_id`,
    orgColumn: 'hc.org_id',
    // The employer subsidiary is the legal-entity boundary: the executor
    // clamps this to the reader's allowlist, so a restricted reader counts
    // only their own subsidiaries.
    subsidiaryScope: { column: 'hc.employer_subsidiary_id' },
    requiredPermission: HRM_EMPLOYMENT_READ_PERMISSION,
    featureKey: HRM_FEATURE_KEY,
    // No fiscal window: the as-of date is the sentinel bound to the org
    // business day, not the period picker. An implicit period on a date
    // column would silently re-window a point-in-time statement.
    defaultPeriodField: null,
    columns: [
      { key: 'subsidiary', label: 'Subsidiary', kind: 'text', expr: 'sub.name' },
      { key: 'department', label: 'Department', kind: 'text', expr: 'dep.name' },
      { key: 'headcount', label: 'Headcount', kind: 'number', expr: 'hc.headcount' },
      { key: 'fte_total', label: 'FTE total', kind: 'number', expr: 'hc.fte_total' },
      { key: 'subsidiary_id', label: 'Subsidiary (id)', kind: 'uuid', expr: 'hc.employer_subsidiary_id' },
      { key: 'department_id', label: 'Department (id)', kind: 'uuid', expr: 'hc.department_id' },
    ],
    defaultSort: { column: 'subsidiary', direction: 'asc' },
  },
  {
    key: 'hrm_employment_history',
    label: 'Employment history',
    category: 'hrm',
    description:
      'One row per employment version — person, employer, status, effective and recorded stamps, and the closure evidence reason. Requires the HRM employment permission.',
    // Full version history, not an as-of snapshot: every version row reads
    // back, live or superseded. The change reason is the linked aggregate
    // employment_changes evidence (closed_by_change_id); live versions carry
    // no closure and read NULL — never a fabricated reason.
    from: `worker_employment_versions ev
      JOIN worker_employments e ON e.id = ev.employment_id AND e.org_id = ev.org_id
      JOIN parties w ON w.id = e.worker_party_id AND w.org_id = ev.org_id
      JOIN subsidiaries sub ON sub.id = e.employer_subsidiary_id AND sub.org_id = ev.org_id
      LEFT JOIN employment_changes c ON c.id = ev.closed_by_change_id AND c.org_id = ev.org_id`,
    orgColumn: 'ev.org_id',
    subsidiaryScope: { column: 'e.employer_subsidiary_id' },
    requiredPermission: HRM_EMPLOYMENT_READ_PERMISSION,
    featureKey: HRM_FEATURE_KEY,
    // The period picker narrows versions by effective start; point-in-service
    // queries add an explicit effective_to rule alongside it.
    defaultPeriodField: 'effective_from',
    columns: [
      { key: 'person', label: 'Person', kind: 'text', expr: 'w.display_name' },
      { key: 'employer', label: 'Employer', kind: 'text', expr: 'sub.name' },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'ev.status', options: HRM_EMPLOYMENT_STATUSES },
      { key: 'effective_from', label: 'Effective from', kind: 'date', expr: 'ev.effective_from' },
      { key: 'effective_to', label: 'Effective to', kind: 'date', expr: 'ev.effective_to' },
      { key: 'recorded_at', label: 'Recorded at', kind: 'timestamp', expr: 'ev.recorded_at' },
      { key: 'recorded_until', label: 'Recorded until', kind: 'timestamp', expr: 'ev.recorded_until' },
      { key: 'version_no', label: 'Version', kind: 'number', expr: 'ev.version_no' },
      { key: 'change_reason', label: 'Change reason', kind: 'text', expr: 'c.reason' },
      { key: 'employment_id', label: 'Employment (id)', kind: 'uuid', expr: 'ev.employment_id' },
      { key: 'worker_id', label: 'Person (id)', kind: 'uuid', expr: 'e.worker_party_id' },
    ],
    defaultSort: { column: 'effective_from', direction: 'desc' },
  },
  {
    key: 'hrm_change_requests',
    label: 'Change requests',
    category: 'hrm',
    description:
      'One row per employment change request — status, kind, employment, requester, submission and decision stamps, bound approval run and revision binding. Requires the HRM employment permission.',
    // The 0185 register: kind is the frozen proposal's kind
    // (payload->>'kind'); the requester is the submission actor, NULL for
    // drafts withdrawn before submission, which never fabricate one. The
    // decided stamp is the earliest decided gate in the immutable decision
    // snapshot — NULL until a decision exists, never inferred from status.
    // The snapshot is the request's own evidence: this entity never joins
    // the Flows tables.
    from: `hrm_employment_change_requests r
      JOIN worker_employments e ON e.id = r.employment_id AND e.org_id = r.org_id
      JOIN parties w ON w.id = e.worker_party_id AND w.org_id = r.org_id
      JOIN subsidiaries sub ON sub.id = e.employer_subsidiary_id AND sub.org_id = r.org_id
      LEFT JOIN users s ON s.id = r.submitted_by AND s.org_id = r.org_id
      LEFT JOIN LATERAL (
        SELECT min((g ->> 'decided_at')::timestamptz) AS decided_at
          FROM jsonb_array_elements(r.decision_snapshot -> 'gates') AS g
      ) dec ON TRUE`,
    orgColumn: 'r.org_id',
    subsidiaryScope: { column: 'e.employer_subsidiary_id' },
    requiredPermission: HRM_EMPLOYMENT_READ_PERMISSION,
    featureKey: HRM_FEATURE_KEY,
    // The register timeline is creation: drafts carry a NULL submitted_at, so
    // windowing on submission would silently drop them from their own register.
    defaultPeriodField: 'created_at',
    columns: [
      { key: 'status', label: 'Status', kind: 'enum', expr: 'r.status', options: HRM_REQUEST_STATUSES },
      { key: 'kind', label: 'Kind', kind: 'enum', expr: `(r.payload ->> 'kind')`, options: HRM_REQUEST_KINDS },
      { key: 'employment', label: 'Employment', kind: 'text', expr: 'w.display_name' },
      { key: 'employer', label: 'Employer', kind: 'text', expr: 'sub.name' },
      { key: 'requested_by', label: 'Requested by', kind: 'text', expr: 's.name' },
      { key: 'submitted_at', label: 'Submitted at', kind: 'timestamp', expr: 'r.submitted_at' },
      { key: 'decided_at', label: 'Decided at', kind: 'timestamp', expr: 'dec.decided_at' },
      { key: 'flow_run_id', label: 'Approval run (id)', kind: 'uuid', expr: 'r.flow_run_id' },
      { key: 'request_revision', label: 'Request revision', kind: 'number', expr: 'r.request_revision' },
      {
        key: 'expected_employment_revision',
        label: 'Expected employment revision',
        kind: 'number',
        expr: 'r.expected_employment_revision',
      },
      { key: 'applied_at', label: 'Applied at', kind: 'timestamp', expr: 'r.applied_at' },
      { key: 'reason', label: 'Reason', kind: 'text', expr: 'r.reason' },
      { key: 'created_at', label: 'Created at', kind: 'timestamp', expr: 'r.created_at' },
      { key: 'id', label: 'Request (id)', kind: 'uuid', expr: 'r.id' },
      { key: 'employment_id', label: 'Employment (id)', kind: 'uuid', expr: 'r.employment_id' },
    ],
    defaultSort: { column: 'created_at', direction: 'desc' },
  },
]
