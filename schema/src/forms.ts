import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * App/form builder — ported from the beaconhs form platform. Lifecycle:
 *
 *   form_templates (stable identity, keyed by org+key slug)
 *     └─ form_template_versions (schema snapshots; immutable once published)
 *          └─ form_responses (filled submissions, pinned to a version)
 *               └─ form_response_steps (per-response actor/action audit trail)
 *
 * The version `schema` jsonb is a FormSchemaV1 — the runtime-validated shape
 * lives in @openbooks/forms-core (zod validators + evaluator). The designer
 * edits the latest UNPUBLISHED version row in place; publishing stamps
 * `published_at`, after which the row is never mutated again and the next
 * edit spawns version n+1.
 */

export const FORM_TEMPLATE_STATUSES = ["draft", "published", "archived"] as const;

/** What KIND of artifact this template is — same field builder, different shell. */
export const FORM_TEMPLATE_KINDS = ["form", "wizard", "checklist", "register"] as const;

export const formTemplates = pgTable(
  "form_templates",
  {
    id: id(),
    orgId: orgRef(),
    /** Stable slug across versions; the fill/responses URLs key off this. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    category: text("category"), // e.g. 'finance', 'operations', 'hr', 'custom'
    description: text("description"),
    status: text("status", { enum: FORM_TEMPLATE_STATUSES }).notNull().default("draft"),
    kind: text("kind", { enum: FORM_TEMPLATE_KINDS }).notNull().default("form"),
    /**
     * Role gating. Empty/null ⇒ visible & fillable by everyone. Non-empty ⇒
     * only these role keys (plus admins) may open, fill, or browse the app.
     * Template authoring is always admin-gated regardless of this list.
     */
    allowedRoles: jsonb("allowed_roles").$type<string[]>(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("form_templates_org_key").on(t.orgId, t.key),
    index("form_templates_org_status").on(t.orgId, t.status),
  ],
);

export const formTemplateVersions = pgTable(
  "form_template_versions",
  {
    id: id(),
    orgId: orgRef(),
    templateId: uuid("template_id").notNull(),
    version: integer("version").notNull(),
    /** FormSchemaV1 (see @openbooks/forms-core). */
    schema: jsonb("schema").notNull(),
    changelog: text("changelog"),
    /** Null ⇒ editable draft. Set ⇒ immutable published snapshot. */
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: uuid("published_by"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("form_template_versions_template_version").on(t.templateId, t.version),
    index("form_template_versions_org").on(t.orgId),
  ],
);

export const FORM_RESPONSE_STATUSES = ["draft", "submitted", "locked"] as const;

export const formResponses = pgTable(
  "form_responses",
  {
    id: id(),
    orgId: orgRef(),
    /** Exact immutable schema snapshot this response was filled against. */
    versionId: uuid("version_id").notNull(),
    /** Denormalized template slug for cheap per-template listing/filtering. */
    templateKey: text("template_key").notNull(),
    /**
     * Response payload keyed by field id. Repeating sections store an array
     * of row value maps under the SECTION id. Formula field values are
     * recomputed server-side at submit and persisted for reporting.
     */
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: FORM_RESPONSE_STATUSES }).notNull().default("draft"),
    submittedBy: uuid("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    index("form_responses_org_template").on(t.orgId, t.templateKey, t.submittedAt),
    index("form_responses_version").on(t.versionId),
    index("form_responses_org_status").on(t.orgId, t.status),
  ],
);

/** Append-only audit trail of who did what to a response. */
export const formResponseSteps = pgTable(
  "form_response_steps",
  {
    id: id(),
    orgId: orgRef(),
    responseId: uuid("response_id").notNull(),
    /** users.id of whoever acted. */
    actor: uuid("actor"),
    /** e.g. 'created', 'submitted', 'locked', 'unlocked'. */
    action: text("action").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("form_response_steps_response").on(t.responseId, t.at)],
);

/*
FOREIGN KEYS (added by the integrator's migration pass):
  form_templates.org_id                → orgs.id
  form_templates.created_by/updated_by → users.id
  form_template_versions.org_id        → orgs.id
  form_template_versions.template_id   → form_templates.id ON DELETE CASCADE
  form_template_versions.published_by  → users.id
  form_responses.org_id                → orgs.id
  form_responses.version_id            → form_template_versions.id
  form_responses.submitted_by          → users.id
  form_response_steps.org_id           → orgs.id
  form_response_steps.response_id      → form_responses.id ON DELETE CASCADE
  form_response_steps.actor            → users.id
*/
