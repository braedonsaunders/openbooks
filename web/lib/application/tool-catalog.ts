import "server-only";
import { z, type ZodTypeAny } from "zod";
import { can, type Authz } from "../authz";
import {
  DOCUMENT_REVISION_DESCRIPTION,
  DOCUMENT_REVISION_PATTERN,
  RECORD_TYPE_BY_KEY,
} from "../api/registry-data";
import { decideApproval, listApprovalWorklist } from "./approvals";
import {
  advanceCloseRun,
  createReopenRequest,
  decideReopenRequest,
  getCloseRun,
  listCloseRuns,
  startApplicationCloseRun,
} from "./close";
import type { ApplicationContext } from "./context";
import {
  advanceDocumentLifecycle,
  correctPostedDocument,
  voidDocument,
} from "./documents";
import { createPayment, postPayment, updatePayment } from "./payments";
import {
  createApplicationRecord,
  deleteApplicationRecord,
  getRecord,
  listRecords,
  listRecordTypes,
  updateApplicationRecord,
} from "./records";
import { orgVitals } from "./vitals";

export type ApplicationToolConfirmation = "never" | "always";

export interface ApplicationToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodTypeAny;
  readOnly: boolean;
  destructive: boolean;
  openWorld: boolean;
  assistantConfirmation: ApplicationToolConfirmation;
  visibleTo: (authz: Authz) => boolean;
  execute: (context: ApplicationContext, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

const UUID = z.string().uuid();
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TYPE_KEY = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100);
const MONEY = z.string().regex(/^\d+(?:\.\d{1,4})?$/)
  .describe("Positive exact decimal string with at most four decimal places.");
const SIGNED_MONEY = z.string().regex(/^-?\d+(?:\.\d{1,4})?$/)
  .describe("Exact decimal string with at most four decimal places.");
const RATE = z.string().regex(/^\d+(?:\.\d{1,10})?$/)
  .describe("Positive exact decimal rate with at most ten decimal places.");
const IDEMPOTENCY_KEY = z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const CUSTOM = z.record(z.string(), z.unknown());
const DOCUMENT_REVISION = z.string()
  .regex(new RegExp(DOCUMENT_REVISION_PATTERN), "must be the exact persisted document updated_at token")
  .describe(DOCUMENT_REVISION_DESCRIPTION);
const RECORD_UPDATE_BODY = z.object({
  expectedUpdatedAt: DOCUMENT_REVISION.optional(),
}).catchall(z.unknown());
const DIMENSIONS = z.record(z.string(), UUID.nullable());
const CLOSE_MODULE = z.enum(["ar", "ap", "banking", "assets", "tax", "gl"]);

const DOCUMENT_RECORD_TYPE_KEYS = [...RECORD_TYPE_BY_KEY.entries()]
  .filter(([, recordType]) => recordType.writer.kind === "document")
  .map(([key]) => key);
if (DOCUMENT_RECORD_TYPE_KEYS.length === 0) {
  throw new Error("the application tool catalog has no document record types");
}

const allocationSchema = z.object({
  openLineId: UUID,
  sourceTransactionAmount: MONEY,
  targetTransactionAmount: MONEY,
  targetBaseAmount: MONEY.optional(),
  settlementRate: RATE,
  settlementRateSource: z.enum(["same_currency", "provider", "manual", "contractual", "imported"]),
  settlementRateReference: z.string().trim().min(1).max(500),
  settlementFxRateId: UUID.nullable().optional(),
});

const documentLineSchema = z.object({
  accountId: UUID,
  description: z.string().max(500).nullable().optional(),
  amount: MONEY,
  itemId: UUID.nullable().optional(),
  quantity: SIGNED_MONEY.nullable().optional(),
  unit: z.string().max(50).nullable().optional(),
  unitPrice: SIGNED_MONEY.nullable().optional(),
  taxCodeId: UUID.nullable().optional(),
  taxGroupId: UUID.nullable().optional(),
  taxOverridden: z.boolean().optional(),
  taxAmount: SIGNED_MONEY.nullable().optional(),
  partyId: UUID.nullable().optional(),
  departmentId: UUID.nullable().optional(),
  projectId: UUID.nullable().optional(),
  locationId: UUID.nullable().optional(),
  classId: UUID.nullable().optional(),
  extraDims: DIMENSIONS.optional(),
  custom: CUSTOM.optional(),
});

const correctionSchema = z.object({
  amendmentReason: z.string().trim().min(5).max(500),
  expectedUpdatedAt: DOCUMENT_REVISION,
  partyId: UUID.nullable().optional(),
  paymentCardId: UUID.nullable().optional(),
  documentDate: DATE.optional(),
  dueDate: DATE.nullable().optional(),
  referenceNumber: z.string().max(200).nullable().optional(),
  memo: z.string().max(2000).nullable().optional(),
  postingDate: DATE.nullable().optional(),
  departmentId: UUID.nullable().optional(),
  projectId: UUID.nullable().optional(),
  locationId: UUID.nullable().optional(),
  classId: UUID.nullable().optional(),
  extraDims: DIMENSIONS.optional(),
  subsidiaryId: UUID.nullable().optional(),
  expectedPayDate: DATE.nullable().optional(),
  paymentHoldReason: z.string().max(500).nullable().optional(),
  internalNotes: z.string().max(4000).nullable().optional(),
  billingMethod: z.string().max(100).nullable().optional(),
  isFinalInvoice: z.boolean().optional(),
  custom: CUSTOM.optional(),
  lines: z.array(documentLineSchema).min(1).max(500).optional(),
});

const updateRecordSchema = z.object({
  typeKey: TYPE_KEY,
  id: UUID,
  body: RECORD_UPDATE_BODY,
  idempotencyKey: IDEMPOTENCY_KEY,
}).superRefine((input, context) => {
  if (
    RECORD_TYPE_BY_KEY.get(input.typeKey)?.writer.kind === "document"
    && input.body.expectedUpdatedAt === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["body", "expectedUpdatedAt"],
      message: "required for document updates; copy the exact updated_at returned by a read",
    });
  }
}).meta({
  allOf: [{
    if: {
      properties: { typeKey: { enum: DOCUMENT_RECORD_TYPE_KEYS } },
      required: ["typeKey"],
    },
    then: {
      properties: { body: { required: ["expectedUpdatedAt"] } },
    },
  }],
});

const paymentPatchSchema = z.object({
  partyId: UUID.nullable().optional(),
  bankAccountId: UUID.nullable().optional(),
  documentDate: DATE.optional(),
  referenceNumber: z.string().max(200).nullable().optional(),
  memo: z.string().max(2000).nullable().optional(),
  allocations: z.array(allocationSchema).max(1000).optional(),
  creditAllocations: z.array(z.object({
    fromLineId: UUID,
    toLineId: UUID,
    amount: MONEY,
    sourceDocumentId: UUID,
  })).max(1000).optional(),
  discountAmount: MONEY.optional(),
  discountAccountId: UUID.nullable().optional(),
  controlAccountId: UUID.nullable().optional(),
  feeAmount: MONEY.optional(),
  feeIncomeAccountId: UUID.nullable().optional(),
});

const anyPermission = (...permissions: string[]) => (authz: Authz): boolean =>
  permissions.some((permission) => can(authz, permission));
const hasPermission = (permission: string) => (authz: Authz): boolean => can(authz, permission);
const visible = (): boolean => true;
const documentActor = anyPermission("gl.post", "ap.create", "ap.post", "ar.create", "ar.post", "ap.pay", "ar.pay");

function definition<T extends ZodTypeAny>(args: Omit<ApplicationToolDefinition, "execute" | "inputSchema"> & {
  inputSchema: T;
  execute: (context: ApplicationContext, input: z.infer<T>) => Promise<Record<string, unknown>>;
}): ApplicationToolDefinition {
  const { execute, inputSchema, ...metadata } = args;
  return {
    ...metadata,
    inputSchema,
    execute: (context, input) => execute(context, inputSchema.parse(input)),
  };
}

/**
 * Canonical external capability catalog. MCP and the in-app assistant are
 * adapters over these definitions; all mutations terminate in application
 * services, never transport-specific database code.
 */
export const APPLICATION_TOOLS: readonly ApplicationToolDefinition[] = [
  definition({
    name: "get_vitals", title: "Get Vitals",
    description: "One consistent org snapshot from the same resolvers the screens use: bank cash and runway, AR/AP outstanding and aging totals, pending approvals, and the latest close run. Sections the actor may not read are returned as available:false with the reason — an absent value is never a zero.",
    inputSchema: z.object({}), readOnly: true, destructive: false, openWorld: false,
    assistantConfirmation: "never", visibleTo: visible,
    execute: async (context) => ({ ok: true, ...await orgVitals(context) }),
  }),
  definition({
    name: "list_record_types", title: "List Record Types",
    description: "List record types and live read/write fields this actor may use, including update-only requirements and tenant-defined custom records.",
    inputSchema: z.object({}), readOnly: true, destructive: false, openWorld: false,
    assistantConfirmation: "never", visibleTo: visible,
    execute: async (context) => ({ ok: true, recordTypes: await listRecordTypes(context) }),
  }),
  definition({
    name: "list_records", title: "List Records",
    description: "List one authorized record type with tenant, search, pagination, and subsidiary restrictions enforced. Document updated_at values retain their exact persisted revision.",
    inputSchema: z.object({ typeKey: TYPE_KEY, query: z.string().max(200).optional(), page: z.number().int().min(1).max(10_000).optional(), perPage: z.number().int().min(5).max(100).optional(), subsidiaryId: UUID.optional() }),
    readOnly: true, destructive: false, openWorld: false, assistantConfirmation: "never", visibleTo: visible,
    execute: async (context, input) => ({ ok: true, ...await listRecords(context, input) }),
  }),
  definition({
    name: "get_record", title: "Get Record",
    description: "Get one authorized record by stable UUID with tenant, type, and subsidiary controls enforced. Copy a document's exact updated_at verbatim when updating it.",
    inputSchema: z.object({ typeKey: TYPE_KEY, id: UUID }), readOnly: true, destructive: false, openWorld: false,
    assistantConfirmation: "never", visibleTo: visible,
    execute: async (context, input) => ({ ok: true, record: await getRecord(context, input) }),
  }),
  definition({
    name: "create_record", title: "Create Record",
    description: "Create a record through its authoritative domain writer and validation controls.",
    inputSchema: z.object({ typeKey: TYPE_KEY, body: CUSTOM, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: visible,
    execute: async (context, input) => ({ ok: true, ...await createApplicationRecord(context, input) }),
  }),
  definition({
    name: "update_record", title: "Update Record",
    description: "Update an authorized record through its authoritative domain writer. Document bodies require expectedUpdatedAt copied verbatim from the persisted updated_at returned by get_record; never generate or reformat it.",
    inputSchema: updateRecordSchema,
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: visible,
    execute: async (context, input) => ({ ok: true, ...await updateApplicationRecord(context, input) }),
  }),
  definition({
    name: "delete_record", title: "Delete Record",
    description: "Delete an authorized record only when domain lifecycle and referential-integrity controls permit it.",
    inputSchema: z.object({ typeKey: TYPE_KEY, id: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false, destructive: true, openWorld: false, assistantConfirmation: "always", visibleTo: visible,
    execute: async (context, input) => ({ ok: true, ...await deleteApplicationRecord(context, input) }),
  }),
  definition({
    name: "list_approvals", title: "List Approvals",
    description: "List pending approval gates this actor may decide directly, through a role, or through an active delegation.",
    inputSchema: z.object({}), readOnly: true, destructive: false, openWorld: false,
    assistantConfirmation: "never", visibleTo: hasPermission("flows.approve"),
    execute: async (context) => ({ ok: true, approvals: await listApprovalWorklist(context) }),
  }),
  definition({
    name: "decide_approval", title: "Decide Approval",
    description: "Approve or reject one visible pending gate with assignment, quorum, segregation-of-duties, and signature controls.",
    inputSchema: z.object({ gateId: UUID, decision: z.enum(["approved", "rejected"]), comment: z.string().trim().max(2000).optional(), signature: z.string().trim().min(1).max(200).optional(), idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false, destructive: false, openWorld: true, assistantConfirmation: "always", visibleTo: hasPermission("flows.approve"),
    execute: async (context, input) => ({ ok: true, ...await decideApproval(context, input) }),
  }),
  definition({
    name: "list_close_runs", title: "List Close Runs",
    description: "List period-close runs visible within the actor's subsidiary scope.",
    inputSchema: z.object({ status: z.enum(["in_progress", "pending_approval", "approved", "closed", "published", "cancelled"]).optional(), limit: z.number().int().min(1).max(100).optional() }),
    readOnly: true, destructive: false, openWorld: false, assistantConfirmation: "never", visibleTo: hasPermission("close.run"),
    execute: async (context, input) => ({ ok: true, runs: await listCloseRuns(context, input) }),
  }),
  definition({
    name: "get_close_run", title: "Get Close Run",
    description: "Get one period-close run after tenant and subsidiary-scope checks.",
    inputSchema: z.object({ runId: UUID }),
    readOnly: true, destructive: false, openWorld: false, assistantConfirmation: "never", visibleTo: hasPermission("close.run"),
    execute: async (context, input) => ({ ok: true, run: await getCloseRun(context, input.runId) }),
  }),
  definition({
    name: "start_close_run", title: "Start Close Run",
    description: "Start or resume the authoritative period-close checklist for an explicit period, book, and subsidiary scope.",
    inputSchema: z.object({ periodId: UUID, bookId: UUID, blueprintId: UUID.optional(), reportingPackageId: UUID.optional(), targetCloseDate: DATE.optional(), subsidiaryIds: z.array(UUID).max(500).optional(), idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: hasPermission("close.run"),
    execute: async (context, input) => ({ ok: true, ...await startApplicationCloseRun(context, input) }),
  }),
  ...(["refresh", "request_approval", "attest", "close", "publish"] as const).map((action) => {
    const names = {
      refresh: ["refresh_close_run", "Refresh Close Run"],
      request_approval: ["request_close_approval", "Request Close Approval"],
      attest: ["attest_close_run", "Attest Close Run"],
      close: ["close_period", "Close Period"],
      publish: ["publish_close_package", "Publish Close Package"],
    } as const;
    return definition({
      name: names[action][0], title: names[action][1],
      description: action === "publish"
        ? "Freeze and publish the approved close binder; configured package delivery may be queued after commit. Requires Advanced close controls — omitted when that Features switch is off."
        : `${names[action][1]} through the controlled close lifecycle.`,
      inputSchema: z.object({ runId: UUID, comment: z.string().trim().max(2000).optional(), idempotencyKey: IDEMPOTENCY_KEY }),
      readOnly: false,
      destructive: action === "close",
      openWorld: action === "publish",
      assistantConfirmation: "always",
      visibleTo: hasPermission(action === "attest" || action === "close" ? "close.approve" : "close.run"),
      execute: async (context, input) => ({ ok: true, ...await advanceCloseRun(context, { ...input, action }) }),
    });
  }),
  definition({
    name: "request_period_reopen", title: "Request Period Reopen",
    description: "Create an independently approved, time-bounded request to reopen explicit period modules.",
    inputSchema: z.object({ periodId: UUID, bookId: UUID, subsidiaryId: UUID.optional(), modules: z.array(CLOSE_MODULE).min(1).max(6), reason: z.string().trim().min(5).max(2000), idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: hasPermission("close.reopen"),
    execute: async (context, input) => ({ ok: true, ...await createReopenRequest(context, input) }),
  }),
  definition({
    name: "decide_period_reopen", title: "Decide Period Reopen",
    description: "Independently approve or reject a period-reopen request; approved access is bounded by policy and expiry.",
    inputSchema: z.object({ requestId: UUID, approve: z.boolean(), hours: z.number().int().min(1).max(168).optional(), idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: hasPermission("close.reopen"),
    execute: async (context, input) => ({ ok: true, ...await decideReopenRequest(context, input) }),
  }),
  ...(["submit", "post"] as const).map((action) => definition({
    name: `${action}_document`, title: `${action === "submit" ? "Submit" : "Post"} Document`,
    description: action === "submit" ? "Submit a draft document into its authoritative approval workflow." : "Post an approved document through the accounting kernel; a draft is submitted first and may return pending approval.",
    inputSchema: z.object({ documentId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: documentActor,
    execute: async (context, input) => ({ ok: true, ...await advanceDocumentLifecycle(context, { ...input, action }) }),
  })),
  definition({
    name: "void_document", title: "Void Document",
    description: "Request a controlled void; posted documents reverse through the kernel and retained evidence is preserved.",
    inputSchema: z.object({ documentId: UUID, reason: z.string().trim().min(5).max(500), reversalDate: DATE.nullable().optional(), idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false, destructive: true, openWorld: false, assistantConfirmation: "always", visibleTo: documentActor,
    execute: async (context, input) => ({ ok: true, ...await voidDocument(context, input) }),
  }),
  definition({
    name: "correct_document", title: "Correct Posted Document",
    description: "Create a correcting replacement draft and request a controlled void of the posted source in one exactly-once transaction. The correction requires expectedUpdatedAt copied verbatim from the persisted source revision.",
    inputSchema: z.object({ documentId: UUID, correction: correctionSchema, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false, destructive: true, openWorld: false, assistantConfirmation: "always", visibleTo: documentActor,
    execute: async (context, input) => ({ ok: true, ...await correctPostedDocument(context, input) }),
  }),
  definition({
    name: "create_payment", title: "Create Payment",
    description: "Create a governed vendor-payment or customer-receipt draft with exact currency and subsidiary context.",
    inputSchema: z.object({ kind: z.enum(["vendor_payment", "customer_payment"]), partyId: UUID.nullable().optional(), bankAccountId: UUID.nullable().optional(), documentDate: DATE.optional(), memo: z.string().max(2000).nullable().optional(), subsidiaryId: UUID.nullable().optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), fxRate: RATE.optional(), idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: anyPermission("ap.pay", "ar.pay"),
    execute: async (context, input) => ({ ok: true, ...await createPayment(context, input) }),
  }),
  definition({
    name: "update_payment", title: "Update Payment",
    description: "Update a draft payment or receipt and its exact open-item allocations.",
    inputSchema: z.object({ documentId: UUID, patch: paymentPatchSchema, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: anyPermission("ap.pay", "ar.pay"),
    execute: async (context, input) => ({ ok: true, ...await updatePayment(context, input) }),
  }),
  definition({
    name: "post_payment", title: "Post Payment",
    description: "Submit and post a payment or receipt with open-item applications atomically; may return pending approval.",
    inputSchema: z.object({ documentId: UUID, allocations: z.array(allocationSchema).min(1).max(1000).optional(), idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: anyPermission("ap.pay", "ar.pay"),
    execute: async (context, input) => ({ ok: true, ...await postPayment(context, input) }),
  }),
];

export function applicationTool(name: string): ApplicationToolDefinition | undefined {
  return APPLICATION_TOOLS.find((candidate) => candidate.name === name);
}

export async function executeApplicationTool(
  definition: ApplicationToolDefinition,
  context: ApplicationContext,
  rawInput: unknown,
): Promise<Record<string, unknown>> {
  if (!definition.visibleTo(context.authz)) throw new Error("forbidden");
  const input = definition.inputSchema.parse(rawInput) as Record<string, unknown>;
  return definition.execute(context, input);
}
