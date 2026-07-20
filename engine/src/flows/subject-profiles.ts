import type { FlowFieldDef, FlowSubjectProfile } from "@openbooks/forms-core";

/**
 * FlowSubjectProfiles for document kinds — the author-time vocabulary the
 * builder UI renders against and `lintAutomationGraph` enforces. One generic
 * documents profile parameterized by kind: every document kind shares the
 * supertype's lifecycle, header fields, and hook sites (flows/submit.ts submit,
 * posting.ts before/after post, payments.ts void), so the profiles differ
 * only in label and, for non-posting kinds, the post_document action.
 *
 * Mirrors beaconhs-platform's lib/flows/module-profiles.ts, collapsed to the
 * one `documents` supertype openbooks has instead of beaconhs's 14 modules.
 */

/**
 * Document kinds flows can run over. The posting kinds mirror
 * engine/src/posting.ts RULES; the order kinds (sales_order, purchase_order,
 * quote) live in the same documents table without a posting rule, so their
 * profiles omit `post_document`.
 */
export const POSTING_DOC_KINDS = [
  "vendor_bill",
  "vendor_credit",
  "vendor_payment",
  "expense_report",
  "customer_invoice",
  "customer_credit",
  "customer_payment",
  "card_charge",
  "card_refund",
  "journal",
  "check",
  "deposit",
  "transfer",
] as const;

export const NON_POSTING_DOC_KINDS = ["sales_order", "purchase_order", "quote"] as const;

export const DOCUMENT_FLOW_KINDS: readonly string[] = [
  ...POSTING_DOC_KINDS,
  ...NON_POSTING_DOC_KINDS,
];

/** documents.status enum (schema/src/documents.ts), with builder labels. */
export const DOCUMENT_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "approved", label: "Approved" },
  { value: "posted", label: "Posted" },
  { value: "voided", label: "Voided" },
] as const;

/**
 * Built-in role names for the assignee/recipient `role` target picker. These
 * are the users.role enum values AND the seeded app_roles keys — the two role
 * models intentionally share keys (see engine/src/seed-roles.ts +
 * web/lib/permissions.ts BUILT_IN_ROLES); the runtime resolver matches both.
 * Custom app_roles keys also resolve at runtime; this list is only the picker
 * default.
 */
export const BUILT_IN_ROLE_NAMES = [
  "admin",
  "controller",
  "accountant",
  "approver",
  "viewer",
] as const;

/** Closed execution-context vocabulary shared by every record adapter. */
export const EVENT_SOURCE_OPTIONS = [
  { value: "ui", label: "User interface" },
  { value: "api", label: "API" },
  { value: "sync", label: "Data synchronization" },
  { value: "script", label: "Script" },
  { value: "schedule", label: "Scheduled process" },
  { value: "close_automation", label: "Close automation" },
] as const;

/**
 * Header fields flows may write via set_field — mirrors the trigger-script
 * whitelist (engine/src/scripting.ts MUTABLE_FIELDS) minus the raw `custom`
 * jsonb blob, which has no single field type to offer the builder.
 */
export const WRITABLE_DOCUMENT_FIELDS = new Set([
  "memo",
  "internalNotes",
  "expectedPayDate",
  "paymentHoldReason",
  "dueDate",
  "departmentId",
  "projectId",
  "locationId",
  "classId",
]);

/**
 * The curated header-field tokens documents expose to conditions,
 * {{interpolation}}, and `field` targets. Keys match the values map built by
 * the documents adapter (documents-adapter.ts) 1:1.
 */
export const DOCUMENT_FIELDS: FlowFieldDef[] = [
  { key: "kind", label: "Kind", type: "enum" },
  { key: "documentNumber", label: "Document number", type: "text" },
  { key: "status", label: "Status", type: "enum" },
  { key: "partyId", label: "Party", type: "text" },
  { key: "partyName", label: "Party name", type: "text" },
  { key: "documentDate", label: "Document date", type: "date" },
  { key: "postingDate", label: "Posting date", type: "date" },
  { key: "dueDate", label: "Due date", type: "date", writable: true },
  { key: "expectedPayDate", label: "Expected pay date", type: "date", writable: true },
  { key: "currency", label: "Currency", type: "enum" },
  { key: "subtotal", label: "Subtotal", type: "number" },
  { key: "taxTotal", label: "Tax total", type: "number" },
  { key: "total", label: "Total", type: "number" },
  { key: "openBalance", label: "Open balance", type: "number" },
  { key: "memo", label: "Memo", type: "text", writable: true },
  { key: "internalNotes", label: "Internal notes", type: "text", writable: true },
  { key: "referenceNumber", label: "Reference number", type: "text" },
  { key: "paymentHoldReason", label: "Payment hold reason", type: "text", writable: true },
  { key: "billingMethod", label: "Billing method", type: "enum" },
  { key: "isFinalInvoice", label: "Final invoice", type: "bool" },
  { key: "departmentId", label: "Department", type: "text", writable: true },
  { key: "projectId", label: "Project", type: "text", writable: true },
  { key: "locationId", label: "Location", type: "text", writable: true },
  { key: "classId", label: "Class", type: "text", writable: true },
  { key: "createdBy", label: "Created by (user)", type: "user" },
  { key: "lineCount", label: "Line count", type: "number" },
  { key: "vendorEftEmail", label: "Vendor EFT email", type: "text" },
  // Present only while dispatching an `on_update` event (injected by run.ts
  // from the event, not loaded by the adapter): the edit shape — the
  // "needs re-approval on material edit" building blocks. `changedFields` /
  // `changedLineFields` are ARRAYS; LogicRule `in` over them is any-overlap,
  // so {op:'in', field:'changedFields', value:['total','taxTotal']} reads
  // "total or tax total changed".
  { key: "previousTotal", label: "Previous total (on update)", type: "number" },
  { key: "totalChanged", label: "Total changed (on update)", type: "bool" },
  { key: "changedFields", label: "Changed header fields (on update)", type: "text" },
  { key: "changedLineFields", label: "Changed line fields (on update)", type: "text" },
  { key: "old_total", label: "Old total (on update)", type: "number" },
  { key: "old_taxTotal", label: "Old tax total (on update)", type: "number" },
  // Injected on every dispatch: where the mutation came from
  // ('ui'|'api'|'sync'|'script'|'schedule'|'close_automation') — execution-context
  // filters (auto-approve system-generated records).
  {
    key: "event_source",
    label: "Event source",
    type: "enum",
    options: [...EVENT_SOURCE_OPTIONS],
  },
  // Present only while resolving MANUAL buttons (viewer-aware showIf):
  { key: "current_user_id", label: "Current user (manual buttons)", type: "user" },
  { key: "is_submitter", label: "Viewer is submitter (manual buttons)", type: "bool" },
  { key: "is_pending_approver", label: "Viewer has a pending gate (manual buttons)", type: "bool" },
];

function titleize(kind: string): string {
  return kind.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** The FlowSubjectProfile for one document kind. */
export function documentSubjectProfile(kind: string): FlowSubjectProfile {
  const canPost = (POSTING_DOC_KINDS as readonly string[]).includes(kind);
  return {
    subjectKind: kind,
    label: titleize(kind),
    triggers: [
      "on_create",
      "on_update",
      "on_submit",
      "before_post",
      "after_post",
      "before_void",
      "status_change",
      "on_field_value",
      "scheduled",
      "manual",
    ],
    actions: [
      "send_email",
      "notify",
      "set_field",
      "change_status",
      "lock_record",
      "unlock_record",
      ...(canPost ? (["post_document"] as const) : []),
    ],
    statuses: [...DOCUMENT_STATUSES],
    fields: DOCUMENT_FIELDS.map((field) =>
      field.key === "status"
        ? { ...field, options: DOCUMENT_STATUSES.map((status) => ({ ...status })) }
        : field.key === "kind"
          ? { ...field, options: [{ value: kind, label: titleize(kind) }] }
          : field,
    ),
    roles: [...BUILT_IN_ROLE_NAMES],
  };
}
