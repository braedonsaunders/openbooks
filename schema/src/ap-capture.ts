import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/** One uploaded page packet/document through its complete review lifecycle. */
export const apCaptureItems = pgTable(
  "ap_capture_items",
  {
    id: id(),
    orgId: orgRef(),
    fileId: uuid("file_id").notNull(),
    status: text("status", {
      enum: [
        "queued",
        "extracting",
        "needs_review",
        "ready",
        "duplicate",
        "failed",
        "materialized",
        "rejected",
      ],
    })
      .notNull()
      .default("queued"),
    source: text("source", { enum: ["upload"] }).notNull().default("upload"),
    originalFilename: text("original_filename").notNull(),
    contentHash: text("content_hash").notNull(),
    documentKind: text("document_kind", { enum: ["vendor_bill", "vendor_credit"] })
      .notNull()
      .default("vendor_bill"),
    normalized: jsonb("normalized").notNull().default({}),
    validationIssues: jsonb("validation_issues").notNull().default([]),
    overallConfidence: numeric("overall_confidence", { precision: 5, scale: 4 }),
    vendorCandidateId: uuid("vendor_candidate_id"),
    purchaseOrderId: uuid("purchase_order_id"),
    documentId: uuid("document_id"),
    assignedTo: uuid("assigned_to"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    materializedAt: timestamp("materialized_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    index("ap_capture_items_queue").on(t.orgId, t.status, t.receivedAt),
    index("ap_capture_items_hash").on(t.orgId, t.contentHash),
    index("ap_capture_items_vendor").on(t.orgId, t.vendorCandidateId),
    uniqueIndex("ap_capture_items_document").on(t.documentId),
  ],
);

/** Immutable extraction attempt. A retry always appends a new run. */
export const apCaptureRuns = pgTable(
  "ap_capture_runs",
  {
    id: id(),
    orgId: orgRef(),
    captureItemId: uuid("capture_item_id").notNull(),
    attempt: integer("attempt").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    apiVersion: text("api_version"),
    status: text("status", { enum: ["running", "succeeded", "failed"] })
      .notNull()
      .default("running"),
    rawProviderPayload: jsonb("raw_provider_payload"),
    normalizedSnapshot: jsonb("normalized_snapshot"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
  },
  (t) => [
    uniqueIndex("ap_capture_runs_attempt").on(t.captureItemId, t.attempt),
    index("ap_capture_runs_org_started").on(t.orgId, t.startedAt),
  ],
);

/** Field/line evidence used by the side-by-side highlighter and audit review. */
export const apCaptureFields = pgTable(
  "ap_capture_fields",
  {
    id: id(),
    orgId: orgRef(),
    runId: uuid("run_id").notNull(),
    fieldKey: text("field_key").notNull(),
    lineIndex: integer("line_index"),
    rawValue: text("raw_value"),
    normalizedValue: jsonb("normalized_value"),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    pageNumber: integer("page_number"),
    polygon: jsonb("polygon"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ap_capture_fields_run").on(t.runId, t.fieldKey, t.lineIndex)],
);

/** Append-only human correction evidence; never overwritten by reprocessing. */
export const apCaptureCorrections = pgTable(
  "ap_capture_corrections",
  {
    id: id(),
    orgId: orgRef(),
    captureItemId: uuid("capture_item_id").notNull(),
    fieldKey: text("field_key").notNull(),
    lineIndex: integer("line_index"),
    beforeValue: jsonb("before_value"),
    afterValue: jsonb("after_value"),
    correctedBy: uuid("corrected_by").notNull(),
    correctedAt: timestamp("corrected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ap_capture_corrections_item").on(t.captureItemId, t.correctedAt)],
);

/**
 * Confirmed vendor/account/field mappings learned from reviews. Rules require
 * repeated confirmations before the resolver treats them as automatic.
 */
export const apCaptureRules = pgTable(
  "ap_capture_rules",
  {
    id: id(),
    orgId: orgRef(),
    ruleKind: text("rule_kind", {
      enum: ["vendor_alias", "vendor_account", "field_mapping"],
    }).notNull(),
    match: jsonb("match").notNull(),
    output: jsonb("output").notNull(),
    confirmationCount: integer("confirmation_count").notNull().default(1),
    isActive: boolean("is_active").notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    index("ap_capture_rules_lookup").on(t.orgId, t.ruleKind, t.isActive),
    uniqueIndex("ap_capture_rules_identity").on(t.orgId, t.ruleKind, t.match, t.output),
  ],
);

/** Append-only lifecycle/audit events for queue, review and materialization. */
export const apCaptureEvents = pgTable(
  "ap_capture_events",
  {
    id: id(),
    orgId: orgRef(),
    captureItemId: uuid("capture_item_id").notNull(),
    eventKind: text("event_kind").notNull(),
    detail: jsonb("detail").notNull().default({}),
    actorId: uuid("actor_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ap_capture_events_item").on(t.captureItemId, t.at)],
);

/*
 * Foreign keys (add to schema/migrations/referential-integrity.sql):
 * ap_capture_items.org_id -> orgs.id
 * ap_capture_items.file_id -> files.id
 * ap_capture_items.vendor_candidate_id -> parties.id
 * ap_capture_items.purchase_order_id -> documents.id
 * ap_capture_items.document_id -> documents.id
 * ap_capture_runs.capture_item_id -> ap_capture_items.id
 * ap_capture_fields.run_id -> ap_capture_runs.id
 * ap_capture_corrections.capture_item_id -> ap_capture_items.id
 * ap_capture_rules.org_id -> orgs.id
 * ap_capture_events.capture_item_id -> ap_capture_items.id
 */
