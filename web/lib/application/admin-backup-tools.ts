import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { can } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, forbidden, invalidInput } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { queueBackupAction } from "@/app/api/admin/backups/run/route";

const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

function assertBackupAdmin(context: ApplicationContext) {
  assertApplicationPermission(context, "admin.backups.manage");
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
}

async function routePayload(response: Response): Promise<Record<string, unknown>> {
  if (response.ok) return (await response.json()) as Record<string, unknown>;
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const message = typeof body.error === "string" ? body.error : "Backup operation failed";
  if (response.status === 403) throw new ApplicationError("forbidden", message, 403, body);
  if (response.status === 404) throw new ApplicationError("not_found", message, 404, body);
  if (response.status === 409) throw conflict(message, body);
  if (response.status >= 500)
    throw new ApplicationError("internal_error", message, response.status, body);
  throw invalidInput(message, body);
}

export const ADMIN_BACKUP_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_backup_runs",
    title: "List Backup Runs",
    description:
      "Read the latest backup run ledger, including status and retention evidence. Backup contents and download streams are not returned; manage retention and deletion in the browser.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.backups.manage"),
    execute: async (context) => {
      assertBackupAdmin(context);
      const runs = await db.execute<Record<string, unknown>>(
        sql`
        select id, kind, status, file_name, byte_size, table_count, row_count, sha256,
               error, purged_at, purge_reason, created_at, completed_at
          from backup_runs
         where org_id = ${context.authz.user.orgId}
         order by (status = 'completed' and purged_at is null) desc, created_at desc
         limit 100
      `,
        "objects",
      );
      const policies = await db.execute<Record<string, unknown>>(
        sql`
        select enabled, frequency, hour_utc, day_of_week, day_of_month, max_keep,
               last_run_at, next_run_at
          from backup_policies where org_id = ${context.authz.user.orgId}
      `,
        "objects",
      );
      return { runs, policy: policies[0] ?? null, href: "/admin/backups" };
    },
  }),
  definition({
    name: "run_backup_now",
    title: "Run Backup Now",
    description:
      "Queue an organization backup immediately. Use list_backup_runs to verify the run id and follow its status; the native queue refuses when storage is unavailable or another run is active.",
    inputSchema: z.object({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.backups.manage"),
    execute: async (context) => {
      assertBackupAdmin(context);
      const result = await routePayload(await queueBackupAction(context.authz));
      const runId = String(result.runId ?? "");
      return {
        ok: true,
        ...result,
        href: runId ? `/admin/backups?run=${runId}` : "/admin/backups",
      };
    },
  }),
];
