import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, money, orgRef } from "./helpers";

/**
 * Service dispatch: requests, jobs, visits, agreements, service quotes and
 * their billing links. Visits are booked as schedule entries on dispatch
 * boards (schedule_entries.service_visit_id); labor is recorded on native
 * time entries (time_entries.service_visit_id); invoices, deposits and
 * payments are native documents.
 */
export const SERVICE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const SERVICE_REQUEST_STATUSES = [
  "new",
  "assessment_scheduled",
  "assessed",
  "quoted",
  "converted",
  "declined",
  "cancelled",
] as const;
export const SERVICE_JOB_STATUSES = ["open", "completed", "cancelled"] as const;
export const SERVICE_BILLING_MODES = ["per_job", "per_visit", "not_billable"] as const;
export const SERVICE_VISIT_STATUSES = [
  "unscheduled",
  "scheduled",
  "dispatched",
  "en_route",
  "on_site",
  "completed",
  "unable_to_complete",
  "cancelled",
] as const;
export const SERVICE_VISIT_KINDS = ["assessment", "service"] as const;
export const SERVICE_REVIEW_STATUSES = ["not_required", "pending", "approved", "rejected"] as const;
export const SERVICE_QUOTE_STATUSES = ["draft", "sent", "accepted", "declined"] as const;

const quantity = (name: string) => numeric(name, { precision: 28, scale: 8 });
const audit = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const serviceDispatchPolicies = pgTable(
  "service_dispatch_policies",
  {
    id: id(),
    orgId: orgRef(),
    effectiveFrom: date("effective_from").notNull(),
    notifyArrivalWindow: boolean("notify_arrival_window").notNull(),
    notifyEnRoute: boolean("notify_en_route").notNull(),
    arrivalWindowMinutes: smallint("arrival_window_minutes").notNull(),
    defaultVisitMinutes: smallint("default_visit_minutes").notNull(),
    urgentResponseHours: smallint("urgent_response_hours"),
    highResponseHours: smallint("high_response_hours"),
    normalResponseHours: smallint("normal_response_hours"),
    lowResponseHours: smallint("low_response_hours"),
    agreementHorizonDays: smallint("agreement_horizon_days").notNull(),
    reason: text("reason").notNull(),
    createdAt: audit.createdAt,
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("service_dispatch_policies_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("service_dispatch_policies_org_id_effective_from_key").on(t.orgId, t.effectiveFrom),
  ],
);

export const serviceRequests = pgTable(
  "service_requests",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    requestNumber: text("request_number").notNull(),
    customerPartyId: uuid("customer_party_id").notNull(),
    serviceAddressId: uuid("service_address_id"),
    contactId: uuid("contact_id"),
    title: text("title").notNull(),
    description: text("description"),
    priority: text("priority", { enum: SERVICE_PRIORITIES }).notNull(),
    preferredOn: date("preferred_on"),
    preferredTime: text("preferred_time", { enum: ["any", "morning", "afternoon", "evening"] })
      .notNull()
      .default("any"),
    source: text("source", { enum: ["staff", "portal"] }).notNull(),
    portalLinkId: uuid("portal_link_id"),
    status: text("status", { enum: SERVICE_REQUEST_STATUSES }).notNull(),
    closeReason: text("close_reason"),
    revision: integer("revision").notNull().default(1),
    ...audit,
    createdBy: uuid("created_by"),
    updatedBy: uuid("updated_by"),
  },
  (t) => [
    uniqueIndex("service_requests_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("service_requests_org_id_request_number_key").on(t.orgId, t.requestNumber),
  ],
);

export const serviceAgreements = pgTable(
  "service_agreements",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    agreementNumber: text("agreement_number").notNull(),
    customerPartyId: uuid("customer_party_id").notNull(),
    serviceAddressId: uuid("service_address_id"),
    contactId: uuid("contact_id"),
    title: text("title").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on"),
    status: text("status", { enum: ["active", "ended", "cancelled"] }).notNull(),
    generatedThrough: date("generated_through"),
    closeReason: text("close_reason"),
    revision: integer("revision").notNull().default(1),
    ...audit,
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    uniqueIndex("service_agreements_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("service_agreements_org_id_agreement_number_key").on(t.orgId, t.agreementNumber),
  ],
);

export const serviceAgreementVersions = pgTable(
  "service_agreement_versions",
  {
    id: id(),
    orgId: orgRef(),
    agreementId: uuid("agreement_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    recurrence: jsonb("recurrence").notNull(),
    windowStarts: time("window_starts").notNull(),
    windowEnds: time("window_ends").notNull(),
    estimatedMinutes: smallint("estimated_minutes").notNull(),
    priority: text("priority", { enum: SERVICE_PRIORITIES }).notNull(),
    requiredQualificationTypeIds: uuid("required_qualification_type_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    instructions: text("instructions"),
    reason: text("reason").notNull(),
    createdAt: audit.createdAt,
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("service_agreement_versions_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("service_agreement_versions_org_id_agreement_id_effective_from_key").on(
      t.orgId,
      t.agreementId,
      t.effectiveFrom,
    ),
  ],
);

export const serviceAgreementLines = pgTable(
  "service_agreement_lines",
  {
    id: id(),
    orgId: orgRef(),
    versionId: uuid("version_id").notNull(),
    lineNumber: smallint("line_number").notNull(),
    itemId: uuid("item_id").notNull(),
    description: text("description"),
    quantity: quantity("quantity").notNull(),
    unitPrice: quantity("unit_price").notNull(),
    taxCodeId: uuid("tax_code_id"),
  },
  (t) => [
    uniqueIndex("service_agreement_lines_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("service_agreement_lines_org_id_version_id_line_number_key").on(
      t.orgId,
      t.versionId,
      t.lineNumber,
    ),
  ],
);

export const serviceJobs = pgTable(
  "service_jobs",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    jobNumber: text("job_number").notNull(),
    customerPartyId: uuid("customer_party_id").notNull(),
    serviceAddressId: uuid("service_address_id"),
    contactId: uuid("contact_id"),
    requestId: uuid("request_id"),
    quoteDocumentId: uuid("quote_document_id"),
    agreementId: uuid("agreement_id"),
    title: text("title").notNull(),
    description: text("description"),
    priority: text("priority", { enum: SERVICE_PRIORITIES }).notNull(),
    requiredQualificationTypeIds: uuid("required_qualification_type_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    estimatedMinutes: smallint("estimated_minutes").notNull(),
    slaDueAt: timestamp("sla_due_at", { withTimezone: true }),
    billingMode: text("billing_mode", { enum: SERVICE_BILLING_MODES }).notNull(),
    laborItemId: uuid("labor_item_id"),
    laborUnitPrice: quantity("labor_unit_price"),
    currency: text("currency").notNull(),
    depositRequired: money("deposit_required").notNull().default("0"),
    status: text("status", { enum: SERVICE_JOB_STATUSES }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: uuid("completed_by"),
    closeReason: text("close_reason"),
    revision: integer("revision").notNull().default(1),
    ...audit,
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    uniqueIndex("service_jobs_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("service_jobs_org_id_job_number_key").on(t.orgId, t.jobNumber),
  ],
);

export const serviceJobLines = pgTable(
  "service_job_lines",
  {
    id: id(),
    orgId: orgRef(),
    jobId: uuid("job_id").notNull(),
    lineNumber: smallint("line_number").notNull(),
    itemId: uuid("item_id").notNull(),
    description: text("description"),
    quantity: quantity("quantity").notNull(),
    unitPrice: quantity("unit_price").notNull(),
    taxCodeId: uuid("tax_code_id"),
    sourceQuoteLineId: uuid("source_quote_line_id"),
    createdAt: audit.createdAt,
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("service_job_lines_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("service_job_lines_org_id_job_id_line_number_key").on(
      t.orgId,
      t.jobId,
      t.lineNumber,
    ),
  ],
);

export const serviceQuotes = pgTable(
  "service_quotes",
  {
    id: id(),
    orgId: orgRef(),
    quoteDocumentId: uuid("quote_document_id").notNull(),
    requestId: uuid("request_id"),
    jobId: uuid("job_id"),
    depositBasis: text("deposit_basis", { enum: ["none", "percent", "amount"] }).notNull(),
    depositValue: money("deposit_value").notNull().default("0"),
    status: text("status", { enum: SERVICE_QUOTE_STATUSES }).notNull(),
    signatureRequestId: uuid("signature_request_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedName: text("decided_name"),
    acceptedTotal: money("accepted_total"),
    depositDue: money("deposit_due"),
    revision: integer("revision").notNull().default(1),
    ...audit,
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by"),
  },
  (t) => [
    uniqueIndex("service_quotes_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("service_quotes_org_id_quote_document_id_key").on(t.orgId, t.quoteDocumentId),
  ],
);

export const serviceQuoteLines = pgTable(
  "service_quote_lines",
  {
    orgId: orgRef(),
    quoteDocumentId: uuid("quote_document_id").notNull(),
    documentLineId: uuid("document_line_id").notNull(),
    optional: boolean("optional").notNull(),
    selected: boolean("selected"),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.documentLineId] })],
);

export const serviceVisits = pgTable(
  "service_visits",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    kind: text("kind", { enum: SERVICE_VISIT_KINDS }).notNull(),
    requestId: uuid("request_id"),
    jobId: uuid("job_id"),
    sequence: smallint("sequence").notNull(),
    agreementId: uuid("agreement_id"),
    agreementVersionId: uuid("agreement_version_id"),
    occursOn: date("occurs_on"),
    status: text("status", { enum: SERVICE_VISIT_STATUSES }).notNull(),
    cancelKind: text("cancel_kind", { enum: ["cancelled", "skipped", "superseded"] }),
    priority: text("priority", { enum: SERVICE_PRIORITIES }).notNull(),
    requiredQualificationTypeIds: uuid("required_qualification_type_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    estimatedMinutes: smallint("estimated_minutes").notNull(),
    preferredOn: date("preferred_on"),
    windowStartsAt: timestamp("window_starts_at", { withTimezone: true }),
    windowEndsAt: timestamp("window_ends_at", { withTimezone: true }),
    slaDueAt: timestamp("sla_due_at", { withTimezone: true }),
    instructions: text("instructions"),
    workNotes: text("work_notes"),
    outcomeReason: text("outcome_reason"),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    enRouteAt: timestamp("en_route_at", { withTimezone: true }),
    arrivedAt: timestamp("arrived_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: uuid("completed_by"),
    reviewStatus: text("review_status", { enum: SERVICE_REVIEW_STATUSES }),
    reviewFlowRunId: uuid("review_flow_run_id"),
    reviewDecidedBy: uuid("review_decided_by"),
    reviewDecidedAt: timestamp("review_decided_at", { withTimezone: true }),
    reviewReason: text("review_reason"),
    revision: integer("revision").notNull().default(1),
    ...audit,
    createdBy: uuid("created_by"),
    updatedBy: uuid("updated_by"),
  },
  (t) => [
    uniqueIndex("service_visits_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("service_visits_occurrence_key")
      .on(t.orgId, t.agreementId, t.occursOn)
      .where(sql`${t.agreementId} is not null and ${t.cancelKind} is distinct from 'superseded'`),
  ],
);

export const serviceVisitEvents = pgTable(
  "service_visit_events",
  {
    id: id(),
    orgId: orgRef(),
    visitId: uuid("visit_id").notNull(),
    fromStatus: text("from_status", { enum: SERVICE_VISIT_STATUSES }),
    toStatus: text("to_status", { enum: SERVICE_VISIT_STATUSES }).notNull(),
    visitRevision: integer("visit_revision").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid("actor_id"),
    workerPartyId: uuid("worker_party_id"),
    reason: text("reason"),
  },
  (t) => [
    uniqueIndex("service_visit_events_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("service_visit_events_org_id_visit_id_visit_revision_key").on(
      t.orgId,
      t.visitId,
      t.visitRevision,
    ),
  ],
);

export const serviceVisitParts = pgTable(
  "service_visit_parts",
  {
    id: id(),
    orgId: orgRef(),
    visitId: uuid("visit_id").notNull(),
    itemId: uuid("item_id").notNull(),
    stockLocationId: uuid("stock_location_id").notNull(),
    quantity: money("quantity").notNull(),
    unitPrice: quantity("unit_price").notNull(),
    billable: boolean("billable").notNull(),
    memo: text("memo"),
    lotId: uuid("lot_id"),
    serialId: uuid("serial_id"),
    inventoryMovementId: uuid("inventory_movement_id"),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    createdAt: audit.createdAt,
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [uniqueIndex("service_visit_parts_org_id_id_key").on(t.orgId, t.id)],
);

export const serviceVisitSignatureRequests = pgTable(
  "service_visit_signature_requests",
  {
    id: id(),
    orgId: orgRef(),
    visitId: uuid("visit_id").notNull(),
    recipient: text("recipient"),
    tokenDigest: text("token_digest").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    emailLogId: uuid("email_log_id"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: audit.createdAt,
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("service_visit_signature_requests_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("service_visit_signature_requests_token_digest_key").on(t.tokenDigest),
  ],
);

export const serviceVisitSignatures = pgTable(
  "service_visit_signatures",
  {
    id: id(),
    orgId: orgRef(),
    visitId: uuid("visit_id").notNull(),
    requestId: uuid("request_id").notNull(),
    signerName: text("signer_name").notNull(),
    comment: text("comment"),
    signatureFileId: uuid("signature_file_id").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("service_visit_signatures_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("service_visit_signatures_org_id_visit_id_key").on(t.orgId, t.visitId),
  ],
);

export const serviceBillings = pgTable(
  "service_billings",
  {
    id: id(),
    orgId: orgRef(),
    jobId: uuid("job_id").notNull(),
    visitId: uuid("visit_id"),
    invoiceDocumentId: uuid("invoice_document_id").notNull(),
    createdAt: audit.createdAt,
    createdBy: uuid("created_by").notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedBy: uuid("released_by"),
    releaseReason: text("release_reason"),
  },
  (t) => [uniqueIndex("service_billings_org_id_id_key").on(t.orgId, t.id)],
);

export const serviceJobDeposits = pgTable(
  "service_job_deposits",
  {
    id: id(),
    orgId: orgRef(),
    jobId: uuid("job_id").notNull(),
    paymentDocumentId: uuid("payment_document_id").notNull(),
    amount: money("amount").notNull(),
    createdAt: audit.createdAt,
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("service_job_deposits_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("service_job_deposits_org_id_payment_document_id_key").on(
      t.orgId,
      t.paymentDocumentId,
    ),
  ],
);

export const serviceCustomerNotices = pgTable(
  "service_customer_notices",
  {
    id: id(),
    orgId: orgRef(),
    visitId: uuid("visit_id").notNull(),
    kind: text("kind", { enum: ["arrival_window", "en_route"] }).notNull(),
    occurrenceKey: text("occurrence_key").notNull(),
    recipient: text("recipient"),
    status: text("status", { enum: ["queued", "sent", "suppressed", "failed"] }).notNull(),
    detail: text("detail"),
    emailLogId: uuid("email_log_id"),
    createdAt: audit.createdAt,
    createdBy: uuid("created_by"),
  },
  (t) => [
    uniqueIndex("service_customer_notices_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("service_customer_notices_org_id_visit_id_kind_occurrence_key_key").on(
      t.orgId,
      t.visitId,
      t.kind,
      t.occurrenceKey,
    ),
  ],
);
