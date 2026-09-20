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
export const HRM_POSITION_READ_PERMISSION = 'hrm.position.read'
export const HRM_PROCESS_READ_PERMISSION = 'hrm.process.read'
export const HRM_LEAVE_READ_PERMISSION = 'hrm.leave.read'
export const HRM_RECRUITING_READ_PERMISSION = 'hrm.recruiting.read'
export const HRM_PERFORMANCE_READ_PERMISSION = 'hrm.performance.read'
export const HRM_RETENTION_READ_PERMISSION = 'hrm.retention.read'
export const HRM_BENEFITS_READ_PERMISSION = 'hrm.benefits.read'
export const HRM_FEATURE_KEY = 'hrm'

const HRM_POSITION_STATUSES = ['planned', 'open', 'filled', 'frozen', 'closed'] as const

const HRM_EMPLOYMENT_STATUSES = ['offered', 'active', 'on_leave', 'suspended', 'terminated'] as const
const HRM_REQUEST_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'withdrawn',
  'applied',
] as const
const HRM_REQUEST_KINDS = ['hire', 'status_change', 'assignment_change', 'termination', 'position_assignment', 'profile_change'] as const

const HRM_ABSENCE_SOURCES = ['request', 'recorded'] as const
const HRM_ENROLLMENT_STATUSES = ['elected', 'waived', 'pending_approval', 'active', 'ended', 'cancelled'] as const

const HRM_REQUISITION_STATUSES = ['draft', 'open', 'on_hold', 'filled', 'cancelled'] as const
const HRM_APPLICATION_STATUSES = ['active', 'rejected', 'withdrawn', 'hired'] as const

const HRM_PROCESS_KINDS = ['onboarding', 'offboarding', 'transfer'] as const
const HRM_PROCESS_STATUSES = ['open', 'completed', 'cancelled'] as const

// HR-16 begin: automation + reason-code report entities (0226/0227).
export const AUTOMATIONS_READ_PERMISSION = 'automations.read'
export const AUTOMATIONS_FEATURE_KEY = 'automations'
export const HRM_ACTION_REASONS_FEATURE_KEY = 'hrmActionReasons'

const AUTOMATION_STATUSES = ['draft', 'enabled', 'disabled', 'error'] as const
const AUTOMATION_TRIGGER_KINDS = ['schedule', 'date_relative', 'field_change', 'event', 'document', 'manual'] as const
const AUTOMATION_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'skipped_no_match', 'simulated'] as const
// HR-16 end
const HRM_STEP_STATUSES = ['pending', 'done', 'skipped'] as const
const HRM_STEP_OWNERS = ['manager', 'hr', 'employee', 'named_party'] as const
const HRM_STEP_EVIDENCE = ['none', 'acknowledgement', 'attachment'] as const

const HRM_REVIEW_KINDS = ['self', 'manager', 'peer'] as const
const HRM_REVIEW_STATUSES = ['pending', 'submitted', 'calibrated', 'shared', 'acknowledged'] as const
const HRM_GOAL_STATUSES = ['active', 'achieved', 'missed', 'cancelled'] as const
const HRM_EXIT_REASONS = [
  'resignation',
  'retirement',
  'end_of_contract',
  'dismissal',
  'redundancy',
  'mutual',
  'death',
  'other',
] as const

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
      // HR-16 begin: 0227 classification carried from submit onto the event.
      { key: 'action', label: 'Action', kind: 'text', expr: 'r.action' },
      { key: 'reason_code', label: 'Reason code', kind: 'text', expr: 'r.reason_code' },
      // HR-16 end
      { key: 'created_at', label: 'Created at', kind: 'timestamp', expr: 'r.created_at' },
      { key: 'id', label: 'Request (id)', kind: 'uuid', expr: 'r.id' },
      { key: 'employment_id', label: 'Employment (id)', kind: 'uuid', expr: 'r.employment_id' },
    ],
    defaultSort: { column: 'created_at', direction: 'desc' },
  },
  {
    key: 'hrm_positions',
    label: 'Positions',
    category: 'hrm',
    description:
      'One row per established position at the report as-of date: code, title, status, department, employer, and planned versus funded versus filled FTE. Requires the HRM position permission.',
    // One row per position whose version covers the as-of day (half-open
    // effective containment, currently-known revisions only — the same
    // contract the vacancy read resolves through temporal.ts). Filled sums
    // the live primary assignment versions naming the position; funded sums
    // the plan rows whose fiscal period contains the as-of day. Funded is
    // NULL (not zero) when no plan row covers the day: SUM ignores it, so a
    // missing plan can never deflate the funded total into a
    // precise-looking wrong number — the unfunded gap stays visible.
    from: `positions p
  JOIN LATERAL (
    SELECT title, status, department_id, employer_subsidiary_id, planned_fte
      FROM position_versions
     WHERE org_id = p.org_id AND position_id = p.id AND recorded_until IS NULL
       AND effective_from <= ${REPORT_AS_OF}
       AND (effective_to IS NULL OR effective_to > ${REPORT_AS_OF})
     ORDER BY version_no DESC LIMIT 1
  ) v ON TRUE
  JOIN subsidiaries sub ON sub.id = v.employer_subsidiary_id AND sub.org_id = p.org_id
  LEFT JOIN departments dep ON dep.id = v.department_id AND dep.org_id = p.org_id
  LEFT JOIN LATERAL (
    SELECT sum(f.funded_fte) AS funded_fte
      FROM position_funding f
      JOIN accounting_periods per ON per.id = f.period_id
     WHERE f.org_id = p.org_id AND f.position_id = p.id
       AND per.starts_on <= ${REPORT_AS_OF} AND per.ends_on >= ${REPORT_AS_OF}
  ) fund ON TRUE
  LEFT JOIN LATERAL (
    SELECT sum(av.fte) AS filled_fte
      FROM employment_assignment_versions av
     WHERE av.org_id = p.org_id AND av.position_id = p.id AND av.is_primary
       AND av.recorded_until IS NULL
       AND av.effective_from <= ${REPORT_AS_OF}
       AND (av.effective_to IS NULL OR av.effective_to > ${REPORT_AS_OF})
  ) fill ON TRUE`,
    orgColumn: 'p.org_id',
    // The position's employer is the legal-entity boundary: the executor
    // clamps this to the reader's allowlist, so a restricted reader sees
    // only their own establishments.
    subsidiaryScope: { column: 'v.employer_subsidiary_id' },
    requiredPermission: HRM_POSITION_READ_PERMISSION,
    featureKey: HRM_FEATURE_KEY,
    // No fiscal window: the as-of date is the sentinel bound to the org
    // business day, not the period picker. An implicit period on a date
    // column would silently re-window a point-in-time statement.
    defaultPeriodField: null,
    columns: [
      { key: 'code', label: 'Code', kind: 'text', expr: 'p.position_code' },
      { key: 'title', label: 'Title', kind: 'text', expr: 'v.title' },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'v.status', options: HRM_POSITION_STATUSES },
      { key: 'employer', label: 'Employer', kind: 'text', expr: 'sub.name' },
      { key: 'department', label: 'Department', kind: 'text', expr: 'dep.name' },
      { key: 'planned_fte', label: 'Planned FTE', kind: 'number', expr: 'v.planned_fte' },
      { key: 'funded_fte', label: 'Funded FTE', kind: 'number', expr: 'fund.funded_fte' },
      { key: 'filled_fte', label: 'Filled FTE', kind: 'number', expr: 'fill.filled_fte' },
      {
        key: 'vacant_fte',
        label: 'Vacant FTE',
        kind: 'number',
        expr: 'v.planned_fte - coalesce(fill.filled_fte, 0)',
      },
      { key: 'position_id', label: 'Position (id)', kind: 'uuid', expr: 'p.id' },
    ],
    defaultSort: { column: 'code', direction: 'asc' },
  },
  {
    key: 'hrm_processes',
    label: 'Process checklists',
    category: 'hrm',
    description:
      'One row per process checklist step — process kind and status, employee, template, step owner, due date, evidence kind, and step status with its evidence. Requires the HRM process permission.',
    // The 0193 runtime: every row is a snapshot step copied at open time, so
    // the template join only names the checklist (LEFT: a retired template
    // row is never required for history to read). Skip reasons and done
    // stamps read NULL until set — never inferred. Overdue is derived in
    // the viewer from due_on against the org business day, never stored.
    from: `hrm_process_steps s
      JOIN hrm_processes p ON p.id = s.process_id AND p.org_id = s.org_id
      JOIN worker_employments e ON e.id = p.employment_id AND e.org_id = s.org_id
      JOIN parties w ON w.id = e.worker_party_id AND w.org_id = s.org_id
      JOIN subsidiaries sub ON sub.id = e.employer_subsidiary_id AND sub.org_id = s.org_id
      LEFT JOIN hrm_process_templates t ON t.id = p.template_id AND t.org_id = s.org_id`,
    orgColumn: 's.org_id',
    subsidiaryScope: { column: 'e.employer_subsidiary_id' },
    requiredPermission: HRM_PROCESS_READ_PERMISSION,
    featureKey: HRM_FEATURE_KEY,
    // The period picker narrows steps by due date; the open register reads
    // the full checklist regardless of window.
    defaultPeriodField: 'due_on',
    columns: [
      { key: 'process_kind', label: 'Process kind', kind: 'enum', expr: 'p.kind', options: HRM_PROCESS_KINDS },
      { key: 'process_status', label: 'Process status', kind: 'enum', expr: 'p.status', options: HRM_PROCESS_STATUSES },
      { key: 'effective_date', label: 'Effective date', kind: 'date', expr: 'p.effective_date' },
      { key: 'employee', label: 'Employee', kind: 'text', expr: 'w.display_name' },
      { key: 'employer', label: 'Employer', kind: 'text', expr: 'sub.name' },
      { key: 'template', label: 'Template', kind: 'text', expr: 't.name' },
      { key: 'step', label: 'Step', kind: 'text', expr: 's.title' },
      { key: 'step_status', label: 'Step status', kind: 'enum', expr: 's.status', options: HRM_STEP_STATUSES },
      { key: 'owner', label: 'Owner', kind: 'enum', expr: 's.owner_kind', options: HRM_STEP_OWNERS },
      { key: 'due_on', label: 'Due on', kind: 'date', expr: 's.due_on' },
      { key: 'evidence', label: 'Evidence', kind: 'enum', expr: 's.evidence_kind', options: HRM_STEP_EVIDENCE },
      { key: 'done_at', label: 'Done at', kind: 'timestamp', expr: 's.done_at' },
      { key: 'skip_reason', label: 'Skip reason', kind: 'text', expr: 's.skip_reason' },
      { key: 'process_id', label: 'Process (id)', kind: 'uuid', expr: 'p.id' },
      { key: 'employment_id', label: 'Employment (id)', kind: 'uuid', expr: 'p.employment_id' },
    ],
    defaultSort: { column: 'due_on', direction: 'asc' },
  },
  {
    key: 'hrm_leave_absences',
    label: 'Leave absences',
    category: 'hrm',
    description:
      'One row per absence day — person, employer, department at the time, leave type, and hours. Reversals are separate rows; sums net. Requires the HRM leave permission.',
    // One row per hrm_absences day row (request approvals and after-the-fact
    // recordings alike). The department is the primary assignment effective
    // on the absence day — the same half-open containment the calendar
    // reads use — NULL when no primary covered the day (an unattributed
    // bucket, never dropped and never misattributed). Reversals are
    // negative rows of their own, so SUM(hours) nets while the evidence
    // stays row-visible. This entity never joins the payroll ledger: TIME
    // here, VALUE in payroll's own entities.
    from: `hrm_absences a
      JOIN hrm_leave_types t ON t.id = a.leave_type_id AND t.org_id = a.org_id
      JOIN worker_employments e ON e.id = a.employment_id AND e.org_id = a.org_id
      JOIN parties w ON w.id = e.worker_party_id AND w.org_id = a.org_id
      JOIN subsidiaries sub ON sub.id = e.employer_subsidiary_id AND sub.org_id = a.org_id
      LEFT JOIN employment_assignment_versions pa
        ON pa.employment_id = a.employment_id AND pa.org_id = a.org_id
       AND pa.is_primary AND pa.recorded_until IS NULL
       AND pa.effective_from <= a.on_date
       AND (pa.effective_to IS NULL OR pa.effective_to > a.on_date)
      LEFT JOIN departments dep ON dep.id = pa.department_id AND dep.org_id = a.org_id`,
    orgColumn: 'a.org_id',
    subsidiaryScope: { column: 'e.employer_subsidiary_id' },
    requiredPermission: HRM_LEAVE_READ_PERMISSION,
    featureKey: HRM_FEATURE_KEY,
    // The absence day is the fact: the period picker narrows on it, so a
    // request spanning a boundary splits by the fact, never by the window.
    defaultPeriodField: 'on_date',
    columns: [
      { key: 'on_date', label: 'Date', kind: 'date', expr: 'a.on_date' },
      { key: 'person', label: 'Person', kind: 'text', expr: 'w.display_name' },
      { key: 'employer', label: 'Employer', kind: 'text', expr: 'sub.name' },
      { key: 'department', label: 'Department', kind: 'text', expr: 'dep.name' },
      { key: 'leave_type', label: 'Leave type', kind: 'text', expr: 't.code' },
      { key: 'hours', label: 'Hours', kind: 'number', expr: 'a.hours' },
      { key: 'source', label: 'Source', kind: 'enum', expr: 'a.source', options: HRM_ABSENCE_SOURCES },
      { key: 'employment_id', label: 'Employment (id)', kind: 'uuid', expr: 'a.employment_id' },
      { key: 'id', label: 'Absence (id)', kind: 'uuid', expr: 'a.id' },
    ],
    defaultSort: { column: 'on_date', direction: 'desc' },
  },
  {
    key: 'hrm_requisitions',
    label: 'Requisitions',
    category: 'hrm',
    description:
      'One row per vacancy opening: number, title, status, employer, department, position, and headcount versus filled count. Requires the HRM recruiting permission.',
    // One row per requisition with its establishment and placement. The
    // fill itself is hire-driven (filled_count moves only in the hire
    // transaction), so the register reads the stored counters, never a
    // computed join that could disagree with the hire evidence.
    from: `hrm_requisitions r
  JOIN subsidiaries sub ON sub.id = r.employer_subsidiary_id AND sub.org_id = r.org_id
  LEFT JOIN departments dep ON dep.id = r.department_id AND dep.org_id = r.org_id
  LEFT JOIN positions p ON p.id = r.position_id AND p.org_id = r.org_id`,
    orgColumn: 'r.org_id',
    // The opening's employer is the legal-entity boundary: the executor
    // clamps this to the reader's allowlist, so a restricted reader sees
    // only their own vacancies.
    subsidiaryScope: { column: 'r.employer_subsidiary_id' },
    requiredPermission: HRM_RECRUITING_READ_PERMISSION,
    featureKey: HRM_FEATURE_KEY,
    // A register, not a point-in-time statement: no as-of sentinel and no
    // implicit period — the opened_on column below carries the fact.
    defaultPeriodField: null,
    columns: [
      { key: 'number', label: 'Number', kind: 'text', expr: 'r.requisition_number' },
      { key: 'title', label: 'Title', kind: 'text', expr: 'r.title' },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'r.status', options: HRM_REQUISITION_STATUSES },
      { key: 'employer', label: 'Employer', kind: 'text', expr: 'sub.name' },
      { key: 'department', label: 'Department', kind: 'text', expr: 'dep.name' },
      { key: 'position', label: 'Position', kind: 'text', expr: 'p.position_code' },
      { key: 'headcount', label: 'Headcount', kind: 'number', expr: 'r.headcount' },
      { key: 'filled_count', label: 'Filled', kind: 'number', expr: 'r.filled_count' },
      { key: 'opened_on', label: 'Opened', kind: 'date', expr: 'r.opened_on' },
      { key: 'closed_on', label: 'Closed', kind: 'date', expr: 'r.closed_on' },
      { key: 'requisition_id', label: 'Requisition (id)', kind: 'uuid', expr: 'r.id' },
    ],
    defaultSort: { column: 'number', direction: 'asc' },
  },
  {
    key: 'hrm_applications',
    label: 'Applications',
    category: 'hrm',
    description:
      'One row per candidacy with its funnel stage, plus the funnel-per-stage counts and time-to-fill from opening to hire. Candidate contact PII never leaves through reports — names only. Requires the HRM recruiting permission.',
    // One row per application on its requisition's funnel: the stage name
    // resolves through the same-org stage join, and the hire day resolves
    // through the append-only event ledger (the first hired event), never
    // through a mutable column — so the funnel and the time-to-fill read
    // the same evidence the services wrote.
    from: `hrm_applications a
  JOIN hrm_requisitions r ON r.id = a.requisition_id AND r.org_id = a.org_id
  JOIN hrm_candidates c ON c.id = a.candidate_id AND c.org_id = a.org_id
  JOIN hrm_pipeline_stages s ON s.id = a.stage_id AND s.org_id = a.org_id
  JOIN subsidiaries sub ON sub.id = r.employer_subsidiary_id AND sub.org_id = a.org_id
  LEFT JOIN LATERAL (
    SELECT min(e.recorded_at)::date AS hired_on
      FROM hrm_application_events e
     WHERE e.org_id = a.org_id AND e.application_id = a.id AND e.kind = 'hired'
  ) hire ON TRUE`,
    orgColumn: 'a.org_id',
    // The opening's employer is the legal-entity boundary, as above.
    subsidiaryScope: { column: 'r.employer_subsidiary_id' },
    requiredPermission: HRM_RECRUITING_READ_PERMISSION,
    featureKey: HRM_FEATURE_KEY,
    defaultPeriodField: null,
    columns: [
      { key: 'requisition_number', label: 'Requisition', kind: 'text', expr: 'r.requisition_number' },
      { key: 'candidate', label: 'Candidate', kind: 'text', expr: 'c.display_name' },
      { key: 'stage', label: 'Stage', kind: 'text', expr: 's.name' },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'a.status', options: HRM_APPLICATION_STATUSES },
      { key: 'applied_on', label: 'Applied', kind: 'date', expr: 'a.applied_on' },
      { key: 'opened_on', label: 'Requisition opened', kind: 'date', expr: 'r.opened_on' },
      { key: 'hired_on', label: 'Hired', kind: 'date', expr: 'hire.hired_on' },
      {
        key: 'days_to_fill',
        label: 'Days to fill',
        kind: 'number',
        expr: 'hire.hired_on - r.opened_on',
      },
      { key: 'application_id', label: 'Application (id)', kind: 'uuid', expr: 'a.id' },
    ],
    defaultSort: { column: 'applied_on', direction: 'desc' },
  },
  {
    key: 'hrm_reviews',
    label: 'Reviews',
    category: 'hrm',
    description:
      'One row per performance review — cycle and period, employee, kind, status, and the author rating beside the calibration. HR-only: runners hold the performance grant, so unshared reviews never leave the HR scope. Requires the HRM performance permission.',
    // One row per hrm_reviews assessment with its cycle period and the
    // subject's name. Calibration never overwrites: both ratings read
    // side by side with the reason. Review texts stay out of the report
    // (free-text assessments are PII-dense); ratings and lifecycle state
    // are the reportable facts.
    from: `hrm_reviews r
      JOIN hrm_review_cycles c ON c.id = r.cycle_id AND c.org_id = r.org_id
      JOIN worker_employments e ON e.id = r.employment_id AND e.org_id = r.org_id
      JOIN parties w ON w.id = e.worker_party_id AND w.org_id = r.org_id
      JOIN subsidiaries sub ON sub.id = e.employer_subsidiary_id AND sub.org_id = r.org_id`,
    orgColumn: 'r.org_id',
    subsidiaryScope: { column: 'e.employer_subsidiary_id' },
    requiredPermission: HRM_PERFORMANCE_READ_PERMISSION,
    featureKey: HRM_FEATURE_KEY,
    // The cycle period end is the fact: the period picker narrows reviews
    // to the cycles that ended in the window.
    defaultPeriodField: 'period_end_on',
    columns: [
      { key: 'cycle', label: 'Cycle', kind: 'text', expr: 'c.name' },
      { key: 'period_end_on', label: 'Period end', kind: 'date', expr: 'c.period_end_on' },
      { key: 'employee', label: 'Employee', kind: 'text', expr: 'w.display_name' },
      { key: 'employer', label: 'Employer', kind: 'text', expr: 'sub.name' },
      { key: 'kind', label: 'Kind', kind: 'enum', expr: 'r.kind', options: HRM_REVIEW_KINDS },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'r.status', options: HRM_REVIEW_STATUSES },
      { key: 'overall_rating', label: 'Rating', kind: 'number', expr: 'r.overall_rating' },
      { key: 'calibrated_rating', label: 'Calibrated rating', kind: 'number', expr: 'r.calibrated_rating' },
      { key: 'employment_id', label: 'Employment (id)', kind: 'uuid', expr: 'r.employment_id' },
      { key: 'id', label: 'Review (id)', kind: 'uuid', expr: 'r.id' },
    ],
    defaultSort: { column: 'period_end_on', direction: 'desc' },
  },
  {
    key: 'hrm_goals',
    label: 'Goals',
    category: 'hrm',
    description:
      'One row per performance goal — employee, title, status, progress, and due date. Requires the HRM performance permission.',
    from: `hrm_goals g
      JOIN worker_employments e ON e.id = g.employment_id AND e.org_id = g.org_id
      JOIN parties w ON w.id = e.worker_party_id AND w.org_id = g.org_id
      JOIN subsidiaries sub ON sub.id = e.employer_subsidiary_id AND sub.org_id = g.org_id`,
    orgColumn: 'g.org_id',
    subsidiaryScope: { column: 'e.employer_subsidiary_id' },
    requiredPermission: HRM_PERFORMANCE_READ_PERMISSION,
    featureKey: HRM_FEATURE_KEY,
    defaultPeriodField: 'due_on',
    columns: [
      { key: 'employee', label: 'Employee', kind: 'text', expr: 'w.display_name' },
      { key: 'employer', label: 'Employer', kind: 'text', expr: 'sub.name' },
      { key: 'title', label: 'Title', kind: 'text', expr: 'g.title' },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'g.status', options: HRM_GOAL_STATUSES },
      { key: 'progress', label: 'Progress', kind: 'number', expr: 'g.progress_percent' },
      { key: 'due_on', label: 'Due on', kind: 'date', expr: 'g.due_on' },
      { key: 'employment_id', label: 'Employment (id)', kind: 'uuid', expr: 'g.employment_id' },
      { key: 'id', label: 'Goal (id)', kind: 'uuid', expr: 'g.id' },
    ],
    defaultSort: { column: 'due_on', direction: 'asc' },
  },
  {
    key: 'hrm_turnover',
    label: 'Turnover',
    category: 'hrm',
    description:
      'One row per leaver — person, termination date, tenure in days, exit reason, and the voluntary and regrettable flags from the exit record. Group by termination month and department for the period-by-department leaver table; rates come from the Retention panel, which pairs leavers with both headcount legs. Leavers without an exit record read involuntary until recorded. Requires the HRM retention permission.',
    // Leaver facts: the terminated version start is the termination date.
    // The base subquery pins the leaver set (terminated, currently
    // asserted — superseded rows are not the story); tenure runs from the
    // earliest version start, the department is the live primary
    // assignment's department at termination, and the flags come from the
    // exit record when one exists (LEFT: a missing record is a gap, never
    // a dropped leaver).
    from: `(SELECT * FROM worker_employment_versions WHERE status = 'terminated' AND recorded_until IS NULL) t
      JOIN worker_employments e ON e.id = t.employment_id AND e.org_id = t.org_id
      JOIN parties w ON w.id = e.worker_party_id AND w.org_id = t.org_id
      JOIN subsidiaries sub ON sub.id = e.employer_subsidiary_id AND sub.org_id = t.org_id
      LEFT JOIN employment_assignment_versions pa
        ON pa.employment_id = t.employment_id AND pa.org_id = t.org_id
       AND pa.is_primary AND pa.recorded_until IS NULL
       AND pa.effective_from <= t.effective_from
       AND (pa.effective_to IS NULL OR pa.effective_to > t.effective_from)
      LEFT JOIN departments dep ON dep.id = pa.department_id AND dep.org_id = t.org_id
      LEFT JOIN hrm_exit_records x ON x.employment_id = t.employment_id AND x.org_id = t.org_id
      JOIN LATERAL (
        SELECT min(effective_from) AS first_from
          FROM worker_employment_versions
         WHERE org_id = t.org_id AND employment_id = t.employment_id
      ) f ON TRUE`,
    orgColumn: 't.org_id',
    subsidiaryScope: { column: 'e.employer_subsidiary_id' },
    requiredPermission: HRM_RETENTION_READ_PERMISSION,
    featureKey: HRM_FEATURE_KEY,
    defaultPeriodField: 'terminated_on',
    columns: [
      { key: 'person', label: 'Person', kind: 'text', expr: 'w.display_name' },
      { key: 'employer', label: 'Employer', kind: 'text', expr: 'sub.name' },
      { key: 'department', label: 'Department', kind: 'text', expr: 'dep.name' },
      { key: 'terminated_on', label: 'Terminated on', kind: 'date', expr: 't.effective_from' },
      { key: 'tenure_days', label: 'Tenure (days)', kind: 'number', expr: `(t.effective_from - f.first_from)` },
      { key: 'reason', label: 'Reason', kind: 'enum', expr: 'x.reason_kind', options: HRM_EXIT_REASONS },
      { key: 'voluntary', label: 'Voluntary', kind: 'boolean', expr: 'coalesce(x.is_voluntary, false)' },
      { key: 'regrettable', label: 'Regrettable', kind: 'boolean', expr: 'coalesce(x.is_regrettable, false)' },
      { key: 'employment_id', label: 'Employment (id)', kind: 'uuid', expr: 't.employment_id' },
    ],
    defaultSort: { column: 'terminated_on', direction: 'desc' },
  },
  {
    key: 'hrm_benefit_enrollments',
    label: 'Benefit enrolments',
    category: 'hrm',
    description:
      'One row per benefit election — person, employer, department at election, plan and coverage tier, status, and the stored per-period employee and employer amounts in plan currency. Requires the HRM benefits permission.',
    // One row per hrm_benefit_enrollments row with its stored amounts: a
    // later plan repricing never rewrites these figures, so SUM over a
    // period is the cost the org actually owes. The department is the
    // primary assignment effective on the election start — the same
    // half-open containment the absence entity uses — NULL when no primary
    // covered the day (an unattributed bucket, never dropped and never
    // misattributed). This entity never joins the payroll ledger: election
    // amounts here, money movement in payroll's own entities.
    from: `hrm_benefit_enrollments e
      JOIN hrm_benefit_plans p ON p.id = e.plan_id AND p.org_id = e.org_id
      JOIN worker_employments emp ON emp.id = e.employment_id AND emp.org_id = e.org_id
      JOIN parties w ON w.id = emp.worker_party_id AND w.org_id = e.org_id
      JOIN subsidiaries sub ON sub.id = emp.employer_subsidiary_id AND sub.org_id = e.org_id
      LEFT JOIN hrm_benefit_plan_levels lvl
        ON lvl.plan_id = e.plan_id AND lvl.org_id = e.org_id AND lvl.level_key = e.coverage_level_key
      LEFT JOIN employment_assignment_versions pa
        ON pa.employment_id = e.employment_id AND pa.org_id = e.org_id
       AND pa.is_primary AND pa.recorded_until IS NULL
       AND pa.effective_from <= e.effective_from
       AND (pa.effective_to IS NULL OR pa.effective_to > e.effective_from)
      LEFT JOIN departments dep ON dep.id = pa.department_id AND dep.org_id = e.org_id`,
    orgColumn: 'e.org_id',
    subsidiaryScope: { column: 'emp.employer_subsidiary_id' },
    requiredPermission: HRM_BENEFITS_READ_PERMISSION,
    featureKey: HRM_FEATURE_KEY,
    // The election start is the fact: the period picker narrows cost by
    // the month coverage began, so a mid-year election attributes to its
    // own period, never to the plan year.
    defaultPeriodField: 'effective_from',
    columns: [
      { key: 'effective_from', label: 'Effective from', kind: 'date', expr: 'e.effective_from' },
      { key: 'person', label: 'Person', kind: 'text', expr: 'w.display_name' },
      { key: 'employer', label: 'Employer', kind: 'text', expr: 'sub.name' },
      { key: 'department', label: 'Department', kind: 'text', expr: 'dep.name' },
      { key: 'plan', label: 'Plan', kind: 'text', expr: 'p.code' },
      { key: 'plan_name', label: 'Plan name', kind: 'text', expr: 'p.name' },
      { key: 'coverage', label: 'Coverage', kind: 'text', expr: 'lvl.label' },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'e.status', options: HRM_ENROLLMENT_STATUSES },
      { key: 'employee_amount', label: 'Employee amount', kind: 'number', expr: 'e.employee_amount_per_period' },
      { key: 'employer_amount', label: 'Employer amount', kind: 'number', expr: 'e.employer_amount_per_period' },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 'e.currency' },
      { key: 'effective_to', label: 'Effective to', kind: 'date', expr: 'e.effective_to' },
      { key: 'employment_id', label: 'Employment (id)', kind: 'uuid', expr: 'e.employment_id' },
      { key: 'id', label: 'Enrolment (id)', kind: 'uuid', expr: 'e.id' },
    ],
    defaultSort: { column: 'effective_from', direction: 'desc' },
  },
  // HR-16 begin: the automation recipe register (0226) — one row per org
  // recipe with its trigger kind, status, version, and last run. Recipes
  // are platform configuration, so no subsidiary scope: visibility rides
  // the automations.read grant and the automations switch.
  {
    key: 'automations',
    label: 'Automations',
    category: 'hrm',
    description:
      'One row per automation recipe — trigger kind, status, version, and last run. Requires the automations permission.',
    from: `automations a`,
    orgColumn: 'a.org_id',
    requiredPermission: AUTOMATIONS_READ_PERMISSION,
    featureKey: AUTOMATIONS_FEATURE_KEY,
    defaultPeriodField: 'created_at',
    columns: [
      { key: 'name', label: 'Name', kind: 'text', expr: 'a.name' },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'a.status', options: AUTOMATION_STATUSES },
      { key: 'trigger_kind', label: 'Trigger', kind: 'enum', expr: `(a.trigger ->> 'kind')`, options: AUTOMATION_TRIGGER_KINDS },
      { key: 'version', label: 'Version', kind: 'number', expr: 'a.version' },
      { key: 'priority', label: 'Priority', kind: 'number', expr: 'a.priority' },
      { key: 'last_run_at', label: 'Last run at', kind: 'timestamp', expr: 'a.last_run_at' },
      { key: 'error_message', label: 'Error', kind: 'text', expr: 'a.error_message' },
      { key: 'created_at', label: 'Created at', kind: 'timestamp', expr: 'a.created_at' },
      { key: 'id', label: 'Automation (id)', kind: 'uuid', expr: 'a.id' },
    ],
    defaultSort: { column: 'name', direction: 'asc' },
  },
  // HR-16 begin: the automation run log (0226) — append-only firing
  // evidence with the executed version, subject, steps, and error.
  {
    key: 'automation_runs',
    label: 'Automation runs',
    category: 'hrm',
    description:
      'One row per automation firing — executed version, subject, status, steps, and error. Requires the automations permission.',
    from: `automation_runs r JOIN automations a ON a.id = r.automation_id AND a.org_id = r.org_id`,
    orgColumn: 'r.org_id',
    requiredPermission: AUTOMATIONS_READ_PERMISSION,
    featureKey: AUTOMATIONS_FEATURE_KEY,
    defaultPeriodField: 'created_at',
    columns: [
      { key: 'automation', label: 'Automation', kind: 'text', expr: 'a.name' },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'r.status', options: AUTOMATION_RUN_STATUSES },
      { key: 'version', label: 'Version', kind: 'number', expr: 'r.version' },
      { key: 'subject_kind', label: 'Subject kind', kind: 'text', expr: 'r.subject_kind' },
      { key: 'subject_id', label: 'Subject (id)', kind: 'uuid', expr: 'r.subject_id' },
      { key: 'started_at', label: 'Started at', kind: 'timestamp', expr: 'r.started_at' },
      { key: 'finished_at', label: 'Finished at', kind: 'timestamp', expr: 'r.finished_at' },
      { key: 'error', label: 'Error', kind: 'text', expr: `(r.error ->> 'message')` },
      { key: 'created_at', label: 'Created at', kind: 'timestamp', expr: 'r.created_at' },
      { key: 'id', label: 'Run (id)', kind: 'uuid', expr: 'r.id' },
    ],
    defaultSort: { column: 'created_at', direction: 'desc' },
  },
  // HR-16 begin: the action/reason-code vocabulary (0227) — Setup-owned,
  // read through the employment grant behind the hrmActionReasons switch.
  {
    key: 'hrm_action_reasons',
    label: 'Action reasons',
    category: 'hrm',
    description:
      'One row per reason code per HR action — the vocabulary change requests file under. Requires the HRM employment permission.',
    from: `hrm_action_reasons r`,
    orgColumn: 'r.org_id',
    requiredPermission: HRM_EMPLOYMENT_READ_PERMISSION,
    featureKey: HRM_ACTION_REASONS_FEATURE_KEY,
    defaultPeriodField: 'created_at',
    columns: [
      { key: 'action', label: 'Action', kind: 'text', expr: 'r.action' },
      { key: 'reason_code', label: 'Code', kind: 'text', expr: 'r.reason_code' },
      { key: 'label', label: 'Label', kind: 'text', expr: 'r.label' },
      { key: 'requires_comment', label: 'Requires comment', kind: 'boolean', expr: 'r.requires_comment' },
      { key: 'is_active', label: 'Active', kind: 'boolean', expr: 'r.is_active' },
      { key: 'created_at', label: 'Created at', kind: 'timestamp', expr: 'r.created_at' },
      { key: 'id', label: 'Reason (id)', kind: 'uuid', expr: 'r.id' },
    ],
    defaultSort: { column: 'action', direction: 'asc' },
  },
  // HR-16 end
]
