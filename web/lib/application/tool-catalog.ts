import "server-only";
import { activateExtensionDraft, listExtensions, discardExtensionDraft, describeExtensionVocabulary, draftExtension, getExtensionDraft, getExtensionPackage } from "./extensions";
import { z, type ZodTypeAny } from "zod";
import { can, type Authz } from "../authz";
import {
  DOCUMENT_REVISION_DESCRIPTION,
  DOCUMENT_REVISION_PATTERN,
  RECORD_TYPE_BY_KEY,
} from "../api/registry-data";
import { decideApproval, listApprovalWorklist } from "./approvals";
import {
  matchStatementLine,
  matchStatementLineWithJournal,
  signOffReconciliation,
  startReconciliationSession,
  unmatchStatementLineAction,
} from "./banking";
import { updateBudgetCells } from "./budgets";
import {
  advanceCloseRun,
  createReopenRequest,
  decideReopenRequest,
  getCloseRun,
  listCloseRuns,
  runPeriodRevaluation,
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
import {
  clearLayout,
  describeLayoutVocabulary,
  describePageLayout,
  listLayoutHistory,
  listLayouts,
  previewLayout,
  restoreLayout,
  setLayout,
  validateLayout,
} from "./page-layouts";
import { orgVitals } from "./vitals";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { FEATURES, featureEnabled, resolvedFeatureState } from "../features";
import { applyFeatureChanges, normalizeFeatureChanges } from "../features-admin";
import { readCompanySettings, updateCompanySettings } from "../company-settings";
import { SETUP_ENTITY_BY_KEY, setupEntityForFeatureState } from "../setup/registry";
import { createSetupRecord, deleteSetupRecord, updateSetupRecord } from "../setup/write";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { executeIdempotent } from "./idempotency";

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
  /** Optional-feature key; adapters hide the tool while the org has it off. */
  featureKey?: string;
  execute: (context: ApplicationContext, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/**
 * Stable-UUID tool input. A plain regex (not `.uuid()`) on purpose: `.uuid()`
 * emits `format: uuid` into the provider JSON Schema, which strict providers
 * reject, while the equivalent `pattern` is accepted. The class is written
 * without a case-insensitive flag because JSON Schema patterns carry no
 * flags (same rule as web/lib/assistant/tools-shared.ts UUID_RE).
 */
const UUID = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
  .describe("Stable UUID, copied verbatim from the id a list_, find_, or get_ tool returned; never invent one.");
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date (YYYY-MM-DD).");
const TYPE_KEY = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100)
  .describe("Record type key from list_record_types.");
const MONEY = z.string().regex(/^\d+(?:\.\d{1,4})?$/)
  .describe("Positive exact decimal string with at most four decimal places.");
const SIGNED_MONEY = z.string().regex(/^-?\d+(?:\.\d{1,4})?$/)
  .describe("Exact decimal string with at most four decimal places.");
const RATE = z.string().regex(/^\d+(?:\.\d{1,10})?$/)
  .describe("Positive exact decimal rate with at most ten decimal places.");
const IDEMPOTENCY_KEY = z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const ROUTE = z.string().regex(/^\/[A-Za-z0-9._\-/\[\]()]*$/).max(120)
  .describe("Next.js route PATTERN the layout replaces, e.g. /banking or /apps/[key]. Never a concrete url.");
const LAYOUT_SPEC = z.unknown()
  .describe("A ViewSpec PageSpec document. Call validate_page_layout first; errors name the offending widget or path.");
const EXTENSION_KEY = z.string().regex(/^[a-z][a-z0-9-]*$/).max(64)
  .describe("App package key, e.g. equipment-checks.");
const CUSTOM = z.record(z.string(), z.unknown())
  .describe("Field values keyed by the record type's field keys (camelCase, as list_record_types describes them).");
const DOCUMENT_REVISION = z.string()
  .regex(new RegExp(DOCUMENT_REVISION_PATTERN), "must be the exact persisted document updated_at token")
  .describe(DOCUMENT_REVISION_DESCRIPTION);
const RECORD_UPDATE_BODY = z.object({
  expectedUpdatedAt: DOCUMENT_REVISION.optional(),
}).catchall(z.unknown())
  .describe("Updated field values (partial update); document updates must include expectedUpdatedAt copied verbatim from a read.");
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
  const writerKind = RECORD_TYPE_BY_KEY.get(input.typeKey)?.writer.kind;
  if (
    writerKind === "document"
    && input.body.expectedUpdatedAt === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["body", "expectedUpdatedAt"],
      message: "required for document updates; copy the exact updated_at returned by a read",
    });
  }
  if (
    writerKind === "custom_record"
    && (input.body as { data?: unknown }).data !== undefined
    && input.body.expectedUpdatedAt === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["body", "expectedUpdatedAt"],
      message: "required for custom-record data updates; copy the exact updated_at returned by a read",
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

/**
 * Map a transport-neutral write outcome ({ status, body }) from the settings
 * and setup command layers onto the application error contract. 2xx returns
 * the body; every refusal becomes the same typed ApplicationError the route
 * would have answered with, so chat and MCP see one failure shape.
 */
function settleWrite(result: { status: number; body: Record<string, unknown> }): Record<string, unknown> {
  if (result.status < 300) return result.body;
  const message = typeof result.body.message === "string"
    ? result.body.message
    : typeof result.body.error === "string" ? result.body.error : "request refused";
  const details = result.body;
  switch (result.status) {
    case 403: throw new ApplicationError("forbidden", "forbidden", 403, details);
    case 404: throw new ApplicationError("not_found", message, 404, details);
    case 405: throw new ApplicationError("unsupported_operation", message, 405, details);
    case 409: throw new ApplicationError("conflict", message, 409, details);
    default: throw new ApplicationError("invalid_input", message, 422, details);
  }
}

const SETUP_ENTITY_KEY = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80)
  .describe("Setup entity key from list_setup_entities, e.g. tax-codes, departments, payment-terms.");
const SETUP_BODY = z.record(z.string(), z.unknown())
  .describe("Field values keyed by the entity's field keys (camelCase, as list_setup_entities describes them).");
const SETUP_ADMIN = hasPermission("admin.setup.manage");
const setupActor = (context: ApplicationContext) => ({
  orgId: context.authz.user.orgId,
  id: context.authz.user.id,
  permissions: context.authz.permissions,
});

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
    description: "List one authorized record type with tenant, search, pagination, and subsidiary restrictions enforced. Document and custom-record updated_at values retain their exact persisted revision.",
    inputSchema: z.object({
      typeKey: TYPE_KEY,
      query: z.string().max(200).optional().describe("Free-text match against the record's searchable fields"),
      page: z.number().int().min(1).max(10_000).optional().describe("Page number (default 1)"),
      perPage: z.number().int().min(5).max(100).optional().describe("Rows per page (default 25)"),
      subsidiaryId: UUID.optional(),
    }),
    readOnly: true, destructive: false, openWorld: false, assistantConfirmation: "never", visibleTo: visible,
    execute: async (context, input) => ({ ok: true, ...await listRecords(context, input) }),
  }),
  definition({
    name: "get_record", title: "Get Record",
    description: "Get one authorized record by stable UUID with tenant, type, and subsidiary controls enforced. Copy a document's (or a custom record's, when replacing data) exact updated_at verbatim when updating it.",
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
    description: "Update an authorized record through its authoritative domain writer. Document bodies require expectedUpdatedAt copied verbatim from the persisted updated_at returned by get_record; custom-record bodies that replace data require it too; never generate or reformat it.",
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
    name: "describe_page_layout_vocabulary", title: "Describe Page Layout Vocabulary",
    description: "The block kinds, cell kinds, widget names and frame names a page layout may use, read from the live renderer registries, plus the rules a layout must obey. Start here before writing one: a widget this does not list is refused at save.",
    inputSchema: z.object({}), readOnly: true, destructive: false, openWorld: false,
    assistantConfirmation: "never", visibleTo: visible,
    execute: async (context) => ({ ok: true, ...await describeLayoutVocabulary(context) }),
  }),
  definition({
    name: "describe_page_layout", title: "Describe Page Layout",
    description: "What a route renders TODAY: its built-in layout verbatim, this org's override if one is active, and every field path the page's loader exposes with a sample value. Read this before writing a layout — editing the built-in one beats composing from scratch, and a field path that does not exist here renders as blank rather than as an error. Runs the page's own loader under your own permissions; a page you cannot view reports that instead of its layout.",
    inputSchema: z.object({
      route: ROUTE,
      params: z.record(z.string(), z.string()).optional()
        .describe("Values for the route's dynamic segments, keyed as the route names them, e.g. { accountId: \"…\" } for /banking/[accountId]."),
      searchParams: z.record(z.string(), z.string()).optional()
        .describe("The query string to load the page with, e.g. { period: \"last-month\" }."),
    }),
    readOnly: true, destructive: false, openWorld: false,
    assistantConfirmation: "never", visibleTo: visible,
    execute: async (context, input) => ({ ok: true, ...await describePageLayout(context, input as never) }),
  }),
  definition({
    name: "list_page_layouts", title: "List Page Layouts",
    description: "List the routes this org has customized, with the stored layout for each. A route absent from this list renders its built-in layout.",
    inputSchema: z.object({}), readOnly: true, destructive: false, openWorld: false,
    assistantConfirmation: "never", visibleTo: visible,
    execute: async (context) => ({ ok: true, ...await listLayouts(context) }),
  }),
  definition({
    name: "validate_page_layout", title: "Validate Page Layout",
    description: "Check a draft layout without storing it. Returns the specific errors — an unknown widget is named, an illegal property is pointed at. Iterate here rather than against set_page_layout.",
    inputSchema: z.object({ spec: LAYOUT_SPEC }),
    readOnly: true, destructive: false, openWorld: false,
    assistantConfirmation: "never", visibleTo: visible,
    execute: async (context, input) => ({ ok: true, ...await validateLayout(context, input) }),
  }),
  definition({
    name: "preview_page_layout", title: "Preview Page Layout",
    description: "Stage a draft layout and get a url that renders the REAL page with it applied — visible only to you, expiring on its own, published to nobody. Use this to show a layout before set_page_layout makes it live for the whole org.",
    inputSchema: z.object({
      route: ROUTE,
      spec: LAYOUT_SPEC,
      params: z.record(z.string(), z.string()).optional()
        .describe("Values for the route's dynamic segments, e.g. { key: \"inventory\" } for /apps/[key]."),
    }),
    readOnly: false, destructive: false, openWorld: false,
    assistantConfirmation: "never", visibleTo: visible,
    execute: async (context, input) => ({ ok: true, ...await previewLayout(context, input as never) }),
  }),
  definition({
    name: "set_page_layout", title: "Set Page Layout",
    description: "Replace what a route renders — for everyone in this org, or for you alone with scope: \"user\". The layout binds fields the page's loader already resolved; it cannot reach data the reader could not already see. A rejected layout is returned with its errors rather than stored.",
    inputSchema: z.object({ route: ROUTE, spec: LAYOUT_SPEC, note: z.string().max(500).optional()
        .describe("Human-readable reason for this layout change, stored in history"), scope: z.enum(["org", "user"]).optional()
        .describe("org (default) changes the page for everyone; user stores it for you alone.") }),
    readOnly: false, destructive: false, openWorld: false,
    assistantConfirmation: "always", visibleTo: visible,
    execute: async (context, input) => ({ ok: true, ...await setLayout(context, input) }),
  }),
  definition({
    name: "list_page_layout_history", title: "List Page Layout History",
    description: "Every layout ever saved for a route, newest first, with who saved it and why. A save deactivates its predecessor rather than deleting it, so this is how an edit gets undone after the fact.",
    inputSchema: z.object({ route: ROUTE }),
    readOnly: true, destructive: false, openWorld: false,
    assistantConfirmation: "never", visibleTo: visible,
    execute: async (context, input) => ({ ok: true, ...await listLayoutHistory(context, input as never) }),
  }),
  definition({
    name: "restore_page_layout", title: "Restore Page Layout",
    description: "Publish a previous version of a route's layout again, by the id list_page_layout_history reports. Appends a new active version rather than reactivating the old row, so the history stays a true record of what was live when.",
    inputSchema: z.object({ route: ROUTE, versionId: UUID }),
    readOnly: false, destructive: false, openWorld: false,
    assistantConfirmation: "always", visibleTo: visible,
    execute: async (context, input) => ({ ok: true, ...await restoreLayout(context, input as never) }),
  }),
  definition({
    name: "clear_page_layout", title: "Clear Page Layout",
    description: "Drop a layout for a route so the page returns to what it would otherwise render. The stored layout is deactivated, not destroyed.",
    inputSchema: z.object({ route: ROUTE, scope: z.enum(["org", "user"]).optional()
        .describe("org (default) changes the page for everyone; user stores it for you alone.") }),
    readOnly: false, destructive: true, openWorld: false,
    assistantConfirmation: "always", visibleTo: visible,
    execute: async (context, input) => ({ ok: true, ...await clearLayout(context, input) }),
  }),
  definition({
    name: "list_app_packages", title: "List Apps",
    featureKey: "apps",
    description: "List this organization's app packages, their active versions, status, management and workspace links.",
    inputSchema: z.object({}), readOnly: true, destructive: false, openWorld: false,
    assistantConfirmation: "never", visibleTo: visible,
    execute: async context => ({ ok: true, ...await listExtensions(context) }),
  }),
  definition({
    name: "describe_app_vocabulary", title: "Describe App Capabilities",
    featureKey: "apps",
    description: "Start here to build an app. Returns the native screen and package contract, governed objects and backend capabilities, an example, and the draft → preview → approve workflow.",
    inputSchema: z.object({}), readOnly: true, destructive: false, openWorld: false,
    assistantConfirmation: "never", visibleTo: visible,
    execute: async context => ({ ok: true, ...await describeExtensionVocabulary(context) }),
  }),
  definition({
    name: "draft_app", title: "Prepare App Draft",
    featureKey: "apps",
    description: "Save an immutable unpublished app package for this author. No installation, object creation, backend execution or activation occurs. Returns the human review URL, preview URL and exact content hash. A revision is a new draft; keep all intended files and definitions.",
    inputSchema: z.object({
      bundle: z.unknown().describe("Complete app package bundle: owned definitions and files the draft installs."),
      reason: z.string().trim().min(1).max(2000).describe("Honest human-readable reason for this draft"),
    }),
    readOnly: false, destructive: false, openWorld: false,
    assistantConfirmation: "never", visibleTo: visible,
    execute: async (context, input) => ({ ok: true, ...await draftExtension(context, input as never) }),
  }),
  definition({
    name: "get_app_draft", title: "Read App Draft",
    featureKey: "apps",
    description: "Read this author's exact unpublished package, base version and hash for revision or review. Other authors' drafts are unavailable.",
    inputSchema: z.object({ draftId: UUID }), readOnly: true, destructive: false, openWorld: false,
    assistantConfirmation: "never", visibleTo: visible,
    execute: async (context, input) => ({ ok: true, draft: await getExtensionDraft(context, input.draftId as string) }),
  }),
  definition({
    name: "get_app_package", title: "Read Installed App Package",
    featureKey: "apps",
    description: "Read the installed package or one of its historical versions before preparing an upgrade or rollback. Preserve owned object definitions and use a new version label, then draft and review it.",
    inputSchema: z.object({ key: EXTENSION_KEY, versionId: UUID.optional() }), readOnly: true, destructive: false, openWorld: false,
    assistantConfirmation: "never", visibleTo: visible,
    execute: async (context, input) => ({ ok: true, ...await getExtensionPackage(context, input as never) }),
  }),
  definition({
    name: "discard_app_draft", title: "Discard App Draft",
    featureKey: "apps",
    description: "Discard this author's unpublished draft while preserving its source and audit evidence. Activated versions cannot be discarded.",
    inputSchema: z.object({
      draftId: UUID,
      contentHash: z.string().regex(/^[a-f0-9]{64}$/).describe("Exact content hash the draft call returned; guards against stale-base activation"),
    }),
    readOnly: false, destructive: false, openWorld: false,
    assistantConfirmation: "never", visibleTo: visible,
    execute: async (context, input) => ({ ok: true, ...await discardExtensionDraft(context, input as never) }),
  }),
  definition({
    name: "activate_app_draft", title: "Activate Reviewed Extension",
    featureKey: "apps",
    description: "Activate only the exact author-owned draft the human reviewed and explicitly approved. Bind draftId and contentHash. Refuses stale base versions or unavailable permissions. Provisioning, version activation and audit commit atomically.",
    inputSchema: z.object({
      draftId: UUID,
      contentHash: z.string().regex(/^[a-f0-9]{64}$/).describe("Exact content hash the draft call returned; guards against stale-base activation"),
    }),
    readOnly: false, destructive: false, openWorld: false,
    assistantConfirmation: "always", visibleTo: visible,
    execute: async (context, input) => ({ ok: true, ...await activateExtensionDraft(context, input as never) }),
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
    inputSchema: z.object({
      gateId: UUID,
      decision: z.enum(["approved", "rejected"]).describe("The approval decision"),
      comment: z.string().trim().max(2000).optional().describe("Decision rationale recorded on the gate"),
      signature: z.string().trim().min(1).max(200).optional().describe("Signature text where the gate requires one"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false, destructive: false, openWorld: true, assistantConfirmation: "always", visibleTo: hasPermission("flows.approve"),
    execute: async (context, input) => ({ ok: true, ...await decideApproval(context, input) }),
  }),
  definition({
    name: "list_close_runs", title: "List Close Runs",
    description: "List period-close runs visible within the actor's subsidiary scope.",
    inputSchema: z.object({
      status: z.enum(["in_progress", "pending_approval", "approved", "closed", "published", "cancelled"]).optional()
        .describe("Only runs in this lifecycle status"),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum runs to return (default 50)"),
    }),
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
    inputSchema: z.object({
      periodId: UUID, bookId: UUID, blueprintId: UUID.optional(), reportingPackageId: UUID.optional(),
      targetCloseDate: DATE.optional(),
      subsidiaryIds: z.array(UUID).max(500).optional().describe("Close scope: omit for the whole org"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
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
      inputSchema: z.object({
        runId: UUID,
        comment: z.string().trim().max(2000).optional().describe("Note recorded on the close run"),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      readOnly: false,
      destructive: action === "close",
      openWorld: action === "publish",
      assistantConfirmation: "always",
      // publish is refused without Advanced close controls (advanceCloseRun);
      // the catalog must omit it there too, as the description already claims.
      featureKey: action === "publish" ? "advancedClose" : undefined,
      visibleTo: hasPermission(action === "attest" || action === "close" ? "close.approve" : "close.run"),
      execute: async (context, input) => ({ ok: true, ...await advanceCloseRun(context, { ...input, action }) }),
    });
  }),
  definition({
    name: "request_period_reopen", title: "Request Period Reopen",
    description: "Create an independently approved, time-bounded request to reopen explicit period modules.",
    inputSchema: z.object({
      periodId: UUID, bookId: UUID, subsidiaryId: UUID.optional(),
      modules: z.array(CLOSE_MODULE).min(1).max(6).describe("Period modules to reopen (ar, ap, banking, assets, tax, gl)"),
      reason: z.string().trim().min(5).max(2000).describe("Business reason for the reopen request"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: hasPermission("close.reopen"),
    execute: async (context, input) => ({ ok: true, ...await createReopenRequest(context, input) }),
  }),
  definition({
    name: "decide_period_reopen", title: "Decide Period Reopen",
    description: "Independently approve or reject a period-reopen request; approved access is bounded by policy and expiry.",
    inputSchema: z.object({
      requestId: UUID,
      approve: z.boolean().describe("True approves the reopen; false rejects it"),
      hours: z.number().int().min(1).max(168).optional().describe("Approved access window in hours"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: hasPermission("close.reopen"),
    execute: async (context, input) => ({ ok: true, ...await decideReopenRequest(context, input) }),
  }),
  definition({
    name: "run_revaluation", title: "Run FX Revaluation",
    description: "Run period-end unrealized FX revaluation for an accounting period: restate foreign-currency monetary balances to the period-end spot rate, booking the remaining gain/loss plus its next-period mirror. Reruns book only incremental corrections; unchanged reruns post nothing. Requires the multi-currency module and a configured unrealized gain/loss account.",
    inputSchema: z.object({ periodId: UUID, bookId: UUID.optional(), idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always",
    visibleTo: hasPermission("close.run"), featureKey: "multiCurrency",
    execute: async (context, input) => ({ ok: true, ...(await runPeriodRevaluation(context, input)) }),
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
    inputSchema: z.object({
      documentId: UUID,
      reason: z.string().trim().min(5).max(500).describe("Reason recorded for the void"),
      reversalDate: DATE.nullable().optional(),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false, destructive: true, openWorld: false, assistantConfirmation: "always", visibleTo: documentActor,
    execute: async (context, input) => ({ ok: true, ...await voidDocument(context, input) }),
  }),
  definition({
    name: "correct_document", title: "Correct Posted Document",
    description: "Create a correcting replacement draft and request a controlled void of the posted source in one exactly-once transaction. The correction requires expectedUpdatedAt copied verbatim from the persisted source revision.",
    inputSchema: z.object({
      documentId: UUID,
      correction: correctionSchema.describe("Replacement header and lines for the correcting draft"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false, destructive: true, openWorld: false, assistantConfirmation: "always", visibleTo: documentActor,
    execute: async (context, input) => ({ ok: true, ...await correctPostedDocument(context, input) }),
  }),
  definition({
    name: "create_payment", title: "Create Payment",
    description: "Create a governed vendor-payment or customer-receipt draft with exact currency and subsidiary context.",
    inputSchema: z.object({
      kind: z.enum(["vendor_payment", "customer_payment"]).describe("Draft kind: vendor_payment pays a vendor, customer_payment records a receipt"),
      partyId: UUID.nullable().optional(), bankAccountId: UUID.nullable().optional(), documentDate: DATE.optional(),
      memo: z.string().max(2000).nullable().optional().describe("Memo on the payment draft"),
      subsidiaryId: UUID.nullable().optional(),
      currency: z.string().regex(/^[A-Z]{3}$/).optional().describe("Three-letter currency code, e.g. CAD"),
      fxRate: RATE.optional(), idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: anyPermission("ap.pay", "ar.pay"),
    execute: async (context, input) => ({ ok: true, ...await createPayment(context, input) }),
  }),
  definition({
    name: "update_payment", title: "Update Payment",
    description: "Update a draft payment or receipt and its exact open-item allocations.",
    inputSchema: z.object({
      documentId: UUID,
      patch: paymentPatchSchema.describe("Draft changes: header fields and exact open-item allocations"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: anyPermission("ap.pay", "ar.pay"),
    execute: async (context, input) => ({ ok: true, ...await updatePayment(context, input) }),
  }),
  definition({
    name: "post_payment", title: "Post Payment",
    description: "Submit and post a payment or receipt with open-item applications atomically; may return pending approval.",
    inputSchema: z.object({
      documentId: UUID,
      allocations: z.array(allocationSchema).min(1).max(1000).optional()
        .describe("Open-item applications built from list_open_items rows; omit when nothing is applied"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: anyPermission("ap.pay", "ar.pay"),
    execute: async (context, input) => ({ ok: true, ...await postPayment(context, input) }),
  }),
  definition({
    name: "start_reconciliation", title: "Start Reconciliation",
    description: "Start a bank reconciliation session for an account through an explicit through-date and statement balance (one open session per account). Returns the session id; match lines with match_bank_line, then sign off.",
    inputSchema: z.object({ accountId: UUID, throughDate: DATE, statementBalance: SIGNED_MONEY, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always",
    visibleTo: hasPermission("banking.reconcile"), featureKey: "banking",
    execute: async (context, input) => ({ ok: true, ...(await startReconciliationSession(context, input)) }),
  }),
  definition({
    name: "match_bank_line", title: "Match Bank Line",
    description: "Manually pair one unmatched bank statement line with one or more posted journal lines in a reconciliation session. The journal total must equal the statement line exactly. Returns the session totals (difference must reach zero before sign-off).",
    inputSchema: z.object({
      reconciliationId: UUID, statementLineId: UUID,
      journalLineIds: z.array(UUID).min(1).max(50).describe("Posted journal lines whose total must equal the statement line exactly"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always",
    visibleTo: hasPermission("banking.reconcile"), featureKey: "banking",
    execute: async (context, input) => ({ ok: true, ...(await matchStatementLine(context, input)) }),
  }),
  definition({
    name: "match_bank_line_with_journal", title: "Match Bank Line With Journal",
    description: "Create a categorizing journal from one unmatched bank statement line (bank leg on the line's account, remainder to the offset account) and match it into the session — the Match Bank Data Add-journal action. Use when no posted journal line explains the bank line.",
    inputSchema: z.object({ reconciliationId: UUID, statementLineId: UUID, offsetAccountId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always",
    visibleTo: hasPermission("banking.reconcile"), featureKey: "banking",
    execute: async (context, input) => ({ ok: true, ...(await matchStatementLineWithJournal(context, input)) }),
  }),
  definition({
    name: "unmatch_bank_line", title: "Unmatch Bank Line",
    description: "Remove all of a statement line's matches within a reconciliation session, returning it to the unmatched queue. Signed-off sessions refuse.",
    inputSchema: z.object({ reconciliationId: UUID, statementLineId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always",
    visibleTo: hasPermission("banking.reconcile"), featureKey: "banking",
    execute: async (context, input) => ({ ok: true, ...(await unmatchStatementLineAction(context, input)) }),
  }),
  definition({
    name: "sign_off_reconciliation", title: "Sign Off Reconciliation",
    description: "Sign off a zero-difference reconciliation session: stamps every matched journal line reconciled and closes the session. Refuses when the difference is not exactly zero or statement evidence is missing. A signed-off session is permanent.",
    inputSchema: z.object({ reconciliationId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always",
    visibleTo: hasPermission("banking.reconcile"), featureKey: "banking",
    execute: async (context, input) => ({ ok: true, ...(await signOffReconciliation(context, input)) }),
  }),
  definition({
    name: "update_budget_cells", title: "Update Budget Cells",
    description: "Write planning cells into a draft budget scenario through the same revision-checked command as the budget worksheet: amounts are exact decimal strings, cells are keyed by account, period, subsidiary and dimensions, and expectedRevision (from get_budget_workspace) must match or the write is refused. Approved, pending or archived scenarios refuse. Audited with before/after evidence.",
    inputSchema: z.object({
      scenarioId: UUID,
      expectedRevision: z.number().int().min(1),
      cells: z.array(z.object({
        accountId: UUID,
        periodId: UUID,
        subsidiaryId: UUID.nullable().optional(),
        departmentId: UUID.nullable().optional(),
        projectId: UUID.nullable().optional(),
        locationId: UUID.nullable().optional(),
        classId: UUID.nullable().optional(),
        amount: SIGNED_MONEY,
        note: z.string().max(2000).nullable().optional(),
      })).min(1).max(1000),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always",
    visibleTo: hasPermission("budgets.manage"), featureKey: "budgets",
    execute: async (context, input) => ({ ok: true, ...(await updateBudgetCells(context, input)) }),
  }),
  definition({
    name: "get_company_settings", title: "Get Company Settings",
    description: "Company & Accounting settings as the settings screen shows them: identity (name, legal name, country), default locale, base currency, fiscal-year start month, reporting and tax frameworks, report PDF style, control-account mappings (with account numbers), and the resolved optional-feature switchboard. Read-only.",
    inputSchema: z.object({}), readOnly: true, destructive: false, openWorld: false,
    assistantConfirmation: "never", visibleTo: anyPermission("admin.users.manage", "admin.setup.manage"),
    execute: async (context) => {
      const orgId = context.authz.user.orgId;
      const view = settleWrite(await readCompanySettings(orgId));
      const row = (await db.execute<{ base_currency: string; settings: Record<string, unknown> | null }>(sql`
        select base_currency, settings from orgs where id = ${orgId}`)).rows[0];
      if (!row) throw notFound("organization");
      const settings = row.settings ?? {};
      const control = (settings.controlAccounts ?? {}) as Record<string, string>;
      const ids = Object.values(control).filter((v): v is string => typeof v === "string" && v.length > 0);
      const accounts = ids.length
        ? (await db.execute<{ id: string; number: string | null; name: string; type: string }>(sql`
            select id, number, name, type from accounts
             where org_id = ${orgId} and id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)).rows
        : [];
      const byId = new Map(accounts.map((a) => [a.id, a]));
      const features = await resolvedFeatureState(orgId);
      return {
        ok: true,
        ...view,
        accounting: {
          baseCurrency: row.base_currency,
          fiscalYearStartMonth: typeof settings.fiscalYearStartMonth === "number" ? settings.fiscalYearStartMonth : 1,
          reportPdfStyle: settings.reportPdfStyle ?? "modern",
          fairValueRangePolicy: settings.fairValueRangePolicy ?? null,
          controlAccounts: Object.fromEntries(Object.entries(control).map(([role, id]) => {
            const a = byId.get(id);
            return [role, a ? { id, number: a.number, name: a.name, type: a.type } : { id, missing: true }];
          })),
        },
        features: Object.fromEntries(FEATURES.map((f) => [f.key, featureEnabled(features, f.key)])),
        href: "/admin/settings",
      };
    },
  }),
  definition({
    name: "update_company_settings", title: "Update Company Settings",
    description: "Change Company & Accounting settings through the same command the settings screen uses: name, legalName, country, baseCurrency, fiscalYearStartMonth, reportingFramework (us_gaap|ifrs), taxFramework (asc740|ias12), defaultLocale, reportPdfStyle (formal|modern), controlAccounts ({ role: accountId | null }), fairValueRangePolicy. Only the keys you pass change. Refuses fiscal-calendar or base-currency changes once postings exist, and invalid control accounts. Audited.",
    inputSchema: z.object({
      changes: z.record(z.string(), z.unknown())
        .describe("Settings to change, keyed by setting name (only the keys passed change)"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: SETUP_ADMIN,
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      const changes = input.changes as Record<string, unknown>;
      if (Object.keys(changes).length === 0) throw invalidInput("changes must name at least one setting");
      const outcome = await executeIdempotent({
        context, operation: "company_settings.update", idempotencyKey: input.idempotencyKey, request: { changes },
        execute: async () => settleWrite(await updateCompanySettings(context.authz.user, changes)),
      });
      return { ok: true, replayed: outcome.replayed, ...outcome.value };
    },
  }),
  definition({
    name: "update_features", title: "Update Features",
    description: "Turn optional modules on or off ({ featureKey: boolean }, keys from list_features) through the same fenced command as Setup → Features: dependency rules are enforced, a module whose data is structurally load-bearing cannot be disabled, enabling installs the module's baseline configuration, and the change is audited. Returns the before/after switchboard.",
    inputSchema: z.object({
      features: z.record(z.string(), z.boolean())
        .describe("Feature switches to set, keyed by feature key from list_features"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: SETUP_ADMIN,
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      const normalized = normalizeFeatureChanges(input.features);
      if (!normalized.ok) throw invalidInput(normalized.error, normalized.key ? { key: normalized.key } : undefined);
      const outcome = await executeIdempotent({
        context, operation: "features.update", idempotencyKey: input.idempotencyKey, request: { features: normalized.changes },
        execute: async () => {
          const result = await applyFeatureChanges(context.authz.user.orgId, context.authz.user.id, normalized.changes);
          if (!result.ok) {
            if (result.error === "not-found") throw notFound("organization");
            const { ok: _ok, error, ...details } = result;
            throw conflict(error, details);
          }
          return { before: result.before, after: result.after };
        },
      });
      return { ok: true, replayed: outcome.replayed, ...outcome.value, href: "/admin/setup/features" };
    },
  }),
  definition({
    name: "create_setup_record", title: "Create Setup Record",
    description: "Create one configuration record in a Setup entity (tax codes, departments, classes, locations, payment terms, item rate books, pay components, …) through the same validated, audited command as the Setup screens. Resolve the entity key and its field descriptors with list_setup_entities first; reference fields take the referenced row's id.",
    inputSchema: z.object({ entityKey: SETUP_ENTITY_KEY, body: SETUP_BODY, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: SETUP_ADMIN,
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      const outcome = await executeIdempotent({
        context, operation: "setup_record.create", idempotencyKey: input.idempotencyKey,
        request: { entityKey: input.entityKey, body: input.body },
        execute: async () => settleWrite(await createSetupRecord(setupActor(context), input.entityKey, input.body as Record<string, unknown>)),
      });
      return { ok: true, replayed: outcome.replayed, entityKey: input.entityKey, ...outcome.value, href: `/admin/setup/${input.entityKey}` };
    },
  }),
  definition({
    name: "update_setup_record", title: "Update Setup Record",
    description: "Update one configuration record in a Setup entity by id through the same validated, audited command as the Setup screens. Pass only the fields to change; get ids from list_setup_records. Some entities version instead of overwrite (e.g. effective-dated payroll rules) and some values lock once used by postings — the command reports which.",
    inputSchema: z.object({
      entityKey: SETUP_ENTITY_KEY,
      id: z.string().min(1).max(120).describe("Id of the setup record, from list_setup_records"),
      body: SETUP_BODY, idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: SETUP_ADMIN,
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      const body = { ...(input.body as Record<string, unknown>), id: input.id };
      const outcome = await executeIdempotent({
        context, operation: "setup_record.update", idempotencyKey: input.idempotencyKey,
        request: { entityKey: input.entityKey, body },
        execute: async () => settleWrite(await updateSetupRecord(setupActor(context), input.entityKey, body)),
      });
      return { ok: true, replayed: outcome.replayed, entityKey: input.entityKey, ...outcome.value, href: `/admin/setup/${input.entityKey}` };
    },
  }),
  definition({
    name: "delete_setup_record", title: "Delete Setup Record",
    description: "Delete (or archive, where the entity keeps history) one configuration record by id. Refuses records referenced by postings or other configuration (reported as in-use) and shared reference data. Audited.",
    inputSchema: z.object({
      entityKey: SETUP_ENTITY_KEY,
      id: z.string().min(1).max(120).describe("Id of the setup record, from list_setup_records"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false, destructive: true, openWorld: false, assistantConfirmation: "always", visibleTo: SETUP_ADMIN,
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      const outcome = await executeIdempotent({
        context, operation: "setup_record.delete", idempotencyKey: input.idempotencyKey,
        request: { entityKey: input.entityKey, id: input.id },
        execute: async () => settleWrite(await deleteSetupRecord(setupActor(context), input.entityKey, input.id)),
      });
      return { ok: true, replayed: outcome.replayed, entityKey: input.entityKey, ...outcome.value };
    },
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
