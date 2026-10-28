import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { can } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { mutateAdminUser, type requestBodySchema } from "@/app/api/admin/users/route";

const UUID = z.string().regex(UUID_RE);
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

async function runUserMutation(
  context: ApplicationContext,
  body: z.infer<typeof requestBodySchema>,
): Promise<Record<string, unknown>> {
  assertApplicationPermission(context, "admin.users.manage");
  const response = await mutateAdminUser({
    request: new Request("https://openbooks.invalid/api/admin/users", {
      headers: { "user-agent": `OpenBooks ${context.source} command` },
    }),
    body,
    authz: context.authz,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const message =
      typeof payload.error === "string" ? payload.error : "User administration request failed";
    if (response.status === 403)
      throw new ApplicationError("forbidden", message, 403, { permission: "admin.users.manage" });
    if (response.status === 404) throw notFound(message);
    if (response.status === 409) throw conflict(message, payload);
    if (response.status === 429) throw new ApplicationError("rate_limited", message, 429);
    throw invalidInput(message, payload);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const userId = typeof payload.userId === "string" ? payload.userId : "";
  return {
    ...payload,
    ...(userId ? { href: `/admin/users?user=${userId}` } : { href: "/admin/users" }),
  };
}

function userTool<T extends z.ZodType>(args: {
  name: string;
  title: string;
  description: string;
  schema: T;
  destructive?: boolean;
  openWorld?: boolean;
  execute: (context: ApplicationContext, input: z.infer<T>) => Promise<Record<string, unknown>>;
}): ApplicationToolDefinition {
  return definition({
    name: args.name,
    title: args.title,
    description: args.description,
    inputSchema: args.schema,
    readOnly: false,
    destructive: args.destructive ?? false,
    openWorld: args.openWorld ?? false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.users.manage"),
    execute: args.execute,
  });
}

const userIdField = UUID.describe("User id returned by list_users.");
const roleIdField = UUID.describe("Role id returned by list_roles.");

export const ADMIN_USER_TOOLS: ApplicationToolDefinition[] = [
  userTool({
    name: "invite_user",
    title: "Invite User",
    description:
      "Invite a person to the organization with an initial role. Use list_roles to choose the role; the native permission ceiling, subsidiary coverage, and invite issuance checks are enforced before a setup link is created.",
    schema: z.object({
      email: z
        .string()
        .trim()
        .max(320)
        .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)
        .describe("Email address to invite."),
      roleId: roleIdField,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    openWorld: true,
    execute: async (context, input) =>
      runUserMutation(context, { action: "invite", email: input.email, roleId: input.roleId }),
  }),
  userTool({
    name: "set_user_active",
    title: "Set User Active State",
    description:
      "Activate or deactivate an organization user. Use list_users to find the user id; reactivation rechecks stored role permissions and subsidiary limits, and deactivation revokes active sessions.",
    schema: z.object({
      userId: userIdField,
      isActive: z.boolean().describe("Whether the user should be active."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    destructive: true,
    execute: async (context, input) =>
      runUserMutation(context, {
        action: "set-active",
        userId: input.userId,
        isActive: input.isActive,
      }),
  }),
  userTool({
    name: "assign_user_role",
    title: "Assign User Role",
    description:
      "Assign an organization role to a user. Use list_users and list_roles to find ids; the existing self-assignment, permission-ceiling, subsidiary-coverage, and last-role safeguards apply.",
    schema: z.object({
      userId: userIdField,
      roleId: roleIdField,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    destructive: true,
    execute: async (context, input) =>
      runUserMutation(context, { action: "assign", userId: input.userId, roleId: input.roleId }),
  }),
  userTool({
    name: "unassign_user_role",
    title: "Unassign User Role",
    description:
      "Remove one role assignment from a user. Use list_users and list_roles to find ids; an active user must retain at least one role.",
    schema: z.object({
      userId: userIdField,
      roleId: roleIdField,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) =>
      runUserMutation(context, { action: "unassign", userId: input.userId, roleId: input.roleId }),
  }),
  userTool({
    name: "resend_user_invite",
    title: "Resend User Invite",
    description:
      "Issue a fresh setup link for a user who has not set a password. Use list_users to find the user id; current role permissions and subsidiary coverage are checked inside the link-issuance transaction.",
    schema: z.object({ userId: userIdField, idempotencyKey: IDEMPOTENCY_KEY }),
    openWorld: true,
    execute: async (context, input) =>
      runUserMutation(context, { action: "resend-invite", userId: input.userId }),
  }),
  userTool({
    name: "link_user_party",
    title: "Link User to Person",
    description:
      "Link or unlink a login user to an existing active party, using the exact current party id from list_users. Supply a reason and identity attestation; self-link and subsidiary checks are enforced by the user administration route.",
    schema: z.object({
      userId: userIdField,
      partyId: UUID.nullable().describe("Active party id to link, or null to unlink."),
      expectedPartyId: UUID.nullable().describe(
        "Current party id from list_users, or null if currently unlinked.",
      ),
      reason: z.string().trim().min(1).max(500).describe("Reason recorded in the audit event."),
      attestation: z
        .literal(true)
        .describe("Attest that the selected party is the correct person."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) =>
      runUserMutation(context, {
        action: "set-party",
        userId: input.userId,
        partyId: input.partyId,
        expectedPartyId: input.expectedPartyId,
        reason: input.reason,
        attestation: input.attestation,
      }),
  }),
];
