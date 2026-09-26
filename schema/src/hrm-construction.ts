import {
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

export const HRM_COMPLIANCE_FINDING_KINDS = [
  "ratio_breach",
  "missing_rate",
  "class_unresolved",
  "registration_missing",
  "fringe_mismatch",
] as const;

export const HRM_COMPLIANCE_FINDING_STATUSES = ["open", "acknowledged", "resolved"] as const;

/** Compliance findings (0224): append-only pre-run flags. */
export const hrmComplianceFindings = pgTable(
  "hrm_compliance_findings",
  {
    id: id(),
    orgId: orgRef(),
    kind: text("kind", { enum: HRM_COMPLIANCE_FINDING_KINDS }).notNull(),
    projectId: uuid("project_id"),
    workedOn: date("worked_on"),
    employmentId: uuid("employment_id"),
    detail: jsonb("detail").notNull().default({}),
    status: text("status", { enum: HRM_COMPLIANCE_FINDING_STATUSES }).notNull().default("open"),
    resolvedReason: text("resolved_reason"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("hrm_compliance_findings_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_compliance_findings_org_status").on(t.orgId, t.status),
    index("hrm_compliance_findings_org_project_day").on(t.orgId, t.projectId, t.workedOn),
  ],
);
