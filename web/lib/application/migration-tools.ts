import "server-only";
import { z } from "zod";
import { can, type Authz } from "../authz";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, forbidden, invalidInput } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { MIGRATION_PATHS } from "../migration/plan-model";
import { MigrationPlanRefusal, recordGoLive, updateMigrationPlan } from "../migration/plan";
import { loadJourneyFacts, measureCutoverChecks } from "../migration/journey";
import { draftOpeningBalances, OpeningBalanceRefusal } from "../migration/opening-balances";
import { requestConnectionRun } from "../sync/connection-run";
import { updateConnection } from "../sync/connection-update";
import { commandTransfer } from "../data-io/transfer-commands";
import { loadTransfer } from "../data-io/transfer-store";
import { TransferRefusal } from "../data-io/transfer-contract";
import { MIGRATION_WORKSPACE_HREF } from "../migration/links";

/**
 * Migration commands for the assistant and MCP. Each one terminates in the
 * native command the corresponding screen uses — the plan writer, the
 * connection run and update commands, the durable import transfer, and the
 * manual journal writer — so the conversation can never bypass a refusal,
 * an approval or an audit record those screens enforce.
 */

const UUID = z.string().regex(UUID_RE).describe("UUID copied from a migration or import tool result; never invent one.");
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Calendar date (YYYY-MM-DD).");
const IDEMPOTENCY_KEY = z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/).describe("Unique retry key for this exact mutation.");
const COLUMN = z.string().min(1).max(200).describe("A header exactly as inspect_import_file returned it.");

const setupAdmin = (authz: Authz) => can(authz, "admin.setup.manage");

/** Organization-wide migration state is configured only by unrestricted administrators. */
function assertMigrationAdmin(context: ApplicationContext): void {
  assertApplicationPermission(context, "admin.setup.manage");
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
}

/** Domain refusals keep their own message, status and remedy on the way to the operator. */
function settleRefusal(error: unknown): never {
  if (error instanceof MigrationPlanRefusal || error instanceof OpeningBalanceRefusal || error instanceof TransferRefusal) {
    const status = error.status
    const details: Record<string, unknown> = {}
    if (error instanceof MigrationPlanRefusal && error.field) details.field = error.field
    if (error instanceof OpeningBalanceRefusal && error.issues.length) details.issues = error.issues.slice(0, 20)
    if (status === 403) throw new ApplicationError("forbidden", error.message, 403, details)
    if (status === 404) throw new ApplicationError("not_found", error.message, 404, details)
    if (status === 409) throw conflict(error.message, details)
    throw invalidInput(error.message, details)
  }
  throw error
}

function settleOutcome(outcome: { status: number; body: Record<string, unknown> }): Record<string, unknown> {
  if (outcome.status < 300) return outcome.body
  const message = typeof outcome.body.error === "string"
    ? outcome.body.error
    : typeof outcome.body.errorCode === "string" ? runRefusalMessage(outcome.body.errorCode) : "request refused"
  switch (outcome.status) {
    case 403: throw new ApplicationError("forbidden", message, 403, outcome.body)
    case 404: throw new ApplicationError("not_found", message, 404, outcome.body)
    case 409: throw conflict(message, outcome.body)
    default: throw invalidInput(message, outcome.body)
  }
}

function runRefusalMessage(code: string): string {
  switch (code) {
    case "CONNECTION_NOT_FOUND": return "That connection does not exist in this organization."
    case "CONNECTION_UNCONFIGURED": return "The connection has no credentials yet — finish connecting it on the Migration & Sync page."
    case "RUN_ALREADY_ACTIVE": return "A run for this connection is already queued or running — wait for it to finish, then try again."
    case "CONNECTION_CHANGED": return "The connection changed while the run was being queued — retry against the current configuration."
    case "ATTACHMENTS_UNSUPPORTED":
    case "PROJECT_FINANCIALS_UNSUPPORTED": return "That run mode is not supported for this connection's source."
    default: return code
  }
}

const planChange = z.object({
  path: z.enum(MIGRATION_PATHS).nullable().optional()
    .describe("mirror = keep syncing from the old system; cutover = migrate via connector then go live; spreadsheet = files; fresh = no history"),
  sourceSystem: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/).nullable().optional()
    .describe("Connector key from list_migration_sources, or spreadsheet / other"),
  sourceLabel: z.string().max(120).nullable().optional().describe("The previous system's name when it has no connector"),
  connectionId: UUID.nullable().optional(),
  cutoverDate: DATE.nullable().optional().describe("First day kept in these books rather than the previous system"),
  openingBalanceAccountId: UUID.nullable().optional().describe("Clearing account used by both opening open items and the opening trial balance"),
  notes: z.string().max(4000).nullable().optional().describe("Agreed scope decisions: history depth, exclusions, owners, dates"),
});

export const MIGRATION_APPLICATION_TOOLS: readonly ApplicationToolDefinition[] = [
  definition({
    name: "update_migration_plan", title: "Update Migration Plan",
    description: "Record the migration path, source system, connection, cutover date, opening-balance clearing account or scope notes (only passed fields change). Audited. Refuses unknown references and changes to path or cutover after go-live.",
    inputSchema: planChange.extend({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: setupAdmin,
    execute: async (context, input) => {
      assertMigrationAdmin(context);
      const { idempotencyKey: _key, ...change } = input;
      if (Object.values(change).every((value) => value === undefined)) throw invalidInput("Name at least one plan field to change.");
      try {
        const { before, after } = await updateMigrationPlan({ orgId: context.authz.user.orgId, id: context.authz.user.id }, change, "migration plan updated");
        return { ok: true, before, plan: after, href: MIGRATION_WORKSPACE_HREF };
      } catch (error) { settleRefusal(error); }
    },
  }),
  definition({
    name: "start_migration_run", title: "Start Migration Run",
    description: "Queue a connector run: preflight (read-only rehearsal against the source), full_migration (load all history through the posting engine, then verify trial balance and open items), or mirror (incremental sync). Refuses while another run is active. Progress appears on the migration plan.",
    inputSchema: z.object({
      connectionId: UUID,
      mode: z.enum(["preflight", "full_migration", "mirror"]).describe("preflight = read-only rehearsal; full_migration = load and verify all history; mirror = incremental sync"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false, destructive: false, openWorld: true, assistantConfirmation: "always", visibleTo: (authz) => can(authz, "sync.run"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "sync.run");
      if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
      const body = settleOutcome(await requestConnectionRun({ orgId: context.authz.user.orgId, userId: context.authz.user.id }, input.connectionId, input.mode));
      return { ok: true, queued: true, ...body, href: "/sync" };
    },
  }),
  definition({
    name: "set_connection_mirror", title: "Set Connection Mirror",
    description: "Turn a connection's scheduled mirror on or off, set its schedule, or pause/resume the connection. Stopping the mirror is the cutover step that makes these books the system of record. Audited.",
    inputSchema: z.object({
      connectionId: UUID,
      mirrorEnabled: z.boolean().optional().describe("true runs the scheduled mirror; false stops it"),
      mirrorSchedule: z.enum(["hourly", "every_6_hours", "daily", "weekly"]).optional().describe("How often the mirror runs"),
      status: z.enum(["active", "paused"]).optional().describe("paused stops every run for the connection"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: setupAdmin,
    execute: async (context, input) => {
      assertMigrationAdmin(context);
      const { connectionId, idempotencyKey: _key, ...patch } = input;
      if (Object.values(patch).every((value) => value === undefined)) throw invalidInput("Name the mirror setting or status to change.");
      settleOutcome(await updateConnection({ orgId: context.authz.user.orgId, userId: context.authz.user.id }, connectionId, patch));
      return { ok: true, connectionId, ...patch, href: "/sync" };
    },
  }),
  definition({
    name: "prepare_import", title: "Validate Import File",
    description: "Point a staged import file at a resource and start validation (a dry run that changes no records). Then read the outcome with inspect_import_file; a clean preview yields the approvalHash commit_import needs. Mapping is source header → field key.",
    inputSchema: z.object({
      transferId: UUID,
      resource: z.string().min(1).max(200).describe("Resource key from list_import_templates"),
      mapping: z.record(z.string(), z.string()).describe("Source header → field key; omit unmapped headers"),
      importMode: z.enum(["insert", "upsert"]).optional().describe("upsert (default) updates records matched by their natural key"),
      post: z.boolean().optional().describe("Transactions only: post after creating (default false keeps drafts)"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "never", visibleTo: (authz) => can(authz, "data.import"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "data.import");
      try {
        let job = await loadTransfer(context.authz.user.orgId, input.transferId);
        if (job.resource !== input.resource) {
          await commandTransfer(context.authz, job.id, { action: "select-resource", revision: job.revision, resource: input.resource });
          job = await loadTransfer(context.authz.user.orgId, input.transferId);
        }
        const next = await commandTransfer(context.authz, job.id, {
          action: "preview", revision: job.revision,
          options: { mapping: input.mapping, importMode: input.importMode ?? "upsert", post: input.post ?? false },
        });
        return { ok: true, transferId: next.id, state: next.state, resource: next.resource, href: `/data/import?transfer=${next.id}` };
      } catch (error) { settleRefusal(error); }
    },
  }),
  definition({
    name: "commit_import", title: "Import Records",
    description: "Commit a validated import whose preview has no failed rows, through the resource's native services. Batches commit in order; a refused batch rolls back and earlier batches remain. Pass the approvalHash from inspect_import_file.",
    inputSchema: z.object({
      transferId: UUID,
      approvalHash: z.string().regex(/^[a-f0-9]{64}$/).describe("approvalHash from inspect_import_file after a clean preview"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: (authz) => can(authz, "data.import"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "data.import");
      try {
        const job = await loadTransfer(context.authz.user.orgId, input.transferId);
        const next = await commandTransfer(context.authz, job.id, { action: "commit", revision: job.revision, approvalHash: input.approvalHash });
        return { ok: true, transferId: next.id, state: next.state, resource: next.resource, totalRows: next.totalRows, href: `/data/import?transfer=${next.id}` };
      } catch (error) { settleRefusal(error); }
    },
  }),
  definition({
    name: "draft_opening_balances", title: "Draft Opening Balance Journal",
    description: "Create a DRAFT journal from a staged trial-balance file (review it first with preview_opening_balances). Refuses unresolved accounts, non-decimal amounts and an unbalanced file unless an explicit balancing account is named. The user posts the draft from the journal screen.",
    inputSchema: z.object({
      transferId: UUID,
      columns: z.object({
        account: COLUMN,
        debit: COLUMN.optional(),
        credit: COLUMN.optional(),
        amount: COLUMN.optional().describe("One signed, debit-positive column instead of debit/credit"),
        description: COLUMN.optional(),
      }).describe("Which file columns hold the account and the amounts"),
      excludeRows: z.array(z.number().int().positive()).max(200).optional().describe("Row numbers to leave out, e.g. a totals row"),
      documentDate: DATE.describe("The day before the cutover date"),
      memo: z.string().max(500).optional().describe("Journal memo; defaults to the opening-balance date"),
      subsidiaryId: UUID.optional(),
      balancingAccountId: UUID.optional().describe("Only when the user explicitly chose where an out-of-balance difference belongs"),
    accountRemap: z.array(z.object({
      from: z.string().min(1).max(200).describe("Account cell text exactly as it appears in the file"),
      toAccountId: UUID,
    })).max(50).optional().describe("Re-point rows to another account, e.g. the AR/AP control lines to the opening clearing account"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: (authz) => setupAdmin(authz) && authz.allowedSubsidiaryIds === null && can(authz, "gl.post") && can(authz, "data.import"),
    execute: async (context, input) => {
      assertMigrationAdmin(context);
      assertApplicationPermission(context, "gl.post");
      const { idempotencyKey, ...request } = input;
      try {
        return { ok: true, ...await draftOpeningBalances(context.authz, request, idempotencyKey) };
      } catch (error) { settleRefusal(error); }
    },
  }),
  definition({
    name: "record_go_live", title: "Record Go-Live",
    description: "Measure the cutover checks and, only if every required check passes, record that these books are live from the cutover date with the measured evidence. Refuses on a mirror path, without a cutover date, or with any failing or unmeasured required check. Recorded once.",
    inputSchema: z.object({
      confirmation: z.string().trim().min(5).max(500).describe("The user's own words confirming go-live"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false, destructive: false, openWorld: false, assistantConfirmation: "always", visibleTo: setupAdmin,
    execute: async (context, input) => {
      assertMigrationAdmin(context);
      const orgId = context.authz.user.orgId;
      try {
        const { after } = await recordGoLive(
          { orgId, id: context.authz.user.id },
          async () => measureCutoverChecks(orgId, await loadJourneyFacts(orgId)),
          `went live: ${input.confirmation}`,
        );
        return { ok: true, goLive: after.goLive, href: MIGRATION_WORKSPACE_HREF };
      } catch (error) { settleRefusal(error); }
    },
  }),
];
