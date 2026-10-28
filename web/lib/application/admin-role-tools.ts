import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { can } from "../authz";
import { createAdminRole, deleteAdminRole, updateAdminRole } from "@/app/api/admin/roles/route";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z.string().regex(UUID_RE).describe("Role id returned by list_roles.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

async function runRoleAction(
  context: ApplicationContext,
  action: (authz: ApplicationContext["authz"]) => Promise<Response>,
): Promise<Record<string, unknown>> {
  assertApplicationPermission(context, "admin.roles.manage");
  const response = await action(context.authz);
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const message =
      typeof payload.error === "string" ? payload.error : "Role administration request failed";
    if (response.status === 403)
      throw new ApplicationError("forbidden", message, 403, {
        permission: "admin.roles.manage",
        ...payload,
      });
    if (response.status === 404) throw notFound(message);
    if (response.status === 409) throw conflict(message, payload);
    throw invalidInput(message, payload);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const roleId = typeof payload.id === "string" ? payload.id : "";
  return {
    ...payload,
    ...(roleId ? { roleId, href: `/admin/roles?id=${roleId}` } : { href: "/admin/roles" }),
  };
}

const keyField = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]{1,63}$/)
  .optional()
  .describe("Stable lowercase role key; generated from the name when omitted.");
const nameField = z.string().trim().min(1).max(200).describe("Role display name.");
const descriptionField = z.string().max(2000).nullable().optional().describe("Role description.");
const permissionsField = z
  .array(z.string().max(100))
  .max(500)
  .optional()
  .describe("Permission catalogue keys granted by this role.");
const subsidiaryRestrictionField = z
  .union([
    z.object({ mode: z.literal("all") }).describe("All subsidiaries."),
    z
      .object({ mode: z.literal("subtree"), subsidiaryId: UUID.describe("Root subsidiary id.") })
      .describe("A subsidiary and its descendants."),
    z
      .object({
        mode: z.literal("list"),
        subsidiaryIds: z.array(UUID).min(1).max(500).describe("Allowed subsidiary ids."),
      })
      .describe("A finite set of subsidiaries."),
  ])
  .optional()
  .describe("Role's subsidiary restriction; the native handler checks delegation coverage.");

export const ADMIN_ROLE_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "create_role",
    title: "Create Role",
    description:
      "Create a custom organization role with its permission set and subsidiary restriction. Use list_roles to review existing roles and the permission catalogue; the native permission ceiling and subsidiary delegation checks are enforced.",
    inputSchema: z.object({
      name: nameField,
      key: keyField,
      description: descriptionField,
      permissions: permissionsField,
      subsidiaryRestriction: subsidiaryRestrictionField,
      selfServiceBaseline: z
        .boolean()
        .optional()
        .describe(
          "Whether the employee self-service permission baseline is added; defaults to true.",
        ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.roles.manage"),
    execute: async (context, input) =>
      runRoleAction(context, (authz) => createAdminRole({ body: input, authz })),
  }),
  definition({
    name: "update_role_permissions",
    title: "Update Role Permissions",
    description:
      "Edit a role's permissions or subsidiary restriction using the current revision from list_roles. The Administrator role stays locked, and native segregation, permission-ceiling, and subsidiary delegation checks reject escalations.",
    inputSchema: z
      .object({
        id: UUID,
        expectedUpdatedAt: z
          .string()
          .min(1)
          .max(64)
          .describe("Exact role revision from list_roles for optimistic concurrency."),
        name: nameField.optional(),
        key: z.never().optional().describe("Role keys cannot be changed after creation."),
        description: descriptionField,
        permissions: permissionsField,
        subsidiaryRestriction: subsidiaryRestrictionField,
        selfServiceBaseline: z
          .boolean()
          .optional()
          .describe("Set true to add the employee self-service baseline."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        (input) =>
          input.name !== undefined ||
          input.description !== undefined ||
          input.permissions !== undefined ||
          input.subsidiaryRestriction !== undefined ||
          input.selfServiceBaseline !== undefined,
        "provide a role field to update",
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.roles.manage"),
    execute: async (context, input) =>
      runRoleAction(context, (authz) => updateAdminRole({ body: input, authz })),
  }),
  definition({
    name: "delete_role",
    title: "Delete Role",
    description:
      "Delete a custom role and its dashboard layout. Use list_roles to find the role id; if active users would lose their last role, provide a replacement role that passes the native permission and subsidiary delegation checks.",
    inputSchema: z.object({
      id: UUID,
      replacementRoleId: UUID.optional().describe(
        "Replacement role for users who would otherwise have no role.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.roles.manage"),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...body } = input;
      return runRoleAction(context, (authz) => deleteAdminRole({ body, authz }));
    },
  }),
];
