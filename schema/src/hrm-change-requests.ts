import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Governed HRM employment change REQUESTS — proposals, not mutations.
 *
 * One row binds a frozen proposal payload to the exact
 * worker_employments.revision it was written against and to the native
 * Flows run that decides it. Canonical mutation stays in employment_changes
 * (0184); approval execution stays in flow_runs/flow_gates behind a
 * FlowSubjectAdapter with subject_kind 'hrm_employment_change_request'.
 * There is no parallel approval engine and no separate payroll employment
 * store: the underlying canonical employment is core infrastructure
 * consumed by Payroll with no HRM feature gate in this lifecycle, and no
 * boolean approved flag anywhere — status is the only lifecycle signal.
 *
 * Storage owns the payload digest: the guard trigger computes sha256 hex
 * over the exact bytes of the jsonb normalized text form
 * (convert_to(payload::text, 'UTF8')) on insert and on every draft payload
 * edit, and freezes it afterwards. The service submits the payload and
 * reads the digest back — it must not invent its own canonicalization.
 *
 * Lifecycle: draft -> pending_approval -> approved/rejected/withdrawn,
 * approved -> applied. Drafts may withdraw without submission (no
 * fabricated submission stamps). Rejected, withdrawn, and applied are
 * terminal: a revised proposal is a NEW row, so an old approval can never
 * be re-pointed at edited payload.
 *
 * Decision evidence (not duplication): decision_snapshot is written once,
 * atomically with approve/reject, and frozen forever. It carries the bound
 * digests plus every decided native gate (actual decided_by with
 * delegation principal). The gates themselves stay native; the final
 * application inspects native gate evidence through the service and never
 * trusts status=approved alone. applied_by is evidence only — storage
 * authenticates no application user, and actor UUIDs carry no same-org
 * assertion (home-org users).
 */

export const HRM_CHANGE_REQUEST_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "withdrawn",
  "applied",
] as const;

/** Native Flows subject kind for employment change requests. */
export const HRM_CHANGE_REQUEST_SUBJECT_KIND = "hrm_employment_change_request";

export const hrmEmploymentChangeRequests = pgTable(
  "hrm_employment_change_requests",
  {
    id: id(),
    orgId: orgRef(),
    /** Stable employment identity (0184). Composite-scoped with org_id. */
    employmentId: uuid("employment_id").notNull(),
    /** Row version of this request: draft edits bump by exactly one. */
    requestRevision: integer("request_revision").notNull().default(1),
    /** Exact worker_employments.revision the proposal was written against. */
    expectedEmploymentRevision: integer("expected_employment_revision").notNull(),
    /** The frozen proposal. Draft-editable only. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** Storage-computed sha256 hex over canonical jsonb text. */
    payloadDigest: text("payload_digest").notNull(),
    /** Payload contract version (service-side JSON-schema validation). */
    payloadSchemaVersion: text("payload_schema_version").notNull(),
    /** Submission reason: null in draft, non-blank once submitted. */
    reason: text("reason"),
    status: text("status", { enum: HRM_CHANGE_REQUEST_STATUSES })
      .notNull()
      .default("draft"),
    submittedBy: uuid("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    /** Native approval run anchor: set at submit, retained, never re-pointed. */
    flowRunId: uuid("flow_run_id"),
    /** Immutable decision evidence bound to the row's digests. */
    decisionSnapshot: jsonb("decision_snapshot").$type<Record<string, unknown> | null>(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    /** Evidence only — never authentication. */
    appliedBy: uuid("applied_by"),
    appliedEmploymentRevision: integer("applied_employment_revision"),
    /** Link to the canonical immutable change the approval produced. */
    appliedEmploymentChangeId: uuid("applied_employment_change_id"),
    /** Generic HR action vocabulary (0227, hrmActionReasons). Null when the
     *  feature is off — unclassified, never a refusal. */
    action: text("action"),
    /** Reason code from hrm_action_reasons; service-validated, never FK: a
     *  renamed code must not strand submitted history. */
    reasonCode: text("reason_code"),
    ...auditColumns,
  },
  (t) => [
    check(
      "hrm_employment_change_requests_revision_floor",
      sql`${t.requestRevision} >= 1 AND ${t.expectedEmploymentRevision} >= 1`,
    ),
    index("hrm_employment_change_requests_employment").on(
      t.orgId,
      t.employmentId,
      t.status,
    ),
    index("hrm_employment_change_requests_flow_run").on(t.orgId, t.flowRunId),
  ],
);

/*
FOREIGN KEYS (added by migration 0185 to public.hrm_employment_change_requests):
  org_id                      → orgs.id (on delete cascade)
  (org_id, employment_id)     → worker_employments(org_id, id) (on delete restrict;
                                composite ONLY — no single-column FK plus trigger)
  flow_run_id                 → flow_runs(id) (on delete restrict; same-org +
                                governed subject kind/id binding enforced by the
                                guard trigger, which a simple FK cannot express)
  applied_employment_change_id → employment_changes(id) (on delete restrict;
                                org match verified by the guard trigger)
  submitted_by / applied_by /
  created_by / updated_by      → users(id) (on delete restrict — frozen
                                evidence is never nulled; NO same-org
                                assertion — home-org users)
*/
