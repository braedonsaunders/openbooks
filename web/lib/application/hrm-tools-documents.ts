import "server-only";
import { z } from "zod";
import {
  acknowledgeDocument,
  generateDocument,
  getDocumentDetail,
  listDocuments,
  remindDocument,
  resolveMergeFields,
  sendDocument,
  setLegalHold,
  signOwnDocument,
  uploadDocument,
  voidDocument,
} from "@openbooks/engine/hrm/documents";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { db } from "@openbooks/engine/platform/db";
import { executeIdempotent } from "./idempotency";
import { invalidInput } from "./errors";
import { deliverHrDocumentInvitations } from "../hrm/document-delivery";
import {
  describeObjectFields,
  hrmMutation,
  hrmRead,
  HRM_UUID,
  hrmShortText,
} from "./hrm-tools-shared";
import type { ApplicationToolDefinition } from "./tool-definition";

const documentQuery = z.object({
  partyId: HRM_UUID.optional().describe("Filter to one native party."),
  status: hrmShortText("Filter by a document lifecycle status.", 40).optional(),
  categoryKey: hrmShortText("Filter by the HR document category key.", 80).optional(),
});
const fileInput = describeObjectFields(
  z.object({
    employmentId: HRM_UUID.nullable().optional(),
    partyId: HRM_UUID,
    categoryKey: hrmShortText("Declared HR document category key.", 80),
    title: hrmShortText("Document title.", 200),
    filename: hrmShortText("Original filename with extension.", 160),
    contentType: hrmShortText("MIME content type.", 120),
    fileBase64: z
      .string()
      .min(1)
      .max(14_000_000)
      .describe("File bytes encoded as base64, within the native HR documents upload limit."),
    expiresAt: z
      .string()
      .max(40)
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/)
      .nullable()
      .optional()
      .describe("Optional expiration timestamp in ISO 8601 format."),
  }),
);
const generateInput = z.object({
  templateId: HRM_UUID.describe("Active HR document template id from the native template read."),
  employmentId: HRM_UUID.nullable()
    .optional()
    .describe("Employment to resolve merge fields from, when applicable."),
  partyId: HRM_UUID.describe("Native party who owns the generated document."),
  title: hrmShortText("Document title.", 200),
  expiresAt: z
    .string()
    .max(40)
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/)
    .nullable()
    .optional()
    .describe("Optional expiration timestamp in ISO 8601 format."),
});
const appBaseUrl = z
  .string()
  .trim()
  .max(2048)
  .regex(/^https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/)
  .optional()
  .describe(
    "Public OpenBooks base URL for signing links; defaults to OPENBOOKS_APP_URL when configured.",
  );

function signingBaseUrl(value?: string): string {
  const configured = value ?? process.env.OPENBOOKS_APP_URL?.trim().replace(/\/+$/, "");
  if (!configured) {
    throw invalidInput(
      "Configure OPENBOOKS_APP_URL or pass appBaseUrl so signers receive usable document links.",
    );
  }
  return configured;
}

export const HRM_DOCUMENT_TOOLS: ApplicationToolDefinition[] = [
  hrmRead({
    name: "list_hr_documents",
    title: "List HR Documents",
    description:
      "List HR documents by party, status or category, including signature and retention state. Use this before sending, holding, voiding or reminding a document; read results with hrm_documents.",
    input: describeObjectFields(documentQuery),
    permission: "hrm.documents.read",
    featureKey: "hrmDocuments",
    execute: async (context, input) => {
      const documents = await listDocuments({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return { documents, href: "/hrm/documents" };
    },
  }),
  hrmRead({
    name: "get_hr_document",
    title: "Get HR Document",
    description:
      "Read one HR document and its signer state before an action. Find document ids with hrm_documents or list_hr_documents; the result uses the same native record read as the Documents page.",
    input: z.object({
      documentId: HRM_UUID.describe("Document id from hrm_documents or list_hr_documents."),
    }),
    permission: "hrm.documents.read",
    featureKey: "hrmDocuments",
    execute: async (context, input) => {
      const document = await getDocumentDetail({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        documentId: input.documentId,
      });
      return { document, href: `/hrm/documents?document=${input.documentId}` };
    },
  }),
  hrmRead({
    name: "preview_hr_document_merge_fields",
    title: "Preview HR Document Merge Fields",
    description:
      "Preview the native merge values for a party and optional employment before generating a template-based document. Resolve ids through hrm_employment_as_of and the party read; this preview makes no record.",
    input: z.object({
      employmentId: HRM_UUID.nullable()
        .optional()
        .describe("Employment id for employment-specific merge values."),
      partyId: HRM_UUID.describe("Native party id whose values will be merged."),
    }),
    permission: "hrm.documents.manage",
    featureKey: "hrmDocuments",
    execute: async (context, input) => {
      const today = await businessToday(context.authz.user.orgId);
      const mergeValues = await resolveMergeFields(
        db,
        context.authz.user.orgId,
        { employmentId: input.employmentId ?? null, partyId: input.partyId },
        today,
      );
      return { mergeValues, asOf: today, href: "/hrm/documents" };
    },
  }),
  hrmMutation({
    name: "generate_hr_document",
    title: "Generate HR Document",
    description:
      "Generate an HR document from an active template for a party or employment after previewing its merge fields. Find template ids in the HR Documents workspace and verify generated documents with hrm_documents.",
    input: generateInput,
    permission: "hrm.documents.manage",
    featureKey: "hrmDocuments",
    execute: async (context, input) => {
      const outcome = await executeIdempotent({
        context,
        operation: "hrm_document.generate",
        idempotencyKey: input.idempotencyKey,
        request: {
          templateId: input.templateId,
          employmentId: input.employmentId ?? null,
          partyId: input.partyId,
          title: input.title,
          expiresAt: input.expiresAt ?? null,
        },
        successStatus: () => 201,
        execute: async () => {
          const today = await businessToday(context.authz.user.orgId);
          return generateDocument({
            orgId: context.authz.user.orgId,
            actorId: context.authz.user.id,
            templateId: input.templateId,
            employmentId: input.employmentId ?? null,
            partyId: input.partyId,
            title: input.title,
            expiresAt: input.expiresAt ?? null,
            today,
          });
        },
      });
      const document = outcome.value.document;
      return {
        ok: true,
        document,
        documentId: document.id,
        status: document.status,
        href: `/hrm/documents?document=${document.id}`,
      };
    },
  }),
  hrmMutation({
    name: "upload_hr_document",
    title: "Upload HR Document",
    description:
      "Upload a source HR document for a party or employment into its declared HR document category. Read the HR Documents category list first; the native service validates category, type, bytes and subject scope.",
    input: fileInput,
    permission: "hrm.documents.manage",
    featureKey: "hrmDocuments",
    execute: async (context, input) => {
      const bytes = Buffer.from(input.fileBase64, "base64");
      const document = await uploadDocument({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        employmentId: input.employmentId ?? null,
        partyId: input.partyId,
        categoryKey: input.categoryKey,
        title: input.title,
        filename: input.filename,
        contentType: input.contentType,
        bytes,
        expiresAt: input.expiresAt ?? null,
      });
      return {
        ok: true,
        document,
        documentId: document.id,
        status: document.status,
        href: `/hrm/documents?document=${document.id}`,
      };
    },
  }),
  hrmMutation({
    name: "send_hr_document",
    title: "Send HR Document for Signature",
    description:
      "Open the ordered signer steps for a prepared HR document and deliver each signer's link through the configured email and in-app channels. Read the document and signer roles first; pass appBaseUrl when OPENBOOKS_APP_URL is not configured.",
    input: z.object({
      documentId: HRM_UUID.describe("Prepared document id from hrm_documents or get_hr_document."),
      appBaseUrl,
    }),
    permission: "hrm.documents.manage",
    featureKey: "hrmDocuments",
    openWorld: true,
    execute: async (context, input) => {
      const baseUrl = signingBaseUrl(input.appBaseUrl);
      const { document, deliveries } = await sendDocument({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        documentId: input.documentId,
      });
      const signerDeliveries = await deliverHrDocumentInvitations({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        appBaseUrl: baseUrl,
        docTitle: document.title,
        expiresDate: document.expiresAt?.toISOString(),
        recipients: deliveries,
        deliveryKey: `send:${document.id}:${context.authz.user.id}:${input.idempotencyKey}`,
      });
      return {
        ok: true,
        document,
        documentId: document.id,
        status: document.status,
        deliveries: signerDeliveries,
        href: `/hrm/documents?document=${document.id}`,
      };
    },
  }),
  hrmMutation({
    name: "remind_hr_document_signers",
    title: "Remind HR Document Signers",
    description:
      "Reissue fresh signing links to the remaining signers of a sent HR document and deliver the reminder. Read the document first; drafts must be sent and terminal documents cannot be reminded.",
    input: z.object({
      documentId: HRM_UUID.describe("Sent document id from hrm_documents or get_hr_document."),
      appBaseUrl,
    }),
    permission: "hrm.documents.manage",
    featureKey: "hrmDocuments",
    destructive: false,
    openWorld: true,
    execute: async (context, input) => {
      const baseUrl = signingBaseUrl(input.appBaseUrl);
      const outcome = await executeIdempotent({
        context,
        operation: "hrm_document.remind",
        idempotencyKey: input.idempotencyKey,
        request: { documentId: input.documentId },
        successStatus: () => 200,
        execute: () =>
          remindDocument({
            orgId: context.authz.user.orgId,
            actorId: context.authz.user.id,
            documentId: input.documentId,
          }),
      });
      const { document, deliveries } = outcome.value;
      if (outcome.replayed)
        return {
          ok: true,
          document,
          documentId: document.id,
          status: document.status,
          deliveries: [],
          href: `/hrm/documents?document=${document.id}`,
        };
      const signerDeliveries = await deliverHrDocumentInvitations({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        appBaseUrl: baseUrl,
        docTitle: document.title,
        recipients: deliveries,
        reminder: true,
        deliveryKey: `remind:${document.id}:${context.authz.user.id}:${input.idempotencyKey}`,
      });
      return {
        ok: true,
        document,
        documentId: document.id,
        status: document.status,
        deliveries: signerDeliveries,
        href: `/hrm/documents?document=${document.id}`,
      };
    },
  }),
  hrmMutation({
    name: "sign_own_hr_document",
    title: "Sign Own HR Document",
    description:
      "Sign an open signer step assigned to the key's own user, using the employee's typed name. Read the document with hrm_documents first; the native service refuses if the key is not the active signer.",
    input: z.object({
      documentId: HRM_UUID.describe("Document id from the user's own HR document read."),
      name: hrmShortText("Name the signer enters to attest the signature.", 120),
    }),
    permission: ["hrm.self.read", "hrm.documents.read"],
    featureKey: "hrmDocuments",
    execute: async (context, input) => {
      const document = await signOwnDocument({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        documentId: input.documentId,
        name: input.name,
      });
      return {
        ok: true,
        document,
        documentId: document.id,
        status: document.status,
        href: `/hrm/documents?document=${document.id}`,
      };
    },
  }),
  hrmMutation({
    name: "acknowledge_own_hr_document",
    title: "Acknowledge Own HR Document",
    description:
      "Acknowledge an acknowledgment-only HR document assigned to the key's own user. Read the document with hrm_documents first; the native service refuses another employee's document or an already terminal record.",
    input: z.object({
      documentId: HRM_UUID.describe("Acknowledgment-only document assigned to the key's user."),
    }),
    permission: ["hrm.self.read", "hrm.documents.read"],
    featureKey: "hrmDocuments",
    execute: async (context, input) => {
      const document = await acknowledgeDocument({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        documentId: input.documentId,
      });
      return {
        ok: true,
        document,
        documentId: document.id,
        status: document.status,
        href: `/hrm/documents?document=${document.id}`,
      };
    },
  }),
  hrmMutation({
    name: "set_hr_document_legal_hold",
    title: "Set HR Document Legal Hold",
    description:
      "Place an HR document on legal hold or release an existing hold. Read the document and its retention status first; held documents are excluded from automated retention actions.",
    input: z.object({
      documentId: HRM_UUID.describe("Document id from hrm_documents or get_hr_document."),
      hold: z.boolean().describe("true places the hold; false releases it."),
    }),
    permission: "hrm.documents.manage",
    featureKey: "hrmDocuments",
    execute: async (context, input) => {
      const document = await setLegalHold({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        documentId: input.documentId,
        hold: input.hold,
      });
      return {
        ok: true,
        document,
        documentId: document.id,
        status: document.status,
        href: `/hrm/documents?document=${document.id}`,
      };
    },
  }),
  hrmMutation({
    name: "void_hr_document",
    title: "Void HR Document",
    description:
      "Void an HR document when its lifecycle allows, with a reason recorded in history. Read the document with get_hr_document first; signed or retained evidence may require a governed legal or retention action.",
    input: z.object({
      documentId: HRM_UUID.describe("Document id from hrm_documents or get_hr_document."),
      reason: hrmShortText("Reason for voiding the document.", 500),
    }),
    permission: "hrm.documents.manage",
    featureKey: "hrmDocuments",
    destructive: true,
    execute: async (context, input) => {
      const document = await voidDocument({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        documentId: input.documentId,
        reason: input.reason,
      });
      return {
        ok: true,
        document,
        documentId: document.id,
        status: document.status,
        href: `/hrm/documents?document=${document.id}`,
      };
    },
  }),
];
