import "server-only";
import { listExtensionRuns, rehearseExtensionEndpoint } from "./extension-rehearsal";
import {
  activateExtensionDraft,
  listExtensions,
  discardExtensionDraft,
  describeExtensionVocabulary,
  draftExtension,
  getExtensionDraft,
  getExtensionPackage,
} from "./extensions";
import { z } from "zod";
import { EINVOICE_PROFILES, type EInvoiceProfileKey } from "@openbooks/engine/einvoice";
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
  submitReopenRequest,
  getCloseRun,
  listCloseRuns,
  runPeriodRevaluation,
  startApplicationCloseRun,
} from "./close";
import type { ApplicationContext } from "./context";
import {
  advanceDocumentLifecycle,
  correctPostedDocument,
  postJournalDocument,
  returnDocumentToDraftAction,
  retryDocumentPostingEffects,
  withdrawDocumentAction,
  voidDocument,
} from "./documents";
import {
  applyDocumentPromotionAction,
  correctPurchaseReceiptRemainder,
  getDocumentSupplyEvidence,
  issueDocumentEInvoice,
  listVendorBillMatchCandidates,
  matchVendorBillLinesAction,
  recordDocumentSupplyEvidence,
} from "./document-actions";
import { createPayment, postPayment, updatePayment } from "./payments";
import { assertCabinetUploadAccess, uploadCabinetFile } from "./files";
import { withContentDigest } from "./idempotency-core";
import {
  createApplicationRecord,
  deleteApplicationRecord,
  getRecord,
  listRecords,
  listRecordTypes,
  updateApplicationRecord,
  applicationRecordHref,
  applicationDocumentHref,
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
import { db } from "@openbooks/engine/platform/db";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { FEATURES, featureEnabled, resolvedFeatureState, type FeatureState } from "../features";
import { applyFeatureChanges, normalizeFeatureChanges } from "../features-admin";
import { readCompanySettings, updateCompanySettings } from "../company-settings";
import { createSetupRecord, deleteSetupRecord, updateSetupRecord } from "../setup/write";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, forbidden, invalidInput, notFound } from "./errors";
import { executeIdempotent } from "./idempotency";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { MIGRATION_APPLICATION_TOOLS } from "./migration-tools";
import { LEDGER_APPLICATION_TOOLS } from "./ledger-tools";
import { TREASURY_APPLICATION_TOOLS } from "./treasury-tools";
import { CAPITAL_APPLICATION_TOOLS } from "./capital-tools";
import { SALES_APPLICATION_TOOLS } from "./sales-tools";
import { PURCHASING_APPLICATION_TOOLS } from "./purchasing-tools";
import { INVENTORY_APPLICATION_TOOLS } from "./inventory-tools";
import { MANUFACTURING_APPLICATION_TOOLS } from "./manufacturing-tools";
import { SUBSCRIPTION_APPLICATION_TOOLS } from "./subscription-tools";
import { PROJECT_APPLICATION_TOOLS } from "./project-tools";
import { TIME_APPLICATION_TOOLS } from "./time-tools";
import { HRM_APPLICATION_TOOLS } from "./hrm-tools";
import { TALENT_APPLICATION_TOOLS } from "./talent-tools";
import { PAYROLL_APPLICATION_TOOLS } from "./payroll-tools";
import { CRM_APPLICATION_TOOLS } from "./crm-tools";
import { ADMIN_APPLICATION_TOOLS } from "./admin-tools";
import { WORKSPACE_APPLICATION_TOOLS } from "./workspace-tools";
import { convertApplicationOrder, issueApplicationOrder } from "./orders";
import {
  createCustomRecordType,
  deleteCustomRecordType,
  getCustomRecordTypeDefinition,
  listCustomRecordTypeDefinitions,
  transitionCustomRecordType,
  updateCustomRecordType,
} from "./custom-record-types";

export type { ApplicationToolConfirmation, ApplicationToolDefinition } from "./tool-definition";

/**
 * Stable-UUID tool input. A plain regex (not `.uuid()`) on purpose: `.uuid()`
 * emits `format: uuid` into the provider JSON Schema, which strict providers
 * reject, while the equivalent `pattern` is accepted. The class is written
 * through the house UUID_RE, which carries no case-insensitive flag because
 * JSON Schema patterns carry no flags.
 */
const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from a list_, find_, or get_ tool; never invent one.");
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date (YYYY-MM-DD).");
const TYPE_KEY = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(100)
  .describe("Record type key from list_record_types.");
const MONEY = z
  .string()
  .regex(/^\d+(?:\.\d{1,4})?$/)
  .describe("Positive exact decimal, at most four places.");
const SIGNED_MONEY = z
  .string()
  .regex(/^-?\d+(?:\.\d{1,4})?$/)
  .describe("Exact decimal, at most four places; negative allowed.");
const RATE = z
  .string()
  .regex(/^\d+(?:\.\d{1,10})?$/)
  .describe("Positive exact decimal rate, at most ten places.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const ROUTE = z
  .string()
  .regex(/^\/[A-Za-z0-9._\-/\[\]()]*$/)
  .max(120)
  .describe(
    "Next.js route PATTERN the layout replaces, e.g. /banking or /apps/[key]. Never a concrete url.",
  );
const ROUTE_PARAMS = z
  .record(z.string(), z.string())
  .optional()
  .describe(
    "Values for the route's dynamic segments, keyed as the route names them, used to load its data for checking.",
  );
const ROUTE_SEARCH_PARAMS = z
  .record(z.string(), z.string())
  .optional()
  .describe("Query string to load the page data with when checking bound fields.");
const LAYOUT_SPEC = z
  .unknown()
  .describe("A ViewSpec PageSpec document; call validate_page_layout first.");
const EXTENSION_KEY = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .max(64)
  .describe("App package key, e.g. equipment-checks.");
const CUSTOM = z
  .record(z.string(), z.unknown())
  .describe("Field values by the record type's camelCase field keys.");
const DOCUMENT_REVISION = z
  .string()
  .regex(
    new RegExp(DOCUMENT_REVISION_PATTERN),
    "must be the exact persisted document updated_at token",
  )
  .describe(DOCUMENT_REVISION_DESCRIPTION);
const RECORD_UPDATE_BODY = z
  .object({
    expectedUpdatedAt: DOCUMENT_REVISION.optional(),
  })
  .catchall(z.unknown())
  .describe("Partial update; documents must copy expectedUpdatedAt verbatim from a read.");
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
const EINVOICE_PROFILE = z.enum(
  Object.keys(EINVOICE_PROFILES) as [EInvoiceProfileKey, ...EInvoiceProfileKey[]],
);

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

const updateRecordSchema = z
  .object({
    typeKey: TYPE_KEY,
    id: UUID,
    body: RECORD_UPDATE_BODY,
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .superRefine((input, context) => {
    const writerKind = RECORD_TYPE_BY_KEY.get(input.typeKey)?.writer.kind;
    if (writerKind === "document" && input.body.expectedUpdatedAt === undefined) {
      context.addIssue({
        code: "custom",
        path: ["body", "expectedUpdatedAt"],
        message: "required for document updates; copy the exact updated_at returned by a read",
      });
    }
    if (
      writerKind === "custom_record" &&
      (input.body as { data?: unknown }).data !== undefined &&
      input.body.expectedUpdatedAt === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["body", "expectedUpdatedAt"],
        message:
          "required for custom-record data updates; copy the exact updated_at returned by a read",
      });
    }
  })
  .meta({
    allOf: [
      {
        if: {
          properties: { typeKey: { enum: DOCUMENT_RECORD_TYPE_KEYS } },
          required: ["typeKey"],
        },
        then: {
          properties: { body: { required: ["expectedUpdatedAt"] } },
        },
      },
    ],
  });

const paymentPatchSchema = z.object({
  partyId: UUID.nullable().optional(),
  bankAccountId: UUID.nullable().optional(),
  documentDate: DATE.optional(),
  referenceNumber: z.string().max(200).nullable().optional(),
  memo: z.string().max(2000).nullable().optional(),
  allocations: z.array(allocationSchema).max(1000).optional(),
  creditAllocations: z
    .array(
      z.object({
        fromLineId: UUID,
        toLineId: UUID,
        amount: MONEY,
        sourceDocumentId: UUID,
      }),
    )
    .max(1000)
    .optional(),
  discountAmount: MONEY.optional(),
  discountAccountId: UUID.nullable().optional(),
  controlAccountId: UUID.nullable().optional(),
  feeAmount: MONEY.optional(),
  feeIncomeAccountId: UUID.nullable().optional(),
});

const anyPermission =
  (...permissions: string[]) =>
  (authz: Authz): boolean =>
    permissions.some((permission) => can(authz, permission));
const hasPermission =
  (permission: string) =>
  (authz: Authz): boolean =>
    can(authz, permission);

/**
 * Map a transport-neutral write outcome ({ status, body }) from the settings
 * and setup command layers onto the application error contract. 2xx returns
 * the body; every refusal becomes the same typed ApplicationError the route
 * would have answered with, so chat and MCP see one failure shape. Exported
 * for the public v1 REST adapters, which share the same mapping.
 */
export function settleWrite(result: {
  status: number;
  body: Record<string, unknown>;
}): Record<string, unknown> {
  if (result.status < 300) return result.body;
  const message =
    typeof result.body.message === "string"
      ? result.body.message
      : typeof result.body.error === "string"
        ? result.body.error
        : "request refused";
  const details = result.body;
  switch (result.status) {
    case 403:
      throw new ApplicationError("forbidden", "forbidden", 403, details);
    case 404:
      throw new ApplicationError("not_found", message, 404, details);
    case 405:
      throw new ApplicationError("unsupported_operation", message, 405, details);
    case 409:
      throw new ApplicationError("conflict", message, 409, details);
    default:
      throw new ApplicationError("invalid_input", message, 422, details);
  }
}

const SETUP_ENTITY_KEY = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(80)
  .describe(
    "Setup entity key from list_setup_entities, e.g. tax-codes, departments, payment-terms.",
  );
const SETUP_BODY = z
  .record(z.string(), z.unknown())
  .describe(
    "Field values keyed by the entity's field keys (camelCase, as list_setup_entities describes them).",
  );
const SETUP_ADMIN = hasPermission("admin.setup.manage");
const setupActor = (context: ApplicationContext) => ({
  orgId: context.authz.user.orgId,
  id: context.authz.user.id,
  permissions: context.authz.permissions,
  allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
});

const visible = (): boolean => true;
const documentActor = anyPermission(
  "gl.post",
  "ap.create",
  "ap.post",
  "ar.create",
  "ar.post",
  "ap.pay",
  "ar.pay",
);

/**
 * Canonical external capability catalog. MCP and the in-app assistant are
 * adapters over these definitions; all mutations terminate in application
 * services, never transport-specific database code.
 */
export const APPLICATION_TOOLS: readonly ApplicationToolDefinition[] = [
  definition({
    name: "get_vitals",
    title: "Get Vitals",
    description:
      "One org snapshot from the screen resolvers: cash and runway, AR/AP outstanding and aging, pending approvals, latest close run. Unreadable sections return available:false with reason; absent is never zero.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visible,
    execute: async (context) => ({ ok: true, ...(await orgVitals(context)) }),
  }),
  definition({
    name: "list_record_types",
    title: "List Record Types",
    description:
      "List record types and live read/write fields this actor may use, including update-only requirements and tenant-defined custom records.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visible,
    execute: async (context) => ({ ok: true, recordTypes: await listRecordTypes(context) }),
  }),
  definition({
    name: "list_custom_record_type_definitions",
    title: "List Custom Record Type Definitions",
    description:
      "List draft, published, and archived custom record definitions, including field sections and subsidiary-scoped record counts. Use the id to inspect or change a definition.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("records.manage_types"),
    execute: async (context) => ({
      ok: true,
      types: await listCustomRecordTypeDefinitions(context),
    }),
  }),
  definition({
    name: "get_custom_record_type_definition",
    title: "Get Custom Record Type Definition",
    description:
      "Get one custom record definition, including its status, editable FormSection fields, and exact updated_at token. Find its id with list_custom_record_type_definitions.",
    inputSchema: z.object({ id: UUID.describe("Custom record type id from the definition list.") }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("records.manage_types"),
    execute: async (context, input) => ({
      ok: true,
      ...settleWrite(await getCustomRecordTypeDefinition(context, input.id)),
    }),
  }),
  definition({
    name: "create_custom_record_type",
    title: "Create Custom Record Type",
    description:
      "Create an unsaved custom record definition as a draft. Supply its display name and FormSection field structure; use list_custom_record_type_definitions to verify the new id.",
    inputSchema: z.object({
      name: z.string().trim().min(1).max(200).describe("Singular record type name."),
      pluralName: z
        .string()
        .max(200)
        .optional()
        .describe("Plural label; defaults to the name plus s."),
      key: z
        .string()
        .max(64)
        .optional()
        .describe("Optional lowercase URL key; if omitted, one is derived from the name."),
      iconKey: z
        .string()
        .max(32)
        .optional()
        .describe("Optional lowercase icon key; defaults to grid."),
      description: z
        .string()
        .max(2000)
        .nullable()
        .optional()
        .describe("Optional purpose shown to users."),
      fields: z
        .array(CUSTOM)
        .max(100)
        .optional()
        .describe("FormSection definitions that describe custom fields and repeating groups."),
      showInNav: z
        .boolean()
        .optional()
        .describe("Whether the published type appears in navigation."),
      allowedRoles: z
        .array(z.string().min(1).max(100))
        .max(50)
        .nullable()
        .optional()
        .describe("Optional role audience for the type."),
      sortOrder: z
        .number()
        .int()
        .min(-100000)
        .max(100000)
        .optional()
        .describe("Navigation sort order."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("records.manage_types"),
    authorizeReplay: async (context) =>
      assertApplicationPermission(context, "records.manage_types"),
    execute: async (context, input) => {
      const { idempotencyKey, ...body } = input;
      const created = settleWrite(await createCustomRecordType(context, body, idempotencyKey));
      const id = String(created.id);
      return {
        ok: true,
        ...created,
        status: "draft",
        href: `/records/types?type=${encodeURIComponent(id)}`,
      };
    },
  }),
  definition({
    name: "update_custom_record_type",
    title: "Update Custom Record Type",
    description:
      "Update a draft or published custom record definition with optimistic concurrency. Copy expectedUpdatedAt exactly from get_custom_record_type_definition.",
    inputSchema: z.object({
      id: UUID.describe("Custom record type id from the definition list."),
      expectedUpdatedAt: DOCUMENT_REVISION,
      allowedRoles: z
        .array(z.string().min(1).max(100))
        .max(50)
        .nullable()
        .optional()
        .describe("Replace the role audience."),
      description: z.string().max(2000).optional().describe("Replace the type description."),
      fields: z
        .array(CUSTOM)
        .max(100)
        .optional()
        .describe("Replace the complete FormSection field structure."),
      iconKey: z.string().max(32).optional().describe("Replace the lowercase icon key."),
      key: z
        .string()
        .max(64)
        .optional()
        .describe("Change the URL key while the type is still a draft."),
      name: z.string().max(200).optional().describe("Replace the singular name."),
      pluralName: z.string().max(200).optional().describe("Replace the plural label."),
      showInNav: z.boolean().optional().describe("Replace the navigation visibility flag."),
      sortOrder: z
        .number()
        .int()
        .min(-100000)
        .max(100000)
        .optional()
        .describe("Replace the navigation sort order."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("records.manage_types"),
    authorizeReplay: async (context) =>
      assertApplicationPermission(context, "records.manage_types"),
    execute: async (context, input) => {
      const { id, idempotencyKey: _idempotencyKey, ...body } = input;
      const updated = settleWrite(await updateCustomRecordType(context, id, body));
      return { ok: true, ...updated, href: `/records/types?type=${encodeURIComponent(id)}` };
    },
  }),
  definition({
    name: "delete_custom_record_type",
    title: "Delete Custom Record Type",
    description:
      "Delete a draft custom record type only when it has no records. Published types must be archived; find the id with list_custom_record_type_definitions.",
    inputSchema: z.object({
      id: UUID.describe("Draft custom record type id."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("records.manage_types"),
    authorizeReplay: async (context) =>
      assertApplicationPermission(context, "records.manage_types"),
    execute: async (context, input) => ({
      ok: true,
      id: input.id,
      ...settleWrite(await deleteCustomRecordType(context, input.id)),
      href: "/records/types",
    }),
  }),
  definition({
    name: "publish_custom_record_type",
    title: "Publish Custom Record Type",
    description:
      "Publish a lint-clean draft or archived custom record type after adding at least one valid field. Include an audit reason and find the id with list_custom_record_type_definitions.",
    inputSchema: z.object({
      id: UUID.describe("Draft or archived custom record type id."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Reason recorded in the immutable audit event."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("records.manage_types"),
    authorizeReplay: async (context) =>
      assertApplicationPermission(context, "records.manage_types"),
    execute: async (context, input) => ({
      ok: true,
      ...settleWrite(await transitionCustomRecordType(context, input.id, "publish", input.reason)),
      id: input.id,
      href: `/records/types?type=${encodeURIComponent(input.id)}`,
    }),
  }),
  definition({
    name: "archive_custom_record_type",
    title: "Archive Custom Record Type",
    description:
      "Archive a published custom record type while retaining its records and audit history. Include an audit reason and find the id with list_custom_record_type_definitions.",
    inputSchema: z.object({
      id: UUID.describe("Published custom record type id."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Reason recorded in the immutable audit event."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("records.manage_types"),
    authorizeReplay: async (context) =>
      assertApplicationPermission(context, "records.manage_types"),
    execute: async (context, input) => ({
      ok: true,
      ...settleWrite(await transitionCustomRecordType(context, input.id, "archive", input.reason)),
      id: input.id,
      href: `/records/types?type=${encodeURIComponent(input.id)}`,
    }),
  }),
  definition({
    name: "list_records",
    title: "List Records",
    description:
      "List one authorized record type with tenant, search, pagination, and subsidiary restrictions enforced. Document and custom-record updated_at values retain their exact persisted revision.",
    inputSchema: z.object({
      typeKey: TYPE_KEY,
      query: z
        .string()
        .max(200)
        .optional()
        .describe("Free-text match against the record's searchable fields"),
      page: z.number().int().min(1).max(10_000).optional().describe("Page number (default 1)"),
      perPage: z.number().int().min(5).max(100).optional().describe("Rows per page (default 25)"),
      subsidiaryId: UUID.optional(),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visible,
    execute: async (context, input) => ({ ok: true, ...(await listRecords(context, input)) }),
  }),
  definition({
    name: "get_record",
    title: "Get Record",
    description:
      "Get one authorized record by stable UUID with tenant, type, and subsidiary controls enforced. Copy a document's (or a custom record's, when replacing data) exact updated_at verbatim when updating it.",
    inputSchema: z.object({ typeKey: TYPE_KEY, id: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visible,
    execute: async (context, input) => ({ ok: true, record: await getRecord(context, input) }),
  }),
  definition({
    name: "create_record",
    title: "Create Record",
    description: "Create a record through its authoritative domain writer and validation controls.",
    inputSchema: z.object({ typeKey: TYPE_KEY, body: CUSTOM, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: visible,
    execute: async (context, input) => {
      const outcome = await createApplicationRecord(context, input);
      const href = applicationRecordHref(input.typeKey, outcome.result);
      return {
        ok: true,
        ...outcome,
        ...(href ? { href } : {}),
      };
    },
  }),
  definition({
    name: "update_record",
    title: "Update Record",
    description:
      "Update a record through its domain writer. Documents (and data-replacing custom records) require expectedUpdatedAt copied verbatim from get_record; never generate or reformat it.",
    inputSchema: updateRecordSchema,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: visible,
    execute: async (context, input) => {
      const outcome = await updateApplicationRecord(context, input);
      const href = applicationRecordHref(input.typeKey, outcome.result, input.id);
      return {
        ok: true,
        ...outcome,
        ...(href ? { href } : {}),
      };
    },
  }),
  definition({
    name: "delete_record",
    title: "Delete Record",
    description:
      "Delete an authorized record only when domain lifecycle and referential-integrity controls permit it.",
    inputSchema: z.object({ typeKey: TYPE_KEY, id: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: visible,
    execute: async (context, input) => ({
      ok: true,
      ...(await deleteApplicationRecord(context, input)),
    }),
  }),
  definition({
    name: "describe_page_layout_vocabulary",
    title: "Describe Page Layout Vocabulary",
    description:
      "Everything a page layout may use, from the live registries: block and cell kinds with their required/optional properties, widgets with the props each reads (dashboard and presentation widgets documented), frames, and the rules layouts obey. Start here; unlisted widgets and unknown properties are refused at save.",
    inputSchema: z
      .object({
        widgets: z
          .array(z.string().max(64))
          .max(40)
          .optional()
          .describe(
            "Widget names whose prop contracts to return (presentation widgets are always documented).",
          ),
      })
      .strict(),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visible,
    execute: async (context, input) => ({
      ok: true,
      ...(await describeLayoutVocabulary(context, input as never)),
    }),
  }),
  definition({
    name: "describe_page_layout",
    title: "Describe Page Layout",
    description:
      "What a route renders today: built-in layout, org override, loader field paths with sample values. Edit the built-in; unknown paths render blank. Runs under your permissions.",
    inputSchema: z.object({
      route: ROUTE,
      params: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'Values for the route\'s dynamic segments, keyed as the route names them, e.g. { accountId: "…" } for /banking/[accountId].',
        ),
      searchParams: z
        .record(z.string(), z.string())
        .optional()
        .describe('The query string to load the page with, e.g. { period: "last-month" }.'),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visible,
    execute: async (context, input) => ({
      ok: true,
      ...(await describePageLayout(context, input as never)),
    }),
  }),
  definition({
    name: "list_page_layouts",
    title: "List Page Layouts",
    description:
      "List the routes this org has customized, with the stored layout for each. A route absent from this list renders its built-in layout.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visible,
    execute: async (context) => ({ ok: true, ...(await listLayouts(context)) }),
  }),
  definition({
    name: "validate_page_layout",
    title: "Validate Page Layout",
    description:
      "Check a draft layout without storing it. Returns field-level errors — an unknown widget or property is named, a missing required property is pointed at, and a bound field the page data lacks is reported with the nearest real path. Iterate here rather than against set_page_layout.",
    inputSchema: z
      .object({
        spec: LAYOUT_SPEC,
        route: ROUTE.optional().describe(
          "Route the layout is for (defaults to spec.route). When known, every bound field is checked against that page's data for you.",
        ),
        params: ROUTE_PARAMS,
        searchParams: ROUTE_SEARCH_PARAMS,
      })
      .strict(),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visible,
    execute: async (context, input) => ({
      ok: true,
      ...(await validateLayout(context, input as never)),
    }),
  }),
  definition({
    name: "preview_page_layout",
    title: "Preview Page Layout",
    description:
      "Stage a draft layout for a private expiring preview url of the real page. Show it before set_page_layout goes live org-wide.",
    inputSchema: z
      .object({
        route: ROUTE,
        spec: LAYOUT_SPEC,
        params: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Values for the route\'s dynamic segments, e.g. { key: "inventory" } for /apps/[key].',
          ),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .strict(),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visible,
    execute: async (context, input) => ({
      ok: true,
      ...(await previewLayout(context, input as never)),
    }),
  }),
  definition({
    name: "set_page_layout",
    title: "Set Page Layout",
    description:
      "Replace what a route renders (org-wide, or just you with scope user). The route must be one a page declares and every bound field must exist in that page's data; rejections return errors, never store.",
    inputSchema: z
      .object({
        route: ROUTE,
        spec: LAYOUT_SPEC,
        idempotencyKey: IDEMPOTENCY_KEY,
        note: z
          .string()
          .max(500)
          .optional()
          .describe("Human-readable reason for this layout change, stored in history"),
        scope: z
          .enum(["org", "user"])
          .optional()
          .describe("org (default) changes the page for everyone; user stores it for you alone."),
        params: ROUTE_PARAMS,
        searchParams: ROUTE_SEARCH_PARAMS,
      })
      .strict(),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: visible,
    execute: async (context, input) => ({ ok: true, ...(await setLayout(context, input)) }),
  }),
  definition({
    name: "list_page_layout_history",
    title: "List Page Layout History",
    description:
      "Every layout ever saved for a route, newest first, with its layer, who saved it and the note given at save. A save deactivates its predecessor rather than deleting it, so this is how an edit gets undone after the fact. includeSpecs returns each version's document for comparison.",
    inputSchema: z
      .object({
        route: ROUTE,
        includeSpecs: z
          .boolean()
          .optional()
          .describe("Include each version's stored layout document."),
      })
      .strict(),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visible,
    execute: async (context, input) => ({
      ok: true,
      ...(await listLayoutHistory(context, input as never)),
    }),
  }),
  definition({
    name: "restore_page_layout",
    title: "Restore Page Layout",
    description:
      "Republish a past layout version by its list_page_layout_history id, into the layer (org or user) it was saved in. Appends a new active version; history stays a true live-record.",
    inputSchema: z
      .object({
        route: ROUTE,
        versionId: UUID.describe("The version id from list_page_layout_history"),
        idempotencyKey: IDEMPOTENCY_KEY,
        scope: z
          .enum(["org", "user"])
          .optional()
          .describe("Defaults to the layer the version was saved in."),
      })
      .strict(),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: visible,
    execute: async (context, input) => ({
      ok: true,
      ...(await restoreLayout(context, input as never)),
    }),
  }),
  definition({
    name: "clear_page_layout",
    title: "Clear Page Layout",
    description:
      "Drop a layout for a route so the page returns to what it would otherwise render. The stored layout is deactivated, not destroyed.",
    inputSchema: z.object({
      route: ROUTE,
      idempotencyKey: IDEMPOTENCY_KEY,
      scope: z
        .enum(["org", "user"])
        .optional()
        .describe("org (default) changes the page for everyone; user stores it for you alone."),
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: visible,
    execute: async (context, input) => ({ ok: true, ...(await clearLayout(context, input)) }),
  }),
  definition({
    name: "list_app_packages",
    title: "List Apps",
    featureKey: "apps",
    description:
      "List this organization's app packages, their active versions, status, management and workspace links.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visible,
    execute: async (context) => ({ ok: true, ...(await listExtensions(context)) }),
  }),
  definition({
    name: "describe_app_vocabulary",
    title: "Describe App Capabilities",
    featureKey: "apps",
    description:
      "Start here to build an app. Returns the native screen and package contract, governed objects and backend capabilities, an example, and the draft → preview → approve workflow.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visible,
    execute: async (context) => ({ ok: true, ...(await describeExtensionVocabulary(context)) }),
  }),
  definition({
    name: "draft_app",
    title: "Prepare App Draft",
    featureKey: "apps",
    description:
      "Save an immutable unpublished app package (no install, objects, execution, or activation). Returns review/preview urls and content hash. Revisions are new drafts.",
    inputSchema: z.object({
      bundle: z
        .unknown()
        .describe("Complete app package bundle: owned definitions and files the draft installs."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Honest human-readable reason for this draft"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visible,
    execute: async (context, input) => ({
      ok: true,
      ...(await draftExtension(context, input as never)),
    }),
  }),
  definition({
    name: "get_app_draft",
    title: "Read App Draft",
    featureKey: "apps",
    description:
      "Read this author's exact unpublished package, base version and hash for revision or review. Other authors' drafts are unavailable.",
    inputSchema: z.object({ draftId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visible,
    execute: async (context, input) => ({
      ok: true,
      draft: await getExtensionDraft(context, input.draftId as string),
    }),
  }),
  definition({
    name: "get_app_package",
    title: "Read Installed App Package",
    featureKey: "apps",
    description:
      "Read the installed package or one of its historical versions before preparing an upgrade or rollback. Preserve owned object definitions and use a new version label, then draft and review it.",
    inputSchema: z.object({ key: EXTENSION_KEY, versionId: UUID.optional() }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visible,
    execute: async (context, input) => ({
      ok: true,
      ...(await getExtensionPackage(context, input as never)),
    }),
  }),
  definition({
    name: "discard_app_draft",
    title: "Discard App Draft",
    featureKey: "apps",
    description:
      "Discard this author's unpublished draft while preserving its source and audit evidence. Activated versions cannot be discarded.",
    inputSchema: z.object({
      draftId: UUID,
      contentHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .describe(
          "Exact content hash the draft call returned; guards against stale-base activation",
        ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visible,
    execute: async (context, input) => ({
      ok: true,
      ...(await discardExtensionDraft(context, input as never)),
    }),
  }),
  definition({
    name: "activate_app_draft",
    title: "Activate Reviewed Extension",
    featureKey: "apps",
    description:
      "Activate the exact reviewed, approved author draft (bind draftId and contentHash). Refuses stale bases or missing permissions. Atomic commit.",
    inputSchema: z.object({
      draftId: UUID,
      contentHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .describe(
          "Exact content hash the draft call returned; guards against stale-base activation",
        ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: visible,
    execute: async (context, input) => ({
      ok: true,
      ...(await activateExtensionDraft(context, input as never)),
    }),
  }),
  definition({
    name: "test_app_endpoint",
    title: "Rehearse App Endpoint",
    featureKey: "apps",
    description:
      "Run one backend endpoint of a draft (draftId) or the installed app (key) exactly as production would — sandbox, unit budget, grants ∩ your permissions, the draft's own record types and settings — then roll everything back. Returns the response or refusal, ob.log lines and units. Nothing persists. Use before activate_app_draft.",
    inputSchema: z
      .object({
        draftId: UUID.optional().describe(
          "Rehearse this unpublished draft (installed inside the rolled-back transaction).",
        ),
        key: EXTENSION_KEY.optional().describe("Or rehearse the installed app's active version."),
        endpoint: z.string().min(1).max(64).describe("Endpoint name from manifest.endpoints."),
        body: z
          .unknown()
          .optional()
          .describe(
            "Request body as the caller sends it. Native action screens send { input: { <field id>: value }, invocationId }.",
          ),
      })
      .strict(),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visible,
    execute: async (context, input) => ({
      ok: true,
      ...(await rehearseExtensionEndpoint(context, input as never)),
    }),
  }),
  definition({
    name: "list_app_runs",
    title: "List App Runs",
    featureKey: "apps",
    description:
      "Recent backend invocations of an installed app, newest first: endpoint, status, refusal message, ob.log lines, units, duration and who triggered it.",
    inputSchema: z
      .object({
        key: EXTENSION_KEY.describe("Installed app key from list_app_packages."),
        endpoint: z.string().min(1).max(64).optional().describe("Only runs of this endpoint."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Most recent runs to return (default 20)."),
      })
      .strict(),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visible,
    execute: async (context, input) => ({
      ok: true,
      ...(await listExtensionRuns(context, input as never)),
    }),
  }),
  definition({
    name: "list_approvals",
    title: "List Approvals",
    description:
      "List pending approval gates this actor may decide directly, through a role, or through an active delegation.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("flows.approve"),
    execute: async (context) => ({ ok: true, approvals: await listApprovalWorklist(context) }),
  }),
  definition({
    name: "decide_approval",
    title: "Decide Approval",
    description:
      "Approve or reject one visible pending gate with assignment, quorum, segregation-of-duties, and signature controls.",
    inputSchema: z.object({
      gateId: UUID,
      decision: z.enum(["approved", "rejected"]).describe("The approval decision"),
      comment: z
        .string()
        .trim()
        .max(2000)
        .optional()
        .describe("Decision rationale recorded on the gate"),
      signature: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe("Signature text where the gate requires one"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: hasPermission("flows.approve"),
    execute: async (context, input) => ({ ok: true, ...(await decideApproval(context, input)) }),
  }),
  definition({
    name: "list_close_runs",
    title: "List Close Runs",
    description: "List period-close runs visible within the actor's subsidiary scope.",
    inputSchema: z.object({
      status: z
        .enum(["in_progress", "pending_approval", "approved", "closed", "published", "cancelled"])
        .optional()
        .describe("Only runs in this lifecycle status"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum runs to return (default 50)"),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("close.run"),
    execute: async (context, input) => ({ ok: true, runs: await listCloseRuns(context, input) }),
  }),
  definition({
    name: "get_close_run",
    title: "Get Close Run",
    description: "Get one period-close run after tenant and subsidiary-scope checks.",
    inputSchema: z.object({ runId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("close.run"),
    execute: async (context, input) => ({ ok: true, run: await getCloseRun(context, input.runId) }),
  }),
  definition({
    name: "start_close_run",
    title: "Start Close Run",
    description:
      "Start or resume the authoritative period-close checklist for an explicit period, book, and subsidiary scope.",
    inputSchema: z.object({
      periodId: UUID,
      bookId: UUID,
      blueprintId: UUID.optional(),
      reportingPackageId: UUID.optional(),
      targetCloseDate: DATE.optional(),
      subsidiaryIds: z
        .array(UUID)
        .max(500)
        .optional()
        .describe("Close scope: omit for the whole org"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("close.run"),
    execute: async (context, input) => ({
      ok: true,
      ...(await startApplicationCloseRun(context, input)),
    }),
  }),
  ...(["refresh", "request_approval", "close", "publish"] as const).map((action) => {
    const names = {
      refresh: ["refresh_close_run", "Refresh Close Run"],
      request_approval: ["request_close_approval", "Request Close Approval"],
      close: ["close_period", "Close Period"],
      publish: ["publish_close_package", "Publish Close Package"],
    } as const;
    return definition({
      name: names[action][0],
      title: names[action][1],
      description:
        action === "publish"
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
      visibleTo: hasPermission(action === "close" ? "close.approve" : "close.run"),
      execute: async (context, input) => ({
        ok: true,
        ...(await advanceCloseRun(context, { ...input, action })),
      }),
    });
  }),
  definition({
    name: "request_period_reopen",
    title: "Request Period Reopen",
    description:
      "Create an independently approved, time-bounded request to reopen explicit period modules.",
    inputSchema: z.object({
      periodId: UUID,
      bookId: UUID,
      subsidiaryId: UUID.optional(),
      modules: z
        .array(CLOSE_MODULE)
        .min(1)
        .max(6)
        .describe("Period modules to reopen (ar, ap, banking, assets, tax, gl)"),
      reason: z.string().trim().min(5).max(2000).describe("Business reason for the reopen request"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("close.reopen"),
    execute: async (context, input) => ({
      ok: true,
      ...(await createReopenRequest(context, input)),
    }),
  }),
  definition({
    name: "submit_period_reopen",
    title: "Submit Period Reopen",
    description:
      "Submit the requester’s period reopen through tenant Flows. Configured gates hold reopening; zero gates release the bounded access window.",
    inputSchema: z.object({
      requestId: UUID,
      hours: z
        .number()
        .int()
        .min(1)
        .max(168)
        .optional()
        .describe("Approved access window in hours"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("close.reopen"),
    execute: async (context, input) => ({
      ok: true,
      ...(await submitReopenRequest(context, input)),
    }),
  }),
  definition({
    name: "run_revaluation",
    title: "Run FX Revaluation",
    description:
      "Period-end unrealized FX revaluation: restate foreign balances to spot, booking gain/loss plus next-period mirror. Reruns book incremental corrections only. Needs multi-currency and a gain/loss account.",
    inputSchema: z.object({
      periodId: UUID,
      bookId: UUID.optional(),
      subsidiaryIds: z
        .array(UUID)
        .min(1)
        .max(1000)
        .optional()
        .describe(
          "Selected legal entities, within the caller’s close scope; omitted uses the caller’s whole scope",
        ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("close.run"),
    featureKey: "multiCurrency",
    execute: async (context, input) => ({
      ok: true,
      ...(await runPeriodRevaluation(context, input)),
    }),
  }),
  ...(["submit", "post"] as const).map((action) =>
    definition({
      name: `${action}_document`,
      title: `${action === "submit" ? "Submit" : "Post"} Document`,
      description:
        action === "submit"
          ? "Submit a draft document into its authoritative approval workflow."
          : "Post an approved document through the accounting kernel; a draft is submitted first and may return pending approval.",
      inputSchema: z.object({ documentId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
      readOnly: false,
      destructive: false,
      openWorld: false,
      assistantConfirmation: "always",
      visibleTo: documentActor,
      execute: async (context, input) => {
        const outcome = await advanceDocumentLifecycle(context, { ...input, action });
        const document = (outcome.result as { document?: { kind?: string } } | null)?.document;
        return {
          ok: true,
          ...outcome,
          ...(document?.kind
            ? { href: applicationDocumentHref(document.kind, input.documentId) }
            : {}),
        };
      },
    }),
  ),
  definition({
    name: "list_vendor_bill_match_candidates",
    title: "List Vendor Bill Match Candidates",
    description:
      "List unmatched stocked bill lines and approved purchase order lines with open quantity for a vendor bill. Find the bill id with get_record before matching its lines.",
    inputSchema: z.object({
      documentId: UUID.describe("Vendor bill id from get_record."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("ap.read"),
    execute: async (context, input) => ({
      ok: true,
      ...(await listVendorBillMatchCandidates(context, input.documentId)),
    }),
  }),
  definition({
    name: "get_document_supply_evidence",
    title: "Get Document Supply Evidence",
    description:
      "Read the cross-border supply election, saved country evidence, and correction link for a customer invoice or credit. Find the document id with get_record.",
    inputSchema: z.object({
      documentId: UUID.describe("Customer invoice or credit id from get_record."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "crossBorderTax",
    visibleTo: hasPermission("ar.read"),
    execute: async (context, input) => ({
      ok: true,
      ...(await getDocumentSupplyEvidence(context, input.documentId)),
    }),
  }),
  definition({
    name: "return_document_to_draft",
    title: "Return Document to Draft",
    description:
      "Return an approved, never-posted document to draft when its kind supports that transition. Find the document id and exact revision token with get_record.",
    inputSchema: z.object({
      documentId: UUID.describe("Document id from get_record or list_records."),
      reason: z
        .string()
        .trim()
        .min(5)
        .max(500)
        .describe("Reason recorded for returning the document."),
      expectedUpdatedAt: DOCUMENT_REVISION.optional(),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: documentActor,
    execute: async (context, input) => {
      const outcome = await returnDocumentToDraftAction(context, input);
      const result = outcome.result as { kind: string; documentId: string };
      return {
        ok: true,
        ...outcome,
        href: applicationDocumentHref(result.kind, result.documentId),
      };
    },
  }),
  definition({
    name: "withdraw_document_submission",
    title: "Withdraw Document Submission",
    description:
      "Withdraw the caller's pending submission or an approver's assigned request. Find the document id and exact revision token with get_record.",
    inputSchema: z.object({
      documentId: UUID.describe("Document id from get_record or list_records."),
      reason: z.string().trim().min(5).max(500).describe("Reason recorded for withdrawal."),
      expectedUpdatedAt: DOCUMENT_REVISION.optional(),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: documentActor,
    execute: async (context, input) => {
      const outcome = await withdrawDocumentAction(context, input);
      const result = outcome.result as { kind: string; documentId: string };
      return {
        ok: true,
        ...outcome,
        href: applicationDocumentHref(result.kind, result.documentId),
      };
    },
  }),
  definition({
    name: "retry_document_posting_effects",
    title: "Retry Document Posting Effects",
    description:
      "Retry the posting effect for a posted document only when its effect is terminally failed. Find the document id with get_record and provide the operator review reason.",
    inputSchema: z.object({
      documentId: UUID.describe("Posted document id from get_record or list_records."),
      reason: z
        .string()
        .trim()
        .min(10)
        .max(1000)
        .describe("Review reason recorded with the retry."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: documentActor,
    execute: async (context, input) => {
      const outcome = await retryDocumentPostingEffects(context, input);
      const result = outcome.result as { kind: string; documentId: string };
      return {
        ok: true,
        ...outcome,
        href: applicationDocumentHref(result.kind, result.documentId),
      };
    },
  }),
  definition({
    name: "issue_einvoice",
    title: "Issue E Invoice",
    description:
      "Issue and archive a validated electronic invoice from a posted invoice or credit. Find the document id with get_record; configure the e-invoice profile and PDF template first when required.",
    inputSchema: z.object({
      documentId: UUID.describe("Posted invoice or credit id from get_record."),
      profile: EINVOICE_PROFILE.describe("Supported electronic-invoice profile."),
      buyerReference: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .nullable()
        .optional()
        .describe("Optional buyer reference included in the issued invoice."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "einvoicing",
    visibleTo: hasPermission("documents.manage"),
    execute: async (context, input) => issueDocumentEInvoice(context, input),
  }),
  definition({
    name: "correct_receipt_remainder",
    title: "Correct Receipt Remainder",
    description:
      "Correct an unconsumed remainder or named over-received lines on a posted purchase receipt without voiding its evidence. Find the receipt and line ids with get_record.",
    inputSchema: z.object({
      documentId: UUID.describe("Purchase receipt id from get_record."),
      reason: z
        .string()
        .trim()
        .min(5)
        .max(500)
        .describe("Reason recorded for the inventory correction."),
      date: DATE.optional().describe("Business date for the correcting inventory adjustment."),
      lines: z
        .array(
          z.object({
            receiptLineId: UUID.describe("Receipt line id from get_record.lines."),
            correctedQuantity: z
              .string()
              .min(1)
              .max(50)
              .describe("Correct delivered quantity as an exact decimal string."),
          }),
        )
        .min(1)
        .max(500)
        .optional()
        .describe("Named receipt lines and their true delivered quantities."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("goods_receipts.create"),
    execute: async (context, input) => {
      const outcome = await correctPurchaseReceiptRemainder(context, input);
      return {
        ok: true,
        ...outcome,
        href: applicationDocumentHref("purchase_receipt", input.documentId),
      };
    },
  }),
  definition({
    name: "record_document_supply_evidence",
    title: "Record Document Supply Evidence",
    description:
      "Set the cross-border supply classification and collected country signals on a draft customer invoice or credit. Find the document id with get_record; evidence values must contain derived country codes, never raw network or payment data.",
    inputSchema: z.object({
      documentId: UUID.describe("Draft customer invoice or credit id from get_record."),
      election: z
        .object({
          supplyKind: z.enum(["digital_service", "goods"]).describe("Kind of supply."),
          customerKind: z.enum(["consumer", "business"]).describe("Customer classification."),
          correctsDocumentId: UUID.nullable()
            .optional()
            .describe("Posted invoice corrected by this credit, when applicable."),
        })
        .describe("Cross-border supply election."),
      evidence: z
        .array(
          z.object({
            kind: z
              .enum([
                "billing_address",
                "ip_country",
                "card_bin_country",
                "bank_country",
                "sim_country",
                "ship_to",
              ])
              .describe("Evidence signal type."),
            country: z.string().min(2).max(2).describe("ISO country code derived from the signal."),
            source: z.string().min(1).max(40).describe("Source label for the evidence."),
          }),
        )
        .max(6)
        .describe("Collected country signals."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "crossBorderTax",
    visibleTo: hasPermission("ar.create"),
    execute: async (context, input) => {
      const result = await recordDocumentSupplyEvidence(context, input);
      return {
        ok: true,
        ...result,
        href: applicationDocumentHref(result.kind, input.documentId),
      };
    },
  }),
  definition({
    name: "match_vendor_bill_lines",
    title: "Match Vendor Bill Lines",
    description:
      "Attach purchase-order provenance to stocked lines on a hand-coded vendor bill while the matching order quantity remains open. Find bill, bill-line, and purchase-order-line ids with get_record and bill-match candidates.",
    inputSchema: z.object({
      documentId: UUID.describe("Vendor bill id from get_record."),
      expectedUpdatedAt: DOCUMENT_REVISION.optional(),
      matches: z
        .array(
          z.object({
            billLineId: UUID.describe("Unmatched vendor bill line id."),
            purchaseOrderLineId: UUID.describe("Open purchase-order line id."),
          }),
        )
        .min(1)
        .max(200)
        .describe("Bill lines paired with their purchase-order lines."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "ap.read") && can(authz, "ap.create"),
    execute: async (context, input) => ({
      ...(await matchVendorBillLinesAction(context, input)),
      href: `/ap/bills?doc=${encodeURIComponent(input.documentId)}`,
    }),
  }),
  definition({
    name: "apply_document_promotion",
    title: "Apply Document Promotion",
    description:
      "Apply an active promotion to an eligible draft customer document. Find the document id with get_record and use either a promotion code or promotion id from the promotions list.",
    inputSchema: z
      .object({
        documentId: UUID.describe("Eligible draft customer document id from get_record."),
        code: z.string().max(64).optional().describe("Promotion code."),
        promotionId: UUID.optional().describe("Promotion id from the promotions list."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        (input) => Boolean(input.code || input.promotionId),
        "A promotion code or id is required",
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "promotions",
    visibleTo: hasPermission("ar.create"),
    execute: async (context, input) => {
      const result = await applyDocumentPromotionAction(context, input);
      return {
        ok: true,
        ...result,
        href: applicationDocumentHref(result.kind, input.documentId),
      };
    },
  }),
  definition({
    name: "issue_sales_order",
    title: "Issue Sales Order",
    description:
      "Issue a draft sales order after its customer, lines, and exact revision are ready; this can return pending approval. Find the id and expectedUpdatedAt with get_record.",
    inputSchema: z.object({
      documentId: UUID.describe("Draft sales-order id from get_record."),
      expectedUpdatedAt: DOCUMENT_REVISION,
      creditOverrideReason: z
        .string()
        .trim()
        .min(5)
        .max(500)
        .optional()
        .describe("Reason for a credit override when the native credit gate requires one."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "orders",
    visibleTo: hasPermission("ar.create"),
    authorizeReplay: async (context) => assertApplicationPermission(context, "ar.create"),
    execute: async (context, input) => {
      const outcome = await issueApplicationOrder(context, input);
      return {
        ok: true,
        ...outcome,
        href: applicationDocumentHref("sales_order", outcome.result.id),
      };
    },
  }),
  definition({
    name: "convert_quote",
    title: "Convert Quote",
    description:
      "Convert an approved quote into a sales order or customer invoice using only its open line quantities. Find the quote id and exact revision with get_record.",
    inputSchema: z.object({
      documentId: UUID.describe("Quote id from get_record."),
      targetKind: z
        .enum(["sales_order", "customer_invoice"])
        .describe("Downstream record kind to create."),
      expectedUpdatedAt: DOCUMENT_REVISION,
      creditOverrideReason: z
        .string()
        .trim()
        .min(5)
        .max(500)
        .optional()
        .describe("Reason for a credit override when the native credit gate requires one."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "orders",
    visibleTo: hasPermission("ar.create"),
    authorizeReplay: async (context, input) => {
      await convertApplicationOrder(context, { ...input, expectedKind: "quote" });
    },
    execute: async (context, input) => {
      const outcome = await convertApplicationOrder(context, {
        ...input,
        expectedKind: "quote",
      });
      return {
        ok: true,
        ...outcome,
        href: applicationDocumentHref(outcome.result.kind, outcome.result.id),
      };
    },
  }),
  definition({
    name: "convert_sales_order",
    title: "Convert Sales Order",
    description:
      "Convert an issued sales order into a shipment or customer invoice using only its open line quantities. Find the order id and exact revision with get_record.",
    inputSchema: z.object({
      documentId: UUID.describe("Issued sales-order id from get_record."),
      targetKind: z
        .enum(["sales_fulfillment", "customer_invoice"])
        .describe("Downstream record kind to create."),
      expectedUpdatedAt: DOCUMENT_REVISION,
      creditOverrideReason: z
        .string()
        .trim()
        .min(5)
        .max(500)
        .optional()
        .describe("Reason for a credit override when the native credit gate requires one."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "orders",
    visibleTo: hasPermission("ar.create"),
    authorizeReplay: async (context, input) => {
      await convertApplicationOrder(context, { ...input, expectedKind: "sales_order" });
    },
    execute: async (context, input) => {
      const outcome = await convertApplicationOrder(context, {
        ...input,
        expectedKind: "sales_order",
      });
      return {
        ok: true,
        ...outcome,
        href: applicationDocumentHref(outcome.result.kind, outcome.result.id),
      };
    },
  }),
  definition({
    name: "convert_purchase_order",
    title: "Convert Purchase Order",
    description:
      "Convert an approved purchase order into a goods receipt or vendor bill using only its open line quantities. Find the order id and exact revision with get_record.",
    inputSchema: z.object({
      documentId: UUID.describe("Approved purchase-order id from get_record."),
      targetKind: z
        .enum(["purchase_receipt", "vendor_bill"])
        .describe("Downstream record kind to create."),
      expectedUpdatedAt: DOCUMENT_REVISION,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "orders",
    visibleTo: anyPermission("goods_receipts.create", "ap.create"),
    authorizeReplay: async (context, input) => {
      await convertApplicationOrder(context, { ...input, expectedKind: "purchase_order" });
    },
    execute: async (context, input) => {
      const outcome = await convertApplicationOrder(context, {
        ...input,
        expectedKind: "purchase_order",
      });
      return {
        ok: true,
        ...outcome,
        href: applicationDocumentHref(outcome.result.kind, outcome.result.id),
      };
    },
  }),
  definition({
    name: "post_journal",
    title: "Post Journal",
    description:
      "Submit (if draft) and post a manual journal; drafts may return pending approval. Journals skip the generic document lifecycle.",
    inputSchema: z.object({ documentId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("gl.post"),
    execute: async (context, input) => {
      const outcome = await postJournalDocument(context, input);
      return {
        ok: true,
        ...outcome,
        href: applicationDocumentHref(outcome.kind, input.documentId),
      };
    },
  }),
  definition({
    name: "void_document",
    title: "Void Document",
    description:
      "Request a controlled void; posted documents reverse through the kernel and retained evidence is preserved.",
    inputSchema: z.object({
      documentId: UUID,
      reason: z.string().trim().min(5).max(500).describe("Reason recorded for the void"),
      reversalDate: DATE.nullable().optional(),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: documentActor,
    execute: async (context, input) => {
      const outcome = await voidDocument(context, input);
      return {
        ok: true,
        ...outcome,
        href: applicationDocumentHref(outcome.kind, input.documentId),
      };
    },
  }),
  definition({
    name: "correct_document",
    title: "Correct Posted Document",
    description:
      "Create a correcting replacement draft and request a controlled void of the posted source in one exactly-once transaction. The correction requires expectedUpdatedAt copied verbatim from the persisted source revision.",
    inputSchema: z.object({
      documentId: UUID,
      correction: correctionSchema.describe(
        "Replacement header and lines for the correcting draft",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: documentActor,
    execute: async (context, input) => {
      const outcome = await correctPostedDocument(context, input);
      const result = outcome.result as { correctionId?: string };
      return {
        ok: true,
        ...outcome,
        ...(result.correctionId
          ? { href: applicationDocumentHref(outcome.kind, result.correctionId) }
          : { href: applicationDocumentHref(outcome.kind, input.documentId) }),
      };
    },
  }),
  definition({
    name: "create_payment",
    title: "Create Payment",
    tier: "core",
    description:
      "Create a governed vendor-payment or customer-receipt draft with exact currency and subsidiary context.",
    inputSchema: z.object({
      kind: z
        .enum(["vendor_payment", "customer_payment"])
        .describe("Draft kind: vendor_payment pays a vendor, customer_payment records a receipt"),
      partyId: UUID.nullable().optional(),
      bankAccountId: UUID.nullable().optional(),
      documentDate: DATE.optional(),
      memo: z.string().max(2000).nullable().optional().describe("Memo on the payment draft"),
      subsidiaryId: UUID.nullable().optional(),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .optional()
        .describe("Three-letter currency code, e.g. CAD"),
      fxRate: RATE.optional(),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: anyPermission("ap.pay", "ar.pay"),
    execute: async (context, input) => ({
      ok: true,
      ...(await createPayment(context, input)),
    }),
  }),
  definition({
    name: "update_payment",
    title: "Update Payment",
    description: "Update a draft payment or receipt and its exact open-item allocations.",
    inputSchema: z.object({
      documentId: UUID,
      patch: paymentPatchSchema.describe(
        "Draft changes: header fields and exact open-item allocations",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: anyPermission("ap.pay", "ar.pay"),
    execute: async (context, input) => ({
      ok: true,
      ...(await updatePayment(context, input)),
    }),
  }),
  definition({
    name: "post_payment",
    title: "Post Payment",
    tier: "core",
    description:
      "Submit and post a payment or receipt with open-item applications atomically; may return pending approval.",
    inputSchema: z.object({
      documentId: UUID,
      allocations: z
        .array(allocationSchema)
        .min(1)
        .max(1000)
        .optional()
        .describe(
          "Open-item applications built from list_open_items rows; omit when nothing is applied",
        ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: anyPermission("ap.pay", "ar.pay"),
    execute: async (context, input) => ({
      ok: true,
      ...(await postPayment(context, input)),
    }),
  }),
  definition({
    name: "start_reconciliation",
    title: "Start Reconciliation",
    description:
      "Start a bank reconciliation session for an account through an explicit through-date and statement balance (one open session per account). Returns the session id; match lines with match_bank_line, then sign off.",
    inputSchema: z.object({
      accountId: UUID,
      throughDate: DATE,
      statementBalance: SIGNED_MONEY,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => ({
      ok: true,
      ...(await startReconciliationSession(context, input)),
    }),
  }),
  definition({
    name: "match_bank_line",
    title: "Match Bank Line",
    description:
      "Pair one unmatched bank line with posted journal lines totalling exactly the statement line, as a one-line group. Returns session totals (difference must reach zero).",
    inputSchema: z.object({
      reconciliationId: UUID,
      statementLineId: UUID,
      journalLineIds: z
        .array(UUID)
        .min(1)
        .max(50)
        .describe("Posted journal lines whose total must equal the statement line exactly"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => ({
      ok: true,
      ...(await matchStatementLine(context, input)),
    }),
  }),
  definition({
    name: "match_bank_line_with_journal",
    title: "Match Bank Line With Journal",
    description:
      "Create a categorizing journal from one unmatched bank line (bank leg, remainder to offset) and match it in-session. Use when no posted line explains it.",
    inputSchema: z.object({
      reconciliationId: UUID,
      statementLineId: UUID,
      offsetAccountId: UUID,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => ({
      ok: true,
      ...(await matchStatementLineWithJournal(context, input)),
    }),
  }),
  definition({
    name: "unmatch_bank_line",
    title: "Unmatch Bank Line",
    description:
      "Remove a statement line's whole match group within a reconciliation session, returning every grouped line to the unmatched queue. Signed-off sessions refuse.",
    inputSchema: z.object({
      reconciliationId: UUID,
      statementLineId: UUID,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => ({
      ok: true,
      ...(await unmatchStatementLineAction(context, input)),
    }),
  }),
  definition({
    name: "sign_off_reconciliation",
    title: "Sign Off Reconciliation",
    description:
      "Sign off a zero-difference session: stamps matched lines reconciled, closes it. Refuses nonzero difference or missing evidence. Permanent.",
    inputSchema: z.object({ reconciliationId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => ({
      ok: true,
      ...(await signOffReconciliation(context, input)),
    }),
  }),
  definition({
    name: "update_budget_cells",
    title: "Update Budget Cells",
    description:
      "Write planning cells into a draft scenario (revision-checked): exact decimal amounts keyed by account, period, subsidiary, dimensions; expectedRevision must match. Draft scenarios only. Audited.",
    inputSchema: z.object({
      scenarioId: UUID.describe("Budget scenario id from get_budget_workspace or budget_vs_actual"),
      expectedRevision: z
        .number()
        .int()
        .min(1)
        .describe(
          "Scenario revision from get_budget_workspace; the write is refused when it no longer matches",
        ),
      cells: z
        .array(
          z.object({
            accountId: UUID,
            periodId: UUID,
            subsidiaryId: UUID.nullable().optional(),
            departmentId: UUID.nullable().optional(),
            projectId: UUID.nullable().optional(),
            locationId: UUID.nullable().optional(),
            classId: UUID.nullable().optional(),
            amount: SIGNED_MONEY,
            note: z.string().max(2000).nullable().optional(),
          }),
        )
        .min(1)
        .max(1000)
        .describe(
          "Planning cells to write, keyed by account, period, subsidiary, and dimensions; at most 1000 per call",
        ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("budgets.manage"),
    featureKey: "budgets",
    execute: async (context, input) => ({ ok: true, ...(await updateBudgetCells(context, input)) }),
  }),
  definition({
    name: "get_company_settings",
    title: "Get Company Settings",
    tier: "core",
    description:
      "Company & Accounting settings as the screen shows them: identity (incl. address, legal form, tax numbers), locale, base currency, fiscal start month, frameworks, PDF style, control accounts, feature switchboard. Read-only.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: anyPermission("admin.users.manage", "admin.setup.manage"),
    execute: async (context) => {
      const orgId = context.authz.user.orgId;
      const view = settleWrite(await readCompanySettings(orgId));
      const row = (
        await db.execute<{ base_currency: string; settings: Record<string, unknown> | null }>(
          sql`
        select base_currency, settings from orgs where id = ${orgId}`,
          "objects",
        )
      )[0];
      if (!row) throw notFound("organization");
      const settings = row.settings ?? {};
      const control = (settings.controlAccounts ?? {}) as Record<string, string>;
      const ids = Object.values(control).filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      const accounts = ids.length
        ? await db.execute<{ id: string; number: string | null; name: string; type: string }>(
            sql`
            select id, number, name, type from accounts
             where org_id = ${orgId} and id in (${sql.join(
               ids.map((id) => sql`${id}`),
               sql`, `,
             )})`,
            "objects",
          )
        : [];
      const byId = new Map(accounts.map((a) => [a.id, a]));
      const features = await resolvedFeatureState(orgId);
      return {
        ok: true,
        ...view,
        accounting: {
          baseCurrency: row.base_currency,
          fiscalYearStartMonth:
            typeof settings.fiscalYearStartMonth === "number" ? settings.fiscalYearStartMonth : 1,
          reportPdfStyle: settings.reportPdfStyle ?? "modern",
          fairValueRangePolicy: settings.fairValueRangePolicy ?? null,
          controlAccounts: Object.fromEntries(
            Object.entries(control).map(([role, id]) => {
              const a = byId.get(id);
              return [
                role,
                a ? { id, number: a.number, name: a.name, type: a.type } : { id, missing: true },
              ];
            }),
          ),
        },
        features: Object.fromEntries(FEATURES.map((f) => [f.key, featureEnabled(features, f.key)])),
        href: "/admin/setup/company",
      };
    },
  }),
  definition({
    name: "update_company_settings",
    title: "Update Company Settings",
    description:
      "Change Company & Accounting settings (only passed keys change): names, locale, frameworks, PDF style, control accounts, legal identity (address {line1,line2,city,region,postalCode,country}, legalForm, taxClassification, taxIds keyed by scheme such as us_ein, ca_bn, ca_gst_hst, eu_vat). Refuses fiscal-calendar/base-currency changes with postings, invalid control accounts, malformed tax numbers and classifications the business structure cannot elect. Audited.",
    inputSchema: z.object({
      changes: z
        .record(z.string(), z.unknown())
        .describe("Settings to change, keyed by setting name (only the keys passed change)"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: SETUP_ADMIN,
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      const changes = input.changes as Record<string, unknown>;
      if (Object.keys(changes).length === 0)
        throw invalidInput("changes must name at least one setting");
      const outcome = await executeIdempotent({
        context,
        operation: "company_settings.update",
        idempotencyKey: input.idempotencyKey,
        request: { changes },
        execute: async () =>
          settleWrite(
            await updateCompanySettings(
              {
                orgId: context.authz.user.orgId,
                id: context.authz.user.id,
                allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
              },
              changes,
            ),
          ),
      });
      return { ok: true, replayed: outcome.replayed, ...outcome.value };
    },
  }),
  definition({
    name: "update_features",
    title: "Update Features",
    description:
      "Turn modules on/off (keys from list_features) via the fenced Setup command: dependencies enforced, load-bearing modules cannot disable, enabling installs baseline config. Audited; returns before/after.",
    inputSchema: z.object({
      features: z
        .record(z.string(), z.boolean())
        .describe("Feature switches to set, keyed by feature key from list_features"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: SETUP_ADMIN,
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      const normalized = normalizeFeatureChanges(input.features);
      if (!normalized.ok)
        throw invalidInput(normalized.error, normalized.key ? { key: normalized.key } : undefined);
      const outcome = await executeIdempotent({
        context,
        operation: "features.update",
        idempotencyKey: input.idempotencyKey,
        request: { features: normalized.changes },
        execute: async () => {
          const result = await applyFeatureChanges(
            context.authz.user.orgId,
            context.authz.user.id,
            normalized.changes,
          );
          if (!result.ok) {
            if (result.error === "not-found") throw notFound("organization");
            const details: Record<string, unknown> = { ...result };
            delete details.ok;
            delete details.error;
            throw conflict(result.error, details);
          }
          return { before: result.before, after: result.after };
        },
      });
      return {
        ok: true,
        replayed: outcome.replayed,
        ...outcome.value,
        href: "/admin/setup/features",
      };
    },
  }),
  definition({
    name: "create_setup_record",
    title: "Create Setup Record",
    description:
      "Create one Setup-entity record via the validated, audited Setup command. Resolve key and fields with list_setup_entities first; references take row ids.",
    inputSchema: z.object({
      entityKey: SETUP_ENTITY_KEY,
      body: SETUP_BODY,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: SETUP_ADMIN,
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      const outcome = await executeIdempotent({
        context,
        operation: "setup_record.create",
        idempotencyKey: input.idempotencyKey,
        request: { entityKey: input.entityKey, body: input.body },
        execute: async () =>
          settleWrite(
            await createSetupRecord(
              setupActor(context),
              input.entityKey,
              input.body as Record<string, unknown>,
            ),
          ),
      });
      return {
        ok: true,
        replayed: outcome.replayed,
        entityKey: input.entityKey,
        ...outcome.value,
        href: `/admin/setup/${input.entityKey}`,
      };
    },
  }),
  definition({
    name: "update_setup_record",
    title: "Update Setup Record",
    description:
      "Update one Setup-entity record by id (only changed fields; ids from list_setup_records). Some entities version, some values lock once posted — the command reports which.",
    inputSchema: z.object({
      entityKey: SETUP_ENTITY_KEY,
      id: z.string().min(1).max(120).describe("Id of the setup record, from list_setup_records"),
      body: SETUP_BODY,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: SETUP_ADMIN,
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      const body = { ...(input.body as Record<string, unknown>), id: input.id };
      const outcome = await executeIdempotent({
        context,
        operation: "setup_record.update",
        idempotencyKey: input.idempotencyKey,
        request: { entityKey: input.entityKey, body },
        execute: async () =>
          settleWrite(await updateSetupRecord(setupActor(context), input.entityKey, body)),
      });
      return {
        ok: true,
        replayed: outcome.replayed,
        entityKey: input.entityKey,
        ...outcome.value,
        href: `/admin/setup/${input.entityKey}`,
      };
    },
  }),
  definition({
    name: "delete_setup_record",
    title: "Delete Setup Record",
    description:
      "Delete (or archive, where the entity keeps history) one configuration record by id. Refuses records referenced by postings or other configuration (reported as in-use) and shared reference data. Audited.",
    inputSchema: z.object({
      entityKey: SETUP_ENTITY_KEY,
      id: z.string().min(1).max(120).describe("Id of the setup record, from list_setup_records"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: SETUP_ADMIN,
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      const outcome = await executeIdempotent({
        context,
        operation: "setup_record.delete",
        idempotencyKey: input.idempotencyKey,
        request: { entityKey: input.entityKey, id: input.id },
        execute: async () =>
          settleWrite(await deleteSetupRecord(setupActor(context), input.entityKey, input.id)),
      });
      return { ok: true, replayed: outcome.replayed, entityKey: input.entityKey, ...outcome.value };
    },
  }),
  definition({
    name: "upload_file",
    title: "Upload File",
    description:
      "Upload a small file (at most 1 MB) to a File Cabinet folder through the same storage and folder grants as the files screen: needs Editor access or better on the destination folder, accepts the cabinet's allowlisted document, image, spreadsheet, and text types, and is audited. Resolve the folder with list_folders first. Returns the created file's metadata.",
    inputSchema: z
      .object({
        folderId: UUID,
        filename: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .describe("File name with extension, e.g. statement-jan.pdf"),
        contentType: z
          .string()
          .max(120)
          .describe(
            "MIME type, one of the cabinet's allowlisted types, e.g. application/pdf or text/csv",
          ),
        contentBase64: z
          .string()
          .max(1400000)
          .describe("File bytes as base64, at most 1 MB decoded"),
        sourceSystem: z
          .string()
          .min(1)
          .max(100)
          .refine((value) => value.trim().length > 0)
          .optional()
          .describe(
            "System the file is adopted from, e.g. a prior accounting system; supply it with sourceId and auditReason",
          ),
        sourceId: z
          .string()
          .min(1)
          .max(1000)
          .refine((value) => value.trim().length > 0)
          .optional()
          .describe(
            "The file's identifier in sourceSystem, so a repeated adoption resolves to the same file",
          ),
        auditReason: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .optional()
          .describe("Why the file is adopted from its source system; required with sourceSystem"),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        (body) => (body.sourceSystem === undefined) === (body.sourceId === undefined),
        "Supply both sourceSystem and sourceId",
      )
      .refine(
        (body) => body.sourceSystem === undefined || body.auditReason !== undefined,
        "Source uploads require an adoption reason",
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: anyPermission("documents.manage", "documents.read"),
    authorizeReplay: (context, input) => assertCabinetUploadAccess(context.authz, input.folderId),
    execute: async (context, input) => {
      // documents.read does not imply from documents.manage (no wildcard),
      // so either suffices here — the folder grant is the true gate below.
      if (!can(context.authz, "documents.read") && !can(context.authz, "documents.manage")) {
        throw forbidden("documents.read");
      }
      const source = {
        ...(input.sourceSystem === undefined
          ? {}
          : { sourceSystem: input.sourceSystem, sourceId: input.sourceId }),
        ...(input.auditReason === undefined ? {} : { auditReason: input.auditReason }),
      };
      const outcome = await executeIdempotent({
        context,
        operation: "file.upload",
        idempotencyKey: input.idempotencyKey,
        request: withContentDigest(
          {
            folderId: input.folderId,
            filename: input.filename,
            contentType: input.contentType,
            ...source,
          },
          input.contentBase64.replace(/\s+/g, ""),
        ),
        authorizeReplay: () => assertCabinetUploadAccess(context.authz, input.folderId),
        execute: async () =>
          uploadCabinetFile(context.authz, {
            folderId: input.folderId,
            filename: input.filename,
            contentType: input.contentType,
            contentBase64: input.contentBase64,
            ...source,
          }),
      });
      return { ok: true, replayed: outcome.replayed, ...outcome.value, href: "/documents" };
    },
  }),
  ...MIGRATION_APPLICATION_TOOLS,
  ...LEDGER_APPLICATION_TOOLS,
  ...TREASURY_APPLICATION_TOOLS,
  ...CAPITAL_APPLICATION_TOOLS,
  ...SALES_APPLICATION_TOOLS,
  ...PURCHASING_APPLICATION_TOOLS,
  ...INVENTORY_APPLICATION_TOOLS,
  ...MANUFACTURING_APPLICATION_TOOLS,
  ...SUBSCRIPTION_APPLICATION_TOOLS,
  ...PROJECT_APPLICATION_TOOLS,
  ...TIME_APPLICATION_TOOLS,
  ...HRM_APPLICATION_TOOLS,
  ...TALENT_APPLICATION_TOOLS,
  ...PAYROLL_APPLICATION_TOOLS,
  ...CRM_APPLICATION_TOOLS,
  ...ADMIN_APPLICATION_TOOLS,
  ...WORKSPACE_APPLICATION_TOOLS,
];

export function applicationTool(name: string): ApplicationToolDefinition | undefined {
  return APPLICATION_TOOLS.find((candidate) => candidate.name === name);
}

/**
 * The one execution gate every transport shares. Permission and feature are
 * both re-checked here, at execution, so a command discovered or proposed
 * earlier cannot run after the actor lost the permission or the organization
 * turned the module off. Callers that already resolved the feature state pass
 * it to avoid a second read.
 */
export async function executeApplicationTool(
  definition: ApplicationToolDefinition,
  context: ApplicationContext,
  rawInput: unknown,
  features?: FeatureState | null,
): Promise<Record<string, unknown>> {
  if (!definition.visibleTo(context.authz)) throw new Error("forbidden");
  if (definition.featureKey) {
    const state = features ?? (await resolvedFeatureState(context.authz.user.orgId));
    if (!featureEnabled(state, definition.featureKey)) {
      throw new ApplicationError(
        "forbidden",
        `${definition.name} needs the ${definition.featureKey} feature; an administrator can turn it on in Company Settings → Features`,
        403,
      );
    }
  }
  const input = definition.inputSchema.parse(rawInput) as Record<string, unknown>;
  return definition.execute(context, input);
}
