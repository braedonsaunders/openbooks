import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { can } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, invalidInput } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { createPdfTemplate } from "@/app/api/pdf-templates/route";
import {
  deletePdfTemplateAction,
  updatePdfTemplateAction,
} from "@/app/api/pdf-templates/[id]/route";
import { previewPdfTemplate } from "@/app/api/pdf-templates/preview/route";

const UUID = z.string().regex(UUID_RE).describe("PDF template id returned by list_pdf_templates.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const recordType = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe("Supported printable record type from the PDF template catalog.");
const html = z.string().max(100_000).describe("Template HTML with supported record tokens.");

function requestFor(path: string, body?: unknown): Request {
  return new Request(
    `https://openbooks.invalid${path}`,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
}

async function payload(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const message = typeof body.error === "string" ? body.error : "PDF template operation failed";
    if (response.status === 403) throw new ApplicationError("forbidden", message, 403, body);
    if (response.status === 404) throw new ApplicationError("not_found", message, 404, body);
    if (response.status === 409) throw conflict(message, body);
    throw invalidInput(message, body);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/pdf")) {
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      pdfBase64: bytes.toString("base64"),
      contentType,
      byteLength: bytes.byteLength,
    };
  }
  return (await response.json()) as Record<string, unknown>;
}

function requireCustomization(context: ApplicationContext) {
  assertApplicationPermission(context, "admin.customization.manage");
}

const createSchema = z.object({
  recordType,
  name: z.string().trim().min(1).max(200).describe("Template name."),
  description: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe("Optional template description."),
  sourceHtml: html.optional(),
  headerHtml: html.nullable().optional().describe("Optional repeated page header markup."),
  footerHtml: html.nullable().optional().describe("Optional repeated page footer markup."),
  paperSize: z.enum(["letter", "a4", "legal"]).optional().describe("Printed page size."),
  orientation: z.enum(["landscape", "portrait"]).optional().describe("Printed page orientation."),
  marginMm: z
    .number()
    .int()
    .min(0)
    .max(60)
    .optional()
    .describe("Page margin in whole millimetres."),
  isDefault: z.boolean().optional().describe("Make this template the default for its record type."),
});
const updateSchema = z
  .object({
    id: UUID,
    name: z.string().trim().min(1).max(200).optional().describe("Replacement template name."),
    description: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .describe("Replacement template description."),
    sourceHtml: html.optional(),
    headerHtml: html.nullable().optional().describe("Replacement repeated page header markup."),
    footerHtml: html.nullable().optional().describe("Replacement repeated page footer markup."),
    paperSize: z.enum(["letter", "a4", "legal"]).optional().describe("Printed page size."),
    orientation: z.enum(["landscape", "portrait"]).optional().describe("Printed page orientation."),
    marginMm: z
      .number()
      .int()
      .min(0)
      .max(60)
      .optional()
      .describe("Page margin in whole millimetres."),
    isDefault: z.boolean().optional().describe("Whether this template is the default."),
    isActive: z
      .boolean()
      .optional()
      .describe("Whether this template can be selected for printing."),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .refine(
    (input) => Object.keys(input).some((key) => key !== "id" && key !== "idempotencyKey"),
    "provide a template field to update",
  );

const previewSchema = z.object({
  recordType,
  sourceHtml: html.optional(),
  headerHtml: html.nullable().optional().describe("Optional repeated page header markup."),
  footerHtml: html.nullable().optional().describe("Optional repeated page footer markup."),
  paperSize: z.enum(["letter", "a4", "legal"]).optional().describe("Printed page size."),
  orientation: z.enum(["landscape", "portrait"]).optional().describe("Printed page orientation."),
  marginMm: z
    .number()
    .int()
    .min(0)
    .max(60)
    .optional()
    .describe("Page margin in whole millimetres."),
  calibration: z.boolean().optional().describe("Render the calibration specimen when supported."),
});

export const ADMIN_PDF_TEMPLATE_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "create_pdf_template",
    title: "Create PDF Template",
    description:
      "Create a printable template for a supported record type. Omit sourceHtml to use the record type's starter design; use list_pdf_templates to verify it.",
    inputSchema: createSchema.extend({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.customization.manage"),
    execute: async (context, input) => {
      requireCustomization(context);
      const { idempotencyKey: _key, ...body } = input;
      const res = await createPdfTemplate(context.authz, body);
      const result = await payload(res);
      const id = String(result.id ?? "");
      return {
        ok: true,
        ...result,
        href: id ? `/admin/pdf-templates/${id}` : "/admin/pdf-templates",
      };
    },
  }),
  definition({
    name: "update_pdf_template",
    title: "Update PDF Template",
    description:
      "Edit template HTML or print settings, including its default status. Use get_pdf_template to inspect the current design and list_pdf_templates to verify the saved revision.",
    inputSchema: updateSchema,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.customization.manage"),
    execute: async (context, input) => {
      requireCustomization(context);
      const { idempotencyKey: _key, id, ...body } = input;
      const res = await updatePdfTemplateAction(
        requestFor(`/api/pdf-templates/${id}`, body),
        { params: Promise.resolve({ id }) },
        context.authz,
      );
      return {
        ok: true,
        ...(await payload(res)),
        templateId: id,
        href: `/admin/pdf-templates/${id}`,
      };
    },
  }),
  definition({
    name: "delete_pdf_template",
    title: "Delete PDF Template",
    description:
      "Delete a PDF template after confirming it is no longer needed. Use list_pdf_templates to find the id; affected records fall back to the organization default or starter design.",
    inputSchema: z.object({ id: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.customization.manage"),
    execute: async (context, input) => {
      requireCustomization(context);
      const res = await deletePdfTemplateAction(
        requestFor(`/api/pdf-templates/${input.id}`),
        { params: Promise.resolve({ id: input.id }) },
        context.authz,
      );
      return {
        ok: true,
        ...(await payload(res)),
        templateId: input.id,
        href: "/admin/pdf-templates",
      };
    },
  }),
  definition({
    name: "preview_pdf_template",
    title: "Preview PDF Template",
    description:
      "Render a draft PDF for a supported record type without saving it. The route uses an in-scope real sample when available and requires the corresponding record read permission.",
    inputSchema: previewSchema,
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.customization.manage"),
    execute: async (context, input) => {
      requireCustomization(context);
      const result = await payload(await previewPdfTemplate(context.authz, input));
      return {
        ...result,
        href: `/admin/pdf-templates?recordType=${encodeURIComponent(input.recordType)}`,
      };
    },
  }),
];
