import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { documentRevisionSql } from "../records/revision.ts";
import type {
  AccountScope,
  AllocationApplyPolicy,
  AllocationBasisKind,
  AllocationBookScope,
  AllocationDriverAsOf,
  AllocationImpact,
  AllocationMode,
  AllocationResidualPolicy,
  AllocationRuleHead,
  AllocationRuleTarget,
  AllocationRuleVersion,
  AllocationRunPolicy,
  AllocationSolveMethod,
  AllocationSourceMeasure,
  AllocationTargetKind,
  DimensionFilters,
  DynamicTarget,
  RuleInEffect,
} from "./types.ts";
import {
  definitionHash,
  validateRuleVersion,
  type AllocationValidationProblem,
  type KnownDriver,
} from "./validate.ts";

/**
 * Rule/version service (shard A1): versioned, effective-dated allocation
 * rules. Drafts are freely editable; publish validates, hashes and freezes;
 * retire ends a version. Every mutation runs in withOrgTransaction (RLS) and
 * writes audit_log evidence with before/after and a reason.
 */

export class AllocationRuleError extends Error {
  readonly code: "NOT_FOUND" | "INVALID" | "FROZEN" | "STALE";
  readonly problems?: AllocationValidationProblem[];

  constructor(code: "NOT_FOUND" | "INVALID" | "FROZEN" | "STALE", message: string, problems?: AllocationValidationProblem[]) {
    super(message);
    this.name = "AllocationRuleError";
    this.code = code;
    if (problems !== undefined) this.problems = problems;
  }
}

export interface AllocationAudit {
  actorId: string | null;
  reason?: string;
}

export interface AllocationOrgScope {
  orgId: string;
  /**
   * Optimistic-concurrency token: the `revision` a read API returned for this
   * row. When present the write is refused as STALE unless the row still
   * carries it (the drawer maps that to a 409); null skips the check.
   */
  expectedRevision?: string | null;
}

/** A rule head with its update revision and current-version summary. */
export interface CurrentVersionSummary {
  id: string;
  versionNo: number;
  status: AllocationRuleVersion["status"];
  effectiveFrom: string;
  effectiveTo: string | null;
  definitionHash: string | null;
}

export interface RuleHeadSummary {
  rule: AllocationRuleHead;
  revision: string;
  currentVersion: CurrentVersionSummary | null;
}

export interface RuleVersionTimelineEntry {
  version: AllocationRuleVersion;
  revision: string;
  targetCount: number;
}

export interface RuleDetail {
  rule: AllocationRuleHead;
  revision: string;
  versions: RuleVersionTimelineEntry[];
}

export interface RuleVersionWithTargets {
  version: AllocationRuleVersion;
  targets: AllocationRuleTarget[];
  revision: string;
}

export interface RuleMutationResult {
  rule: AllocationRuleHead;
  revision: string;
}

export interface VersionMutationResult {
  version: AllocationRuleVersion;
  revision: string;
}

export interface TargetsMutationResult {
  targets: AllocationRuleTarget[];
  revision: string;
}

export interface CreateRuleInput extends AllocationOrgScope {
  key: string;
  name: string;
  description?: string | null;
  mode: AllocationMode;
  sortOrder?: number;
  isActive?: boolean;
}

export interface UpdateRuleInput extends AllocationOrgScope {
  name?: string;
  description?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

export interface AllocationTargetInput {
  sequence?: number;
  targetAccountId?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
  classId?: string | null;
  projectId?: string | null;
  subsidiaryId?: string | null;
  extraDims?: Record<string, string>;
  fixedPercent?: string | null;
  weight?: string | null;
  isRemainder?: boolean;
  label?: string | null;
}

export interface DraftVersionInput extends AllocationOrgScope {
  /** Copy the definition and targets of this same-rule version; nothing else may be set. */
  fromVersionId?: string;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  bookScope?: AllocationBookScope;
  bookIds?: string[];
  documentKinds?: string[] | null;
  accountScope?: AccountScope;
  dimensionFilters?: DimensionFilters;
  applyPolicy?: AllocationApplyPolicy;
  sourceMeasure?: AllocationSourceMeasure;
  basisKind?: AllocationBasisKind;
  driverId?: string | null;
  driverAsOf?: AllocationDriverAsOf;
  basisConfig?: Record<string, unknown>;
  targetKind?: AllocationTargetKind;
  dynamicTarget?: Partial<DynamicTarget>;
  impact?: AllocationImpact;
  offsetAccountId?: string | null;
  residualPolicy?: AllocationResidualPolicy;
  residualTargetId?: string | null;
  solveMethod?: AllocationSolveMethod;
  runPolicy?: AllocationRunPolicy;
  runOffsetDays?: number;
  approvalFlowId?: string | null;
  memoTemplate?: string | null;
  lineDescriptionTemplate?: string | null;
  targets?: AllocationTargetInput[];
}

export type UpdateDraftInput = Omit<DraftVersionInput, "fromVersionId" | "targets">;

export interface ReplaceTargetsInput extends AllocationOrgScope {
  targets: AllocationTargetInput[];
}

export interface VersionTransitionInput {
  orgId: string;
  actorId: string | null;
  reason?: string;
}

export interface ListRulesInEffectInput {
  orgId: string;
  mode: AllocationMode;
  /** ISO date the version window must cover. */
  onDate: string;
  /** Only versions whose book scope covers this book. */
  bookId?: string;
}

const MODES: readonly AllocationMode[] = ["entry", "post", "period"];
const BOOK_SCOPES: readonly AllocationBookScope[] = ["primary", "all_posting", "books"];
const APPLY_POLICIES: readonly AllocationApplyPolicy[] = ["automatic", "suggest", "manual"];
const SOURCE_MEASURES: readonly AllocationSourceMeasure[] = ["period_activity", "period_end_balance", "ytd_activity"];
const BASIS_KINDS: readonly AllocationBasisKind[] = ["fixed_percent", "driver", "stepped"];
const DRIVER_AS_OF: readonly AllocationDriverAsOf[] = ["period", "document_date", "prior_period"];
const TARGET_KINDS: readonly AllocationTargetKind[] = ["explicit", "dynamic"];
const IMPACTS: readonly AllocationImpact[] = ["reclass", "net_zero_pair", "report_only"];
const RESIDUAL_POLICIES: readonly AllocationResidualPolicy[] = ["largest_share", "first_target", "last_target", "explicit_target"];
const SOLVE_METHODS: readonly AllocationSolveMethod[] = ["sequential", "simultaneous"];
const RUN_POLICIES: readonly AllocationRunPolicy[] = ["manual", "auto_preview", "auto_post"];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new AllocationRuleError("INVALID", `${what} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function nonEmpty(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AllocationRuleError("INVALID", `${what} must be a non-empty string`);
  }
  return value.trim();
}

function slug(value: unknown, what: string): string {
  const text = nonEmpty(value, what);
  if (!KEY_PATTERN.test(text)) {
    throw new AllocationRuleError("INVALID", `${what} must match ${KEY_PATTERN.source}: "${text}"`);
  }
  return text;
}

function uuid(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new AllocationRuleError("INVALID", `${what} must be a uuid`);
  }
  return value;
}

function isoDate(value: unknown, what: string): string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new AllocationRuleError("INVALID", `${what} must be an ISO date (YYYY-MM-DD)`);
  }
  return value;
}

function intIn(value: unknown, what: string, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new AllocationRuleError("INVALID", `${what} must be an integer >= ${min}`);
  }
  return value;
}

function asDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").slice(0, 10);
}

function asInstant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function asObject<T>(value: unknown, fallback: T): T {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as T;
  return fallback;
}

/** Walk the driver-error cause chain for a Postgres constraint failure. */
function dbFault(error: unknown): { code?: string; constraint?: string; message?: string } {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; message?: string; cause?: unknown };
    if (candidate.code !== undefined) return { code: candidate.code, constraint: candidate.constraint, message: candidate.message };
    current = candidate.cause;
  }
  return {};
}

function mapConstraint(error: unknown, what: string): never {
  const fault = dbFault(error);
  if (fault.code === "23505") {
    if (fault.constraint === "allocation_rules_org_key") {
      throw new AllocationRuleError("INVALID", `allocation rule key is already taken in this organization`);
    }
    if (fault.constraint === "allocation_rule_targets_version_seq") {
      throw new AllocationRuleError("INVALID", `duplicate target sequence in ${what}`);
    }
    throw new AllocationRuleError("INVALID", `${what} conflicts with an existing row`);
  }
  if (fault.code === "23503") {
    throw new AllocationRuleError("INVALID", `${what} references a row outside this organization or that does not exist`);
  }
  if (fault.code === "23514" || fault.code === "22P02" || fault.code === "22P01") {
    throw new AllocationRuleError("INVALID", `${what} failed a database check: ${fault.message ?? fault.code}`);
  }
  if (fault.code === "P0001") {
    const message = fault.message ?? "";
    if (/immutable|retired/.test(message)) {
      throw new AllocationRuleError("FROZEN", message);
    }
    throw new AllocationRuleError("INVALID", message);
  }
  throw error;
}

async function auditEvidence(args: {
  orgId: string;
  table: "allocation_rules" | "allocation_rule_versions";
  rowId: string;
  action: "insert" | "update" | "delete";
  event: string;
  before: unknown;
  after: unknown;
  actorId: string | null;
  reason?: string;
}): Promise<void> {
  await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${args.orgId}, ${args.table}, ${args.rowId}, ${args.action},
      ${JSON.stringify({ event: args.event, before: args.before, after: args.after, reason: args.reason ?? args.event })},
      ${args.actorId})`);
}

async function requireRevision(
  table: "allocation_rules" | "allocation_rule_versions",
  orgId: string,
  id: string,
  expected: string | null | undefined,
): Promise<void> {
  if (expected === null || expected === undefined) return;
  const column = table === "allocation_rules" ? sql.raw("allocation_rules.updated_at") : sql.raw("allocation_rule_versions.updated_at");
  const rows = await db.execute<{ match: boolean }>(sql`select (${documentRevisionSql(sql`${column}`)} = ${expected}) as match
    from ${sql.raw(table)} where org_id = ${orgId} and id = ${id}`);
  const row = rows.rows[0];
  if (row === undefined) throw new AllocationRuleError("NOT_FOUND", `${table} row not found: ${id}`);
  if (!row.match) {
    throw new AllocationRuleError("STALE", `${table} row ${id} changed since the revision token was read; reload and retry`);
  }
}

/** The current update revision of a rule or version row (opaque to callers). */
async function readRevision(
  table: "allocation_rules" | "allocation_rule_versions",
  orgId: string,
  id: string,
): Promise<string> {
  const column = table === "allocation_rules" ? sql.raw("allocation_rules.updated_at") : sql.raw("allocation_rule_versions.updated_at");
  const rows = await db.execute<{ revision: string }>(
    sql`select ${documentRevisionSql(sql`${column}`)} as revision from ${sql.raw(table)} where org_id = ${orgId} and id = ${id}`,
  );
  const row = rows.rows[0];
  if (row === undefined) throw new AllocationRuleError("NOT_FOUND", `${table} row not found: ${id}`);
  return row.revision;
}

type Prefixed = Record<string, unknown>;
const get = (row: Prefixed, prefix: string, name: string): unknown => row[`${prefix}${name}`];

function mapRule(row: Prefixed, prefix: string): AllocationRuleHead {
  return {
    id: String(get(row, prefix, "id")),
    orgId: String(get(row, prefix, "org_id")),
    key: String(get(row, prefix, "key")),
    name: String(get(row, prefix, "name")),
    description: (get(row, prefix, "description") as string | null) ?? null,
    mode: get(row, prefix, "mode") as AllocationMode,
    sortOrder: Number(get(row, prefix, "sort_order")),
    isActive: Boolean(get(row, prefix, "is_active")),
    isSystem: Boolean(get(row, prefix, "is_system")),
    currentVersionId: (get(row, prefix, "current_version_id") as string | null) ?? null,
  };
}

function mapVersion(row: Prefixed, prefix: string): AllocationRuleVersion {
  const documentKinds = get(row, prefix, "document_kinds");
  return {
    id: String(get(row, prefix, "id")),
    orgId: String(get(row, prefix, "org_id")),
    ruleId: String(get(row, prefix, "rule_id")),
    versionNo: Number(get(row, prefix, "version_no")),
    status: get(row, prefix, "status") as AllocationRuleVersion["status"],
    effectiveFrom: asDate(get(row, prefix, "effective_from")),
    effectiveTo: get(row, prefix, "effective_to") === null ? null : asDate(get(row, prefix, "effective_to")),
    bookScope: get(row, prefix, "book_scope") as AllocationRuleVersion["bookScope"],
    bookIds: asStrings(get(row, prefix, "book_ids")),
    documentKinds: documentKinds === null || documentKinds === undefined ? null : asStrings(documentKinds),
    accountScope: asObject<AccountScope>(get(row, prefix, "account_scope"), { kind: "any" }),
    dimensionFilters: asObject<DimensionFilters>(get(row, prefix, "dimension_filters"), {}),
    applyPolicy: get(row, prefix, "apply_policy") as AllocationRuleVersion["applyPolicy"],
    sourceMeasure: get(row, prefix, "source_measure") as AllocationRuleVersion["sourceMeasure"],
    basisKind: get(row, prefix, "basis_kind") as AllocationRuleVersion["basisKind"],
    driverId: (get(row, prefix, "driver_id") as string | null) ?? null,
    driverAsOf: get(row, prefix, "driver_as_of") as AllocationRuleVersion["driverAsOf"],
    basisConfig: asObject<Record<string, unknown>>(get(row, prefix, "basis_config"), {}),
    targetKind: get(row, prefix, "target_kind") as AllocationRuleVersion["targetKind"],
    dynamicTarget: asObject<Partial<DynamicTarget>>(get(row, prefix, "dynamic_target"), {}),
    impact: get(row, prefix, "impact") as AllocationRuleVersion["impact"],
    offsetAccountId: (get(row, prefix, "offset_account_id") as string | null) ?? null,
    residualPolicy: get(row, prefix, "residual_policy") as AllocationRuleVersion["residualPolicy"],
    residualTargetId: (get(row, prefix, "residual_target_id") as string | null) ?? null,
    solveMethod: get(row, prefix, "solve_method") as AllocationRuleVersion["solveMethod"],
    runPolicy: get(row, prefix, "run_policy") as AllocationRuleVersion["runPolicy"],
    runOffsetDays: Number(get(row, prefix, "run_offset_days")),
    approvalFlowId: (get(row, prefix, "approval_flow_id") as string | null) ?? null,
    memoTemplate: (get(row, prefix, "memo_template") as string | null) ?? null,
    lineDescriptionTemplate: (get(row, prefix, "line_description_template") as string | null) ?? null,
    definitionHash: (get(row, prefix, "definition_hash") as string | null) ?? null,
    publishedAt: asInstant(get(row, prefix, "published_at")),
    publishedBy: (get(row, prefix, "published_by") as string | null) ?? null,
  };
}

function mapTarget(row: Prefixed, prefix: string): AllocationRuleTarget {
  const extra = get(row, prefix, "extra_dims");
  const extraDims: Record<string, string> = {};
  if (typeof extra === "object" && extra !== null && !Array.isArray(extra)) {
    for (const [key, value] of Object.entries(extra as Record<string, unknown>)) extraDims[key] = String(value);
  }
  return {
    id: String(get(row, prefix, "id")),
    sequence: Number(get(row, prefix, "sequence")),
    targetAccountId: (get(row, prefix, "target_account_id") as string | null) ?? null,
    departmentId: (get(row, prefix, "department_id") as string | null) ?? null,
    locationId: (get(row, prefix, "location_id") as string | null) ?? null,
    classId: (get(row, prefix, "class_id") as string | null) ?? null,
    projectId: (get(row, prefix, "project_id") as string | null) ?? null,
    subsidiaryId: (get(row, prefix, "subsidiary_id") as string | null) ?? null,
    extraDims,
    fixedPercent: get(row, prefix, "fixed_percent") === null ? null : String(get(row, prefix, "fixed_percent")),
    weight: get(row, prefix, "weight") === null ? null : String(get(row, prefix, "weight")),
    isRemainder: Boolean(get(row, prefix, "is_remainder")),
    label: (get(row, prefix, "label") as string | null) ?? null,
  };
}

const RULE_COLS = sql`r.id as rule_id, r.org_id as rule_org_id, r.key as rule_key, r.name as rule_name,
  r.description as rule_description, r.mode as rule_mode, r.sort_order as rule_sort_order,
  r.is_active as rule_is_active, r.is_system as rule_is_system, r.current_version_id as rule_current_version_id`;
const VERSION_COLS = sql`v.id as version_id, v.org_id as version_org_id, v.rule_id as version_rule_id,
  v.version_no as version_version_no, v.status as version_status, v.effective_from as version_effective_from,
  v.effective_to as version_effective_to, v.book_scope as version_book_scope, v.book_ids as version_book_ids,
  v.document_kinds as version_document_kinds, v.account_scope as version_account_scope,
  v.dimension_filters as version_dimension_filters, v.apply_policy as version_apply_policy,
  v.source_measure as version_source_measure, v.basis_kind as version_basis_kind,
  v.driver_id as version_driver_id, v.driver_as_of as version_driver_as_of,
  v.basis_config as version_basis_config, v.target_kind as version_target_kind,
  v.dynamic_target as version_dynamic_target, v.impact as version_impact,
  v.offset_account_id as version_offset_account_id, v.residual_policy as version_residual_policy,
  v.residual_target_id as version_residual_target_id, v.solve_method as version_solve_method,
  v.run_policy as version_run_policy, v.run_offset_days as version_run_offset_days,
  v.approval_flow_id as version_approval_flow_id, v.memo_template as version_memo_template,
  v.line_description_template as version_line_description_template, v.definition_hash as version_definition_hash,
  v.published_at as version_published_at, v.published_by as version_published_by`;
const TARGET_COLS = sql`t.id as target_id, t.sequence as target_sequence,
  t.target_account_id as target_target_account_id, t.department_id as target_department_id,
  t.location_id as target_location_id, t.class_id as target_class_id, t.project_id as target_project_id,
  t.subsidiary_id as target_subsidiary_id, t.extra_dims as target_extra_dims,
  t.fixed_percent as target_fixed_percent, t.weight as target_weight,
  t.is_remainder as target_is_remainder, t.label as target_label`;

async function loadRuleHead(orgId: string, ruleId: string, forUpdate: boolean): Promise<AllocationRuleHead> {
  const lock = forUpdate ? sql` for update` : sql``;
  const rows = await db.execute<Prefixed>(
    sql`select ${RULE_COLS} from allocation_rules r where r.org_id = ${orgId} and r.id = ${ruleId}${lock}`,
  );
  const row = rows.rows[0];
  if (row === undefined) throw new AllocationRuleError("NOT_FOUND", `allocation rule not found: ${ruleId}`);
  return mapRule(row, "rule_");
}

async function loadVersionRow(orgId: string, versionId: string): Promise<Prefixed> {
  const rows = await db.execute<Prefixed>(
    sql`select ${VERSION_COLS} from allocation_rule_versions v where v.org_id = ${orgId} and v.id = ${versionId}`,
  );
  const row = rows.rows[0];
  if (row === undefined) throw new AllocationRuleError("NOT_FOUND", `allocation rule version not found: ${versionId}`);
  return row;
}

async function loadTargets(orgId: string, versionId: string): Promise<AllocationRuleTarget[]> {
  const rows = await db.execute<Prefixed>(
    sql`select ${TARGET_COLS} from allocation_rule_targets t
        where t.org_id = ${orgId} and t.version_id = ${versionId} order by t.sequence`,
  );
  return rows.rows.map((row) => mapTarget(row, "target_"));
}

function checkedTargets(input: AllocationTargetInput[] | undefined, what: string): AllocationTargetInput[] {
  const targets = input ?? [];
  const sequences = new Set<number>();
  targets.forEach((target, index) => {
    const sequence = target.sequence ?? index + 1;
    intIn(sequence, `${what} target sequence`, 0);
    if (sequences.has(sequence)) {
      throw new AllocationRuleError("INVALID", `duplicate target sequence ${sequence} in ${what}`);
    }
    sequences.add(sequence);
    if (target.extraDims !== undefined && (typeof target.extraDims !== "object" || target.extraDims === null || Array.isArray(target.extraDims))) {
      throw new AllocationRuleError("INVALID", `${what} target sequence ${sequence} extraDims must be an object`);
    }
    for (const id of [target.targetAccountId, target.departmentId, target.locationId, target.classId, target.projectId, target.subsidiaryId]) {
      if (id !== undefined && id !== null) uuid(id, `${what} target dimension reference`);
    }
  });
  return targets;
}

async function insertTargets(orgId: string, versionId: string, targets: AllocationTargetInput[], actorId: string | null): Promise<void> {
  const checked = checkedTargets(targets, "allocation version");
  let position = 0;
  for (const target of checked) {
    position += 1;
    const sequence = target.sequence ?? position;
    try {
      await db.execute(sql`insert into allocation_rule_targets
        (id, org_id, version_id, sequence, target_account_id, department_id, location_id, class_id,
         project_id, subsidiary_id, extra_dims, fixed_percent, weight, is_remainder, label, created_by, updated_by)
        values (${randomUUID()}, ${orgId}, ${versionId}, ${sequence},
          ${target.targetAccountId ?? null}, ${target.departmentId ?? null}, ${target.locationId ?? null},
          ${target.classId ?? null}, ${target.projectId ?? null}, ${target.subsidiaryId ?? null},
          ${JSON.stringify(target.extraDims ?? {})}, ${target.fixedPercent ?? null}, ${target.weight ?? null},
          ${target.isRemainder ?? false}, ${target.label ?? null}, ${actorId}, ${actorId})`);
    } catch (error) {
      mapConstraint(error, "allocation target insert");
    }
  }
}

export async function createRule(input: CreateRuleInput, audit: AllocationAudit): Promise<RuleMutationResult> {
  const orgId = uuid(input.orgId, "orgId");
  const key = slug(input.key, "key");
  const name = nonEmpty(input.name, "name");
  const mode = oneOf(input.mode, MODES, "mode");
  const sortOrder = input.sortOrder === undefined ? 100 : intIn(input.sortOrder, "sortOrder", -2147483648);
  const isActive = input.isActive ?? true;
  const description = input.description ?? null;
  return withOrgTransaction(orgId, async () => {
    const existing = await db.execute<{ id: string }>(
      sql`select id from allocation_rules where org_id = ${orgId} and key = ${key}`,
    );
    if (existing.rows.length > 0) {
      throw new AllocationRuleError("INVALID", `allocation rule key is already taken in this organization: "${key}"`);
    }
    const id = randomUUID();
    try {
      await db.execute(sql`insert into allocation_rules
        (id, org_id, key, name, description, mode, sort_order, is_active, is_system, custom, created_by, updated_by)
        values (${id}, ${orgId}, ${key}, ${name}, ${description}, ${mode}, ${sortOrder}, ${isActive}, false,
          ${JSON.stringify({})}, ${audit.actorId}, ${audit.actorId})`);
    } catch (error) {
      mapConstraint(error, "allocation rule create");
    }
    const head = await loadRuleHead(orgId, id, false);
    await auditEvidence({
      orgId, table: "allocation_rules", rowId: id, action: "insert", event: "rule.created",
      before: null, after: head, actorId: audit.actorId, reason: audit.reason,
    });
    return { rule: head, revision: await readRevision("allocation_rules", orgId, id) };
  });
}

/**
 * Engine-owned rules (is_system, e.g. the overhead net-zero pair) are managed
 * through their owning policy — overhead settings, rate publishes — never
 * through the rules API. Every service mutation below refuses them; the
 * owning engine sync writes its rows directly with its own audit evidence.
 */
function refuseSystemRule(head: AllocationRuleHead, what: string): void {
  if (head.isSystem) {
    throw new AllocationRuleError(
      "FROZEN",
      `engine-owned rule "${head.key}" is managed through its owning policy and cannot be ${what} through the rules API`,
    );
  }
}

export async function deleteRule(
  ruleId: string,
  input: AllocationOrgScope,
  audit: AllocationAudit,
): Promise<{ ruleId: string }> {
  const orgId = uuid(input.orgId, "orgId");
  const id = uuid(ruleId, "ruleId");
  return withOrgTransaction(orgId, async () => {
    const before = await loadRuleHead(orgId, id, true);
    refuseSystemRule(before, "deleted");
    await requireRevision("allocation_rules", orgId, id, input.expectedRevision);
    const versions = await db.execute<{ id: string; status: string }>(
      sql`select id, status from allocation_rule_versions where org_id = ${orgId} and rule_id = ${id}`,
    );
    if (versions.rows.some((row) => row.status !== "draft")) {
      throw new AllocationRuleError(
        "INVALID",
        `allocation rule "${before.key}" has published history and cannot be deleted; retire its versions instead`,
      );
    }
    for (const version of versions.rows) {
      await db.execute(sql`delete from allocation_rule_targets where org_id = ${orgId} and version_id = ${version.id}`);
      await db.execute(sql`delete from allocation_rule_versions where org_id = ${orgId} and id = ${version.id}`);
    }
    await db.execute(sql`delete from allocation_rules where org_id = ${orgId} and id = ${id}`);
    await auditEvidence({
      orgId, table: "allocation_rules", rowId: id, action: "delete", event: "rule.deleted",
      before, after: null, actorId: audit.actorId, reason: audit.reason,
    });
    return { ruleId: id };
  });
}

export async function updateRule(ruleId: string, input: UpdateRuleInput, audit: AllocationAudit): Promise<RuleMutationResult> {
  const orgId = uuid(input.orgId, "orgId");
  const id = uuid(ruleId, "ruleId");
  return withOrgTransaction(orgId, async () => {
    const before = await loadRuleHead(orgId, id, false);
    refuseSystemRule(before, "edited");
    await requireRevision("allocation_rules", orgId, id, input.expectedRevision);
    const name = input.name === undefined ? before.name : nonEmpty(input.name, "name");
    const description = input.description === undefined ? (before.description ?? null) : input.description;
    const sortOrder = input.sortOrder === undefined ? before.sortOrder : intIn(input.sortOrder, "sortOrder", -2147483648);
    const isActive = input.isActive ?? before.isActive;
    await db.execute(sql`update allocation_rules
      set name = ${name}, description = ${description}, sort_order = ${sortOrder}, is_active = ${isActive},
        updated_at = now(), updated_by = ${audit.actorId}
      where org_id = ${orgId} and id = ${id}`);
    const after = await loadRuleHead(orgId, id, false);
    await auditEvidence({
      orgId, table: "allocation_rules", rowId: id, action: "update", event: "rule.updated",
      before, after, actorId: audit.actorId, reason: audit.reason,
    });
    return { rule: after, revision: await readRevision("allocation_rules", orgId, id) };
  });
}

interface ResolvedDefinition {
  effectiveFrom: string;
  effectiveTo: string | null;
  bookScope: AllocationBookScope;
  bookIds: string[];
  documentKinds: string[] | null;
  accountScope: AccountScope;
  dimensionFilters: DimensionFilters;
  applyPolicy: AllocationApplyPolicy;
  sourceMeasure: AllocationSourceMeasure;
  basisKind: AllocationBasisKind;
  driverId: string | null;
  driverAsOf: AllocationDriverAsOf;
  basisConfig: Record<string, unknown>;
  targetKind: AllocationTargetKind;
  dynamicTarget: Partial<DynamicTarget>;
  impact: AllocationImpact;
  offsetAccountId: string | null;
  residualPolicy: AllocationResidualPolicy;
  residualTargetId: string | null;
  solveMethod: AllocationSolveMethod;
  runPolicy: AllocationRunPolicy;
  runOffsetDays: number;
  approvalFlowId: string | null;
  memoTemplate: string | null;
  lineDescriptionTemplate: string | null;
}

function checkedAccountScope(value: unknown): AccountScope {
  if (!isRecord(value)) throw new AllocationRuleError("INVALID", "accountScope must be an object");
  const kind = value["kind"];
  if (kind === "any") return { kind: "any" };
  if (kind === "accounts") {
    const ids = value["accountIds"];
    if (!Array.isArray(ids)) throw new AllocationRuleError("INVALID", "accountScope.accounts needs accountIds");
    return { kind: "accounts", accountIds: ids.map((id) => uuid(id, "accountScope.accountIds")) };
  }
  if (kind === "account_group") {
    if (typeof value["dimension"] !== "string" || typeof value["groupKey"] !== "string") {
      throw new AllocationRuleError("INVALID", "accountScope.account_group needs dimension and groupKey");
    }
    return { kind: "account_group", dimension: value["dimension"], groupKey: value["groupKey"] };
  }
  throw new AllocationRuleError("INVALID", "accountScope.kind must be any, accounts or account_group");
}

function checkedDimensionFilters(value: unknown): DimensionFilters {
  if (!isRecord(value)) throw new AllocationRuleError("INVALID", "dimensionFilters must be an object");
  const out: DimensionFilters = {};
  const idList = (key: string): string[] | undefined => {
    const raw: unknown = value[key];
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) throw new AllocationRuleError("INVALID", `dimensionFilters.${key} must be an array`);
    return raw.map((id) => uuid(id, `dimensionFilters.${key}`));
  };
  const departmentIds = idList("departmentIds");
  if (departmentIds !== undefined) out.departmentIds = departmentIds;
  const locationIds = idList("locationIds");
  if (locationIds !== undefined) out.locationIds = locationIds;
  const classIds = idList("classIds");
  if (classIds !== undefined) out.classIds = classIds;
  const projectIds = idList("projectIds");
  if (projectIds !== undefined) out.projectIds = projectIds;
  const subsidiaryIds = idList("subsidiaryIds");
  if (subsidiaryIds !== undefined) out.subsidiaryIds = subsidiaryIds;
  const partyIds = idList("partyIds");
  if (partyIds !== undefined) out.partyIds = partyIds;
  const itemIds = idList("itemIds");
  if (itemIds !== undefined) out.itemIds = itemIds;
  const extraDims: unknown = value["extraDims"];
  if (extraDims !== undefined) {
    if (!isRecord(extraDims)) throw new AllocationRuleError("INVALID", "dimensionFilters.extraDims must be an object");
    out.extraDims = {};
    for (const [segment, ids] of Object.entries(extraDims)) {
      if (!Array.isArray(ids)) throw new AllocationRuleError("INVALID", `dimensionFilters.extraDims.${segment} must be an array`);
      out.extraDims[segment] = ids.map((id) => uuid(id, `dimensionFilters.extraDims.${segment}`));
    }
  }
  const untagged: unknown = value["requireUntagged"];
  if (untagged !== undefined) {
    if (!Array.isArray(untagged)) throw new AllocationRuleError("INVALID", "dimensionFilters.requireUntagged must be an array");
    out.requireUntagged = untagged.map((entry) => oneOf(entry, ["department", "location", "class", "project"] as const, "dimensionFilters.requireUntagged"));
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveDefinition(input: DraftVersionInput | UpdateDraftInput, kind: "create" | "update"): Partial<ResolvedDefinition> {
  const def: Partial<ResolvedDefinition> = {};
  if (input.effectiveFrom !== undefined) def.effectiveFrom = isoDate(input.effectiveFrom, "effectiveFrom");
  else if (kind === "create") throw new AllocationRuleError("INVALID", "effectiveFrom is required for a new version");
  if (input.effectiveTo !== undefined) {
    def.effectiveTo = input.effectiveTo === null ? null : isoDate(input.effectiveTo, "effectiveTo");
  }
  if (input.bookScope !== undefined) def.bookScope = oneOf(input.bookScope, BOOK_SCOPES, "bookScope");
  if (input.bookIds !== undefined) {
    if (!Array.isArray(input.bookIds)) throw new AllocationRuleError("INVALID", "bookIds must be an array");
    def.bookIds = input.bookIds.map((id) => uuid(id, "bookIds"));
  }
  if (input.documentKinds !== undefined) {
    if (input.documentKinds !== null && !Array.isArray(input.documentKinds)) {
      throw new AllocationRuleError("INVALID", "documentKinds must be an array or null");
    }
    def.documentKinds = input.documentKinds === null ? null : input.documentKinds.map((kind) => nonEmpty(kind, "documentKinds"));
  }
  if (input.accountScope !== undefined) def.accountScope = checkedAccountScope(input.accountScope);
  if (input.dimensionFilters !== undefined) def.dimensionFilters = checkedDimensionFilters(input.dimensionFilters);
  if (input.applyPolicy !== undefined) def.applyPolicy = oneOf(input.applyPolicy, APPLY_POLICIES, "applyPolicy");
  if (input.sourceMeasure !== undefined) def.sourceMeasure = oneOf(input.sourceMeasure, SOURCE_MEASURES, "sourceMeasure");
  if (input.basisKind !== undefined) def.basisKind = oneOf(input.basisKind, BASIS_KINDS, "basisKind");
  if (input.driverId !== undefined) def.driverId = input.driverId === null ? null : uuid(input.driverId, "driverId");
  if (input.driverAsOf !== undefined) def.driverAsOf = oneOf(input.driverAsOf, DRIVER_AS_OF, "driverAsOf");
  if (input.basisConfig !== undefined) {
    if (!isRecord(input.basisConfig)) throw new AllocationRuleError("INVALID", "basisConfig must be an object");
    def.basisConfig = input.basisConfig;
  }
  if (input.targetKind !== undefined) def.targetKind = oneOf(input.targetKind, TARGET_KINDS, "targetKind");
  if (input.dynamicTarget !== undefined) {
    if (!isRecord(input.dynamicTarget)) throw new AllocationRuleError("INVALID", "dynamicTarget must be an object");
    def.dynamicTarget = input.dynamicTarget as Partial<DynamicTarget>;
  }
  if (input.impact !== undefined) def.impact = oneOf(input.impact, IMPACTS, "impact");
  if (input.offsetAccountId !== undefined) {
    def.offsetAccountId = input.offsetAccountId === null ? null : uuid(input.offsetAccountId, "offsetAccountId");
  }
  if (input.residualPolicy !== undefined) def.residualPolicy = oneOf(input.residualPolicy, RESIDUAL_POLICIES, "residualPolicy");
  if (input.residualTargetId !== undefined) {
    def.residualTargetId = input.residualTargetId === null ? null : uuid(input.residualTargetId, "residualTargetId");
  }
  if (input.solveMethod !== undefined) def.solveMethod = oneOf(input.solveMethod, SOLVE_METHODS, "solveMethod");
  if (input.runPolicy !== undefined) def.runPolicy = oneOf(input.runPolicy, RUN_POLICIES, "runPolicy");
  if (input.runOffsetDays !== undefined) def.runOffsetDays = intIn(input.runOffsetDays, "runOffsetDays", 0);
  if (input.approvalFlowId !== undefined) {
    def.approvalFlowId = input.approvalFlowId === null ? null : uuid(input.approvalFlowId, "approvalFlowId");
  }
  if (input.memoTemplate !== undefined) def.memoTemplate = input.memoTemplate;
  if (input.lineDescriptionTemplate !== undefined) def.lineDescriptionTemplate = input.lineDescriptionTemplate;
  return def;
}

const COPY_EXCLUSIVE: (keyof DraftVersionInput)[] = [
  "effectiveFrom", "effectiveTo", "bookScope", "bookIds", "documentKinds", "accountScope",
  "dimensionFilters", "applyPolicy", "sourceMeasure", "basisKind", "driverId", "driverAsOf",
  "basisConfig", "targetKind", "dynamicTarget", "impact", "offsetAccountId", "residualPolicy",
  "residualTargetId", "solveMethod", "runPolicy", "runOffsetDays", "approvalFlowId",
  "memoTemplate", "lineDescriptionTemplate", "targets",
];

function defaultDefinition(): ResolvedDefinition {
  return {
    effectiveFrom: "",
    effectiveTo: null,
    bookScope: "primary",
    bookIds: [],
    documentKinds: null,
    accountScope: { kind: "any" },
    dimensionFilters: {},
    applyPolicy: "manual",
    sourceMeasure: "period_activity",
    basisKind: "fixed_percent",
    driverId: null,
    driverAsOf: "period",
    basisConfig: {},
    targetKind: "explicit",
    dynamicTarget: {},
    impact: "reclass",
    offsetAccountId: null,
    residualPolicy: "largest_share",
    residualTargetId: null,
    solveMethod: "sequential",
    runPolicy: "manual",
    runOffsetDays: 0,
    approvalFlowId: null,
    memoTemplate: null,
    lineDescriptionTemplate: null,
  };
}

export async function createDraftVersion(
  ruleId: string,
  input: DraftVersionInput,
  audit: AllocationAudit,
): Promise<RuleVersionWithTargets> {
  const orgId = uuid(input.orgId, "orgId");
  const id = uuid(ruleId, "ruleId");
  return withOrgTransaction(orgId, async () => {
    const head = await loadRuleHead(orgId, id, true);
    refuseSystemRule(head, "edited");
    const maxRow = await db.execute<{ n: string }>(
      sql`select coalesce(max(version_no), 0)::text as n from allocation_rule_versions where org_id = ${orgId} and rule_id = ${id}`,
    );
    const versionNo = Number(maxRow.rows[0]?.n ?? "0") + 1;
    let def: ResolvedDefinition;
    let targets: AllocationTargetInput[];
    if (input.fromVersionId !== undefined) {
      const sourceId = uuid(input.fromVersionId, "fromVersionId");
      for (const key of COPY_EXCLUSIVE) {
        if (input[key] !== undefined) {
          throw new AllocationRuleError("INVALID", `cannot combine fromVersionId with ${key}; edit the copy afterwards`);
        }
      }
      const sourceRow = await loadVersionRow(orgId, sourceId);
      const source = mapVersion(sourceRow, "version_");
      if (source.ruleId !== id) {
        throw new AllocationRuleError("INVALID", "fromVersionId must belong to the same rule");
      }
      const sourceTargets = await loadTargets(orgId, sourceId);
      def = {
        ...defaultDefinition(),
        effectiveFrom: source.effectiveFrom,
        effectiveTo: source.effectiveTo ?? null,
        bookScope: source.bookScope,
        bookIds: [...source.bookIds],
        documentKinds: source.documentKinds === undefined || source.documentKinds === null ? null : [...source.documentKinds],
        accountScope: source.accountScope,
        dimensionFilters: source.dimensionFilters,
        applyPolicy: source.applyPolicy,
        sourceMeasure: source.sourceMeasure,
        basisKind: source.basisKind,
        driverId: source.driverId ?? null,
        driverAsOf: source.driverAsOf,
        basisConfig: source.basisConfig,
        targetKind: source.targetKind,
        dynamicTarget: source.dynamicTarget,
        impact: source.impact,
        offsetAccountId: source.offsetAccountId ?? null,
        residualPolicy: source.residualPolicy,
        residualTargetId: null,
        solveMethod: source.solveMethod,
        runPolicy: source.runPolicy,
        runOffsetDays: source.runOffsetDays,
        approvalFlowId: source.approvalFlowId ?? null,
        memoTemplate: source.memoTemplate ?? null,
        lineDescriptionTemplate: source.lineDescriptionTemplate ?? null,
      };
      targets = sourceTargets.map((target) => ({
        targetAccountId: target.targetAccountId,
        departmentId: target.departmentId,
        locationId: target.locationId,
        classId: target.classId,
        projectId: target.projectId,
        subsidiaryId: target.subsidiaryId,
        extraDims: { ...(target.extraDims ?? {}) },
        fixedPercent: target.fixedPercent,
        weight: target.weight,
        isRemainder: target.isRemainder,
        label: target.label,
        sequence: target.sequence,
      }));
    } else {
      const partial = resolveDefinition(input, "create");
      def = { ...defaultDefinition(), ...partial };
      targets = input.targets ?? [];
    }
    if (def.effectiveFrom === "") throw new AllocationRuleError("INVALID", "effectiveFrom is required for a new version");
    const versionId = randomUUID();
    try {
      await db.execute(sql`insert into allocation_rule_versions
        (id, org_id, rule_id, version_no, status, effective_from, effective_to, book_scope, book_ids,
         document_kinds, account_scope, dimension_filters, apply_policy, source_measure, basis_kind,
         driver_id, driver_as_of, basis_config, target_kind, dynamic_target, impact, offset_account_id,
         residual_policy, residual_target_id, solve_method, run_policy, run_offset_days, approval_flow_id,
         memo_template, line_description_template, created_by, updated_by)
        values (${versionId}, ${orgId}, ${id}, ${versionNo}, 'draft', ${def.effectiveFrom}, ${def.effectiveTo},
          ${def.bookScope}, ${JSON.stringify(def.bookIds)},
          ${def.documentKinds === null ? null : JSON.stringify(def.documentKinds)},
          ${JSON.stringify(def.accountScope)}, ${JSON.stringify(def.dimensionFilters)}, ${def.applyPolicy},
          ${def.sourceMeasure}, ${def.basisKind}, ${def.driverId}, ${def.driverAsOf},
          ${JSON.stringify(def.basisConfig)}, ${def.targetKind}, ${JSON.stringify(def.dynamicTarget)},
          ${def.impact}, ${def.offsetAccountId}, ${def.residualPolicy}, ${def.residualTargetId},
          ${def.solveMethod}, ${def.runPolicy}, ${def.runOffsetDays}, ${def.approvalFlowId},
          ${def.memoTemplate}, ${def.lineDescriptionTemplate}, ${audit.actorId}, ${audit.actorId})`);
    } catch (error) {
      mapConstraint(error, "allocation version create");
    }
    try {
      await insertTargets(orgId, versionId, targets, audit.actorId);
    } catch (error) {
      // insertTargets already maps; a failure here leaves no partial version behind (same transaction rolls back).
      throw error;
    }
    const version = mapVersion(await loadVersionRow(orgId, versionId), "version_");
    const stored = await loadTargets(orgId, versionId);
    await auditEvidence({
      orgId, table: "allocation_rule_versions", rowId: versionId, action: "insert", event: "version.created",
      before: null, after: { version, targets: stored }, actorId: audit.actorId, reason: audit.reason,
    });
    return { version, targets: stored, revision: await readRevision("allocation_rule_versions", orgId, versionId) };
  });
}

export async function updateDraftVersion(
  versionId: string,
  input: UpdateDraftInput,
  audit: AllocationAudit,
): Promise<VersionMutationResult> {
  const orgId = uuid(input.orgId, "orgId");
  const id = uuid(versionId, "versionId");
  return withOrgTransaction(orgId, async () => {
    const before = mapVersion(await loadVersionRow(orgId, id), "version_");
    refuseSystemRule(await loadRuleHead(orgId, before.ruleId, true), "edited");
    if (before.status !== "draft") {
      throw new AllocationRuleError("FROZEN", `version ${id} is ${before.status}; only drafts are editable`);
    }
    await requireRevision("allocation_rule_versions", orgId, id, input.expectedRevision);
    const patch = resolveDefinition(input, "update");
    const next: ResolvedDefinition = {
      ...defaultDefinition(),
      effectiveFrom: before.effectiveFrom,
      effectiveTo: before.effectiveTo ?? null,
      bookScope: before.bookScope,
      bookIds: before.bookIds,
      documentKinds: before.documentKinds ?? null,
      accountScope: before.accountScope,
      dimensionFilters: before.dimensionFilters,
      applyPolicy: before.applyPolicy,
      sourceMeasure: before.sourceMeasure,
      basisKind: before.basisKind,
      driverId: before.driverId ?? null,
      driverAsOf: before.driverAsOf,
      basisConfig: before.basisConfig,
      targetKind: before.targetKind,
      dynamicTarget: before.dynamicTarget,
      impact: before.impact,
      offsetAccountId: before.offsetAccountId ?? null,
      residualPolicy: before.residualPolicy,
      residualTargetId: before.residualTargetId ?? null,
      solveMethod: before.solveMethod,
      runPolicy: before.runPolicy,
      runOffsetDays: before.runOffsetDays,
      approvalFlowId: before.approvalFlowId ?? null,
      memoTemplate: before.memoTemplate ?? null,
      lineDescriptionTemplate: before.lineDescriptionTemplate ?? null,
      ...patch,
    };
    try {
      await db.execute(sql`update allocation_rule_versions
        set effective_from = ${next.effectiveFrom}, effective_to = ${next.effectiveTo},
          book_scope = ${next.bookScope}, book_ids = ${JSON.stringify(next.bookIds)},
          document_kinds = ${next.documentKinds === null ? null : JSON.stringify(next.documentKinds)},
          account_scope = ${JSON.stringify(next.accountScope)},
          dimension_filters = ${JSON.stringify(next.dimensionFilters)}, apply_policy = ${next.applyPolicy},
          source_measure = ${next.sourceMeasure}, basis_kind = ${next.basisKind}, driver_id = ${next.driverId},
          driver_as_of = ${next.driverAsOf}, basis_config = ${JSON.stringify(next.basisConfig)},
          target_kind = ${next.targetKind}, dynamic_target = ${JSON.stringify(next.dynamicTarget)},
          impact = ${next.impact}, offset_account_id = ${next.offsetAccountId},
          residual_policy = ${next.residualPolicy}, residual_target_id = ${next.residualTargetId},
          solve_method = ${next.solveMethod}, run_policy = ${next.runPolicy},
          run_offset_days = ${next.runOffsetDays}, approval_flow_id = ${next.approvalFlowId},
          memo_template = ${next.memoTemplate}, line_description_template = ${next.lineDescriptionTemplate},
          updated_at = now(), updated_by = ${audit.actorId}
        where org_id = ${orgId} and id = ${id}`);
    } catch (error) {
      mapConstraint(error, "allocation version update");
    }
    const after = mapVersion(await loadVersionRow(orgId, id), "version_");
    await auditEvidence({
      orgId, table: "allocation_rule_versions", rowId: id, action: "update", event: "version.updated",
      before, after, actorId: audit.actorId, reason: audit.reason,
    });
    return { version: after, revision: await readRevision("allocation_rule_versions", orgId, id) };
  });
}

export async function replaceTargets(
  versionId: string,
  input: ReplaceTargetsInput,
  audit: AllocationAudit,
): Promise<TargetsMutationResult> {
  const orgId = uuid(input.orgId, "orgId");
  const id = uuid(versionId, "versionId");
  return withOrgTransaction(orgId, async () => {
    const version = mapVersion(await loadVersionRow(orgId, id), "version_");
    refuseSystemRule(await loadRuleHead(orgId, version.ruleId, true), "edited");
    if (version.status !== "draft") {
      throw new AllocationRuleError("FROZEN", `version ${id} is ${version.status}; its targets are immutable`);
    }
    await requireRevision("allocation_rule_versions", orgId, id, input.expectedRevision);
    const before = await loadTargets(orgId, id);
    checkedTargets(input.targets, "allocation version");
    try {
      await db.execute(sql`delete from allocation_rule_targets where org_id = ${orgId} and version_id = ${id}`);
      await insertTargets(orgId, id, input.targets, audit.actorId);
      await db.execute(sql`update allocation_rule_versions
        set updated_at = now(), updated_by = ${audit.actorId} where org_id = ${orgId} and id = ${id}`);
    } catch (error) {
      mapConstraint(error, "allocation target replace");
    }
    const after = await loadTargets(orgId, id);
    await auditEvidence({
      orgId, table: "allocation_rule_versions", rowId: id, action: "update", event: "version.targets_replaced",
      before: { targets: before }, after: { targets: after }, actorId: audit.actorId, reason: audit.reason,
    });
    return { targets: after, revision: await readRevision("allocation_rule_versions", orgId, id) };
  });
}

async function validationContext(
  orgId: string,
  ruleId: string,
  version: AllocationRuleVersion,
): Promise<{ siblings: { id: string; effectiveFrom: string; effectiveTo: string | null }[]; driver: KnownDriver | null; activePostingBookIds: string[] }> {
  const siblingRows = await db.execute<{ id: string; effective_from: unknown; effective_to: unknown }>(
    sql`select id, effective_from, effective_to from allocation_rule_versions
        where org_id = ${orgId} and rule_id = ${ruleId} and status = 'published' and id <> ${version.id}`,
  );
  let driver: KnownDriver | null = null;
  if (version.driverId !== null) {
    const driverRows = await db.execute<{ id: string; dimension: string; is_active: boolean }>(
      sql`select id, dimension, is_active from allocation_drivers where org_id = ${orgId} and id = ${version.driverId}`,
    );
    const row = driverRows.rows[0];
    driver = row === undefined ? null : { id: row.id, dimension: row.dimension, isActive: row.is_active };
  }
  const bookRows = await db.execute<{ id: string }>(
    sql`select id from accounting_books where org_id = ${orgId} and is_active and posts_gl`,
  );
  return {
    siblings: siblingRows.rows.map((row) => ({
      id: row.id,
      effectiveFrom: asDate(row.effective_from),
      effectiveTo: row.effective_to === null ? null : asDate(row.effective_to),
    })),
    driver,
    activePostingBookIds: bookRows.rows.map((row) => row.id),
  };
}

export async function publishVersion(
  versionId: string,
  input: VersionTransitionInput,
): Promise<RuleVersionWithTargets> {
  const orgId = uuid(input.orgId, "orgId");
  const id = uuid(versionId, "versionId");
  return withOrgTransaction(orgId, async () => {
    const row = await loadVersionRow(orgId, id);
    const version = mapVersion(row, "version_");
    // Lock the rule head so two overlapping publishes cannot both pass validation.
    const head = await loadRuleHead(orgId, version.ruleId, true);
    refuseSystemRule(head, "published");
    if (version.status === "published") {
      throw new AllocationRuleError("FROZEN", `version ${id} is already published`);
    }
    if (version.status === "retired") {
      throw new AllocationRuleError("FROZEN", `version ${id} is retired and cannot publish`);
    }
    const targets = await loadTargets(orgId, id);
    const context = await validationContext(orgId, version.ruleId, version);
    const problems = validateRuleVersion(version, targets, {
      orgId,
      ruleId: version.ruleId,
      mode: head.mode,
      publishedVersions: context.siblings,
      driver: context.driver,
      activePostingBookIds: context.activePostingBookIds,
    });
    if (problems.length > 0) {
      throw new AllocationRuleError("INVALID", `version ${id} cannot publish with ${problems.length} problem(s)`, problems);
    }
    const hash = definitionHash(version, targets);
    try {
      await db.execute(sql`update allocation_rule_versions
        set status = 'published', definition_hash = ${hash}, published_at = now(), published_by = ${input.actorId},
          updated_at = now(), updated_by = ${input.actorId}
        where org_id = ${orgId} and id = ${id}`);
      await db.execute(sql`update allocation_rules
        set current_version_id = ${id}, updated_at = now(), updated_by = ${input.actorId}
        where org_id = ${orgId} and id = ${version.ruleId}`);
    } catch (error) {
      mapConstraint(error, "allocation version publish");
    }
    const after = mapVersion(await loadVersionRow(orgId, id), "version_");
    await auditEvidence({
      orgId, table: "allocation_rule_versions", rowId: id, action: "update", event: "version.published",
      before: { status: "draft" as const }, after, actorId: input.actorId, reason: input.reason,
    });
    return { version: after, targets, revision: await readRevision("allocation_rule_versions", orgId, id) };
  });
}

export async function retireVersion(
  versionId: string,
  input: VersionTransitionInput,
): Promise<VersionMutationResult> {
  const orgId = uuid(input.orgId, "orgId");
  const id = uuid(versionId, "versionId");
  return withOrgTransaction(orgId, async () => {
    const version = mapVersion(await loadVersionRow(orgId, id), "version_");
    const head = await loadRuleHead(orgId, version.ruleId, true);
    refuseSystemRule(head, "retired");
    if (version.status === "retired") {
      throw new AllocationRuleError("FROZEN", `version ${id} is already retired`);
    }
    try {
      await db.execute(sql`update allocation_rule_versions
        set status = 'retired', retired_at = now(), retired_by = ${input.actorId},
          updated_at = now(), updated_by = ${input.actorId}
        where org_id = ${orgId} and id = ${id}`);
      if (head.currentVersionId === id) {
        await db.execute(sql`update allocation_rules
          set current_version_id = null, updated_at = now(), updated_by = ${input.actorId}
          where org_id = ${orgId} and id = ${version.ruleId}`);
      }
    } catch (error) {
      mapConstraint(error, "allocation version retire");
    }
    const after = mapVersion(await loadVersionRow(orgId, id), "version_");
    await auditEvidence({
      orgId, table: "allocation_rule_versions", rowId: id, action: "update", event: "version.retired",
      before: { status: version.status }, after, actorId: input.actorId, reason: input.reason,
    });
    return { version: after, revision: await readRevision("allocation_rule_versions", orgId, id) };
  });
}

async function queryRulesInEffect(args: {
  orgId: string;
  mode?: AllocationMode;
  key?: string;
  onDate: string;
  bookId?: string;
}): Promise<RuleInEffect[]> {
  const orgId = uuid(args.orgId, "orgId");
  const onDate = isoDate(args.onDate, "onDate");
  const modeFilter = args.mode === undefined ? sql`` : sql`and r.mode = ${oneOf(args.mode, MODES, "mode")}`;
  const keyFilter = args.key === undefined ? sql`` : sql`and r.key = ${nonEmpty(args.key, "key")}`;
  let bookFilter = sql``;
  if (args.bookId !== undefined) {
    const bookId = uuid(args.bookId, "bookId");
    bookFilter = sql`and exists (select 1 from accounting_books b where b.org_id = ${orgId} and b.id = ${bookId} and (
      (v.book_scope = 'primary' and b.is_primary) or
      (v.book_scope = 'all_posting' and b.posts_gl) or
      (v.book_scope = 'books' and v.book_ids ? (${bookId}::text))))`;
  }
  const rows = await db.execute<Prefixed>(sql`select ${RULE_COLS}, ${VERSION_COLS}, ${TARGET_COLS}
    from allocation_rules r
    join allocation_rule_versions v on v.org_id = r.org_id and v.rule_id = r.id
      and v.status = 'published'
      and v.effective_from <= ${onDate}::date
      and (v.effective_to is null or v.effective_to >= ${onDate}::date)
    left join allocation_rule_targets t on t.org_id = v.org_id and t.version_id = v.id
    where r.org_id = ${orgId} and r.is_active ${modeFilter} ${keyFilter} ${bookFilter}
    order by r.sort_order, r.key, t.sequence`);
  const grouped = new Map<string, RuleInEffect>();
  for (const row of rows.rows) {
    const ruleId = String(row["rule_id"]);
    let entry = grouped.get(ruleId);
    if (entry === undefined) {
      entry = { rule: mapRule(row, "rule_"), version: mapVersion(row, "version_"), targets: [] };
      grouped.set(ruleId, entry);
    }
    if (row["target_id"] !== null && row["target_id"] !== undefined) {
      entry.targets.push(mapTarget(row, "target_"));
    }
  }
  return [...grouped.values()];
}

/**
 * Rules in force for one mode on one date: active heads with a published
 * version whose effective window covers the date. One query, ordered by
 * sort_order then key (the waterfall order period runs consume).
 */
export async function listRulesInEffect(input: ListRulesInEffectInput): Promise<RuleInEffect[]> {
  return withOrgTransaction(input.orgId, () => queryRulesInEffect(input));
}

export async function loadRuleInEffectByKey(
  orgId: string,
  key: string,
  onDate: string,
  bookId?: string,
): Promise<RuleInEffect | null> {
  return withOrgTransaction(orgId, async () => {
    const found = await queryRulesInEffect({ orgId, key, onDate, bookId });
    return found[0] ?? null;
  });
}

/**
 * Rule heads for the setup drawer list, each with its update revision and a
 * current-version summary (null while nothing is published). One query,
 * ordered by sort_order then key.
 */
export async function listRuleHeads(
  orgId: string,
  opts: { mode?: AllocationMode; activeOnly?: boolean } = {},
): Promise<RuleHeadSummary[]> {
  const id = uuid(orgId, "orgId");
  return withOrgTransaction(id, async () => {
    const modeFilter = opts.mode === undefined ? sql`` : sql`and r.mode = ${oneOf(opts.mode, MODES, "mode")}`;
    const activeFilter = opts.activeOnly === true ? sql`and r.is_active` : sql``;
    const rows = await db.execute<Prefixed>(sql`select ${RULE_COLS},
      ${documentRevisionSql(sql`r.updated_at`)} as rule_revision,
      v.id as current_id, v.version_no as current_version_no, v.status as current_status,
      v.effective_from as current_effective_from, v.effective_to as current_effective_to,
      v.definition_hash as current_definition_hash
      from allocation_rules r
      left join allocation_rule_versions v on v.org_id = r.org_id and v.id = r.current_version_id
      where r.org_id = ${id} ${modeFilter} ${activeFilter}
      order by r.sort_order, r.key`);
    return rows.rows.map((row) => ({
      rule: mapRule(row, "rule_"),
      revision: String(row["rule_revision"]),
      currentVersion:
        row["current_id"] === null || row["current_id"] === undefined
          ? null
          : {
              id: String(row["current_id"]),
              versionNo: Number(row["current_version_no"]),
              status: row["current_status"] as CurrentVersionSummary["status"],
              effectiveFrom: asDate(row["current_effective_from"]),
              effectiveTo: row["current_effective_to"] === null ? null : asDate(row["current_effective_to"]),
              definitionHash: (row["current_definition_hash"] as string | null) ?? null,
            },
    }));
  });
}

/** A rule head with its full version timeline (each with revision and target count). */
export async function getRuleDetail(orgId: string, ruleId: string): Promise<RuleDetail> {
  const oid = uuid(orgId, "orgId");
  const rid = uuid(ruleId, "ruleId");
  return withOrgTransaction(oid, async () => {
    const rule = await loadRuleHead(oid, rid, false);
    const revision = await readRevision("allocation_rules", oid, rid);
    const versionRows = await db.execute<Prefixed>(sql`select ${VERSION_COLS},
      ${documentRevisionSql(sql`v.updated_at`)} as version_revision,
      (select count(*)::text from allocation_rule_targets t
        where t.org_id = v.org_id and t.version_id = v.id) as target_count
      from allocation_rule_versions v
      where v.org_id = ${oid} and v.rule_id = ${rid}
      order by v.version_no`);
    return {
      rule,
      revision,
      versions: versionRows.rows.map((row) => ({
        version: mapVersion(row, "version_"),
        revision: String(row["version_revision"]),
        targetCount: Number(row["target_count"]),
      })),
    };
  });
}

/** One version with its targets and revision — the drawer's edit payload. */
export async function getRuleVersion(orgId: string, versionId: string): Promise<RuleVersionWithTargets> {
  const oid = uuid(orgId, "orgId");
  const vid = uuid(versionId, "versionId");
  return withOrgTransaction(oid, async () => {
    const version = mapVersion(await loadVersionRow(oid, vid), "version_");
    const targets = await loadTargets(oid, vid);
    const revision = await readRevision("allocation_rule_versions", oid, vid);
    return { version, targets, revision };
  });
}
