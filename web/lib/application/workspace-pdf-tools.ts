import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { isValidEmailAddress } from "@openbooks/emails";
import { can } from "../authz";
import { isDocKindEnabled } from "../documents";
import { PDF_RECORD_TYPE_BY_KEY } from "../pdf-templates/catalog";
import { RecordPdfSendError, sendRecordPdfEmail } from "../pdf-templates/send";
import { RECORD_TYPE_SEND_PERMISSION } from "../pdf-templates/send-permissions";
import { loadRecordSubsidiaryScope } from "@/app/api/record-pdf/lib";
import {
  assertApplicationPermission,
  assertSubsidiaryAccess,
  type ApplicationContext,
} from "./context";
import { ApplicationError, forbidden, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("Record or PDF template UUID from the corresponding record read.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact email delivery.");
const EMAIL = z
  .string()
  .max(320)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
  .describe("Destination email address.");

function canSendAnyRecord(authz: Parameters<ApplicationToolDefinition["visibleTo"]>[0]): boolean {
  return Object.values(RECORD_TYPE_SEND_PERMISSION).some((permission) => can(authz, permission));
}

export const WORKSPACE_PDF_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "send_record_pdf_email",
    title: "Send Record PDF Email",
    description:
      "Render and email a record PDF to its party or an explicit recipient. Requires the record family's write authority, an enabled document kind, and subsidiary access; use the record list or detail read to resolve recordType and recordId. Email delivery is an external action.",
    inputSchema: z.object({
      recordType: z
        .string()
        .min(1)
        .max(80)
        .describe("Record type key from the PDF record catalog."),
      recordId: UUID,
      to: EMAIL.optional().describe(
        "Optional destination email; otherwise the party email is used.",
      ),
      message: z.string().max(4000).optional().describe("Optional message accompanying the PDF."),
      templateId: UUID.nullable()
        .optional()
        .describe("PDF template UUID, or null to use the configured default."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: canSendAnyRecord,
    execute: async (context: ApplicationContext, input) => {
      const meta = PDF_RECORD_TYPE_BY_KEY[input.recordType];
      if (!meta) throw invalidInput("unknown record type");
      const permission = RECORD_TYPE_SEND_PERMISSION[input.recordType];
      if (!permission) throw forbidden("record_pdf.send");
      assertApplicationPermission(context, permission);
      if (!(await isDocKindEnabled(context.authz.user.orgId, meta.docKind ?? meta.key)))
        throw notFound("record");
      const owned = await loadRecordSubsidiaryScope(
        input.recordType,
        context.authz.user.orgId,
        input.recordId,
      );
      if (!owned) throw notFound("record");
      assertSubsidiaryAccess(context, owned.subsidiaryId);
      const recipient = input.to?.trim() ?? "";
      if (recipient && !isValidEmailAddress(recipient))
        throw invalidInput("invalid recipient email address");
      try {
        const result = await sendRecordPdfEmail({
          recordType: input.recordType,
          orgId: context.authz.user.orgId,
          id: input.recordId,
          to: recipient || undefined,
          message: input.message,
          templateId: input.templateId,
          scope: context.authz.allowedSubsidiaryIds,
        });
        return {
          ok: true,
          ...result,
          recordType: input.recordType,
          recordId: input.recordId,
          status: "sent",
          href: `/documents/${input.recordId}`,
        };
      } catch (error) {
        if (error instanceof RecordPdfSendError)
          throw new ApplicationError("invalid_input", error.message, error.status);
        throw error;
      }
    },
  }),
];
