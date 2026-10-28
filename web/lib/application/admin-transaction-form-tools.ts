import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { can } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import {
  createFormLayoutAction,
  listFormLayoutsAction,
} from "@/app/api/customization/form-layouts/route";
import {
  deleteFormLayoutAction,
  readFormLayoutAction,
  updateFormLayoutAction,
} from "@/app/api/customization/form-layouts/[id]/route";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("Transaction form id returned by list_transaction_forms.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const recordType = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe("Supported transaction type key, such as vendor_bill or journal_entry.");
const roleIds = z
  .array(z.string().regex(UUID_RE))
  .max(100)
  .nullable()
  .optional()
  .describe("Role ids permitted to use this form, or null for the native default access.");
const layout = z
  .json()
  .describe("Full transaction form layout; native validation preserves locked fields.");

function requireCustomization(context: ApplicationContext) {
  assertApplicationPermission(context, "admin.customization.manage");
}

function requestFor(path: string): Request {
  return new Request(`https://openbooks.invalid${path}`);
}

async function responsePayload(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.ok) return body;
  const message = typeof body.error === "string" ? body.error : "Transaction form operation failed";
  if (response.status === 403) throw new ApplicationError("forbidden", message, 403, body);
  if (response.status === 404) throw notFound(message);
  if (response.status === 409) throw conflict(message, body);
  throw invalidInput(message, body);
}

function formHref(recordTypeValue: string, id?: string) {
  const query = new URLSearchParams({ recordType: recordTypeValue });
  if (id) query.set("form", id);
  return `/admin/customization?${query.toString()}`;
}

export const ADMIN_TRANSACTION_FORM_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_transaction_forms",
    title: "List Transaction Forms",
    description:
      "List customized transaction forms for one supported transaction type. Use the returned ids to read or edit a form and verify its saved default and access settings.",
    inputSchema: z.object({ recordType }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.customization.manage"),
    execute: async (context, input) => {
      requireCustomization(context);
      const url = new URL("https://openbooks.invalid/api/customization/form-layouts");
      url.searchParams.set("recordType", input.recordType);
      const result = await responsePayload(
        await listFormLayoutsAction({ request: new Request(url), authz: context.authz }),
      );
      return { ...result, href: formHref(input.recordType) };
    },
  }),
  definition({
    name: "get_transaction_form",
    title: "Get Transaction Form",
    description:
      "Read a complete customized transaction form, including its layout and default flags. Use list_transaction_forms to find the id and verify edits.",
    inputSchema: z.object({ id: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.customization.manage"),
    execute: async (context, input) => {
      requireCustomization(context);
      const result = await responsePayload(
        await readFormLayoutAction({
          request: requestFor(`/api/customization/form-layouts/${input.id}`),
          authz: context.authz,
          params: { id: input.id },
        }),
      );
      const kind = typeof result.recordType === "string" ? result.recordType : "";
      return { ...result, href: formHref(kind, input.id) };
    },
  }),
  definition({
    name: "create_transaction_form",
    title: "Create Transaction Form",
    description:
      "Create a custom form for a supported transaction type, optionally making it the default. Use list_transaction_forms to find and verify the new form.",
    inputSchema: z.object({
      recordType,
      name: z.string().trim().min(1).max(200).describe("Transaction form name."),
      description: z
        .string()
        .trim()
        .max(2000)
        .nullable()
        .optional()
        .describe("Optional form description."),
      layout: layout.optional(),
      allowedRoles: roleIds,
      isDefault: z
        .boolean()
        .optional()
        .describe("Make this form the default for its transaction type."),
      isActive: z.boolean().optional().describe("Whether operators can select this form."),
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
        await createFormLayoutAction({
          request: requestFor("/api/customization/form-layouts"),
          authz: context.authz,
          body,
        }),
      );
      const id = typeof result.id === "string" ? result.id : "";
      return { ok: true, ...result, href: formHref(input.recordType, id || undefined) };
    },
  }),
  definition({
    name: "update_transaction_form",
    title: "Update Transaction Form",
    description:
      "Edit a transaction form's layout, roles, active status, or default status. Use get_transaction_form to inspect the current layout and list_transaction_forms to verify the saved revision.",
    inputSchema: z
      .object({
        id: UUID,
        name: z.string().trim().min(1).max(200).optional().describe("Replacement form name."),
        description: z
          .string()
          .trim()
          .max(2000)
          .nullable()
          .optional()
          .describe("Replacement description."),
        layout: layout.optional(),
        allowedRoles: roleIds,
        isDefault: z.boolean().optional().describe("Whether this is the default transaction form."),
        isActive: z.boolean().optional().describe("Whether operators can select this form."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        (input) => Object.keys(input).some((key) => key !== "id" && key !== "idempotencyKey"),
        "provide a transaction form field to update",
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.customization.manage"),
    execute: async (context, input) => {
      requireCustomization(context);
      const { idempotencyKey: _key, id, ...body } = input;
      const current = await responsePayload(
        await readFormLayoutAction({
          request: requestFor(`/api/customization/form-layouts/${id}`),
          authz: context.authz,
          params: { id },
        }),
      );
      const kind = typeof current.recordType === "string" ? current.recordType : "";
      const result = await responsePayload(
        await updateFormLayoutAction({
          request: requestFor(`/api/customization/form-layouts/${id}`),
          authz: context.authz,
          params: { id },
          body,
        }),
      );
      return { ok: true, ...result, formId: id, href: formHref(kind, id) };
    },
  }),
  definition({
    name: "delete_transaction_form",
    title: "Delete Transaction Form",
    description:
      "Delete a transaction form after confirming it is no longer used. Use list_transaction_forms to find its id; deletion preserves the native audit snapshot.",
    inputSchema: z.object({ id: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.customization.manage"),
    execute: async (context, input) => {
      requireCustomization(context);
      const result = await responsePayload(
        await deleteFormLayoutAction({
          request: requestFor(`/api/customization/form-layouts/${input.id}`),
          authz: context.authz,
          params: { id: input.id },
        }),
      );
      return { ok: true, ...result, formId: input.id, href: "/admin/customization" };
    },
  }),
];
