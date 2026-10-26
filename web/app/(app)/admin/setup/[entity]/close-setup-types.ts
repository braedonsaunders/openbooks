import type { ReportDescriptor } from "../../../../../lib/close/report-descriptor";
import type { Opt } from "../../../../../lib/documents.ts";

/**
 * Config-list rows. Each tab reads a different table, so every list has its
 * own shape below — column types per the schema (uuids as strings, `date`
 * columns as ISO-date strings, counts as driver strings, JSONB parsed).
 * Drafts are the working copies the drawers edit before saving.
 */
export interface CalendarRow extends Record<string, unknown> {
  id: string;
  name: string;
  cadence: string;
  year_start_month: number;
  week_starts_on: number;
  anchor_date: string | null;
  time_zone: string;
  adjustment_period_enabled: boolean;
  is_default: boolean;
  is_active: boolean;
  config: Record<string, unknown>;
}
export interface CalendarOptionRow extends Record<string, unknown> {
  id: string;
  name: string;
  is_default: boolean;
  is_active: boolean;
}
export interface PeriodLockState extends Record<string, unknown> {
  state: string;
  lockedAt: string | null;
  reason: string | null;
  reopenExpiresAt: string | null;
}
export interface PeriodRow extends Record<string, unknown> {
  id: string;
  name: string;
  starts_on: string;
  ends_on: string;
  fiscal_year: number;
  period_number: number;
  is_adjustment: boolean;
  calendar_name: string;
  locks: Record<string, PeriodLockState>;
  entries: string;
}
export interface CloseSetupBookRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  is_primary: boolean;
}
export interface BlueprintStepRow extends Record<string, unknown> {
  id: string;
  blueprint_id: string;
  key: string;
  title: string;
  description: string | null;
  workstream: string;
  task_type: string;
  completion_mode: string;
  gate_type: string;
  due_offset_business_days: number;
  evidence_required: boolean;
  default_owner_role_key: string | null;
  applicability: unknown;
  depends_on: string[];
}
export interface BlueprintBaseRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string | null;
  period_type: string;
  is_default: boolean;
  is_active: boolean;
  version: number;
  scope_rules: unknown;
}
export interface BlueprintRow extends BlueprintBaseRow {
  steps: BlueprintStepRow[];
}
export interface PolicyRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  description: string | null;
  policy_type: string;
  rules: Record<string, unknown>;
  is_active: boolean;
}
export interface AutomationRow extends Record<string, unknown> {
  id: string;
  name: string;
  trigger: string;
  action: string;
  conditions: Record<string, unknown>;
  config: Record<string, unknown>;
  is_active: boolean;
}
export interface PackageRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string | null;
  reports: unknown;
  recipients: unknown;
  delivery: Record<string, unknown>;
  is_default: boolean;
  is_active: boolean;
}
export interface SetupUserRow extends Record<string, unknown> {
  id: string;
  name: string;
  email: string;
}
export interface SetupRoleRow extends Record<string, unknown> {
  key: string;
  name: string;
}
export interface ReportDefEntry extends Record<string, unknown> {
  slug: string;
  name: string;
  kind: string;
  descriptor: ReportDescriptor;
}
export interface ReopenRow extends Record<string, unknown> {
  id: string;
  period_id: string;
  book_id: string;
  status: string;
  reason: string;
  modules: unknown[];
  impact_snapshot?: { amendment?: { expiresAt: string } };
  /** The period's display label in the viewer's locale (`P12 FY2026 · Dec 2026`). */
  period_name: string;
  book_name: string;
  requested_by: string;
  requester_name: string;
  approved_by: string | null;
  approver_name: string | null;
  /** Stored decision/end evidence from the audit trail (CloseSetupPage). */
  decision_action: string | null;
  decision_attestation: string | null;
  end_actor_name: string | null;
  end_reason: string | null;
}
/** One bank account's reconciliation status for the period being closed. */
export interface BankingReconAccount {
  accountId: string;
  number: string | null;
  name: string;
  status: string;
  throughDate: string | null;
  difference: string | null;
  stale: boolean;
  staleSince: string | null;
  clearedEffect: string | null;
}
/** Working copies the drawers edit (camelCase) before saving. */
export interface CalendarDraft extends Record<string, unknown> {
  id?: string;
  name: string;
  cadence: string;
  yearStartMonth: number;
  weekStartsOn: number;
  timeZone: string;
  adjustmentPeriodEnabled: boolean;
  isDefault: boolean;
  isActive: boolean;
  anchorDate: string;
  configText: string;
}
export interface BlueprintStepDraft extends Record<string, unknown> {
  key: string;
  title: string;
  description: string;
  workstream: string;
  taskType: string;
  completionMode: string;
  gateType: string;
  dueOffsetBusinessDays: number;
  evidenceRequired: boolean;
  defaultOwnerRoleKey: string;
  applicabilityText: string;
  dependsOn: string[];
}
export interface BlueprintDraft extends Record<string, unknown> {
  id?: string;
  name: string;
  description: string;
  periodType: string;
  isDefault: boolean;
  steps: BlueprintStepDraft[];
}
export interface PolicyDraft extends Record<string, unknown> {
  id?: string;
  code: string;
  name: string;
  description: string;
  policyType: string;
  rules: Record<string, unknown>;
  isActive: boolean;
}
export interface AutomationDraft extends Record<string, unknown> {
  id?: string;
  name: string;
  trigger: string;
  automationAction: string;
  conditions: Record<string, unknown>;
  config: Record<string, unknown>;
  isActive: boolean;
}
export interface PackageDraft extends Record<string, unknown> {
  id?: string;
  name: string;
  description: string;
  reports: ReportAttachment[];
  recipientsText: string;
  delivery: Record<string, unknown>;
  isDefault: boolean;
  isActive: boolean;
}
export type ConfigListKey = "calendar" | "blueprint" | "policy" | "automation" | "package";
export type ConfigListMeta = { page: number; total: number };
export type Props = {
  currentParams: Record<string, string | string[] | undefined>;
  fiscalYear: number;
  periodPage: number;
  periodPerPage: number;
  periodTotal: number;
  configLists: Record<ConfigListKey, ConfigListMeta>;
  configPerPage: number;
  calendars: CalendarRow[];
  calendarOptions: CalendarOptionRow[];
  periods: PeriodRow[];
  books: CloseSetupBookRow[];
  selectedBookId: string;
  canReopen: boolean;
  /** The signed-in user: their own pending request offers Withdraw. */
  viewerId?: string;
  /**
   * Every live (requested or approved) request plus the one the URL selects,
   * whatever page the request list shows: the period panel and the request
   * drawer resolve from these.
   */
  liveReopenRequests?: ReopenRow[];
  blueprints: BlueprintRow[];
  policies: PolicyRow[];
  automations: AutomationRow[];
  packages: PackageRow[];
  users: SetupUserRow[];
  roles: SetupRoleRow[];
  reportDefs: ReportDefEntry[];
  subsidiaries: Opt[];
  dimensions: {
    departments: Opt[];
    projects: Opt[];
    locations: Opt[];
    classes: Opt[];
  };
  reopenRequests: ReopenRow[];
  reopenPage: number;
  reopenTotal: number;
  reopenPerPage: number;
  advancedClose: boolean;
};

/** One report attached to a reporting package, with the author's overrides for
 * the date range, break-out dimension, and dimension filters it should run
 * with when the package is delivered. */
export type ReportAttachment = {
  slug: string;
  period?: string;
  from?: string;
  to?: string;
  breakout?: string;
  departmentId?: string;
  locationId?: string;
  classId?: string;
  projectId?: string;
  subsidiaryId?: string;
};
