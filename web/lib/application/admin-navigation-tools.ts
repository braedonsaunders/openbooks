import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { readNavigationConfig } from "../nav/config";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, forbidden, invalidInput } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { requestBodySchema, saveNavigationConfigAction } from "@/app/api/admin/navigation/route";

const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

function assertNavigationPermission(context: ApplicationContext) {
  const permission = can(context.authz, "admin.nav.manage")
    ? "admin.nav.manage"
    : "admin.customization.manage";
  assertApplicationPermission(context, permission);
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
}

export const ADMIN_NAVIGATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_org_navigation_config",
    title: "Get Organization Navigation",
    description:
      "Read the saved organization navigation layout and its revision. Use this before a full-config update so the optimistic revision and all existing groups are preserved.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) =>
      can(authz, "admin.nav.manage") || can(authz, "admin.customization.manage"),
    execute: async (context) => {
      assertNavigationPermission(context);
      const saved = await readNavigationConfig(context.authz.user.orgId);
      return {
        config: saved?.config ?? null,
        updatedAt: saved?.updated_at?.toISOString() ?? null,
        href: "/admin/navigation",
      };
    },
  }),
  definition({
    name: "update_org_navigation_config",
    title: "Update Organization Navigation",
    description:
      "Replace the organization navigation layout, preserving the full versioned configuration from get_org_navigation_config. Supply its exact revision; the native handler validates module, app, extension, and local-navigation destinations before saving.",
    inputSchema: z.object({
      config: z
        .json()
        .describe(
          "Complete version-2 organization navigation document, including groups and local navigation preferences.",
        ),
      expectedUpdatedAt: z
        .string()
        .max(35)
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
        .nullable()
        .optional()
        .describe(
          "Exact revision returned by get_org_navigation_config; null means the organization has not saved a layout yet.",
        ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) =>
      can(authz, "admin.nav.manage") || can(authz, "admin.customization.manage"),
    execute: async (context, input) => {
      assertNavigationPermission(context);
      let body: z.infer<typeof requestBodySchema>;
      try {
        body = requestBodySchema.parse({
          config: input.config,
          expectedUpdatedAt: input.expectedUpdatedAt,
        });
      } catch (error) {
        if (error instanceof z.ZodError)
          throw invalidInput("invalid navigation config", { issues: error.issues });
        throw error;
      }
      try {
        const response = await saveNavigationConfigAction({ body, authz: context.authz });
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          const message =
            typeof payload.error === "string" ? payload.error : "Navigation was not saved";
          if (response.status === 409) throw conflict(message, payload);
          if (response.status === 403)
            throw new ApplicationError("forbidden", message, 403, payload);
          throw invalidInput(message, payload);
        }
        const payload = (await response.json()) as Record<string, unknown>;
        return { ok: true, ...payload, href: "/admin/navigation" };
      } catch (error) {
        if (error && typeof error === "object" && "status" in error && error.status === 409) {
          throw conflict(error instanceof Error ? error.message : "Navigation was not saved");
        }
        throw error;
      }
    },
  }),
];
