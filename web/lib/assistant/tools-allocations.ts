import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { can, type Authz } from "../authz";
import { entryDetail } from "../data";
import { isFeatureEnabled } from "../features";
import { ReportBookSelectionError, reportBookSelection } from "../report-books";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import type { AssistantToolDef, ToolResult } from "./types";
import {
  compactRows,
  periodPresetInput,
  resolveToolRange,
  uuidInput,
  type RangeArgs,
} from "./tools-shared";
// NOTE (fleet worktree): @openbooks/* resolves to the MAIN checkout through
// the shared node_modules symlink, so worktree engine code is imported via
// relative paths (the route-test precedent). Identical after cherry-pick.
import {
  AllocationRuleError,
  getRuleDetail,
  getRuleVersion,
  listRuleHeads,
} from "../../../engine/src/allocations/rules.ts";
import {
  DriverAdminError,
  getDimensionValueLabels,
  getDriver,
  listDrivers,
  vectorShares,
} from "../../../engine/src/allocations/driver-admin.ts";
import {
  DriverNotAvailableError,
  previewDriverVector,
} from "../../../engine/src/allocations/drivers.ts";
import {
  postDriverResolver,
  runDriverReport,
} from "../../../engine/src/allocations/report-runner.ts";
import { previewAllocationRun } from "../../../engine/src/allocations/period-run.ts";
import {
  allocationScopeVisible,
  previewPinError,
} from "../../../engine/src/allocations/subsidiary-scope.ts";
import {
  RunQueryError,
  getRun,
  listRuns,
  queryLineage,
  validateLineageAnchor,
} from "../../../engine/src/allocations/run-queries.ts";

/**
 * Allocation-kernel read tools for the agentic assistant (A13). Every tool
 * calls the SAME engine service the Setup screens and API routes call —
 * `listRuleHeads` (rules list route), `getRuleDetail`/`getRuleVersion`
 * (rule drawer), `listDrivers` + `previewDriverVector` with the engine
 * report runner (drivers tab + preview route), `previewAllocationRun` with
 * the posting path's composed driver resolver (runs preview route),
 * `listRuns`/`getRun`/`queryLineage` (runs list, run drawer, lineage
 * drill) — under the same gates: the `allocations` feature switch plus
 * `allocations.read` for reads, and `allocations.run` for preview (the same
 * persist the HTTP preview route writes), with the actor's subsidiary scope
 * carried into run reads exactly as the routes carry it.
 *
 * preview_allocation computes and stores a `previewed` run row — the same
 * write as the Setup Preview button — so it is a write tool gated on
 * `allocations.run`. It never posts, reverses, or re-runs.
 */

const ALLOCATIONS_HREF = "/admin/setup/allocations";

/** Feature-off hides the module exactly as the routes 404 it. */
async function allocationsOff(authz: Authz): Promise<ToolResult | null> {
  if (!(await isFeatureEnabled(authz.user.orgId, "allocations"))) {
    return { ok: false, error: "allocations_feature_disabled" };
  }
  return null;
}

const ruleKeyInput = z.string().max(120)
  .describe("Rule key slug from list_allocation_rules; exactly one of ruleId or ruleKey");
const driverKeyInput = z.string().max(120)
  .describe("Driver key slug from list_allocation_drivers; exactly one of driverId or driverKey");

/** Rule id from either address form (the drawer links by id, prose by key). */
async function resolveRuleId(
  orgId: string,
  a: { ruleId?: string; ruleKey?: string },
): Promise<string | ToolResult> {
  if ((a.ruleId === undefined) === (a.ruleKey === undefined)) {
    return { ok: false, error: "rule_id_or_key_required" };
  }
  if (a.ruleId !== undefined) return a.ruleId;
  const heads = await listRuleHeads(orgId);
  const found = heads.find((head) => head.rule.key === a.ruleKey);
  if (!found) return { ok: false, error: "allocation_rule_not_found" };
  return found.rule.id;
}

/** Driver id from either address form. */
async function resolveDriverId(
  orgId: string,
  a: { driverId?: string; driverKey?: string },
): Promise<string | ToolResult> {
  if ((a.driverId === undefined) === (a.driverKey === undefined)) {
    return { ok: false, error: "driver_id_or_key_required" };
  }
  if (a.driverId !== undefined) {
    const driver = await getDriver(orgId, a.driverId);
    if (!driver) return { ok: false, error: "allocation_driver_not_found" };
    return driver.id;
  }
  const drivers = await listDrivers(orgId, { includeInactive: true });
  const found = drivers.find((driver) => driver.key === a.driverKey);
  if (!found) return { ok: false, error: "allocation_driver_not_found" };
  return found.id;
}

/** End date of a fiscal preset window, resolved like the other date tools. */
async function resolvePresetEnd(
  orgId: string,
  preset: string,
): Promise<string | ToolResult> {
  const range = await resolveToolRange(orgId, { period: preset } as RangeArgs);
  if ("error" in range) return { ok: false, error: range.error };
  return range.to;
}

/**
 * One accounting period from either address form: an explicit period id, or
 * a fiscal preset resolved server-side — the accounting period holding the
 * preset window's end date. A miss fails closed (never a neighbouring
 * period): the caller picks an explicit period id instead.
 */
async function resolveAllocationPeriodId(
  orgId: string,
  a: { periodId?: string; period?: string },
): Promise<string | ToolResult> {
  if ((a.periodId === undefined) === (a.period === undefined)) {
    return { ok: false, error: "period_id_or_preset_required" };
  }
  if (a.periodId !== undefined) return a.periodId;
  const end = await resolvePresetEnd(orgId, a.period!);
  if (typeof end !== "string") return end;
  const rows = await db.execute<{ id: string }>(sql`
    select id::text as id from accounting_periods
     where org_id = ${orgId} and starts_on <= ${end} and ${end} <= ends_on
     order by is_adjustment, starts_on desc limit 1`);
  const found = rows.rows[0];
  if (!found) return { ok: false, error: "period_not_found" };
  return found.id;
}

/**
 * Preview/computation failures are operator-written refusal text (inactive
 * rule, no version in effect, stepped basis, empty target set, a report
 * driver the actor may not run) — the model needs the reason, not an
 * opaque tool_failed. Identity failures become stable not-found codes.
 */
function previewFailure(error: unknown): ToolResult {
  if (error instanceof ReportBookSelectionError) return { ok: false, error: "accounting_book_not_found" };
  if (error instanceof DriverAdminError) {
    if (error.code === "not_found") return { ok: false, error: "allocation_driver_not_found" };
    return { ok: false, error: error.message.slice(0, 400) };
  }
  if (error instanceof DriverNotAvailableError) return { ok: false, error: error.message.slice(0, 400) };
  if (error instanceof Error) {
    const message = error.message;
    if (/^allocation rule .* does not belong/.test(message)) return { ok: false, error: "allocation_rule_not_found" };
    if (/^accounting period .* does not belong/.test(message)) return { ok: false, error: "period_not_found" };
    if (/^accounting book .* does not belong/.test(message)) return { ok: false, error: "accounting_book_not_found" };
    if (/^subsidiary .* does not belong/.test(message)) return { ok: false, error: "subsidiary_not_found" };
    if (/^allocation driver .* does not belong/.test(message)) {
      return { ok: false, error: "allocation_driver_not_found" };
    }
    return { ok: false, error: message.slice(0, 400) };
  }
  return { ok: false, error: "tool_failed" };
}

const listAllocationRules: AssistantToolDef = {
  name: "list_allocation_rules",
  tier: "module",
  description:
    "Allocation rule heads: key, name, mode, active flag, current published-version summary. Filter by mode or active rules; use get_allocation_rule for versions and targets. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["allocations.read"] },
  feature: "allocations",
  inputSchema: z.object({
    mode: z.enum(["entry", "post", "period"]).optional().describe("Only rules bound at this moment; omit for all modes"),
    activeOnly: z.boolean().optional().describe("Only active rules; default lists active and inactive"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const off = await allocationsOff(authz);
    if (off) return off;
    const a = raw as { mode?: "entry" | "post" | "period"; activeOnly?: boolean };
    const heads = await listRuleHeads(authz.user.orgId, { mode: a.mode, activeOnly: a.activeOnly });
    const rows = heads.map((head) => ({
      id: head.rule.id,
      key: head.rule.key,
      name: head.rule.name,
      description: head.rule.description,
      mode: head.rule.mode,
      sortOrder: head.rule.sortOrder,
      isActive: head.rule.isActive,
      isSystem: head.rule.isSystem,
      currentVersion: head.currentVersion,
    }));
    const paged = compactRows(rows);
    return {
      ok: true,
      data: { ...paged, rules: paged.items, href: ALLOCATIONS_HREF },
    };
  },
};

const getAllocationRule: AssistantToolDef = {
  name: "get_allocation_rule",
  tier: "module",
  description:
    "One allocation rule by id or key: head, current published version with its targets, and the version timeline. Resolve the key with list_allocation_rules first. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["allocations.read"] },
  feature: "allocations",
  inputSchema: z.object({
    ruleId: uuidInput.optional().describe("Rule id from list_allocation_rules"),
    ruleKey: ruleKeyInput.optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const off = await allocationsOff(authz);
    if (off) return off;
    const a = raw as { ruleId?: string; ruleKey?: string };
    const resolved = await resolveRuleId(authz.user.orgId, a);
    if (typeof resolved !== "string") return resolved;
    let detail;
    try {
      detail = await getRuleDetail(authz.user.orgId, resolved, authz.allowedSubsidiaryIds);
    } catch (error) {
      if (error instanceof AllocationRuleError && error.code === "NOT_FOUND") {
        return { ok: false, error: "allocation_rule_not_found" };
      }
      throw error;
    }
    const currentId = detail.rule.currentVersionId;
    let currentVersion: unknown = null;
    if (currentId) {
      try {
        const full = await getRuleVersion(authz.user.orgId, currentId, authz.allowedSubsidiaryIds);
        const targets = compactRows(full.targets, { limit: 100 });
        currentVersion = {
          ...full.version,
          targets: targets.items,
          targetTotal: targets.total,
          targetsTruncated: targets.truncated,
        };
      } catch (error) {
        if (error instanceof AllocationRuleError && error.code === "NOT_FOUND") {
          return { ok: false, error: "allocation_rule_not_found" };
        }
        throw error;
      }
    }
    const timeline = compactRows(
      detail.versions.map((entry) => ({
        versionNo: entry.version.versionNo,
        status: entry.version.status,
        effectiveFrom: entry.version.effectiveFrom,
        effectiveTo: entry.version.effectiveTo,
        definitionHash: entry.version.definitionHash,
        targetCount: entry.targetCount,
      })),
      { limit: 50 },
    );
    return {
      ok: true,
      data: {
        rule: detail.rule,
        currentVersion,
        timeline: timeline.items,
        timelineTotal: timeline.total,
        timelineTruncated: timeline.truncated,
        href: ALLOCATIONS_HREF,
      },
    };
  },
};

const listAllocationDrivers: AssistantToolDef = {
  name: "list_allocation_drivers",
  tier: "module",
  description:
    "Allocation driver registry: key, name, dimension, source kind, unit, active flag. Use preview_driver_vector for one driver's weights. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["allocations.read"] },
  feature: "allocations",
  inputSchema: z.object({
    includeInactive: z.boolean().optional().describe("Include inactive drivers; needs allocations.manage like the drivers tab"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const off = await allocationsOff(authz);
    if (off) return off;
    const a = raw as { includeInactive?: boolean };
    // Route parity: the drivers tab only serves inactive rows to managers.
    if (a.includeInactive === true && !can(authz, "allocations.manage")) {
      return { ok: false, error: "forbidden" };
    }
    const drivers = await listDrivers(authz.user.orgId, { includeInactive: a.includeInactive === true });
    const rows = drivers.map((driver) => ({
      id: driver.id,
      key: driver.key,
      name: driver.name,
      description: driver.description,
      unit: driver.unit,
      dimension: driver.dimension,
      sourceKind: driver.sourceKind,
      isActive: driver.isActive,
    }));
    const paged = compactRows(rows);
    return {
      ok: true,
      data: { ...paged, drivers: paged.items, href: ALLOCATIONS_HREF },
    };
  },
};

const previewDriverVectorTool: AssistantToolDef = {
  name: "preview_driver_vector",
  tier: "module",
  description:
    "One driver's apportionment weights as of a period id or fiscal preset: labelled values with exact shares and total. Report-backed drivers run under your reports permission. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["allocations.read"] },
  feature: "allocations",
  inputSchema: z.object({
    driverId: uuidInput.optional().describe("Driver id from list_allocation_drivers"),
    driverKey: driverKeyInput.optional(),
    periodId: uuidInput.optional().describe("Accounting period id; exactly one of periodId or period"),
    period: periodPresetInput.optional().describe("Fiscal preset; the driver reads the window ending on its end date"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const off = await allocationsOff(authz);
    if (off) return off;
    const a = raw as { driverId?: string; driverKey?: string; periodId?: string; period?: string };
    const driverId = await resolveDriverId(authz.user.orgId, a);
    if (typeof driverId !== "string") return driverId;
    let asOf: { periodId: string } | { date: string };
    if ((a.periodId === undefined) === (a.period === undefined)) {
      return { ok: false, error: "period_id_or_preset_required" };
    }
    if (a.periodId !== undefined) {
      asOf = { periodId: a.periodId };
    } else {
      const end = await resolvePresetEnd(authz.user.orgId, a.period!);
      if (typeof end !== "string") return end;
      asOf = { date: end };
    }
    try {
      // Same composition as the drivers-tab preview route: A2's preview
      // with the engine report runner, so report_definition drivers read
      // the same numbers a run would apportion on.
      const result = await previewDriverVector(
        { orgId: authz.user.orgId, driverId, asOf, actorId: authz.user.id },
        { reportRunner: { runReport: runDriverReport } },
      );
      const labels = await getDimensionValueLabels(
        authz.user.orgId,
        result.driver.dimension,
        result.vector.map((entry) => entry.key),
      );
      const shares = vectorShares(new Map(result.vector.map((entry) => [entry.key, entry.value] as [string, string])));
      const rows = result.vector.map((entry) => ({
        id: entry.key,
        label: labels.get(entry.key) ?? entry.key,
        value: entry.value,
        share: shares.get(entry.key) ?? "0.0000",
      }));
      const paged = compactRows(rows);
      return {
        ok: true,
        data: {
          ...paged,
          driver: {
            id: result.driver.id,
            key: result.driver.key,
            name: result.driver.name,
            unit: result.driver.unit,
            dimension: result.driver.dimension,
            sourceKind: result.driver.sourceKind,
            isActive: result.driver.isActive,
          },
          from: result.from,
          to: result.to,
          total: result.total,
          vector: paged.items,
          href: ALLOCATIONS_HREF,
        },
      };
    } catch (error) {
      return previewFailure(error);
    }
  },
};

const RUN_STATUSES = ["previewed", "pending_approval", "posted", "reversed", "failed", "superseded"] as const;

const listAllocationRuns: AssistantToolDef = {
  name: "list_allocation_runs",
  tier: "module",
  description:
    "Allocation runs: rule, period, book, status, source and allocated totals, journal links. Filter by rule, period, book, subsidiary, or status. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["allocations.read"] },
  feature: "allocations",
  inputSchema: z.object({
    ruleId: uuidInput.optional().describe("Only runs of this rule; resolve the key with list_allocation_rules"),
    periodId: uuidInput.optional().describe("Only runs for this accounting period"),
    bookId: uuidInput.optional().describe("Only runs posted to this accounting book"),
    subsidiaryId: uuidInput.optional().describe("Only runs pinned to this subsidiary"),
    status: z.enum(RUN_STATUSES).optional().describe("Only runs in this lifecycle status"),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum runs to return (default 25)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const off = await allocationsOff(authz);
    if (off) return off;
    const a = raw as {
      ruleId?: string; periodId?: string; bookId?: string;
      subsidiaryId?: string; status?: (typeof RUN_STATUSES)[number]; limit?: number;
    };
    try {
      // Same read as the runs-tab list route: the caller's subsidiary
      // scope hides org-wide runs from restricted callers.
      const result = await listRuns(authz.user.orgId, {
        ruleId: a.ruleId,
        periodId: a.periodId,
        bookId: a.bookId,
        subsidiaryId: a.subsidiaryId,
        status: a.status,
        limit: a.limit ?? 25,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      });
      const rows = result.runs.map((run) => ({
        id: run.id,
        rule: run.ruleKey ?? run.ruleId,
        ruleName: run.ruleName,
        versionId: run.versionId,
        periodId: run.periodId,
        bookId: run.bookId,
        subsidiaryId: run.subsidiaryId,
        status: run.status,
        triggerKind: run.triggerKind,
        sourceTotal: run.sourceTotal,
        allocatedTotal: run.allocatedTotal,
        residual: run.residual,
        journalEntryId: run.journalEntryId,
        reversalEntryId: run.reversalEntryId,
        requestedBy: run.requestedBy,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      }));
      const paged = compactRows(rows, { limit: a.limit ?? 25 });
      return {
        ok: true,
        data: { ...paged, total: result.total, runs: paged.items, href: ALLOCATIONS_HREF },
      };
    } catch (error) {
      if (error instanceof RunQueryError) return { ok: false, error: error.message.slice(0, 300) };
      throw error;
    }
  },
};

const previewAllocation: AssistantToolDef = {
  name: "preview_allocation",
  tier: "module",
  description:
    "Preview a period allocation sweep for a rule and period id or fiscal preset: sources, driver vector, per-target shares and amounts. Persists a previewed run; never posts.",
  category: "write",
  gate: { mode: "anyOf", perms: ["allocations.run"] },
  feature: "allocations",
  inputSchema: z.object({
    ruleId: uuidInput.optional().describe("Rule id from list_allocation_rules"),
    ruleKey: ruleKeyInput.optional(),
    periodId: uuidInput.optional().describe("Accounting period id; exactly one of periodId or period"),
    period: periodPresetInput.optional().describe("Fiscal preset; sweeps the accounting period holding its end date"),
    bookId: uuidInput.optional().describe("Accounting book; defaults to the primary book like the runs tab"),
    subsidiaryId: uuidInput.optional().describe("Pin the sweep to one subsidiary; must be inside your scope"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    // HTTP parity: POST /api/allocations/runs/preview is allocations.run.
    // Persist is a write; a read-only caller must see a named refusal even
    // if they reach execute without canRunTool.
    if (!can(authz, "allocations.run")) {
      return { ok: false, error: "forbidden" };
    }
    const a = raw as {
      ruleId?: string; ruleKey?: string; periodId?: string; period?: string;
      bookId?: string; subsidiaryId?: string;
    };
    // Restricted callers must pin a subsidiary they can see. Omitting the pin
    // would pass null into previewAllocationRun and sweep every legal entity.
    // One shared helper with the preview route and the engine backstop, so
    // the refusal names the same remedy everywhere.
    const pinRefusal = previewPinError(authz.allowedSubsidiaryIds, a.subsidiaryId ?? null);
    if (pinRefusal) return { ok: false, error: pinRefusal };
    const off = await allocationsOff(authz);
    if (off) return off;
    const ruleId = await resolveRuleId(authz.user.orgId, a);
    if (typeof ruleId !== "string") return ruleId;
    const periodId = await resolveAllocationPeriodId(authz.user.orgId, a);
    if (typeof periodId !== "string") return periodId;
    try {
      // Omitted book defaults to the primary book (the statement-pages
      // selection contract); the engine re-checks book scope at compute.
      const { selectedBook } = await reportBookSelection(authz.user.orgId, a.bookId ?? null);
      // Same service as the runs-tab Preview button, with the posting
      // path's composed driver resolver so report_definition drivers read
      // real numbers (their reports.read refusal surfaces cleanly).
      const run = await previewAllocationRun(
        {
          orgId: authz.user.orgId,
          ruleId,
          periodId,
          bookId: selectedBook.id,
          subsidiaryId: a.subsidiaryId ?? null,
          actorId: authz.user.id,
          trigger: "manual",
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        },
        { driverResolver: postDriverResolver },
      );
      const computation = run.computation;
      const sources = compactRows(computation.sources, { limit: 100 });
      const targets = compactRows(computation.targets, { limit: 100 });
      const lines = compactRows(computation.lines, { limit: 100 });
      return {
        ok: true,
        data: {
          runId: run.id,
          status: run.status,
          ruleId: run.ruleId,
          versionId: run.versionId,
          definitionHash: run.definitionHash,
          periodId: run.periodId,
          bookId: run.bookId,
          subsidiaryId: run.subsidiaryId,
          book: selectedBook.code,
          sourceMeasure: computation.sourceMeasure,
          sourceTotal: run.sourceTotal,
          allocatedTotal: run.allocatedTotal,
          residual: run.residual,
          fingerprint: run.fingerprint,
          impact: computation.impact,
          residualPolicy: computation.residualPolicy,
          driver: computation.driver,
          sources: sources.items,
          sourceCount: sources.total,
          sourcesTruncated: sources.truncated,
          targets: targets.items,
          targetCount: targets.total,
          targetsTruncated: targets.truncated,
          lines: lines.items,
          lineCount: lines.total,
          linesTruncated: lines.truncated,
          note: "Preview only: a previewed run row was stored and nothing was posted to the ledger.",
          href: ALLOCATIONS_HREF,
        },
      };
    } catch (error) {
      return previewFailure(error);
    }
  },
};

const explainAllocation: AssistantToolDef = {
  name: "explain_allocation",
  tier: "module",
  description:
    "Explain allocated lines from exactly one anchor — a run, journal entry, or document: every line back to its rule, version, driver value, share, and amount. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["allocations.read"] },
  feature: "allocations",
  inputSchema: z.object({
    runId: uuidInput.optional().describe("Allocation run id from list_allocation_runs"),
    journalEntryId: uuidInput.optional().describe("Journal entry holding allocated lines"),
    documentId: uuidInput.optional().describe("Source document whose lines were split or contributed"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const off = await allocationsOff(authz);
    if (off) return off;
    const a = raw as { runId?: string; journalEntryId?: string; documentId?: string };
    let anchor;
    try {
      anchor = validateLineageAnchor(a);
    } catch (error) {
      if (error instanceof RunQueryError) return { ok: false, error: error.message.slice(0, 300) };
      throw error;
    }
    try {
      // Same visibility as the surfaces that own each anchor. A miss is
      // not-found (not empty lineage): run drawer, get_journal_entry, get_document.
      if (anchor.kind === "run") {
        const run = await getRun(authz.user.orgId, anchor.id);
        if (!allocationScopeVisible(authz.allowedSubsidiaryIds, run.subsidiaryId, run.computation)) {
          return { ok: false, error: "allocation_run_not_found" };
        }
      } else if (anchor.kind === "journalEntry") {
        const seen = await entryDetail(authz.user.orgId, anchor.id, authz.allowedSubsidiaryIds, can(authz, "payroll.read"));
        if (!seen.entry) return { ok: false, error: "entry_not_found" };
      } else if (anchor.kind === "document") {
        const seen = await db.execute<{ id: string }>(sql`
          select d.id::text as id
            from documents d
           where d.id = ${anchor.id} and d.org_id = ${authz.user.orgId}
             ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, authz.allowedSubsidiaryIds)}
           limit 1`);
        if (!seen.rows[0]) return { ok: false, error: "document_not_found" };
      }
      const result = await queryLineage(
        authz.user.orgId,
        {
          runId: a.runId,
          journalEntryId: a.journalEntryId,
          documentId: a.documentId,
        },
        { allowedSubsidiaryIds: authz.allowedSubsidiaryIds },
      );
      const rows = result.rows.map((row) => ({
        id: row.id,
        mode: row.mode,
        rule: row.ruleKey ?? row.ruleId,
        versionId: row.versionId,
        definitionHash: row.definitionHash,
        runId: row.runId,
        documentId: row.documentId,
        journalEntryId: row.journalEntryId,
        journalLineId: row.journalLineId,
        driver: row.driverKey ?? row.driverId,
        driverValue: row.driverValue,
        driverTotal: row.driverTotal,
        share: row.share,
        amount: row.amount,
        residual: row.residual,
      }));
      const paged = compactRows(rows);
      return {
        ok: true,
        data: {
          ...paged,
          anchor: result.anchor,
          total: rows.length,
          lineage: paged.items,
          href: ALLOCATIONS_HREF,
        },
      };
    } catch (error) {
      if (error instanceof RunQueryError) {
        if (error.code === "not_found") return { ok: false, error: "allocation_run_not_found" };
        return { ok: false, error: error.message.slice(0, 300) };
      }
      throw error;
    }
  },
};

export const ALLOCATIONS_TOOLS: AssistantToolDef[] = [
  listAllocationRules,
  getAllocationRule,
  listAllocationDrivers,
  previewDriverVectorTool,
  previewAllocation,
  listAllocationRuns,
  explainAllocation,
];
