import "server-only";
import { z } from "zod";
import type { ApplicationContext } from "./context";
import { ApplicationError } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { assertApplicationPermission } from "./context";
import { can } from "../authz";
import { daemonConfigBody, updateDaemonRoute } from "@/app/api/platform/sftp/daemon/route";

const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

function assertPlatformSuperAdmin(context: ApplicationContext): void {
  assertApplicationPermission(context, "*");
  if (!context.authz.user.isSuperAdmin)
    throw new ApplicationError("forbidden", "Platform super-admin access is required", 403);
}

export const ADMIN_PLATFORM_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "update_sftp_daemon",
    title: "Update Platform SFTP Daemon",
    description:
      "Enable or disable the installation-wide SFTP listener or change its port and advertised host. This requires platform super-admin authority; inspect the platform console to verify the active daemon settings.",
    inputSchema: daemonConfigBody.extend({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "*"),
    execute: async (context, input) => {
      assertPlatformSuperAdmin(context);
      const { idempotencyKey: _idempotencyKey, ...body } = input;
      const response = await updateDaemonRoute(context.authz, body);
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        throw new ApplicationError(
          "internal_error",
          String(payload.error ?? "The SFTP listener could not be reconciled"),
          response.status,
          payload,
        );
      }
      const result = (await response.json()) as Record<string, unknown>;
      return { ok: true, ...result, href: "/platform" };
    },
  }),
];
