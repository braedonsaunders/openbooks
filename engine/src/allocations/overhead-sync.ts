import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { loadRuleInEffectByKey } from "./rules.ts";
import type { AllocationRuleVersion, RuleInEffect } from "./types.ts";
import { definitionHash, validateRuleVersion } from "./validate.ts";

/**
 * Overhead fold (shard A11) — the provisioning/sync service that derives the
 * system-owned post rule from the overhead policy + rate card.
 *
 * The legacy writer (overhead-apply.ts) posts DR overhead account [project] /
 * CR the same account untagged per approved time entry. That is exactly a
 * post-mode net_zero_pair allocation on a labor-hours driver, so the kernel
 * owns a system rule for it:
 *
 *   key   'overhead-net-zero-pair' (allocation_rules.is_system, mode 'post')
 *   driver 'overhead-labor-hours' (native_measure labor_hours, dimension project)
 *
 * The rule's published version is DERIVED, never hand-edited: every sync
 * reads orgs.settings.overheadApplication { mode, accountId } plus the full
 * per_hour rate card, hashes them into basis_config, and publishes a version
 * effective from the card's earliest row. A changed card or policy retires
 * the open version and publishes the next; an inactive policy (or an empty
 * card) retires the open version and publishes nothing. Equal hashes are a
 * no-op, so publish paths can sync unconditionally.
 *
 * Event binding: the version's documentKinds carries a pseudo-kind no real
 * document bears (OVERHEAD_EVENT_DOCUMENT_KIND), so A4's matchLine / A5's
 * post seam can never select the system rule for a document line — it fires
 * only on the time-approval event through overhead-apply.ts, which resolves
 * it by key and worked day.
 */

export const OVERHEAD_SYSTEM_RULE_KEY = "overhead-net-zero-pair";
export const OVERHEAD_SYSTEM_DRIVER_KEY = "overhead-labor-hours";
export const OVERHEAD_EVENT_DOCUMENT_KIND = "time_entry_approval";
export const OVERHEAD_SYSTEM_RULE_NAME = "Overhead net-zero pair (system)";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class OverheadSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverheadSyncError";
  }
}

/** One per_hour overhead_rates row as the deriver sees it. */
export interface OverheadRateCardRow {
  departmentId: string | null;
  category: string | null;
  method: string;
  ratePercent: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** orgs.settings.overheadApplication as the deriver sees it. */
export interface OverheadPostingPolicy {
  mode: string;
  accountId: string | null;
}

export interface OverheadDerivedDefinition {
  effectiveFrom: string;
  effectiveTo: null;
  bookScope: "primary";
  bookIds: string[];
  documentKinds: string[];
  accountScope: { kind: "accounts"; accountIds: string[] };
  dimensionFilters: Record<string, never>;
  applyPolicy: "manual";
  sourceMeasure: "period_activity";
  basisKind: "driver";
  driverAsOf: "document_date";
  basisConfig: Record<string, unknown>;
  targetKind: "dynamic";
  dynamicTarget: { dimension: "project" };
  impact: "net_zero_pair";
  offsetAccountId: null;
  residualPolicy: "largest_share";
  residualTargetId: null;
  solveMethod: "sequential";
  runPolicy: "manual";
  runOffsetDays: 0;
  approvalFlowId: null;
  memoTemplate: string;
  lineDescriptionTemplate: string;
}

export type OverheadDerivation =
  | { action: "retire"; reason: string }
  | {
      action: "publish";
      effectiveFrom: string;
      accountId: string;
      rateHash: string;
      definition: OverheadDerivedDefinition;
    };

function canonicalRate(value: string): string {
  return fromUnits(toUnits(value));
}

/** sha256 over the policy + the whole hourly card (order-stable). */
export function overheadRateHash(accountId: string, rows: OverheadRateCardRow[]): string {
  const canonical = [...rows]
    .map((row) => ({
      departmentId: row.departmentId,
      category: row.category,
      method: row.method,
      ratePercent: canonicalRate(row.ratePercent),
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
    }))
    .sort((a, b) =>
      JSON.stringify([a.departmentId, a.category, a.method, a.effectiveFrom, a.effectiveTo]) <
      JSON.stringify([b.departmentId, b.category, b.method, b.effectiveFrom, b.effectiveTo])
        ? -1
        : 1,
    );
  return createHash("sha256").update(JSON.stringify({ accountId, rows: canonical })).digest("hex");
}

/**
 * Pure derivation: policy + hourly card → publish (with the full version
 * definition) or retire. No I/O, so the publish paths and the tests share
 * exactly this decision.
 */
export function deriveOverheadSystemVersion(
  policy: OverheadPostingPolicy,
  rows: OverheadRateCardRow[],
): OverheadDerivation {
  if (policy.mode !== "net_zero_pair" || !policy.accountId) {
    return { action: "retire", reason: "overhead policy is not an active net-zero pair" };
  }
  if (rows.length === 0) {
    return { action: "retire", reason: "the hourly rate card is empty" };
  }
  const accountId = policy.accountId;
  const effectiveFrom = rows.map((row) => row.effectiveFrom).sort()[0]!;
  const rateHash = overheadRateHash(accountId, rows);
  return {
    action: "publish",
    effectiveFrom,
    accountId,
    rateHash,
    definition: {
      effectiveFrom,
      effectiveTo: null,
      bookScope: "primary",
      bookIds: [],
      documentKinds: [OVERHEAD_EVENT_DOCUMENT_KIND],
      accountScope: { kind: "accounts", accountIds: [accountId] },
      dimensionFilters: {},
      applyPolicy: "manual",
      sourceMeasure: "period_activity",
      basisKind: "driver",
      driverAsOf: "document_date",
      basisConfig: {
        overhead: {
          accountId,
          rateHash,
          rateEffectiveFrom: effectiveFrom,
          event: "time_entry.approved",
          driverNote:
            "shares resolve at the time-approval event from approved hours × the published department rate (the labor-hours driver); the kernel builds the net-zero pair and its lineage.",
        },
      },
      targetKind: "dynamic",
      dynamicTarget: { dimension: "project" },
      impact: "net_zero_pair",
      offsetAccountId: null,
      residualPolicy: "largest_share",
      residualTargetId: null,
      solveMethod: "sequential",
      runPolicy: "manual",
      runOffsetDays: 0,
      approvalFlowId: null,
      memoTemplate: "Overhead applied with approved hours (net-zero pair)",
      lineDescriptionTemplate: "Overhead applied",
    },
  };
}

export interface OverheadSyncResult {
  action: "published" | "retired" | "noop";
  ruleId: string;
  /** The published version after the sync (null when nothing is in force). */
  versionId: string | null;
  rateHash: string | null;
}

function checkedUuid(value: string, what: string): string {
  if (!UUID_PATTERN.test(value)) throw new OverheadSyncError(`${what} must be a uuid`);
  return value;
}

async function readPolicy(orgId: string): Promise<OverheadPostingPolicy> {
  const rows = await db.execute<{ c: { mode?: unknown; accountId?: unknown } | null }>(sql`
    select settings->'overheadApplication' as c from orgs where id = ${orgId}`);
  const c = rows.rows[0]?.c ?? {};
  return {
    mode: c.mode === "net_zero_pair" ? "net_zero_pair" : c.mode === "off" ? "off" : "report_only",
    accountId: typeof c.accountId === "string" ? c.accountId : null,
  };
}

async function readHourlyCard(orgId: string): Promise<OverheadRateCardRow[]> {
  const rows = await db.execute<{
    department_id: string | null;
    category: string | null;
    method: string;
    rate_percent: string;
    effective_from: string;
    effective_to: string | null;
  }>(sql`
    select department_id, category, method, rate_percent::text as rate_percent,
           effective_from::text as effective_from, effective_to::text as effective_to
      from overhead_rates
     where org_id = ${orgId} and rate_kind = 'per_hour'
     order by effective_from, department_id nulls first`);
  return rows.rows.map((row) => ({
    departmentId: row.department_id,
    category: row.category,
    method: row.method,
    ratePercent: row.rate_percent,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  }));
}

interface PublishedRow {
  id: string;
  version_no: number;
  effective_from: string;
  effective_to: string | null;
  definition_hash: string | null;
  basis_config: unknown;
}

function basisRateHash(basisConfig: unknown): string | null {
  if (typeof basisConfig !== "object" || basisConfig === null) return null;
  const overhead = (basisConfig as Record<string, unknown>)["overhead"];
  if (typeof overhead !== "object" || overhead === null) return null;
  const hash = (overhead as Record<string, unknown>)["rateHash"];
  return typeof hash === "string" ? hash : null;
}

function basisAccountId(basisConfig: unknown): string | null {
  if (typeof basisConfig !== "object" || basisConfig === null) return null;
  const overhead = (basisConfig as Record<string, unknown>)["overhead"];
  if (typeof overhead !== "object" || overhead === null) return null;
  const account = (overhead as Record<string, unknown>)["accountId"];
  return typeof account === "string" ? account : null;
}

async function auditEvidence(args: {
  orgId: string;
  table: string;
  rowId: string;
  action: "insert" | "update";
  event: string;
  before: unknown;
  after: unknown;
  actorId: string | null;
}): Promise<void> {
  await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${args.orgId}, ${args.table}, ${args.rowId}, ${args.action},
      ${JSON.stringify({ event: args.event, before: args.before, after: args.after, reason: "overhead system-rule sync" })},
      ${args.actorId})`);
}

/**
 * Bring the system rule in line with the policy + card. Idempotent: an
 * unchanged card and policy is a no-op. Joins the ambient tenant
 * transaction when one is active (withOrgTransaction is re-entrant), so the
 * overhead publish paths stay lockstep with the rule they derive.
 */
export async function syncOverheadSystemRule(orgIdInput: string, actorIdInput: string | null): Promise<OverheadSyncResult> {
  const orgId = checkedUuid(orgIdInput, "orgId");
  const actorId = actorIdInput === null ? null : checkedUuid(actorIdInput, "actorId");
  return withOrgTransaction(orgId, async () => {
    // Provision-then-lock: the row may not exist yet, and two concurrent
    // first-use syncs must not both insert. ON CONFLICT absorbs the loser,
    // and the following SELECT … FOR UPDATE then serializes them on the one
    // surviving row — the loser re-reads fresh state below and degrades to a
    // no-op instead of double-publishing.
    const provisionedId = randomUUID();
    const inserted = await db.execute<{ id: string }>(sql`insert into allocation_rules
      (id, org_id, key, name, description, mode, sort_order, is_active, is_system, custom, created_by, updated_by)
      values (${provisionedId}, ${orgId}, ${OVERHEAD_SYSTEM_RULE_KEY}, ${OVERHEAD_SYSTEM_RULE_NAME},
        'Engine-owned mirror of the overhead net-zero-pair policy and rate card. Managed only through overhead settings; never hand-edited.',
        'post', 100, true, true, ${JSON.stringify({ managedBy: "overhead-sync" })}, ${actorId}, ${actorId})
      on conflict (org_id, key) do nothing
      returning id`);
    const headRows = await db.execute<{ id: string; is_system: boolean; mode: string; current_version_id: string | null }>(sql`
      select id, is_system, mode, current_version_id from allocation_rules
       where org_id = ${orgId} and key = ${OVERHEAD_SYSTEM_RULE_KEY} for update`);
    const head = headRows.rows[0];
    if (!head) throw new OverheadSyncError("overhead system rule vanished during provisioning");
    if (!head.is_system || head.mode !== "post") {
      throw new OverheadSyncError(
        `allocation rule key "${OVERHEAD_SYSTEM_RULE_KEY}" is taken by a tenant ${head.mode}-mode rule; refusing to adopt it`,
      );
    }
    const ruleId = head.id;
    if (inserted.rows.length > 0) {
      await auditEvidence({
        orgId, table: "allocation_rules", rowId: ruleId, action: "insert",
        event: "rule.provisioned", before: null, after: { key: OVERHEAD_SYSTEM_RULE_KEY }, actorId,
      });
    }

    const [policy, card] = await Promise.all([readPolicy(orgId), readHourlyCard(orgId)]);
    const derived = deriveOverheadSystemVersion(policy, card);
    const published: PublishedRow[] = (
      await db.execute<Record<string, unknown>>(sql`select id, version_no, effective_from::text as effective_from,
          effective_to::text as effective_to, definition_hash, basis_config
        from allocation_rule_versions
       where org_id = ${orgId} and rule_id = ${ruleId} and status = 'published'
       order by version_no`)
    ).rows.map((row) => ({
      id: String(row["id"]),
      version_no: Number(row["version_no"]),
      effective_from: String(row["effective_from"]),
      effective_to: row["effective_to"] === null ? null : String(row["effective_to"]),
      definition_hash: (row["definition_hash"] as string | null) ?? null,
      basis_config: row["basis_config"],
    }));

    if (derived.action === "retire") {
      if (published.length === 0) return { action: "noop", ruleId, versionId: null, rateHash: null };
      for (const version of published) {
        await db.execute(sql`update allocation_rule_versions
          set status = 'retired', retired_at = now(), retired_by = ${actorId}, updated_at = now(), updated_by = ${actorId}
          where org_id = ${orgId} and id = ${version.id}`);
        await auditEvidence({
          orgId, table: "allocation_rule_versions", rowId: version.id, action: "update",
          event: "version.retired", before: { status: "published" }, after: { status: "retired", reason: derived.reason }, actorId,
        });
      }
      await db.execute(sql`update allocation_rules
        set current_version_id = null, updated_at = now(), updated_by = ${actorId}
        where org_id = ${orgId} and id = ${ruleId}`);
      return { action: "retired", ruleId, versionId: null, rateHash: null };
    }

    const current = published.find(
      (version) =>
        basisRateHash(version.basis_config) === derived.rateHash &&
        version.effective_from === derived.effectiveFrom &&
        basisAccountId(version.basis_config) === derived.accountId,
    );
    if (current !== undefined) {
      const head = (await db.execute<{ current_version_id: string | null }>(sql`
        select current_version_id from allocation_rules where org_id = ${orgId} and id = ${ruleId}`)).rows[0];
      if (head?.current_version_id !== current.id) {
        await db.execute(sql`update allocation_rules
          set current_version_id = ${current.id}, updated_at = now(), updated_by = ${actorId}
          where org_id = ${orgId} and id = ${ruleId}`);
      }
      return { action: "noop", ruleId, versionId: current.id, rateHash: derived.rateHash };
    }

    // Provision the labor-hours driver the version names (engine-owned row;
    // a squatting tenant row with a different shape fails closed).
    const provisionedDriverId = randomUUID();
    const driverInserted = await db.execute<{ id: string }>(sql`insert into allocation_drivers
      (id, org_id, key, name, description, unit, dimension, source_kind, config, is_active, custom, created_by, updated_by)
      values (${provisionedDriverId}, ${orgId}, ${OVERHEAD_SYSTEM_DRIVER_KEY}, 'Overhead labor hours',
        'Engine-owned measure for the overhead net-zero pair: approved project hours priced by the published department rate card.',
        'hours', 'project', 'native_measure', ${JSON.stringify({ measure: "labor_hours" })}, true,
        ${JSON.stringify({ managedBy: "overhead-sync" })}, ${actorId}, ${actorId})
      on conflict (org_id, key) do nothing
      returning id`);
    const driverRows = await db.execute<{ id: string; dimension: string; source_kind: string; config: unknown; is_active: boolean }>(sql`
      select id, dimension, source_kind, config, is_active from allocation_drivers
       where org_id = ${orgId} and key = ${OVERHEAD_SYSTEM_DRIVER_KEY}`);
    const driverId = driverRows.rows[0]?.id ?? null;
    if (driverId === null) throw new OverheadSyncError("overhead system driver vanished during provisioning");
    if (driverInserted.rows.length > 0) {
      await auditEvidence({
        orgId, table: "allocation_drivers", rowId: driverId, action: "insert",
        event: "driver.provisioned", before: null, after: { key: OVERHEAD_SYSTEM_DRIVER_KEY }, actorId,
      });
    } else {
      const driver = driverRows.rows[0]!;
      const config = (driver.config ?? {}) as Record<string, unknown>;
      if (driver.dimension !== "project" || driver.source_kind !== "native_measure" || config["measure"] !== "labor_hours") {
        throw new OverheadSyncError(
          `allocation driver key "${OVERHEAD_SYSTEM_DRIVER_KEY}" is taken by an incompatible driver; refusing to adopt it`,
        );
      }
      if (!driver.is_active) {
        await db.execute(sql`update allocation_drivers
          set is_active = true, updated_at = now(), updated_by = ${actorId}
          where org_id = ${orgId} and id = ${driverId}`);
        await auditEvidence({
          orgId, table: "allocation_drivers", rowId: driverId, action: "update",
          event: "driver.reactivated", before: { is_active: false }, after: { is_active: true }, actorId,
        });
      }
    }

    // The new version is fully validated before anything retires: siblings
    // are empty because every other published version of this rule retires
    // in the same transaction below.
    const books = await db.execute<{ id: string }>(sql`
      select id from accounting_books where org_id = ${orgId} and is_active and posts_gl`);
    const candidate: AllocationRuleVersion = {
      id: "00000000-0000-0000-0000-000000000000",
      orgId,
      ruleId,
      versionNo: 0,
      status: "draft",
      ...derived.definition,
      driverId,
      definitionHash: null,
      publishedAt: null,
      publishedBy: null,
    };
    const problems = validateRuleVersion(candidate, [], {
      orgId,
      ruleId,
      mode: "post",
      publishedVersions: [],
      driver: { id: driverId, dimension: "project", isActive: true },
      activePostingBookIds: books.rows.map((row) => row.id),
    });
    if (problems.length > 0) {
      throw new OverheadSyncError(
        `derived overhead version fails publish validation: ${problems.map((p) => p.message).join("; ")}`,
      );
    }

    for (const version of published) {
      await db.execute(sql`update allocation_rule_versions
        set status = 'retired', retired_at = now(), retired_by = ${actorId}, updated_at = now(), updated_by = ${actorId}
        where org_id = ${orgId} and id = ${version.id}`);
      await auditEvidence({
        orgId, table: "allocation_rule_versions", rowId: version.id, action: "update",
        event: "version.retired", before: { status: "published" }, after: { status: "retired", reason: "superseded by overhead sync" }, actorId,
      });
    }
    const maxRow = await db.execute<{ n: string }>(sql`
      select coalesce(max(version_no), 0)::text as n from allocation_rule_versions
       where org_id = ${orgId} and rule_id = ${ruleId}`);
    const versionNo = Number(maxRow.rows[0]?.n ?? "0") + 1;
    const versionId = randomUUID();
    const stored: AllocationRuleVersion = { ...candidate, id: versionId, versionNo, status: "published" };
    const hash = definitionHash(stored, []);
    await db.execute(sql`insert into allocation_rule_versions
      (id, org_id, rule_id, version_no, status, effective_from, effective_to, book_scope, book_ids,
       document_kinds, account_scope, dimension_filters, apply_policy, source_measure, basis_kind,
       driver_id, driver_as_of, basis_config, target_kind, dynamic_target, impact, offset_account_id,
       residual_policy, residual_target_id, solve_method, run_policy, run_offset_days, approval_flow_id,
       memo_template, line_description_template, definition_hash, published_at, published_by, created_by, updated_by)
      values (${versionId}, ${orgId}, ${ruleId}, ${versionNo}, 'published', ${derived.effectiveFrom}, null,
        'primary', '[]', ${JSON.stringify(derived.definition.documentKinds)},
        ${JSON.stringify(derived.definition.accountScope)}, '{}', 'manual', 'period_activity', 'driver',
        ${driverId}, 'document_date', ${JSON.stringify(derived.definition.basisConfig)}, 'dynamic',
        ${JSON.stringify(derived.definition.dynamicTarget)}, 'net_zero_pair', null,
        'largest_share', null, 'sequential', 'manual', 0, null,
        ${derived.definition.memoTemplate}, ${derived.definition.lineDescriptionTemplate},
        ${hash}, now(), ${actorId}, ${actorId}, ${actorId})`);
    await db.execute(sql`update allocation_rules
      set current_version_id = ${versionId}, updated_at = now(), updated_by = ${actorId}
      where org_id = ${orgId} and id = ${ruleId}`);
    await auditEvidence({
      orgId, table: "allocation_rule_versions", rowId: versionId, action: "insert",
      event: "version.published", before: null, after: { versionNo, rateHash: derived.rateHash }, actorId,
    });
    return { action: "published", ruleId, versionId, rateHash: derived.rateHash };
  });
}

/** The kernel binding one overhead posting stamps (resolved by key + worked day). */
export interface OverheadRuleBinding {
  ruleId: string;
  versionId: string;
  definitionHash: string;
  driverId: string | null;
  accountId: string;
}

/**
 * Resolve the system version in force on a date. Null when the policy is
 * not an active pair or no derived version covers the date — the caller
 * (overhead-apply) lazy-syncs first, so null past that point is fail-closed
 * evidence of an inconsistency, never a silent fallback.
 */
export async function resolveOverheadRuleBinding(orgId: string, onDate: string): Promise<OverheadRuleBinding | null> {
  const found = await loadRuleInEffectByKey(orgId, OVERHEAD_SYSTEM_RULE_KEY, onDate);
  if (!found) return null;
  const scope = found.version.accountScope;
  const accountId = scope.kind === "accounts" ? scope.accountIds[0] ?? null : null;
  if (!accountId || !found.version.definitionHash) return null;
  return {
    ruleId: found.rule.id,
    versionId: found.version.id,
    definitionHash: found.version.definitionHash,
    driverId: found.version.driverId ?? null,
    accountId,
  };
}

/**
 * The full system rule in force on a date (head + version + targets) for
 * kernel line-building. Null past a lazy sync is fail-closed evidence of an
 * inconsistency, never a silent fallback.
 */
export async function loadOverheadRuleInEffect(
  orgId: string,
  onDate: string,
): Promise<RuleInEffect | null> {
  const found = await loadRuleInEffectByKey(orgId, OVERHEAD_SYSTEM_RULE_KEY, onDate);
  if (!found || !found.version.definitionHash) return null;
  const scope = found.version.accountScope;
  if (scope.kind !== "accounts" || !scope.accountIds[0]) return null;
  return found;
}

/** Read-only evidence for the Overhead Model workspace (system rule slot). */
export interface OverheadSystemRuleEvidence {
  ruleId: string | null;
  ruleKey: string;
  ruleName: string;
  isActive: boolean;
  driverKey: string;
  currentVersion: {
    id: string;
    versionNo: number;
    effectiveFrom: string;
    definitionHash: string | null;
    accountId: string | null;
    rateHash: string | null;
    rateEffectiveFrom: string | null;
  } | null;
}

export async function getOverheadSystemRuleEvidence(orgId: string): Promise<OverheadSystemRuleEvidence> {
  const rows = await db.execute<{
    rule_id: string | null;
    rule_name: string | null;
    is_active: boolean | null;
    version_id: string | null;
    version_no: number | null;
    effective_from: string | null;
    definition_hash: string | null;
    basis_config: unknown;
  }>(sql`select r.id as rule_id, r.name as rule_name, r.is_active,
           v.id as version_id, v.version_no, v.effective_from::text as effective_from,
           v.definition_hash, v.basis_config
      from allocation_rules r
      left join allocation_rule_versions v
        on v.org_id = r.org_id and v.id = r.current_version_id
     where r.org_id = ${orgId} and r.key = ${OVERHEAD_SYSTEM_RULE_KEY}`);
  const row = rows.rows[0];
  if (!row || !row.rule_id) {
    return {
      ruleId: null, ruleKey: OVERHEAD_SYSTEM_RULE_KEY, ruleName: OVERHEAD_SYSTEM_RULE_NAME,
      isActive: false, driverKey: OVERHEAD_SYSTEM_DRIVER_KEY, currentVersion: null,
    };
  }
  return {
    ruleId: row.rule_id,
    ruleKey: OVERHEAD_SYSTEM_RULE_KEY,
    ruleName: row.rule_name ?? OVERHEAD_SYSTEM_RULE_NAME,
    isActive: row.is_active ?? false,
    driverKey: OVERHEAD_SYSTEM_DRIVER_KEY,
    currentVersion: row.version_id
      ? {
          id: row.version_id,
          versionNo: Number(row.version_no ?? 0),
          effectiveFrom: String(row.effective_from ?? ""),
          definitionHash: row.definition_hash,
          accountId: basisAccountId(row.basis_config),
          rateHash: basisRateHash(row.basis_config),
          rateEffectiveFrom: String(row.effective_from ?? ""),
        }
      : null,
  };
}
