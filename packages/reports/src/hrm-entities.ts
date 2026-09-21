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
export const HRM_COMPENSATION_READ_PERMISSION = 'hrm.compensation.read'
export const HRM_COMPENSATION_FEATURE_KEY = 'hrmCompensation'
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

// HR-12 begin
const HRM_COMP_LINE_STATUSES = ['pending', 'proposed', 'approved', 'rejected', 'pushed'] as const
const HRM_PLAN_LINE_KINDS = ['create', 'backfill', 'change', 'terminate'] as const
const HRM_PLAN_LINE_STATUSES = ['proposed', 'approved', 'rejected', 'opened', 'filled', 'cancelled'] as const
// HR-12 end
// HR-14 begin: certification register and alert queue report entities (0225).
export const HRM_CERTIFICATIONS_READ_PERMISSION = 'hrm.certifications.read'
export const HRM_CERTIFICATIONS_FEATURE_KEY = 'hrmCertifications'
export const HRM_CERTIFICATION_ALERTS_FEATURE_KEY = 'hrmCertificationAlerts'

const HRM_QUALIFICATION_STATUSES = ['valid', 'revoked', 'pending_verification'] as const
const HRM_ALERT_CHANNELS = ['inbox', 'email'] as const
// HR-14 end
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
  // HR-12 begin: compensation report entities — bands, cycle lines,
  // plan lines, and gap snapshots. All four sit behind the
  // compensation read grant and the hrmCompensation switch; gap
  // snapshots expose category aggregates only, never per-person pay.
  {
    key: 'hrm_pay_bands',
    label: 'Pay bands',
    category: 'hrm',
    description:
      'One row per live pay band version: level, scope, currency, basis, and the min/target/max SHOULD-pay figures with their effective window. Requires the HRM compensation permission.',
    from: `hrm_pay_bands b
  JOIN hrm_job_levels lvl ON lvl.id = b.level_id AND lvl.org_id = b.org_id
  LEFT JOIN hrm_job_families fam ON fam.id = b.family_id AND fam.org_id = b.org_id
  LEFT JOIN subsidiaries sub ON sub.id = b.employer_subsidiary_id AND sub.org_id = b.org_id`,
    orgColumn: 'b.org_id',
    subsidiaryScope: { column: 'b.employer_subsidiary_id' },
    requiredPermission: HRM_COMPENSATION_READ_PERMISSION,
    featureKey: HRM_COMPENSATION_FEATURE_KEY,
    defaultPeriodField: null,
    columns: [
      { key: 'level', label: 'Level', kind: 'text', expr: 'lvl.code' },
      { key: 'family', label: 'Family', kind: 'text', expr: 'fam.code' },
      { key: 'employer', label: 'Employer', kind: 'text', expr: 'sub.name' },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 'b.currency' },
      { key: 'basis', label: 'Basis', kind: 'text', expr: 'b.basis' },
      { key: 'min', label: 'Min', kind: 'number', expr: 'b.min' },
      { key: 'target', label: 'Target', kind: 'number', expr: 'b.target' },
      { key: 'max', label: 'Max', kind: 'number', expr: 'b.max' },
      { key: 'effective_from', label: 'Effective from', kind: 'date', expr: 'b.effective_from' },
      { key: 'effective_to', label: 'Effective to', kind: 'date', expr: 'b.effective_to' },
      { key: 'id', label: 'Band (id)', kind: 'uuid', expr: 'b.id' },
    ],
    defaultSort: { column: 'level', direction: 'asc' },
  },
  {
    key: 'hrm_comp_cycle_lines',
    label: 'Merit cycle lines',
    category: 'hrm',
    description:
      'One row per cycle decision: person, employer, snapshotted current rate, stored compa-ratio, guideline range, proposal, and status. Rates here are the frozen snapshot at open, never live payroll. Requires the HRM compensation permission.',
    from: `hrm_comp_cycle_lines l
      JOIN hrm_comp_cycles c ON c.id = l.cycle_id AND c.org_id = l.org_id
      JOIN worker_employments emp ON emp.id = l.employment_id AND emp.org_id = l.org_id
      JOIN parties w ON w.id = emp.worker_party_id AND w.org_id = l.org_id
      JOIN subsidiaries sub ON sub.id = emp.employer_subsidiary_id AND sub.org_id = l.org_id`,
    orgColumn: 'l.org_id',
    subsidiaryScope: { column: 'emp.employer_subsidiary_id' },
    requiredPermission: HRM_COMPENSATION_READ_PERMISSION,
    featureKey: HRM_COMPENSATION_FEATURE_KEY,
    defaultPeriodField: null,
    columns: [
      { key: 'cycle', label: 'Cycle', kind: 'text', expr: 'c.name' },
      { key: 'person', label: 'Person', kind: 'text', expr: 'w.display_name' },
      { key: 'employer', label: 'Employer', kind: 'text', expr: 'sub.name' },
      { key: 'current_rate', label: 'Current rate', kind: 'number', expr: 'l.current_rate' },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 'l.currency' },
      { key: 'compa_ratio', label: 'Compa-ratio', kind: 'number', expr: 'l.compa_ratio' },
      { key: 'proposed_pct', label: 'Proposed %', kind: 'number', expr: 'l.proposed_pct' },
      { key: 'proposed_rate', label: 'Proposed rate', kind: 'number', expr: 'l.proposed_rate' },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'l.status', options: HRM_COMP_LINE_STATUSES },
      { key: 'effective_on', label: 'Effective on', kind: 'date', expr: 'c.effective_on' },
      { key: 'employment_id', label: 'Employment (id)', kind: 'uuid', expr: 'l.employment_id' },
      { key: 'id', label: 'Line (id)', kind: 'uuid', expr: 'l.id' },
    ],
    defaultSort: { column: 'cycle', direction: 'asc' },
  },
  {
    key: 'hrm_headcount_plan_lines',
    label: 'Headcount plan lines',
    category: 'hrm',
    description:
      'One row per planned movement: plan, kind, title, employer, planned FTE, start, computed annual cost with its basis, and status. Costs are computed at save, never typed. Requires the HRM compensation permission.',
    from: `hrm_headcount_plan_lines l
      JOIN hrm_headcount_plans p ON p.id = l.plan_id AND p.org_id = l.org_id
      JOIN subsidiaries sub ON sub.id = l.employer_subsidiary_id AND sub.org_id = l.org_id`,
    orgColumn: 'l.org_id',
    subsidiaryScope: { column: 'l.employer_subsidiary_id' },
    requiredPermission: HRM_COMPENSATION_READ_PERMISSION,
    featureKey: HRM_COMPENSATION_FEATURE_KEY,
    defaultPeriodField: null,
    columns: [
      { key: 'plan', label: 'Plan', kind: 'text', expr: 'p.name' },
      { key: 'kind', label: 'Kind', kind: 'enum', expr: 'l.kind', options: HRM_PLAN_LINE_KINDS },
      { key: 'title', label: 'Title', kind: 'text', expr: 'l.title' },
      { key: 'employer', label: 'Employer', kind: 'text', expr: 'sub.name' },
      { key: 'planned_fte', label: 'Planned FTE', kind: 'number', expr: 'l.planned_fte' },
      { key: 'start_on', label: 'Start', kind: 'date', expr: 'l.start_on' },
      { key: 'est_annual_cost', label: 'Est. annual cost', kind: 'number', expr: 'l.est_annual_cost' },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 'l.currency' },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'l.status', options: HRM_PLAN_LINE_STATUSES },
      { key: 'id', label: 'Line (id)', kind: 'uuid', expr: 'l.id' },
    ],
    defaultSort: { column: 'plan', direction: 'asc' },
  },
  {
    key: 'hrm_pay_gap_snapshots',
    label: 'Pay gap snapshots',
    category: 'hrm',
    description:
      'One row per frozen snapshot per equal-value category: as-of date, level, headcounts, mean/median gaps, the OLS unexplained gap, and the joint-assessment flag. Category aggregates only — no per-person pay ever leaves through reports. Requires the HRM compensation permission.',
    // One row per snapshot × category: the categories jsonb expands in
    // a lateral (skipped by the join-pin rule, which only governs table
    // joins); the level join resolves the code and the subsidiary join
    // names a subsidiary-scoped population. Every table leg carries the
    // org pin.
    from: `hrm_pay_gap_snapshots s
      CROSS JOIN LATERAL jsonb_to_recordset(s.categories)
        AS c(level_id uuid, level_code text, count_a integer, count_b integer,
              mean_gap_pct numeric, median_gap_pct numeric, unexplained_gap_pct numeric,
              method text, joint_assessment_due boolean)
      LEFT JOIN hrm_job_levels lvl ON lvl.id = c.level_id AND lvl.org_id = s.org_id
      LEFT JOIN subsidiaries sub ON sub.id = (s.scope->>'employer_subsidiary_id')::uuid AND sub.org_id = s.org_id`,
    orgColumn: 's.org_id',
    // Snapshots are measured populations, optionally subsidiary-scoped:
    // org-wide snapshots stay visible to every permitted reader
    // (sharedNull), subsidiary ones only to that subsidiary's holders.
    subsidiaryScope: { column: `(s.scope->>'employer_subsidiary_id')::uuid`, sharedNull: true },
    requiredPermission: HRM_COMPENSATION_READ_PERMISSION,
    featureKey: HRM_COMPENSATION_FEATURE_KEY,
    defaultPeriodField: 'as_of',
    columns: [
      { key: 'as_of', label: 'As of', kind: 'date', expr: 's.as_of' },
      { key: 'employer', label: 'Employer', kind: 'text', expr: 'sub.name' },
      { key: 'level', label: 'Level', kind: 'text', expr: 'coalesce(lvl.code, c.level_code)' },
      { key: 'count_a', label: 'Headcount A', kind: 'number', expr: 'c.count_a' },
      { key: 'count_b', label: 'Headcount B', kind: 'number', expr: 'c.count_b' },
      { key: 'mean_gap_pct', label: 'Mean gap %', kind: 'number', expr: 'c.mean_gap_pct' },
      { key: 'median_gap_pct', label: 'Median gap %', kind: 'number', expr: 'c.median_gap_pct' },
      { key: 'unexplained_gap_pct', label: 'Unexplained gap %', kind: 'number', expr: 'c.unexplained_gap_pct' },
      { key: 'method', label: 'Method', kind: 'text', expr: 'c.method' },
      { key: 'joint_assessment_due', label: 'Joint assessment due', kind: 'boolean', expr: 'c.joint_assessment_due' },
      { key: 'id', label: 'Snapshot (id)', kind: 'uuid', expr: 's.id' },
    ],
    defaultSort: { column: 'as_of', direction: 'desc' },
  },
  // HR-12 end
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
  // HR-13 begin: construction-compliance report entities (0223/0224).
  // Gated on the construction switch with the construction read grant —
  // a general-business org never sees them, and the feature-off path
  // hides rather than empties.
  {
    key: 'hrm_rate_schedule_lines',
    label: 'Rate schedule lines',
    category: 'hrm',
    description:
      'One row per schedule, classification, and effective date: the resolvable base, cash fringe, creditable fringe, and overtime multiplier the wage resolver prices from.',
    from: `hrm_rate_schedule_lines l
  JOIN hrm_rate_schedules s ON s.id = l.schedule_id AND s.org_id = l.org_id
  JOIN hrm_work_classifications c ON c.id = l.classification_id AND c.org_id = l.org_id`,
    orgColumn: 'l.org_id',
    // Org-level rate configuration: no subsidiary boundary applies, so no
    // clamp — the construction read grant and the feature switch are the
    // gates, enforced generically at every run path.
    subsidiaryScope: null,
    requiredPermission: 'hrm.construction.read',
    featureKey: 'hrmConstructionCompliance',
    defaultPeriodField: null,
    columns: [
      { key: 'schedule', label: 'Schedule', kind: 'text', expr: 's.name' },
      { key: 'classification', label: 'Classification', kind: 'text', expr: 'c.code' },
      { key: 'base_rate', label: 'Base rate', kind: 'number', expr: 'l.base_rate' },
      { key: 'fringe_rate', label: 'Cash fringe', kind: 'number', expr: 'l.fringe_rate' },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 'l.currency' },
      { key: 'effective_from', label: 'Effective from', kind: 'date', expr: 'l.effective_from' },
    ],
    defaultSort: { column: 'effective_from', direction: 'desc' },
  },
  {
    key: 'hrm_per_diem_entries',
    label: 'Per-diem entries',
    category: 'hrm',
    description:
      'One row per employment, project, and day: computed per-diem and travel amounts with their status across computed, approved, voided, and consumed.',
    from: `hrm_per_diem_entries e
  JOIN hrm_per_diem_policies p ON p.id = e.policy_id AND p.org_id = e.org_id
  LEFT JOIN pay_components pc ON pc.id = p.pay_component_id AND pc.org_id = p.org_id
  JOIN worker_employments w ON w.id = e.employment_id AND w.org_id = e.org_id`,
    orgColumn: 'e.org_id',
    // The employment's employer subsidiary is the legal-entity boundary:
    // the executor clamps this to the reader's allowlist.
    subsidiaryScope: { column: 'w.employer_subsidiary_id' },
    requiredPermission: 'hrm.construction.read',
    featureKey: 'hrmConstructionCompliance',
    defaultPeriodField: 'worked_on',
    columns: [
      { key: 'worked_on', label: 'Day', kind: 'date', expr: 'e.worked_on' },
      { key: 'amount', label: 'Amount', kind: 'number', expr: 'e.amount' },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 'e.currency' },
      { key: 'status', label: 'Status', kind: 'text', expr: 'e.status' },
      { key: 'employment_id', label: 'Employment (id)', kind: 'uuid', expr: 'e.employment_id' },
    ],
    defaultSort: { column: 'worked_on', direction: 'desc' },
  },
  {
    key: 'hrm_comp_class_split',
    label: 'Comp class split',
    category: 'hrm',
    description:
      'Approved project hours priced per comp class: the daily split the resolver reports from the priority match rules.',
    from: `hrm_comp_class_rules r
  JOIN hrm_comp_classes c ON c.id = r.comp_class_id AND c.org_id = r.org_id
  LEFT JOIN hrm_work_classifications cl ON cl.id::text = (r.match->>'classification_id') AND cl.org_id = r.org_id`,
    orgColumn: 'r.org_id',
    // Org-level match configuration: no subsidiary boundary applies, so
    // no clamp — the construction read grant and the feature switch are
    // the gates, enforced generically at every run path.
    subsidiaryScope: null,
    requiredPermission: 'hrm.construction.read',
    featureKey: 'hrmConstructionCompliance',
    defaultPeriodField: null,
    columns: [
      { key: 'class', label: 'Class', kind: 'text', expr: 'c.code' },
      { key: 'priority', label: 'Priority', kind: 'number', expr: 'r.priority' },
      { key: 'rate', label: 'Rate / 100', kind: 'number', expr: 'c.rate_per_100' },
    ],
    defaultSort: { column: 'priority', direction: 'desc' },
  },
  {
    key: 'hrm_certified_runs',
    label: 'Certified runs',
    category: 'hrm',
    description:
      'Certified payroll runs by project and week: frozen payloads with their pack format, file artefact, and amendment links.',
    from: `hrm_certified_payroll_runs r
  LEFT JOIN projects p ON p.id = r.project_id AND p.org_id = r.org_id
  LEFT JOIN hrm_certified_payroll_runs a ON a.id = r.amends_run_id AND a.org_id = r.org_id`,
    orgColumn: 'r.org_id',
    // The project's subsidiary is the legal-entity boundary: the executor
    // clamps this to the reader's allowlist. Runs on subsidiary-less
    // projects hide from restricted readers (fail closed), never leak.
    subsidiaryScope: { column: 'p.subsidiary_id' },
    requiredPermission: 'hrm.construction.read',
    featureKey: 'hrmConstructionCompliance',
    defaultPeriodField: 'week_ending',
    columns: [
      { key: 'week_ending', label: 'Week ending', kind: 'date', expr: 'r.week_ending' },
      { key: 'format_key', label: 'Format', kind: 'text', expr: 'r.format_key' },
      { key: 'status', label: 'Status', kind: 'text', expr: 'r.status' },
      { key: 'project_id', label: 'Project (id)', kind: 'uuid', expr: 'r.project_id' },
    ],
    defaultSort: { column: 'week_ending', direction: 'desc' },
  },
  {
    key: 'hrm_compliance_findings',
    label: 'Compliance findings',
    category: 'hrm',
    description:
      'Append-only pre-run flags by kind: ratio breaches, missing rates, unresolved classes, missing registrations, and fringe mismatches with their lifecycle status.',
    from: `hrm_compliance_findings f
  LEFT JOIN projects p ON p.id = f.project_id AND p.org_id = f.org_id
  LEFT JOIN worker_employments w ON w.id = f.employment_id AND w.org_id = f.org_id`,
    orgColumn: 'f.org_id',
    // The employment's employer subsidiary is the legal-entity boundary.
    // Employment-less flags hide from restricted readers (fail closed).
    subsidiaryScope: { column: 'w.employer_subsidiary_id' },
    requiredPermission: 'hrm.construction.read',
    featureKey: 'hrmConstructionCompliance',
    defaultPeriodField: 'worked_on',
    columns: [
      { key: 'kind', label: 'Kind', kind: 'text', expr: 'f.kind' },
      { key: 'worked_on', label: 'Day', kind: 'date', expr: 'f.worked_on' },
      { key: 'status', label: 'Status', kind: 'text', expr: 'f.status' },
      { key: 'project_id', label: 'Project (id)', kind: 'uuid', expr: 'f.project_id' },
    ],
    defaultSort: { column: 'worked_on', direction: 'desc' },
  },
  // HR-13 end
  // HR-14 begin: certification register (one row per held qualification)
  // and the renewal alert queue (one row per qualification/lead-day).
  // Both read the 0225 ledger through the same joins the engine read
  // path uses; expiring/expired stays a viewer derivation over
  // expires_on against the org business day — storage holds only
  // valid/revoked/pending_verification, so the report never persists a
  // projection either. Renewals are new rows (linked by events), so the
  // register shows every issuance; revoked rows stay visible as history.
  {
    key: 'hrm_qualifications',
    label: 'Qualifications',
    category: 'hrm',
    description:
      'One row per held certification or license — holder, employer, type and category, issuance and expiry, and stored status with its verification. Requires the HRM certifications permission.',
    from: `hrm_worker_qualifications q
      JOIN hrm_qualification_types t ON t.id = q.type_id AND t.org_id = q.org_id
      JOIN worker_employments e ON e.id = q.employment_id AND e.org_id = q.org_id
      JOIN parties w ON w.id = e.worker_party_id AND w.org_id = q.org_id
      JOIN subsidiaries sub ON sub.id = e.employer_subsidiary_id AND sub.org_id = q.org_id`,
    orgColumn: 'q.org_id',
    subsidiaryScope: { column: 'e.employer_subsidiary_id' },
    requiredPermission: HRM_CERTIFICATIONS_READ_PERMISSION,
    featureKey: HRM_CERTIFICATIONS_FEATURE_KEY,
    // The expiry day is the fact: the period picker narrows on it, so a
    // register filtered to a window lists what lapses inside it.
    defaultPeriodField: 'expires_on',
    columns: [
      { key: 'employee', label: 'Employee', kind: 'text', expr: 'w.display_name' },
      { key: 'employer', label: 'Employer', kind: 'text', expr: 'sub.name' },
      { key: 'type_code', label: 'Type code', kind: 'text', expr: 't.code' },
      { key: 'type_name', label: 'Type', kind: 'text', expr: 't.name' },
      { key: 'category', label: 'Category', kind: 'text', expr: 't.category' },
      { key: 'identifier', label: 'License no.', kind: 'text', expr: 'q.identifier' },
      { key: 'issued_on', label: 'Issued on', kind: 'date', expr: 'q.issued_on' },
      { key: 'expires_on', label: 'Expires on', kind: 'date', expr: 'q.expires_on' },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'q.status', options: HRM_QUALIFICATION_STATUSES },
      { key: 'verified_at', label: 'Verified at', kind: 'timestamp', expr: 'q.verified_at' },
      { key: 'qualification_id', label: 'Qualification (id)', kind: 'uuid', expr: 'q.id' },
      { key: 'employment_id', label: 'Employment (id)', kind: 'uuid', expr: 'q.employment_id' },
    ],
    defaultSort: { column: 'expires_on', direction: 'asc' },
  },
  {
    key: 'hrm_qualification_alerts',
    label: 'Qualification alerts',
    category: 'hrm',
    description:
      'One row per certification renewal alert — holder, type, expiry, the lead-day schedule it fired on, and whether it has been sent. Requires the HRM certifications permission.',
    from: `hrm_qualification_alerts a
      JOIN hrm_worker_qualifications q ON q.id = a.qualification_id AND q.org_id = a.org_id
      JOIN hrm_qualification_types t ON t.id = q.type_id AND t.org_id = a.org_id
      JOIN worker_employments e ON e.id = q.employment_id AND e.org_id = a.org_id
      JOIN parties w ON w.id = e.worker_party_id AND w.org_id = a.org_id`,
    orgColumn: 'a.org_id',
    subsidiaryScope: { column: 'e.employer_subsidiary_id' },
    requiredPermission: HRM_CERTIFICATIONS_READ_PERMISSION,
    featureKey: HRM_CERTIFICATION_ALERTS_FEATURE_KEY,
    // The due day is the fact: the period picker narrows on it, so the
    // queue filtered to a window lists what comes due inside it.
    defaultPeriodField: 'due_on',
    columns: [
      { key: 'employee', label: 'Employee', kind: 'text', expr: 'w.display_name' },
      { key: 'type_code', label: 'Type code', kind: 'text', expr: 't.code' },
      { key: 'type_name', label: 'Type', kind: 'text', expr: 't.name' },
      { key: 'expires_on', label: 'Expires on', kind: 'date', expr: 'q.expires_on' },
      { key: 'due_on', label: 'Due on', kind: 'date', expr: 'a.due_on' },
      { key: 'lead_days', label: 'Lead days', kind: 'number', expr: 'a.lead_days' },
      { key: 'sent_at', label: 'Sent at', kind: 'timestamp', expr: 'a.sent_at' },
      { key: 'channel', label: 'Channel', kind: 'enum', expr: 'a.channel', options: HRM_ALERT_CHANNELS },
      { key: 'alert_id', label: 'Alert (id)', kind: 'uuid', expr: 'a.id' },
      { key: 'qualification_id', label: 'Qualification (id)', kind: 'uuid', expr: 'a.qualification_id' },
    ],
    defaultSort: { column: 'due_on', direction: 'asc' },
  },
  // HR-14 end
  // HR-17 begin: continuous-performance entities (0228). 1:1s, feedback,
  // calibration entries and talent reviews read through the HR grant
  // (hrm.performance.read) with the report engine's run-path gate — the
  // same reader-grant pattern as hrm_reviews — each behind its own
  // sub-feature switch. Feedback applies the service's visibility scope:
  // only HR runners reach this entity, and retracted originals plus
  // retraction rows never read (the read hides both, exactly like the
  // service). Talent and succession rows are HR-only by the same gate.
  {
    key: 'hrm_one_on_ones',
    label: 'One-on-ones',
    category: 'hrm',
    description:
      'One row per 1:1 meeting — manager, report, scheduled and held dates, and status. Requires the HRM performance permission.',
    from: `hrm_one_on_ones o
      JOIN worker_employments m ON m.id = o.manager_employment_id AND m.org_id = o.org_id
      JOIN worker_employments r ON r.id = o.report_employment_id AND r.org_id = o.org_id
      JOIN parties mp ON mp.id = m.worker_party_id AND mp.org_id = o.org_id
      JOIN parties rp ON rp.id = r.worker_party_id AND rp.org_id = o.org_id
      JOIN subsidiaries sub ON sub.id = r.employer_subsidiary_id AND sub.org_id = o.org_id`,
    orgColumn: 'o.org_id',
    subsidiaryScope: { column: 'r.employer_subsidiary_id' },
    requiredPermission: HRM_PERFORMANCE_READ_PERMISSION,
    featureKey: 'hrmOneOnOnes',
    defaultPeriodField: 'scheduled_at',
    columns: [
      { key: 'scheduled_at', label: 'Scheduled', kind: 'date', expr: 'o.scheduled_at' },
      { key: 'held_at', label: 'Held', kind: 'date', expr: 'o.held_at' },
      { key: 'manager', label: 'Manager', kind: 'text', expr: 'mp.display_name' },
      { key: 'report', label: 'Report', kind: 'text', expr: 'rp.display_name' },
      { key: 'employer', label: 'Employer', kind: 'text', expr: 'sub.name' },
      { key: 'status', label: 'Status', kind: 'text', expr: 'o.status' },
      { key: 'id', label: 'Meeting (id)', kind: 'uuid', expr: 'o.id' },
    ],
    defaultSort: { column: 'scheduled_at', direction: 'desc' },
  },
  {
    key: 'hrm_feedback',
    label: 'Feedback',
    category: 'hrm',
    description:
      'One row per praise, feedback, or request — subject, kind, visibility, and recorded date. HR-only runners (the service visibility matrix lives at the write/read service); retracted rows and retractions never read. Requires the HRM performance permission.',
    // Retractions hide both rows, exactly like listFeedback: the
    // retraction rows themselves never read, and neither do the
    // originals they link.
    from: `(SELECT * FROM hrm_feedback f0
       WHERE f0.kind <> 'retraction'
         AND NOT EXISTS (SELECT 1 FROM hrm_feedback r0
                          WHERE r0.org_id = f0.org_id AND r0.kind = 'retraction'
                            AND r0.retracts_feedback_id = f0.id)) f
      JOIN worker_employments e ON e.id = f.subject_employment_id AND e.org_id = f.org_id
      JOIN parties w ON w.id = e.worker_party_id AND w.org_id = f.org_id
      JOIN subsidiaries sub ON sub.id = e.employer_subsidiary_id AND sub.org_id = f.org_id`,
    orgColumn: 'f.org_id',
    subsidiaryScope: { column: 'e.employer_subsidiary_id' },
    requiredPermission: HRM_PERFORMANCE_READ_PERMISSION,
    featureKey: 'hrmFeedback',
    defaultPeriodField: 'recorded_at',
    columns: [
      { key: 'recorded_at', label: 'Recorded', kind: 'date', expr: 'f.recorded_at' },
      { key: 'employee', label: 'Employee', kind: 'text', expr: 'w.display_name' },
      { key: 'employer', label: 'Employer', kind: 'text', expr: 'sub.name' },
      { key: 'kind', label: 'Kind', kind: 'text', expr: 'f.kind' },
      { key: 'visibility', label: 'Visibility', kind: 'text', expr: 'f.visibility' },
      { key: 'id', label: 'Feedback (id)', kind: 'uuid', expr: 'f.id' },
    ],
    defaultSort: { column: 'recorded_at', direction: 'desc' },
  },
  {
    key: 'hrm_calibration_entries',
    label: 'Calibration entries',
    category: 'hrm',
    description:
      'One row per calibrated review — session, employee, proposed beside calibrated rating, potential, and the decider. Requires the HRM performance permission.',
    from: `hrm_calibration_entries e
      JOIN hrm_calibration_sessions s ON s.id = e.session_id AND s.org_id = e.org_id
      JOIN hrm_reviews r ON r.id = e.review_id AND r.org_id = e.org_id
      JOIN worker_employments emp ON emp.id = r.employment_id AND emp.org_id = e.org_id
      JOIN parties w ON w.id = emp.worker_party_id AND w.org_id = e.org_id
      JOIN subsidiaries sub ON sub.id = emp.employer_subsidiary_id AND sub.org_id = e.org_id`,
    orgColumn: 'e.org_id',
    subsidiaryScope: { column: 'emp.employer_subsidiary_id' },
    requiredPermission: HRM_PERFORMANCE_READ_PERMISSION,
    featureKey: 'hrmCalibration',
    defaultPeriodField: 'decided_at',
    columns: [
      { key: 'session', label: 'Session', kind: 'text', expr: 's.name' },
      { key: 'employee', label: 'Employee', kind: 'text', expr: 'w.display_name' },
      { key: 'employer', label: 'Employer', kind: 'text', expr: 'sub.name' },
      { key: 'proposed_rating', label: 'Proposed', kind: 'number', expr: 'e.proposed_rating' },
      { key: 'calibrated_rating', label: 'Calibrated', kind: 'number', expr: 'e.calibrated_rating' },
      { key: 'potential_key', label: 'Potential', kind: 'text', expr: 'e.potential_key' },
      { key: 'decided_at', label: 'Decided', kind: 'date', expr: 'e.decided_at' },
      { key: 'id', label: 'Entry (id)', kind: 'uuid', expr: 'e.id' },
    ],
    defaultSort: { column: 'decided_at', direction: 'desc' },
  },
  {
    key: 'hrm_talent_reviews',
    label: 'Talent reviews',
    category: 'hrm',
    description:
      'One row per talent review — employee, performance and potential keys, loss impact and risk, and promotion readiness. HR-only, never visible to the subject. Requires the HRM performance permission.',
    from: `hrm_talent_reviews t
      JOIN worker_employments e ON e.id = t.employment_id AND e.org_id = t.org_id
      JOIN parties w ON w.id = e.worker_party_id AND w.org_id = t.org_id
      JOIN subsidiaries sub ON sub.id = e.employer_subsidiary_id AND sub.org_id = t.org_id`,
    orgColumn: 't.org_id',
    subsidiaryScope: { column: 'e.employer_subsidiary_id' },
    requiredPermission: HRM_PERFORMANCE_READ_PERMISSION,
    featureKey: 'hrmSuccession',
    defaultPeriodField: 'reviewed_at',
    columns: [
      { key: 'reviewed_at', label: 'Reviewed', kind: 'date', expr: 't.reviewed_at' },
      { key: 'employee', label: 'Employee', kind: 'text', expr: 'w.display_name' },
      { key: 'employer', label: 'Employer', kind: 'text', expr: 'sub.name' },
      { key: 'performance_key', label: 'Performance', kind: 'text', expr: 't.performance_key' },
      { key: 'potential_key', label: 'Potential', kind: 'text', expr: 't.potential_key' },
      { key: 'impact_of_loss', label: 'Impact of loss', kind: 'text', expr: 't.impact_of_loss' },
      { key: 'risk_of_loss', label: 'Risk of loss', kind: 'text', expr: 't.risk_of_loss' },
      { key: 'id', label: 'Review (id)', kind: 'uuid', expr: 't.id' },
    ],
    defaultSort: { column: 'reviewed_at', direction: 'desc' },
  },
  // HR-17 end
]
