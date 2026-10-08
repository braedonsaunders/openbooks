import "server-only";
import { z } from "zod";
import { can, type Authz } from "../authz";
import { SOURCE_TYPES } from "@openbooks/engine/sync";
import { getResource, listResources } from "../data-io/resources";
import { loadTransfer, transferAuthority } from "../data-io/transfer-store";
import { TransferRefusal } from "../data-io/transfer-contract";
import { rankResources, type ResourceCandidate } from "../data-io/resource-match";
import { templateFields } from "../data-io/templates";
import { templateHref } from "../data-io/template-links";
import { loadMigrationJourney } from "../migration/journey";
import { goLiveBlockers } from "../migration/plan-model";
import { OpeningBalanceRefusal, previewOpeningBalances } from "../migration/opening-balances";
import { connectSourceHref, MIGRATION_WORKSPACE_HREF } from "../migration/links";
import type { AssistantToolDef, ToolResult } from "./types";
import { uuidInput } from "./tools-shared";

/**
 * Read tools for migrating into these books: the measured migration plan,
 * the connectors available, import templates, staged files, the opening
 * trial balance preview, and the cutover checks. Every change they lead to
 * is a separate reviewed command (see application/migration-tools.ts).
 */

const migrationAdmin = (authz: Authz): ToolResult | null =>
  authz.allowedSubsidiaryIds !== null
    ? { ok: false, error: "Migration planning is organization-wide and needs unrestricted subsidiary access." }
    : null;

/** The connector-independent sequence a migration loads master data and open items in. */
const RECOMMENDED_IMPORT_ORDER = [
  "accounts",
  "departments",
  "classes",
  "locations",
  "payment-terms",
  "tax-codes",
  "parties",
  "items",
  "txn:customer_invoice",
  "txn:customer_credit",
  "txn:vendor_bill",
  "txn:vendor_credit",
  "fixed-assets",
  "payroll-opening-balances",
];

const getMigrationPlanTool: AssistantToolDef = {
  name: "get_migration_plan",
  description:
    "The organization's migration plan and journey, measured live: chosen path, source, cutover date, readiness, connections with their latest preflight/migration/mirror runs (trial-balance and open-item verification counts), committed imports, the opening journal, and each stage's state. Read-only. Call this first in any migration conversation.",
  category: "read",
  gate: { mode: "anyOf", perms: ["admin.setup.manage"] },
  inputSchema: z.object({}),
  execute: async (_raw, authz): Promise<ToolResult> => {
    const denied = migrationAdmin(authz);
    if (denied) return denied;
    const journey = await loadMigrationJourney(authz.user.orgId);
    const current = journey.stages.find((stage) => stage.state === "current") ?? null;
    return {
      ok: true,
      data: {
        href: MIGRATION_WORKSPACE_HREF,
        plan: journey.plan,
        currentStage: current?.key ?? null,
        stages: journey.stages,
        readiness: { profileReady: journey.facts.profileReady, foundationReady: journey.facts.foundationReady, bookStart: journey.facts.bookStart },
        counts: journey.facts.counts,
        connections: journey.facts.connections,
        selectedConnectionId: journey.facts.connection?.id ?? null,
        runs: journey.facts.runs,
        imports: journey.facts.imports,
        openingJournal: journey.facts.openingJournal,
      },
    };
  },
};

const listMigrationSourcesTool: AssistantToolDef = {
  name: "list_migration_sources",
  description:
    "Systems these books can migrate from or mirror through a connector: key, name, how it authenticates, what the operator must prepare in the source system, the fields the secure connection form asks for (labels only — never ask for credentials in chat), and the link that opens that form. Systems without a connector migrate by spreadsheet. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["admin.setup.manage", "sync.run"] },
  inputSchema: z.object({}),
  execute: async (): Promise<ToolResult> => ({
    ok: true,
    data: {
      sources: SOURCE_TYPES.map((type) => ({
        key: type.source,
        name: type.displayName,
        authKind: type.authKind,
        preparation: type.blurb,
        oauthSteps: type.oauthSetup?.steps ?? [],
        portal: type.oauthSetup ? { url: type.oauthSetup.portalUrl, label: type.oauthSetup.portalLabel } : null,
        settings: type.configFields.map((field) => ({ label: field.label, required: field.required === true, help: field.help ?? null })),
        credentials: type.secretFields.map((field) => field.label),
        connectHref: connectSourceHref(type.source),
      })),
      spreadsheet: {
        key: "spreadsheet",
        description: "Any other system: export lists and balances to CSV or Excel, then import them with the templates from list_import_templates.",
        templatesHref: "/data/import",
      },
      note: "Credentials are entered only in the connection form behind connectHref, where they are sealed; they never pass through this conversation.",
    },
  }),
};

const listImportTemplatesTool: AssistantToolDef = {
  name: "list_import_templates",
  description:
    "Importable resources with downloadable Excel/CSV templates generated from their live fields, in the order a migration should load them. Pass resource to get that template's fields (key, label, kind, required, how references are named, allowed values). Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["data.import"] },
  inputSchema: z.object({
    resource: z.string().min(1).max(200).optional().describe("Resource key to describe in full"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const { resource } = raw as { resource?: string };
    if (resource) {
      const found = await getResource(authz.user.orgId, resource, authz.allowedSubsidiaryIds);
      if (!found || !found.descriptor.supportsImport || !can(authz, found.descriptor.writePermission)) {
        return { ok: false, error: `No importable resource "${resource}" is available to you — call list_import_templates without a resource for the list.` };
      }
      return {
        ok: true,
        data: {
          key: found.descriptor.key,
          label: found.descriptor.label,
          group: found.descriptor.group,
          naturalKey: found.descriptor.naturalKey ?? null,
          canPost: found.descriptor.canPost === true,
          xlsx: templateHref(found.descriptor.key, "xlsx"),
          csv: templateHref(found.descriptor.key, "csv"),
          fields: templateFields(await found.fields()),
        },
      };
    }
    const all = (await listResources(authz.user.orgId)).filter((descriptor) => descriptor.supportsImport && can(authz, descriptor.writePermission));
    const keys = new Set(all.map((descriptor) => descriptor.key));
    return {
      ok: true,
      data: {
        importHref: "/data/import",
        recommendedOrder: RECOMMENDED_IMPORT_ORDER.filter((key) => keys.has(key)),
        openingTrialBalance: "Opening balances are not a template: stage the trial-balance file, then use preview_opening_balances and draft_opening_balances.",
        resources: all.map((descriptor) => ({
          key: descriptor.key,
          label: descriptor.label,
          group: descriptor.group,
          xlsx: templateHref(descriptor.key, "xlsx"),
        })),
      },
    };
  },
};

const SAMPLE_ROWS = 5;
const MAX_CELL = 120;

function compactRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith("__")) continue;
    out[key] = typeof value === "string" && value.length > MAX_CELL ? `${value.slice(0, MAX_CELL)}…` : value;
  }
  return out;
}

const inspectImportFileTool: AssistantToolDef = {
  name: "inspect_import_file",
  description:
    "Read a staged import file the user attached (by transferId): state, columns, row count, sample rows, the resources whose fields best match its columns with a suggested mapping, and — after prepare_import — the validation outcome, row errors and the approvalHash needed to commit. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["data.import"] },
  inputSchema: z.object({
    transferId: uuidInput,
    rankResources: z.boolean().optional().describe("Rank importable resources against the columns (default true while the file is unvalidated)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const { transferId, rankResources: rank } = raw as { transferId: string; rankResources?: boolean };
    try {
      const job = await loadTransfer(authz.user.orgId, transferId);
      await transferAuthority(job, authz);
      if (job.kind !== "import") return { ok: false, error: "That transfer is an export, not an import file." };
      const staged = ["mapping", "previewing", "ready", "committing", "completed"].includes(job.state);
      let candidates: ReturnType<typeof rankResources> = [];
      if (staged && (rank ?? !["ready", "committing", "completed"].includes(job.state))) {
        const descriptors = (await listResources(authz.user.orgId)).filter((descriptor) => descriptor.supportsImport && can(authz, descriptor.writePermission));
        const resolved: ResourceCandidate[] = [];
        for (const descriptor of descriptors) {
          const resource = await getResource(authz.user.orgId, descriptor.key, authz.allowedSubsidiaryIds);
          if (resource) resolved.push({ key: descriptor.key, label: descriptor.label, group: descriptor.group, fields: await resource.fields() });
        }
        candidates = rankResources(job.headers, resolved, 5);
      }
      return {
        ok: true,
        data: {
          transferId: job.id,
          filename: job.filename,
          state: job.state,
          stagedResource: job.resource,
          totalRows: job.totalRows,
          processedRows: job.processedRows,
          headers: job.headers,
          sample: job.sample.slice(0, SAMPLE_ROWS).map(compactRow),
          error: job.error,
          mapping: job.options.mapping ?? null,
          preview: job.state === "ready" || job.state === "previewing" || job.state === "committing" || job.state === "completed"
            ? { created: job.preview.created, updated: job.preview.updated, failed: job.preview.failed, errors: job.preview.errors.slice(0, 20), warnings: (job.preview.warnings ?? []).slice(0, 10) }
            : null,
          outcome: job.state === "completed" || job.state === "committing" ? { created: job.outcome.created, updated: job.outcome.updated, failed: job.outcome.failed } : null,
          approvalHash: job.state === "ready" && job.preview.failed === 0 ? job.approvalHash : null,
          candidates,
          href: `/data/import?transfer=${job.id}`,
          note: staged ? undefined : "The file is still uploading or being read; inspect it again shortly.",
        },
      };
    } catch (error) {
      if (error instanceof TransferRefusal) return { ok: false, error: error.message };
      throw error;
    }
  },
};

const previewOpeningBalancesTool: AssistantToolDef = {
  name: "preview_opening_balances",
  description:
    "Build — without writing — the opening journal a staged trial-balance file would produce: totals, line count, resolved accounts for the first lines, and any refusal (unknown account, formatted amount, out of balance). Use before draft_opening_balances. Read-only.",
  category: "read",
  gate: { mode: "allOf", perms: ["admin.setup.manage", "gl.post", "data.import"] },
  inputSchema: z.object({
    transferId: uuidInput,
    columns: z.object({
      account: z.string().min(1).max(200),
      debit: z.string().min(1).max(200).optional(),
      credit: z.string().min(1).max(200).optional(),
      amount: z.string().min(1).max(200).optional().describe("One signed, debit-positive column instead of debit/credit"),
      description: z.string().min(1).max(200).optional(),
    }).describe("Which file columns hold the account and the amounts, as inspect_import_file named them"),
    excludeRows: z.array(z.number().int().positive()).max(200).optional().describe("Row numbers to leave out, e.g. a totals row"),
    documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("The day before the cutover date"),
    balancingAccountId: uuidInput.optional(),
    accountRemap: z.array(z.object({
      from: z.string().min(1).max(200).describe("Account cell text exactly as it appears in the file"),
      toAccountId: uuidInput,
    })).max(50).optional().describe("Re-point rows to another account, e.g. the AR/AP control lines to the opening clearing account"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    try {
      const preview = await previewOpeningBalances(authz, raw as Parameters<typeof previewOpeningBalances>[1]);
      return {
        ok: true,
        data: {
          documentDate: preview.documentDate,
          lineCount: preview.lines.length + (preview.balancingLine ? 1 : 0),
          totalDebits: preview.totalDebits,
          totalCredits: preview.totalCredits,
          difference: preview.net,
          balancingLine: preview.balancingLine,
          skippedZeroRows: preview.skippedZeroRows,
          firstLines: preview.lines.slice(0, 12).map((line) => ({ row: line.rowNo, account: line.accountLabel, amount: line.amount })),
        },
      };
    } catch (error) {
      if (error instanceof OpeningBalanceRefusal || error instanceof TransferRefusal) {
        return { ok: false, error: error.message };
      }
      throw error;
    }
  },
};

const runCutoverChecksTool: AssistantToolDef = {
  name: "run_cutover_checks",
  description:
    "Measure the final checks before go-live for the plan's path: foundation, cutover date, last verified source run and its coverage through the cutover, mirror stopped, opening journal posted, clearing account at zero, receivables and payables tied to open documents, and pre-cutover periods locked. Reports which required checks block record_go_live. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["admin.setup.manage"] },
  inputSchema: z.object({}),
  execute: async (_raw, authz): Promise<ToolResult> => {
    const denied = migrationAdmin(authz);
    if (denied) return denied;
    const journey = await loadMigrationJourney(authz.user.orgId, { includeChecks: true });
    const checks = journey.checks ?? [];
    const blockers = goLiveBlockers(checks);
    return {
      ok: true,
      data: {
        path: journey.plan.path,
        cutoverDate: journey.plan.cutoverDate,
        goLive: journey.plan.goLive,
        readyToGoLive: journey.plan.path !== null && journey.plan.path !== "mirror" && checks.length > 0 && blockers.length === 0 && !journey.plan.goLive,
        blockers: blockers.map((check) => check.key),
        checks,
        measuredAt: journey.measuredAt,
      },
    };
  },
};

export const MIGRATION_TOOLS: AssistantToolDef[] = [
  getMigrationPlanTool,
  listMigrationSourcesTool,
  listImportTemplatesTool,
  inspectImportFileTool,
  previewOpeningBalancesTool,
  runCutoverChecksTool,
];
