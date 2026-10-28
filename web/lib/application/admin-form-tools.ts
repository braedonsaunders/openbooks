import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, invalidInput } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { createFormTemplateAction, listFormTemplatesAction } from "@/app/api/forms/templates/route";
import {
  archiveFormTemplateAction,
  readFormTemplateAction,
  updateFormTemplateAction,
} from "@/app/api/forms/templates/[key]/route";
import { publishFormTemplateAction } from "@/app/api/forms/templates/[key]/publish/route";

const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const formKey = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,63}$/)
  .describe("Stable form-template key.");

async function responsePayload(response: Response): Promise<Record<string, unknown>> {
  if (response.ok) return (await response.json()) as Record<string, unknown>;
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const message = typeof body.error === "string" ? body.error : "Form template operation failed";
  if (response.status === 403) throw new ApplicationError("forbidden", message, 403, body);
  if (response.status === 404) throw new ApplicationError("not_found", message, 404, body);
  if (response.status === 409) throw conflict(message, body);
  throw invalidInput(message, body);
}

function requireCustomization(context: ApplicationContext) {
  assertApplicationPermission(context, "admin.customization.manage");
}

function formHref(_key?: string) {
  return "/admin/setup";
}

export const ADMIN_FORM_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_form_templates",
    title: "List Form Templates",
    description:
      "List form templates, their latest version numbers, and response counts. Use the returned key to read, edit, publish, or archive a template.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.customization.manage"),
    execute: async (context) => {
      requireCustomization(context);
      return {
        ...(await responsePayload(await listFormTemplatesAction(context.authz))),
        href: "/admin/setup",
      };
    },
  }),
  definition({
    name: "get_form_template",
    title: "Get Form Template",
    description:
      "Read form-template metadata, versions, and the latest editable form schema. Use list_form_templates to find its key and verify updates.",
    inputSchema: z.object({ key: formKey }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.customization.manage"),
    execute: async (context, input) => {
      requireCustomization(context);
      const result = await readFormTemplateAction({
        authz: context.authz,
        params: { key: input.key },
      });
      return { ...(await responsePayload(result)), href: formHref(input.key) };
    },
  }),
  definition({
    name: "create_form_template",
    title: "Create Form Template",
    description:
      "Create an empty draft form, wizard, checklist, or register template. Use list_form_templates to verify the new key before editing its schema.",
    inputSchema: z.object({
      key: formKey,
      name: z.string().trim().min(1).max(200).describe("Template display name."),
      kind: z
        .enum(["form", "wizard", "checklist", "register"])
        .optional()
        .describe("Template interaction style; defaults to form."),
      category: z
        .string()
        .trim()
        .max(120)
        .nullable()
        .optional()
        .describe("Optional template category."),
      description: z
        .string()
        .trim()
        .max(2000)
        .nullable()
        .optional()
        .describe("Optional operator-facing description."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.customization.manage"),
    execute: async (context, input) => {
      requireCustomization(context);
      const { idempotencyKey: _key, ...body } = input;
      const result = await responsePayload(
        await createFormTemplateAction({ authz: context.authz, body }),
      );
      const key = String(result.key ?? input.key);
      return { ok: true, ...result, href: formHref(key) };
    },
  }),
  definition({
    name: "update_form_template",
    title: "Update Form Template",
    description:
      "Edit template metadata or save its latest draft schema. When the prior version is published, the native save path creates the next draft version; use get_form_template to inspect the current schema.",
    inputSchema: z
      .object({
        key: formKey,
        name: z.string().trim().min(1).max(200).optional().describe("Replacement template name."),
        category: z
          .string()
          .trim()
          .max(120)
          .nullable()
          .optional()
          .describe("Replacement template category."),
        description: z
          .string()
          .trim()
          .max(2000)
          .nullable()
          .optional()
          .describe("Replacement template description."),
        kind: z
          .enum(["form", "wizard", "checklist", "register"])
          .optional()
          .describe("Replacement template interaction style."),
        allowedRoles: z
          .array(z.string().trim().min(1).max(64))
          .max(20)
          .nullable()
          .optional()
          .describe("Roles allowed to fill this form; null clears the restriction."),
        schema: z
          .json()
          .optional()
          .describe("Full form schema document validated by the native form-schema parser."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        (input) => Object.keys(input).some((key) => key !== "idempotencyKey" && key !== "key"),
        "provide a template field to update",
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.customization.manage"),
    execute: async (context, input) => {
      requireCustomization(context);
      const { idempotencyKey: _key, key, ...body } = input;
      const result = await responsePayload(
        await updateFormTemplateAction({ authz: context.authz, params: { key }, body }),
      );
      return { ok: true, ...result, templateKey: key, href: formHref(key) };
    },
  }),
  definition({
    name: "publish_form_template",
    title: "Publish Form Template",
    description:
      "Publish the latest valid draft form schema as an immutable version. Use get_form_template to confirm a draft exists and list_form_templates to check the published version.",
    inputSchema: z.object({
      key: formKey,
      changelog: z
        .string()
        .trim()
        .max(2000)
        .nullable()
        .optional()
        .describe("Optional publication note recorded with the version."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.customization.manage"),
    execute: async (context, input) => {
      requireCustomization(context);
      const result = await responsePayload(
        await publishFormTemplateAction({
          authz: context.authz,
          params: { key: input.key },
          body: { changelog: input.changelog },
        }),
      );
      return { ok: true, ...result, templateKey: input.key, href: formHref(input.key) };
    },
  }),
  definition({
    name: "archive_form_template",
    title: "Archive Form Template",
    description:
      "Archive a form template while retaining its versions and responses. Use list_form_templates to find the key and verify its archived status.",
    inputSchema: z.object({ key: formKey, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.customization.manage"),
    execute: async (context, input) => {
      requireCustomization(context);
      const result = await responsePayload(
        await archiveFormTemplateAction({ authz: context.authz, params: { key: input.key } }),
      );
      return { ok: true, ...result, templateKey: input.key, href: formHref() };
    },
  }),
];
