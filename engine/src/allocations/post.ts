import { sql } from "drizzle-orm";
import type { db } from "../platform/db.ts";
import { fromUnits, isZero, neg, normalizeMoney, roundDiv, sum, toUnits } from "../money/money.ts";
import { resolveAccountGroups } from "../records/account-groups.ts";
import { AllocationApportionError, apportion, fixedPercentWeights } from "./apportion.ts";
import { resolveDriverVintage } from "./driver-asof.ts";
import { selectRule, type AccountGroupResolver } from "./match.ts";
import { AllocationRuleError, listRulesInEffect } from "./rules.ts";
import type {
  AllocationDriver,
  AllocationRuleTarget,
  ApportionResult,
  ContributedLine,
  DriverResolver,
  DriverVector,
  LineageDraft,
  LineCoordinate,
  RuleInEffect,
  WeightedTarget,
} from "./types.ts";

export class PostAllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostAllocationError";
  }
}

/** Minimal runner: post.ts reads config, never writes. */
export type PostRunner = Pick<typeof db, "execute">;

/** Structural subset of posting.ts KernelLine this module reads. */
export interface PostSourceLine {
  accountId: string;
  amount: string;
  subsidiaryId?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
  classId?: string | null;
  projectId?: string | null;
  partyId?: string | null;
  extraDims?: Record<string, string>;
}

export interface PostableDocument {
  id: string;
  orgId: string;
  kind: string;
  postingDate?: string | null;
  documentDate: string;
  currency: string;
  subsidiaryId?: string | null;
}

export interface PostContributionDeps {
  /** Historical replay: never contribute. Mirrors PostingDeps.migration. */
  migration?: boolean;
  /** Larger atomic units (payment + applications + FX): skip contributions. */
  suppressAutomation?: boolean;
  /**
   * Injected driver resolver. Tests inject doubles here; the posting path
   * supplies the composed engine resolver (report-runner.ts).
   */
  driverResolver?: DriverResolver;
  /** Actor whose permissions govern report-backed drivers. */
  actorId?: string | null;
  /** Account-group membership for account_scope matching; preloaded when needed. */
  resolveAccountGroup?: AccountGroupResolver;
  /** Resolve the feature gate; defaults to reading orgs.settings. */
  featureGate?: (orgId: string) => Promise<boolean>;
  /** Skip the rule load (unit tests inject RuleInEffect rows directly). */
  rulesOverride?: RuleInEffect[];
}

export interface PostContributionOpts {
  postingDate: string;
}

/**
 * A contributed line that still remembers the kernel line it was built from.
 * posting.ts stamps journal ids after insert (lineage needs both the new line
 * id and the source kernel line's inserted id).
 */
export interface ContributedLineWithSource extends ContributedLine {
  sourceKernelIndex: number;
}

/** Lineage-only draft from a report_only rule (writes no journal line). */
export interface ReportOnlyDraft extends LineageDraft {
  sourceKernelIndex: number;
}

export interface PostContributionResult {
  lines: ContributedLineWithSource[];
  reportOnly: ReportOnlyDraft[];
}

// ---------------------------------------------------------------------------
// Feature gate (defensive until A10 registers the keys)
// ---------------------------------------------------------------------------

/**
 * Post-mode fires only when BOTH `allocations` and `allocationsAtPosting`
 * are explicitly true. Unknown keys read back null and refuse — feature off
 * means no rule fires anywhere and posted data is kept as-is.
 */
export async function allocationsAtPostingEnabled(
  runner: PostRunner,
  orgId: string,
): Promise<boolean> {
  // Explicit-'true' reads (never a ::boolean cast): a non-boolean stored
  // value refuses instead of throwing 22P02 like the previous casts did on
  // import artifacts. The explicit conjunction is the allocationsAtPosting
  // parentKey ['allocations'] chain.
  const r = await runner.execute<{ a: boolean; p: boolean }>(sql`
    select case (settings->'features'->>'allocations') when 'true' then true else false end as a,
           case (settings->'features'->>'allocationsAtPosting') when 'true' then true else false end as p
      from orgs where id = ${orgId}`);
  return r.rows[0]?.a === true && r.rows[0]?.p === true;
}

// ---------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------

export interface PostingBook {
  id: string;
  code: string;
  isPrimary: boolean;
  isActive: boolean;
  postsGl: boolean;
}

export async function loadPostingBooks(runner: PostRunner, orgId: string): Promise<PostingBook[]> {
  const r = await runner.execute<{
    id: string;
    code: string;
    is_primary: boolean;
    is_active: boolean;
    posts_gl: boolean;
  }>(sql`
    select id, code, is_primary, is_active, posts_gl from accounting_books where org_id = ${orgId}`);
  return r.rows.map((b) => ({
    id: b.id,
    code: b.code,
    isPrimary: b.is_primary,
    isActive: b.is_active,
    postsGl: b.posts_gl,
  }));
}

/**
 * Which books one matched rule writes to. `undefined` = the primary book
 * (lines join the document's own entry); anything else gets a separate
 * allocation entry. Misconfigured books fail closed at posting time.
 */
export function resolveRuleBooks(
  rule: RuleInEffect,
  books: PostingBook[],
): Array<string | undefined> {
  const scope = rule.version.bookScope;
  if (scope === "primary" || scope === "all_posting") {
    const out: Array<string | undefined> = [undefined];
    if (scope === "all_posting") {
      // Implicit fan-out covers every eligible book; an archived book is
      // simply not eligible. Explicit 'books' listings stay strict below.
      for (const b of books) {
        if (b.isPrimary || !b.isActive || !b.postsGl) continue;
        out.push(b.id);
      }
    }
    return out;
  }
  // scope 'books': exactly the listed books. A listed primary behaves like
  // primary scope; every other listed book must be an active posting book.
  const out: Array<string | undefined> = [];
  for (const id of rule.version.bookIds) {
    const book = books.find((b) => b.id === id);
    if (!book) throw new PostAllocationError(`rule ${rule.rule.key} lists unknown book ${id}`);
    if (book.isPrimary) {
      out.push(undefined);
      continue;
    }
    requirePostingBook(rule, book);
    out.push(book.id);
  }
  return out;
}

function requirePostingBook(rule: RuleInEffect, book: PostingBook): void {
  if (!book.isActive || !book.postsGl) {
    throw new PostAllocationError(
      `rule ${rule.rule.key} targets book ${book.code}, which is not an active posting book`,
    );
  }
}

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

interface ResolvedTargets {
  coords: AllocationRuleTarget[];
  weights: WeightedTarget[];
  driverId: string | null;
  driverVector: DriverVector | null;
  driverDimension: string | null;
}

async function resolveWeights(
  rule: RuleInEffect,
  deps: PostContributionDeps,
  doc: PostableDocument,
  postingDate: string,
  runner: PostRunner,
): Promise<ResolvedTargets> {
  // Publish refuses stepped versions, but pre-refusal publications still
  // reach this seam: refuse before the dynamic branch, which would otherwise
  // measure a driver and silently run a stepped rule as a driver rule.
  if (rule.version.basisKind === "stepped") {
    throw new PostAllocationError(
      `rule ${rule.rule.key} uses a stepped basis, which is not yet runnable — republish the version with a fixed_percent or driver basis`,
    );
  }
  if (rule.version.targetKind === "dynamic") {
    return resolveDynamicTargets(rule, deps, doc, postingDate, runner);
  }
  if (rule.version.basisKind === "fixed_percent") {
    return {
      coords: rule.targets,
      weights: percentWeightsForRule(rule),
      driverId: null,
      driverVector: null,
      driverDimension: null,
    };
  }
  if (rule.version.basisKind === "driver") {
    const measured = await measureDriver(rule, deps, doc, postingDate, runner);
    if (measured) {
      return {
        coords: rule.targets,
        weights: driverWeightsWithDimension(rule.targets, measured.vector, measured.dimension),
        driverId: rule.version.driverId ?? null,
        driverVector: measured.vector,
        driverDimension: measured.dimension,
      };
    }
    // No resolver (or no driver): manual per-target weights are the
    // documented driver-less weighting.
    if (rule.targets.length > 0 && rule.targets.every((t) => t.weight != null)) {
      return {
        coords: rule.targets,
        weights: rule.targets.map((t) => ({
          key: t.id ?? `sequence:${t.sequence}`,
          weight: t.weight!,
          isRemainder: false,
        })),
        driverId: null,
        driverVector: null,
        driverDimension: null,
      };
    }
    throw new PostAllocationError(
      `rule ${rule.rule.key} uses a driver basis but no driver measurement is available`,
    );
  }
  throw new PostAllocationError(
    `rule ${rule.rule.key} uses a stepped basis, which is not yet runnable — republish the version with a fixed_percent or driver basis`,
  );
}

async function measureDriver(
  rule: RuleInEffect,
  deps: PostContributionDeps,
  doc: PostableDocument,
  postingDate: string,
  runner: PostRunner,
): Promise<{ vector: DriverVector; dimension: string } | null> {
  if (!deps.driverResolver || !rule.version.driverId) return null;
  const driver = await loadDriver(runner, doc.orgId, rule.version.driverId);
  if (!driver) throw new PostAllocationError(`rule ${rule.rule.key} points at unknown driver`);
  if (!driver.isActive) throw new PostAllocationError(`rule ${rule.rule.key} points at inactive driver`);
  // The version's driver vintage resolves through the one shared mapping the
  // period runner uses: prior_period reads the period before the posting
  // period, document_date reads the document's own date — never the live
  // posting-date vector the old code measured unconditionally.
  const vintage = await resolveDriverVintage(runner, doc.orgId, rule.version.driverAsOf, {
    kind: "posting",
    postingDate,
    documentDate: doc.documentDate,
  });
  if ("refusal" in vintage) throw new PostAllocationError(`rule ${rule.rule.key}: ${vintage.refusal}`);
  const vector = await deps.driverResolver.resolve({
    orgId: doc.orgId,
    // The registry stores free-text dimensions; resolution treats an
    // unrecognized dimension as matching nothing (fail closed downstream).
    driver: driver as AllocationDriver,
    asOf: vintage.asOf,
    subsidiaryId: doc.subsidiaryId ?? null,
    actorId: deps.actorId ?? null,
  });
  return { vector, dimension: driver.dimension };
}

async function loadDriver(
  runner: PostRunner,
  orgId: string,
  driverId: string,
): Promise<(Omit<AllocationDriver, "dimension"> & { dimension: string }) | null> {
  const r = await runner.execute<{
    id: string;
    key: string;
    name: string;
    unit: string | null;
    dimension: string;
    is_active: boolean;
    source_kind: string;
    config: unknown;
  }>(sql`
    select id, key, name, unit, dimension, is_active, source_kind, config
      from allocation_drivers where org_id = ${orgId} and id = ${driverId} limit 1`);
  const row = r.rows[0];
  if (!row) return null;
  const config = row.config;
  if (config != null && (typeof config !== "object" || Array.isArray(config))) {
    throw new PostAllocationError("allocation driver carries malformed config");
  }
  return {
    id: row.id,
    orgId,
    key: row.key,
    name: row.name,
    unit: row.unit,
    dimension: row.dimension,
    sourceKind: row.source_kind as AllocationDriver["sourceKind"],
    config: (config ?? {}) as Record<string, unknown>,
    isActive: row.is_active,
  };
}

/** Dimension value id a target carries for the driver's dimension. */
function targetDimensionValue(target: AllocationRuleTarget, dimension: string): string | null {
  switch (dimension) {
    case "department":
      return target.departmentId ?? null;
    case "location":
      return target.locationId ?? null;
    case "class":
      return target.classId ?? null;
    case "project":
      return target.projectId ?? null;
    case "subsidiary":
      return target.subsidiaryId ?? null;
    default: {
      if (dimension.startsWith("extra:")) {
        return target.extraDims?.[dimension.slice("extra:".length)] ?? null;
      }
      return null;
    }
  }
}

function driverWeightsWithDimension(
  targets: AllocationRuleTarget[],
  vector: DriverVector,
  dimension: string,
): WeightedTarget[] {
  return targets.map((t) => {
    const valueId = targetDimensionValue(t, dimension);
    const weight = (valueId != null ? vector.get(valueId) : undefined) ?? "0";
    return { key: t.id ?? `sequence:${t.sequence}`, weight, isRemainder: false };
  });
}

const DYNAMIC_DIMENSION_TABLES: Record<string, { table: string; activeColumn: string }> = {
  department: { table: "departments", activeColumn: "is_active" },
  location: { table: "locations", activeColumn: "is_active" },
  class: { table: "classes", activeColumn: "is_active" },
  project: { table: "projects", activeColumn: "is_active" },
  subsidiary: { table: "subsidiaries", activeColumn: "is_active" },
};

async function resolveDynamicTargets(
  rule: RuleInEffect,
  deps: PostContributionDeps,
  doc: PostableDocument,
  postingDate: string,
  runner: PostRunner,
): Promise<ResolvedTargets> {
  const dyn = rule.version.dynamicTarget as {
    dimension?: string;
    include?: string[];
    exclude?: string[];
    minWeight?: string;
    targetAccountId?: string | null;
  };
  const dimension = dyn.dimension;
  if (!dimension) throw new PostAllocationError(`rule ${rule.rule.key} has a dynamic target without a dimension`);
  const measured = await measureDriver(rule, deps, doc, postingDate, runner);
  if (!measured) {
    throw new PostAllocationError(`rule ${rule.rule.key} needs a driver measurement for its dynamic targets`);
  }
  const include = new Set(dyn.include ?? []);
  const exclude = new Set(dyn.exclude ?? []);
  const minWeight = toUnits(dyn.minWeight ?? "0");
  const table = DYNAMIC_DIMENSION_TABLES[dimension];
  if (!table) throw new PostAllocationError(`rule ${rule.rule.key} uses unsupported dynamic dimension ${dimension}`);
  // Table and column names are allow-listed above; values stay parameterized.
  const r = await runner.execute<{ id: string }>(sql`
    select id from ${sql.raw(`public."${table.table}"`)}
     where org_id = ${doc.orgId} and ${sql.raw(`"${table.activeColumn}"`)} = true`);
  const activeIds = new Set(r.rows.map((row) => row.id));
  const coords: AllocationRuleTarget[] = [];
  const weights: WeightedTarget[] = [];
  let sequence = 0;
  for (const key of [...measured.vector.keys()].sort()) {
    const value = measured.vector.get(key)!;
    const units = toUnits(value);
    if (units < 0n) throw new PostAllocationError("driver weights must be non-negative");
    if (units <= minWeight) continue;
    if (include.size > 0 && !include.has(key)) continue;
    if (exclude.has(key)) continue;
    if (!activeIds.has(key)) continue;
    sequence += 1;
    coords.push({
      sequence,
      targetAccountId: dyn.targetAccountId ?? null,
      departmentId: dimension === "department" ? key : null,
      locationId: dimension === "location" ? key : null,
      classId: dimension === "class" ? key : null,
      projectId: dimension === "project" ? key : null,
      subsidiaryId: dimension === "subsidiary" ? key : null,
      extraDims: {},
      label: null,
    });
    weights.push({ key: `dyn:${key}`, weight: value, isRemainder: false });
  }
  if (coords.length === 0) throw new PostAllocationError(`rule ${rule.rule.key} resolved no dynamic targets`);
  return {
    coords,
    weights,
    driverId: rule.version.driverId ?? null,
    driverVector: measured.vector,
    driverDimension: measured.dimension,
  };
}

function renderTemplate(
  template: string | null | undefined,
  vars: { rule: { name: string; key: string }; target: { label: string }; amount: string },
): string | null {
  if (!template) return null;
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, path: string) => {
    const parts = String(path).split(".");
    let cur: unknown = { rule: vars.rule, target: vars.target, amount: vars.amount };
    for (const part of parts) {
      if (cur != null && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[part];
      } else {
        return "";
      }
    }
    return cur == null ? "" : String(cur);
  });
}

interface BuiltTargets {
  coords: AllocationRuleTarget[];
  weights: WeightedTarget[];
  driverId: string | null;
  driverVector: DriverVector | null;
  apportioned: ApportionResult;
}

function lineageBase(
  rule: RuleInEffect,
  doc: PostableDocument,
  hash: string,
): Omit<LineageDraft, "sourceJournalLineId" | "amount" | "residual" | "share" | "driverValue" | "driverTotal"> {
  return {
    mode: "post",
    ruleId: rule.rule.id,
    versionId: rule.version.id,
    definitionHash: hash,
    runId: null,
    documentId: doc.id,
    sourceDocumentLineId: null,
    targetDocumentLineId: null,
    driverId: null,
  };
}

function buildContributedLines(args: {
  rule: RuleInEffect;
  doc: PostableDocument;
  kernelLine: PostSourceLine;
  sourceKernelIndex: number;
  built: BuiltTargets;
  books: Array<string | undefined>;
}): { lines: ContributedLineWithSource[]; reportOnly: ReportOnlyDraft[] } {
  const { rule, doc, kernelLine, sourceKernelIndex, built, books } = args;
  const version = rule.version;
  const hash = version.definitionHash;
  if (!hash) throw new PostAllocationError(`rule ${rule.rule.key} has a published version without a definition hash`);
  const base = lineageBase(rule, doc, hash);
  const lines: ContributedLineWithSource[] = [];
  const reportOnly: ReportOnlyDraft[] = [];
  const memoFor = (label: string, amount: string): string =>
    renderTemplate(version.lineDescriptionTemplate ?? version.memoTemplate, {
      rule: { name: rule.rule.name, key: rule.rule.key },
      target: { label },
      amount,
    }) ?? rule.rule.name;

  if (version.impact === "report_only") {
    for (let i = 0; i < built.coords.length; i += 1) {
      const apportioned = built.apportioned.targets[i]!;
      reportOnly.push({
        ...base,
        sourceJournalLineId: null,
        driverId: built.driverId,
        driverValue: driverValueOf(built, i),
        driverTotal: driverTotalOf(built),
        share: apportioned.share,
        amount: apportioned.amount,
        residual: apportioned.residual,
        sourceKernelIndex,
      });
    }
    return { lines, reportOnly };
  }

  for (const bookId of books) {
    // Target legs first (target sequence order), then the single offset leg,
    // so entry line order is stable for a rule application.
    for (let i = 0; i < built.coords.length; i += 1) {
      const target = built.coords[i]!;
      const apportioned = built.apportioned.targets[i]!;
      // A zero-weight target writes no zero-amount GL line; the kernel
      // strips zero lines and a zero leg carries no attribution.
      if (isZero(apportioned.amount)) continue;
      const accountId = target.targetAccountId ?? kernelLine.accountId;
      if (version.impact === "net_zero_pair" && target.targetAccountId != null) {
        // Invariant §5.5: a statistical pair must never move an account
        // balance. The publish guard (A1) owns this; posting refuses loudly.
        throw new PostAllocationError(
          `rule ${rule.rule.key} is net_zero_pair but names a target account`,
        );
      }
      lines.push({
        accountId,
        subsidiaryId: target.subsidiaryId ?? kernelLine.subsidiaryId ?? doc.subsidiaryId ?? null,
        departmentId: target.departmentId ?? kernelLine.departmentId ?? null,
        locationId: target.locationId ?? kernelLine.locationId ?? null,
        classId: target.classId ?? kernelLine.classId ?? null,
        projectId: target.projectId ?? kernelLine.projectId ?? null,
        partyId: kernelLine.partyId ?? null,
        extraDims: { ...(kernelLine.extraDims ?? {}), ...(target.extraDims ?? {}) },
        amount: apportioned.amount,
        currency: doc.currency,
        memo: memoFor(target.label ?? accountId, apportioned.amount),
        contributorKind: "rule",
        contributorRef: version.id,
        ...(bookId !== undefined ? { bookId } : {}),
        lineage: {
          ...base,
          sourceJournalLineId: null,
          driverId: built.driverId,
          driverValue: driverValueOf(built, i),
          driverTotal: driverTotalOf(built),
          share: apportioned.share,
          amount: apportioned.amount,
          residual: apportioned.residual,
        },
        sourceKernelIndex,
      });
    }
    // The offset leg: reclass credits the offset account (or the source
    // coordinate); net_zero_pair always credits the source coordinate.
    const offsetAccount = version.impact === "reclass"
      ? (version.offsetAccountId ?? kernelLine.accountId)
      : kernelLine.accountId;
    const offsetTotal = neg(sum(built.apportioned.targets.map((t) => t.amount)));
    if (!isZero(offsetTotal)) {
      lines.push({
        accountId: offsetAccount,
        subsidiaryId: kernelLine.subsidiaryId ?? doc.subsidiaryId ?? null,
        departmentId: kernelLine.departmentId ?? null,
        locationId: kernelLine.locationId ?? null,
        classId: kernelLine.classId ?? null,
        projectId: kernelLine.projectId ?? null,
        partyId: kernelLine.partyId ?? null,
        extraDims: { ...(kernelLine.extraDims ?? {}) },
        amount: offsetTotal,
        currency: doc.currency,
        memo: memoFor("offset", offsetTotal),
        contributorKind: "rule",
        contributorRef: version.id,
        ...(bookId !== undefined ? { bookId } : {}),
        lineage: {
          ...base,
          sourceJournalLineId: null,
          driverId: built.driverId,
          driverValue: null,
          driverTotal: driverTotalOf(built),
          share: null,
          amount: offsetTotal,
          residual: "0.0000",
        },
        sourceKernelIndex,
      });
    }
  }
  return { lines, reportOnly };
}

function driverValueOf(built: BuiltTargets, index: number): string | null {
  if (!built.driverVector) return null;
  return built.weights[index]?.weight ?? null;
}

function driverTotalOf(built: BuiltTargets): string | null {
  if (!built.driverVector) return null;
  let total = 0n;
  for (const w of built.weights) total += toUnits(w.weight);
  return fromUnits(total);
}

/**
 * Every contributor's line set must balance per subsidiary on its own —
 * before it joins the kernel union. Null subsidiaries stay distinct from
 * named ones, so a pass here can never hide a real imbalance; the union
 * still flows through applySubsidiaries and assertFinalKernelBalance
 * unchanged.
 */
export function assertContributorBalance(
  lines: ReadonlyArray<{
    contributorKind: string;
    contributorRef: string;
    subsidiaryId?: string | null;
    bookId?: string;
    amount: string;
  }>,
): void {
  const groups = new Map<string, { label: string; total: bigint }>();
  for (const line of lines) {
    const sub = line.subsidiaryId ?? "";
    const book = line.bookId ?? "";
    const key = `${line.contributorKind} ${line.contributorRef} ${sub} ${book}`;
    const group = groups.get(key) ?? {
      label:
        `allocation contributor ${line.contributorKind}:${line.contributorRef}` +
        `${sub ? ` for subsidiary ${sub}` : ""}` +
        `${book ? ` in book ${book}` : ""}`,
      total: 0n,
    };
    group.total += toUnits(line.amount);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.total !== 0n) {
      throw new PostAllocationError(`${group.label} does not balance (sum=${fromUnits(group.total)})`);
    }
  }
}

export async function collectPostContributions(
  runner: PostRunner,
  doc: PostableDocument,
  kernelLines: PostSourceLine[],
  deps: PostContributionDeps,
  opts: PostContributionOpts,
): Promise<PostContributionResult> {
  const empty: PostContributionResult = { lines: [], reportOnly: [] };
  if (deps.migration || deps.suppressAutomation) return empty;
  const gate = deps.featureGate
    ? await deps.featureGate(doc.orgId)
    : await allocationsAtPostingEnabled(runner, doc.orgId);
  if (!gate) return empty;

  let postRules: RuleInEffect[];
  try {
    postRules = deps.rulesOverride ??
      (await listRulesInEffect({ orgId: doc.orgId, mode: "post", onDate: opts.postingDate }));
  } catch (error) {
    if (error instanceof AllocationRuleError) throw new PostAllocationError(error.message);
    throw error;
  }
  if (postRules.length === 0) return empty;
  const resolveAccountGroup = deps.resolveAccountGroup ??
    (await makeAccountGroupResolver(doc.orgId, postRules));
  const books = await loadPostingBooks(runner, doc.orgId);

  const lines: ContributedLineWithSource[] = [];
  const reportOnly: ReportOnlyDraft[] = [];
  for (let kernelIndex = 0; kernelIndex < kernelLines.length; kernelIndex += 1) {
    const kernelLine = kernelLines[kernelIndex]!;
    if (isZero(kernelLine.amount)) continue;
    const coordinate: LineCoordinate = {
      accountId: kernelLine.accountId,
      subsidiaryId: kernelLine.subsidiaryId ?? null,
      departmentId: kernelLine.departmentId ?? null,
      locationId: kernelLine.locationId ?? null,
      classId: kernelLine.classId ?? null,
      projectId: kernelLine.projectId ?? null,
      partyId: kernelLine.partyId ?? null,
      extraDims: kernelLine.extraDims ?? {},
      documentKind: doc.kind,
      itemId: null,
      amount: kernelLine.amount,
    };
    const winner = selectRule(postRules, coordinate, { resolveAccountGroup });
    if (!winner) continue;
    const resolved = await resolveWeights(winner, deps, doc, opts.postingDate, runner);
    const apportioned = apportionForRule(kernelLine.amount, resolved.weights, winner);
    const ruleBooks = resolveRuleBooks(winner, books);
    const built = buildContributedLines({
      rule: winner,
      doc,
      kernelLine,
      sourceKernelIndex: kernelIndex,
      built: {
        coords: resolved.coords,
        weights: resolved.weights,
        driverId: resolved.driverId,
        driverVector: resolved.driverVector,
        apportioned,
      },
      books: ruleBooks,
    });
    lines.push(...built.lines);
    reportOnly.push(...built.reportOnly);
  }
  assertContributorBalance(lines);
  return { lines, reportOnly };
}

/**
 * Preload account-group membership for the dimensions post rules actually
 * reference, so A4's matcher can resolve account_group scopes synchronously.
 * Rules without group scopes need no preload and matchers run without one.
 */
async function makeAccountGroupResolver(
  orgId: string,
  rules: RuleInEffect[],
): Promise<AccountGroupResolver | undefined> {
  const dimensions = new Set<string>();
  for (const rule of rules) {
    const scope = rule.version.accountScope;
    if (scope.kind === "account_group") dimensions.add(scope.dimension);
  }
  if (dimensions.size === 0) return undefined;
  const membership = new Map<string, Map<string, Set<string>>>();
  for (const dimension of dimensions) {
    const resolved = await resolveAccountGroups(dimension, orgId);
    const byGroup = new Map<string, Set<string>>();
    for (const [accountId, ref] of resolved.byAccount) {
      const set = byGroup.get(ref.key) ?? new Set<string>();
      set.add(accountId);
      byGroup.set(ref.key, set);
    }
    membership.set(dimension, byGroup);
  }
  return (dimension, groupKey) => membership.get(dimension)?.get(groupKey) ?? new Set<string>();
}

/** A1 apportionment errors surface as post errors naming the rule. */
function apportionForRule(total: string, weights: WeightedTarget[], rule: RuleInEffect): ApportionResult {
  try {
    return apportion(total, weights, rule.version.residualPolicy, rule.version.residualTargetId);
  } catch (error) {
    if (error instanceof AllocationApportionError) {
      throw new PostAllocationError(`rule ${rule.rule.key}: ${error.message}`);
    }
    throw error;
  }
}

/** A1 fixed-percent weights with post errors naming the rule. */
function percentWeightsForRule(rule: RuleInEffect): WeightedTarget[] {
  try {
    return fixedPercentWeights(rule.targets);
  } catch (error) {
    if (error instanceof AllocationApportionError) {
      throw new PostAllocationError(`rule ${rule.rule.key}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Event-bound net-zero pairs (A11 overhead fold) — additive hook; post.ts
 * document semantics below are untouched.
 *
 * Some post-mode allocations fire on an event, not on a document line: the
 * overhead net-zero pair fires on time approval with pre-apportioned project
 * totals (hours × the published department rate). This builder shapes those
 * totals into kernel lines — DR each project leg, CR the same account
 * untagged — stamped contributor_kind 'rule' with per-entry lineage, so the
 * event path carries the same evidence as a document contribution. Amounts
 * are exact: legs must sum to the total and entries to their leg, or the
 * build refuses rather than inventing or losing a cent.
 */

/** One pre-apportioned project leg with the source entries composing it. */
export interface NetZeroPairLegTarget {
  projectId: string;
  subsidiaryId?: string | null;
  /** Signed exact money (debit +); zero legs write no line. */
  amount: string;
  /** Carried sources; their amounts must sum exactly to the leg amount. */
  entries: Array<{ id: string; amount: string }>;
}

export interface NetZeroPairSource {
  accountId: string;
  subsidiaryId?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
  classId?: string | null;
  partyId?: string | null;
  extraDims?: Record<string, string>;
}

/** One journal-ready line with its lineage drafts (journal ids stamped later). */
export interface NetZeroPairLine {
  line: ContributedLine;
  lineage: LineageDraft[];
}

const SHARE_SCALE = 10_000_000_000n;

/** Exact 10dp share of value in total (both exact money, total non-zero). */
function share10(value: string, total: string): string {
  const quanta = roundDiv(toUnits(value) * SHARE_SCALE, toUnits(total));
  return `${(quanta / SHARE_SCALE).toString()}.${(quanta % SHARE_SCALE).toString().padStart(10, "0")}`;
}

export function buildNetZeroPairLines(args: {
  rule: RuleInEffect;
  /** Functional currency of the amounts; omitted when the poster resolves it (the overhead event path). */
  currency?: string;
  source: NetZeroPairSource;
  total: string;
  targets: NetZeroPairLegTarget[];
}): NetZeroPairLine[] {
  const { rule, currency, source, targets } = args;
  const version = rule.version;
  if (version.impact !== "net_zero_pair") {
    throw new PostAllocationError(`rule ${rule.rule.key} is not a net_zero_pair rule`);
  }
  const hash = version.definitionHash;
  if (!hash) {
    throw new PostAllocationError(`rule ${rule.rule.key} has a published version without a definition hash`);
  }
  if (isZero(args.total)) {
    throw new PostAllocationError(`rule ${rule.rule.key} has nothing to pair (zero total)`);
  }
  const total = normalizeMoney(args.total);
  const legSum = sum(targets.map((t) => t.amount));
  if (toUnits(legSum) !== toUnits(total)) {
    throw new PostAllocationError(
      `rule ${rule.rule.key} leg amounts sum to ${legSum} which does not equal the leg total ${total}`,
    );
  }
  const memoFor = (label: string, amount: string): string =>
    renderTemplate(version.lineDescriptionTemplate ?? version.memoTemplate, {
      rule: { name: rule.rule.name, key: rule.rule.key },
      target: { label },
      amount,
    }) ?? rule.rule.name;

  const out: NetZeroPairLine[] = [];
  for (const target of targets) {
    if (isZero(target.amount)) continue;
    const entrySum = sum(target.entries.map((e) => e.amount));
    if (toUnits(entrySum) !== toUnits(target.amount)) {
      throw new PostAllocationError(
        `rule ${rule.rule.key} entries do not sum to the leg amount for project ${target.projectId}`,
      );
    }
    out.push({
      line: {
        accountId: source.accountId,
        subsidiaryId: target.subsidiaryId ?? source.subsidiaryId ?? null,
        departmentId: source.departmentId ?? null,
        locationId: source.locationId ?? null,
        classId: source.classId ?? null,
        projectId: target.projectId,
        partyId: source.partyId ?? null,
        extraDims: { ...(source.extraDims ?? {}) },
        amount: normalizeMoney(target.amount),
        currency,
        memo: memoFor(target.projectId, target.amount),
        contributorKind: "rule",
        contributorRef: version.id,
        lineage: {
          mode: "post",
          ruleId: rule.rule.id,
          versionId: version.id,
          definitionHash: hash,
          runId: null,
          documentId: null,
          sourceJournalLineId: null,
          sourceDocumentLineId: null,
          targetDocumentLineId: null,
          driverId: version.driverId ?? null,
          driverValue: null,
          driverTotal: total,
          share: null,
          amount: normalizeMoney(target.amount),
          residual: "0",
        },
      },
      lineage: target.entries.map((entry) => ({
        mode: "post" as const,
        ruleId: rule.rule.id,
        versionId: version.id,
        definitionHash: hash,
        runId: null,
        documentId: null,
        sourceJournalLineId: null,
        sourceDocumentLineId: null,
        targetDocumentLineId: null,
        sourceTimeEntryId: entry.id,
        driverId: version.driverId ?? null,
        driverValue: normalizeMoney(entry.amount),
        driverTotal: total,
        share: share10(entry.amount, total),
        amount: normalizeMoney(entry.amount),
        residual: "0",
      })),
    });
  }
  const offsetTotal = neg(total);
  out.push({
    line: {
      accountId: source.accountId,
      subsidiaryId: source.subsidiaryId ?? null,
      departmentId: source.departmentId ?? null,
      locationId: source.locationId ?? null,
      classId: source.classId ?? null,
      projectId: null,
      partyId: source.partyId ?? null,
      extraDims: { ...(source.extraDims ?? {}) },
      amount: offsetTotal,
      currency,
      // The offset leg keeps a distinct memo from the same template — the
      // kernel's event-pair convention, mirroring the "offset" label the
      // document path renders through its own templates.
      memo: `${memoFor("offset", offsetTotal)} — contra`,
      contributorKind: "rule",
      contributorRef: version.id,
      lineage: {
        mode: "post",
        ruleId: rule.rule.id,
        versionId: version.id,
        definitionHash: hash,
        runId: null,
        documentId: null,
        sourceJournalLineId: null,
        sourceDocumentLineId: null,
        targetDocumentLineId: null,
        driverId: version.driverId ?? null,
        driverValue: null,
        driverTotal: total,
        share: null,
        amount: offsetTotal,
        residual: "0",
      },
    },
    lineage: [
      {
        mode: "post",
        ruleId: rule.rule.id,
        versionId: version.id,
        definitionHash: hash,
        runId: null,
        documentId: null,
        sourceJournalLineId: null,
        sourceDocumentLineId: null,
        targetDocumentLineId: null,
        sourceTimeEntryId: null,
        driverId: version.driverId ?? null,
        driverValue: null,
        driverTotal: total,
        share: null,
        amount: offsetTotal,
        residual: "0",
      },
    ],
  });
  assertContributorBalance(out.map((b) => b.line));
  return out;
}

/** Test seam: pure per-impact line building without config loading. */
export function __testBuildContributedLines(args: {
  rule: RuleInEffect;
  doc: PostableDocument;
  kernelLine: PostSourceLine;
  sourceKernelIndex: number;
  coords: AllocationRuleTarget[];
  weights: WeightedTarget[];
  books: Array<string | undefined>;
}): { lines: ContributedLineWithSource[]; reportOnly: ReportOnlyDraft[] } {
  const apportioned = apportionForRule(args.kernelLine.amount, args.weights, args.rule);
  return buildContributedLines({
    rule: args.rule,
    doc: args.doc,
    kernelLine: args.kernelLine,
    sourceKernelIndex: args.sourceKernelIndex,
    built: { coords: args.coords, weights: args.weights, driverId: null, driverVector: null, apportioned },
    books: args.books,
  });
}