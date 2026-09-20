import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { departments, orgs } from "./core";
import { files } from "./file-cabinet";
import { auditColumns, id, orgRef } from "./helpers";
import { parties } from "./parties";
import { subsidiaries } from "./subsidiaries";
import { users } from "./extension";
import { employmentChanges, workerEmployments } from "./hrm";

/**
 * HRM onboarding / offboarding / transfer processes (migration 0193).
 *
 * Every employment start, end, and transfer drives a checklist with owners,
 * due dates, and evidence; completion is a recorded fact, not a memory.
 *
 * - hrm_process_templates / hrm_process_template_steps are CONFIGURATION:
 *   the ordered checklist per kind (onboarding, offboarding, transfer) with
 *   an applies_to filter ({employer_subsidiary_id, department_id}, null =
 *   all). Editable through the Setup registry; deactivation (is_active)
 *   preserves history, never deletes it.
 * - hrm_processes / hrm_process_steps are HISTORY: a process is instantiated
 *   from its template as a SNAPSHOT (steps copied), so later template edits
 *   never rewrite history. Opened automatically inside the same transaction
 *   that applies the approved change request (hire → onboarding,
 *   termination → offboarding, employer/department change → transfer), or
 *   manually through the service. At most one OPEN process of a kind per
 *   employment (partial unique index, race-safe under concurrent writers).
 * - Evidence: a step whose evidence_kind is acknowledgement records who
 *   (done_by) and when (done_at); attachment evidence names a files row the
 *   actor may read (composite tenant FK, RESTRICT so evidence never loses
 *   its file). Skipping a required step needs hrm.employment.manage plus a
 *   reason; completion with a pending required step is refused.
 * - Terminal rows (completed/cancelled processes, done/skipped steps) are
 *   immutable except a pure audit touch; deletes are admitted only on the
 *   governed amend path (openbooks.amend, fixture teardown / org wipe).
 * - Overlap-style concurrency guards that need storage-level safety
 *   (the open-process partial unique) live in the SQL migration; Drizzle
 *   has no partial-unique primitive.
 * - SQL-only edges (documented, not declared): template_step_id lineage →
 *   hrm_process_template_steps(id) (single-column SET NULL, lineage not
 *   scope), done_by / created_by / updated_by → users(id) (RESTRICT frozen
 *   evidence, 0185 home-org pattern), terminal-immutability and no-delete
 *   triggers, and the files(org_id, id) covering unique.
 */

export const PROCESS_KINDS = ["onboarding", "offboarding", "transfer"] as const;
export const PROCESS_STATUSES = ["open", "completed", "cancelled"] as const;
export const STEP_OWNER_KINDS = ["manager", "hr", "employee", "named_party"] as const;
export const STEP_EVIDENCE_KINDS = ["none", "acknowledgement", "attachment"] as const;
export const STEP_STATUSES = ["pending", "done", "skipped"] as const;

/** Checklist configuration per process kind, with an applies_to filter. */
/**
 * NOTE: the SQL migration additionally carries two STORED GENERATED columns
 * on hrm_process_templates (applies_employer_subsidiary_id,
 * applies_department_id) projecting the applies_to slots for structured
 * surfaces. They are readable but never written, so they stay SQL-only by
 * design — the shape CHECK is the single authority on filter content.
 */
export const hrmProcessTemplates = pgTable(
  "hrm_process_templates",
  {
    id: id(),
    orgId: orgRef(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    /**
     * Small jsonb filter: {employer_subsidiary_id, department_id}, each a
     * uuid string or null; absent/null = applies to all. Shape-pinned by
     * hrm_process_templates_applies_shape (0184 null-safe style).
     */
    appliesTo: jsonb("applies_to").notNull().default({}),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_process_templates_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    uniqueIndex("hrm_process_templates_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_process_templates_org_kind_name").on(t.orgId, t.kind, t.name),
    index("hrm_process_templates_org_kind").on(t.orgId, t.kind, t.isActive),
    check("hrm_process_templates_kind", sql`${t.kind} in ('onboarding', 'offboarding', 'transfer')`),
    check(
      "hrm_process_templates_name",
      sql`char_length(btrim(${t.name})) > 0`,
    ),
    check(
      "hrm_process_templates_applies_shape",
      sql`jsonb_typeof(${t.appliesTo}) = 'object'
          and (${t.appliesTo} - 'employer_subsidiary_id' - 'department_id') = '{}'::jsonb
          and (not (${t.appliesTo} ? 'employer_subsidiary_id')
               or jsonb_typeof(${t.appliesTo} -> 'employer_subsidiary_id') = 'null'
               or (jsonb_typeof(${t.appliesTo} -> 'employer_subsidiary_id') = 'string'
                   and ${t.appliesTo} ->> 'employer_subsidiary_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'))
          and (not (${t.appliesTo} ? 'department_id')
               or jsonb_typeof(${t.appliesTo} -> 'department_id') = 'null'
               or (jsonb_typeof(${t.appliesTo} -> 'department_id') = 'string'
                   and ${t.appliesTo} ->> 'department_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'))`,
    ),
  ],
);

/** One ordered checklist row of a template. */
export const hrmProcessTemplateSteps = pgTable(
  "hrm_process_template_steps",
  {
    id: id(),
    orgId: orgRef(),
    templateId: uuid("template_id").notNull(),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    ownerKind: text("owner_kind").notNull(),
    /** Set only when owner_kind is named_party. */
    ownerPartyId: uuid("owner_party_id"),
    /** Days relative to the process effective date; may be negative. */
    dueOffsetDays: integer("due_offset_days").notNull().default(0),
    required: boolean("required").notNull().default(true),
    evidenceKind: text("evidence_kind").notNull().default("none"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_process_template_steps_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    foreignKey({
      name: "hrm_process_template_steps_template_tenant_fkey",
      columns: [t.orgId, t.templateId],
      foreignColumns: [hrmProcessTemplates.orgId, hrmProcessTemplates.id],
    }),
    foreignKey({
      name: "hrm_process_template_steps_owner_tenant_fkey",
      columns: [t.orgId, t.ownerPartyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    uniqueIndex("hrm_process_template_steps_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_process_template_steps_org_template_position").on(
      t.orgId,
      t.templateId,
      t.position,
    ),
    index("hrm_process_template_steps_template").on(t.orgId, t.templateId, t.position),
    check("hrm_process_template_steps_owner", sql`${t.ownerKind} in ('manager', 'hr', 'employee', 'named_party')`),
    check(
      "hrm_process_template_steps_owner_party",
      sql`(${t.ownerKind} = 'named_party') = (${t.ownerPartyId} is not null)`,
    ),
    check(
      "hrm_process_template_steps_title",
      sql`char_length(btrim(${t.title})) > 0`,
    ),
    check("hrm_process_template_steps_position", sql`${t.position} >= 0`),
    check(
      "hrm_process_template_steps_evidence",
      sql`${t.evidenceKind} in ('none', 'acknowledgement', 'attachment')`,
    ),
  ],
);

/** A runtime checklist opened for one employment (snapshot history). */
export const hrmProcesses = pgTable(
  "hrm_processes",
  {
    id: id(),
    orgId: orgRef(),
    templateId: uuid("template_id").notNull(),
    employmentId: uuid("employment_id").notNull(),
    kind: text("kind").notNull(),
    effectiveDate: date("effective_date").notNull(),
    status: text("status").notNull().default("open"),
    /** Aggregate employment_changes event that opened this process (auto-open). */
    openedByChangeId: uuid("opened_by_change_id"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_processes_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    foreignKey({
      name: "hrm_processes_template_tenant_fkey",
      columns: [t.orgId, t.templateId],
      foreignColumns: [hrmProcessTemplates.orgId, hrmProcessTemplates.id],
    }),
    foreignKey({
      name: "hrm_processes_employment_tenant_fkey",
      columns: [t.orgId, t.employmentId],
      foreignColumns: [workerEmployments.orgId, workerEmployments.id],
    }),
    foreignKey({
      name: "hrm_processes_opened_change_tenant_fkey",
      columns: [t.orgId, t.openedByChangeId],
      foreignColumns: [employmentChanges.orgId, employmentChanges.id],
    }),
    uniqueIndex("hrm_processes_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_processes_employment").on(t.orgId, t.employmentId, t.kind, t.status),
    index("hrm_processes_status").on(t.orgId, t.status),
    // At most one OPEN process of a kind per employment: enforced by the
    // partial unique index in the SQL migration (Drizzle has no partial
    // primitive), so concurrent openers serialize instead of duplicating.
    check("hrm_processes_kind", sql`${t.kind} in ('onboarding', 'offboarding', 'transfer')`),
    check("hrm_processes_status", sql`${t.status} in ('open', 'completed', 'cancelled')`),
    check(
      "hrm_processes_completed_paired",
      sql`(${t.status} = 'completed') = (${t.completedAt} is not null)`,
    ),
    check(
      "hrm_processes_cancelled_paired",
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`,
    ),
    check(
      "hrm_processes_cancel_reason",
      sql`(${t.status} = 'cancelled') = (${t.cancelReason} is not null and char_length(btrim(${t.cancelReason})) > 0)`,
    ),
    check(
      "hrm_processes_finite_time",
      sql`${t.effectiveDate} between date '0001-01-01' and date '9999-12-31'
          and (${t.completedAt} is null
               or (${t.completedAt} >= timestamptz '0001-01-01 00:00:00+00'
                   and ${t.completedAt} < timestamptz '10000-01-01 00:00:00+00'))
          and (${t.cancelledAt} is null
               or (${t.cancelledAt} >= timestamptz '0001-01-01 00:00:00+00'
                   and ${t.cancelledAt} < timestamptz '10000-01-01 00:00:00+00'))`,
    ),
  ],
);

/** Snapshot checklist rows of one process (copied from the template). */
export const hrmProcessSteps = pgTable(
  "hrm_process_steps",
  {
    id: id(),
    orgId: orgRef(),
    processId: uuid("process_id").notNull(),
    /** Lineage to the template step copied; null for ad-hoc steps. */
    templateStepId: uuid("template_step_id"),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    ownerKind: text("owner_kind").notNull(),
    ownerPartyId: uuid("owner_party_id"),
    dueOn: date("due_on").notNull(),
    required: boolean("required").notNull().default(true),
    evidenceKind: text("evidence_kind").notNull().default("none"),
    status: text("status").notNull().default("pending"),
    /** Evidence actor for done steps (0185 frozen-evidence pattern). */
    doneBy: uuid("done_by"),
    doneAt: timestamp("done_at", { withTimezone: true }),
    skipReason: text("skip_reason"),
    /** Evidence file the completing actor may read. */
    attachmentId: uuid("attachment_id"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_process_steps_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    foreignKey({
      name: "hrm_process_steps_process_tenant_fkey",
      columns: [t.orgId, t.processId],
      foreignColumns: [hrmProcesses.orgId, hrmProcesses.id],
    }),
    foreignKey({
      name: "hrm_process_steps_owner_tenant_fkey",
      columns: [t.orgId, t.ownerPartyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    foreignKey({
      name: "hrm_process_steps_attachment_tenant_fkey",
      columns: [t.orgId, t.attachmentId],
      foreignColumns: [files.orgId, files.id],
    }),
    uniqueIndex("hrm_process_steps_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_process_steps_org_process_position").on(t.orgId, t.processId, t.position),
    index("hrm_process_steps_process").on(t.orgId, t.processId, t.position),
    index("hrm_process_steps_overdue").on(t.orgId, t.status, t.dueOn),
    check("hrm_process_steps_owner", sql`${t.ownerKind} in ('manager', 'hr', 'employee', 'named_party')`),
    check(
      "hrm_process_steps_owner_party",
      sql`(${t.ownerKind} = 'named_party') = (${t.ownerPartyId} is not null)`,
    ),
    check(
      "hrm_process_steps_title",
      sql`char_length(btrim(${t.title})) > 0`,
    ),
    check("hrm_process_steps_position", sql`${t.position} >= 0`),
    check(
      "hrm_process_steps_evidence",
      sql`${t.evidenceKind} in ('none', 'acknowledgement', 'attachment')`,
    ),
    check("hrm_process_steps_status", sql`${t.status} in ('pending', 'done', 'skipped')`),
    check(
      "hrm_process_steps_done_paired",
      sql`(${t.status} = 'done') = (${t.doneAt} is not null)
          and (${t.status} = 'done') = (${t.doneBy} is not null)`,
    ),
    check(
      "hrm_process_steps_skip_reason",
      sql`(${t.status} = 'skipped') = (${t.skipReason} is not null and char_length(btrim(${t.skipReason})) > 0)`,
    ),
    check(
      "hrm_process_steps_attachment_scope",
      sql`${t.attachmentId} is null or ${t.evidenceKind} = 'attachment'`,
    ),
    check(
      "hrm_process_steps_finite_time",
      sql`${t.dueOn} between date '0001-01-01' and date '9999-12-31'
          and (${t.doneAt} is null
               or (${t.doneAt} >= timestamptz '0001-01-01 00:00:00+00'
                   and ${t.doneAt} < timestamptz '10000-01-01 00:00:00+00'))`,
    ),
  ],
);
