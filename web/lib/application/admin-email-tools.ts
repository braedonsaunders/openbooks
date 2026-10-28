import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, forbidden, invalidInput } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import {
  emailSettingsFieldsSchema,
  readEmailSettingsAction,
  saveEmailSettingsAction,
  testEmailTransportAction,
} from "../delivery/email-admin-actions";
import { OrgEmailConfigConflictError } from "@openbooks/engine/delivery/email-config/module";

const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

function requireSetupPermission(context: ApplicationContext) {
  assertApplicationPermission(context, "admin.setup.manage");
}

function settleEmailError(error: unknown): never {
  if (error instanceof OrgEmailConfigConflictError) throw conflict(error.message);
  if (error instanceof Error && error.message === "invalid provider")
    throw invalidInput(error.message);
  throw error;
}

export const ADMIN_EMAIL_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_org_email_settings",
    title: "Get Organization Email Settings",
    description:
      "Read the organization's outbound email transport configuration and whether a credential is saved. Use this before updating the configuration; the sealed credential is never returned.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context) => {
      requireSetupPermission(context);
      return { ...(await readEmailSettingsAction(context.authz.user.orgId)), href: "/admin/email" };
    },
  }),
  definition({
    name: "update_org_email_settings",
    title: "Update Organization Email Settings",
    description:
      "Save non-secret outbound email settings using the exact revision from get_org_email_settings. Configure or replace provider credentials in the browser; test delivery with test_org_email_transport.",
    inputSchema: emailSettingsFieldsSchema
      .omit({ secret: true })
      .extend({ idempotencyKey: IDEMPOTENCY_KEY })
      .refine(
        ({ idempotencyKey: _idempotencyKey, ...body }) => Object.keys(body).length > 0,
        "Provide an email setting to update or reload the page before saving",
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      requireSetupPermission(context);
      if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
      const { idempotencyKey: _idempotencyKey, ...body } = input;
      try {
        const saved = await saveEmailSettingsAction(
          context.authz.user.orgId,
          context.authz.user.id,
          body,
        );
        return { ok: true, ...saved, href: "/admin/email" };
      } catch (error) {
        settleEmailError(error);
      }
    },
  }),
  definition({
    name: "test_org_email_transport",
    title: "Test Organization Email Transport",
    description:
      "Send a test message through the saved outbound transport and record the delivery result. Use after configuring email with update_org_email_settings; the recipient is an operator supplied address.",
    inputSchema: z.object({
      to: z
        .string()
        .trim()
        .min(1)
        .max(320)
        .describe("Email address that receives the test message."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      requireSetupPermission(context);
      const result = await testEmailTransportAction({
        orgId: context.authz.user.orgId,
        userId: context.authz.user.id,
        to: input.to,
      });
      if (result.status >= 400)
        throw new ApplicationError(
          "invalid_input",
          String(result.body.error ?? "Email test failed"),
          result.status,
        );
      return { ...result.body, href: "/admin/email" };
    },
  }),
];
