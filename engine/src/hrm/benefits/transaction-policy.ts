import { sql } from "drizzle-orm";
import { canonicalDecimal } from "../../money/exact-decimal.ts";
import { decimalNullRefusal } from "../../money/decimal-refusal.ts";
import { fitsLedgerRange, normalizeMoney, toUnits } from "../../money/money.ts";
import { loadSubsidiaryContext, restrictionAdmits } from "../../organization/subsidiaries.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import {
  requireAggregateBenefitsManage,
  requireAggregateBenefitsRead,
  requireHrmBenefitsManageOnEmployment,
} from "../authorization.ts";
import { BenefitsError } from "./errors.ts";
import {
  assertHrmEnabled,
  db,
  requireActorId,
  requireCivilDate,
  requireId,
  requireOneRow,
  requireOrgId,
  withOrgTransaction,
  type SqlExecutor,
} from "./shared.ts";
import type { TransactionIncentiveSourceQuery } from "./transaction-incentive-sources.ts";
import { recordProgramRevision } from "./program-revisions.ts";

/** Source configuration is typed; frozen JSON belongs exclusively to award evidence. */
export type TransactionRecipientSource =
  | "assignment"
  | "field_ticket_foreman"
  | "field_ticket_superintendent"
  | "project_foreman"
  | "project_manager";
const ROLE_SOURCES = [
  "field_ticket_foreman",
  "field_ticket_superintendent",
  "project_foreman",
  "project_manager",
] as const;

export interface BenefitTransactionPolicy {
  readonly documentKind: TransactionIncentiveSourceQuery["documentKind"];
  /** document_date measures the document's date; work_date the line's recorded work date (document date when none). */
  readonly dateBasis: "document_date" | "work_date";
  readonly groupingSegmentId: string | null;
  readonly itemIds: readonly string[];
  /** A position whose role holder is missing or not a member: refuse settlement, or forfeit that share. */
  readonly unassignedShare?: "refuse" | "forfeit";
  /** per_group rounds each group pool; per_recipient sums exact shares and rounds once per recipient. */
  readonly rounding?: "per_group" | "per_recipient";
  /** Ceiling as a percent of program items on each project's original budget; null means none. */
  readonly capPercent?: string | null;
  /** Project type the ceiling applies to; null applies it to every project. */
  readonly capProjectTypeId?: string | null;
  readonly positions: readonly {
    readonly key: string;
    readonly name: string;
    readonly weight: string;
    readonly recipientSource?: TransactionRecipientSource;
    readonly fallbackSource?: Exclude<TransactionRecipientSource, "assignment"> | null;
    readonly fallbackOnlyWhenContextAbsent?: boolean;
  }[];
  readonly responsibilities: readonly {
    readonly groupId: string;
    readonly positionKey: string;
    readonly employmentId: string;
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
  }[];
  readonly limits: readonly {
    readonly groupId: string;
    readonly kind: "none" | "amount";
    readonly amount: string | null;
  }[];
}
export interface BenefitTransactionPolicyRecord {
  readonly policy: BenefitTransactionPolicy;
  readonly programRevision: number;
}
export interface BenefitTransactionPolicyQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly programId: string;
}

const TABLES = [
  "hrm_benefit_transaction_responsibilities",
  "hrm_benefit_transaction_limits",
  "hrm_benefit_transaction_positions",
  "hrm_benefit_transaction_items",
  "hrm_benefit_transaction_policies",
] as const;

export async function requireTransactionPolicyStorage(exec: SqlExecutor): Promise<void> {
  const names = sql`array[${sql.join(
    TABLES.map((name) => sql`${name}`),
    sql`, `,
  )}]::text[]`;
  const rows = await exec.execute<{ present: number; hasContextFallback: boolean }>(
    sql`select count(*)::int as present,
    exists(select 1 from pg_attribute a join pg_class t on t.oid=a.attrelid join pg_namespace ns_context on ns_context.oid=t.relnamespace
      where ns_context.nspname='public' and t.relname='hrm_benefit_transaction_positions'
        and a.attname='fallback_only_when_context_absent' and not a.attisdropped) as "hasContextFallback" from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(${names}) and c.relkind='r'`,
    "objects",
  );
  if (rows[0]?.present !== TABLES.length || rows[0]?.hasContextFallback !== true)
    throw new BenefitsError(
      "REFUSED",
      "Transaction benefit configuration is not installed — have the administrator upgrade through the native bootstrap runner before configuring or settling transaction programs; existing awards are preserved.",
    );
}

/** Restore the native reader's serialization order after a retained JSONB revision.
 * Every supplied field survives; dates, arrays and policy facts are unchanged.
 * Existing transaction digests use this order and must remain reproducible.
 */
export function retainedTransactionPolicyOrder(
  policy: BenefitTransactionPolicy,
): BenefitTransactionPolicy {
  const ordered = <T extends object>(value: T, keys: readonly string[]): T => {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of keys) if (Object.hasOwn(source, key)) result[key] = source[key];
    for (const key of Object.keys(source))
      if (!Object.hasOwn(result, key)) result[key] = source[key];
    return result as T;
  };
  return ordered(
    {
      ...policy,
      positions: policy.positions.map((position) =>
        ordered(position, [
          "key",
          "name",
          "weight",
          "recipientSource",
          "fallbackSource",
          "fallbackOnlyWhenContextAbsent",
        ]),
      ),
      responsibilities: policy.responsibilities.map((responsibility) =>
        ordered(responsibility, [
          "groupId",
          "positionKey",
          "employmentId",
          "effectiveFrom",
          "effectiveTo",
        ]),
      ),
      limits: policy.limits.map((limit) => ordered(limit, ["groupId", "kind", "amount"])),
    },
    [
      "documentKind",
      "dateBasis",
      "groupingSegmentId",
      "unassignedShare",
      "rounding",
      "capPercent",
      "capProjectTypeId",
      "itemIds",
      "positions",
      "responsibilities",
      "limits",
    ],
  );
}

export async function readTransactionPolicy(
  exec: SqlExecutor,
  orgId: string,
  programId: string,
): Promise<BenefitTransactionPolicy | null> {
  await requireTransactionPolicyStorage(exec);
  const row = (
    await exec.execute<{
      documentKind: BenefitTransactionPolicy["documentKind"];
      dateBasis: BenefitTransactionPolicy["dateBasis"];
      groupingSegmentId: string | null;
      unassignedShare: "refuse" | "forfeit";
      rounding: "per_group" | "per_recipient";
      capPercent: string | null;
      capProjectTypeId: string | null;
    }>(
      sql`select document_kind as "documentKind",date_basis as "dateBasis",grouping_segment_id as "groupingSegmentId",unassigned_share as "unassignedShare",rounding,cap_percent::text as "capPercent",cap_project_type_id as "capProjectTypeId" from hrm_benefit_transaction_policies where org_id=${orgId} and program_id=${programId}`,
      "objects",
    )
  )[0];
  if (!row) return null;
  const itemIds = (
    await exec.execute<{ id: string }>(
      sql`select item_id as id from hrm_benefit_transaction_items where org_id=${orgId} and program_id=${programId} order by item_id`,
      "objects",
    )
  ).map((r) => r.id);
  const positions = (
    await exec.execute<BenefitTransactionPolicy["positions"][number] & Record<string, unknown>>(
      sql`select position_key as key,name,weight::text,recipient_source as "recipientSource",fallback_source as "fallbackSource",fallback_only_when_context_absent as "fallbackOnlyWhenContextAbsent" from hrm_benefit_transaction_positions where org_id=${orgId} and program_id=${programId} order by position_key`,
      "objects",
    )
  ).map(({ fallbackOnlyWhenContextAbsent, ...position }) =>
    fallbackOnlyWhenContextAbsent === true
      ? { ...position, fallbackOnlyWhenContextAbsent: true }
      : position,
  );
  const responsibilities = await exec.execute<
    BenefitTransactionPolicy["responsibilities"][number] & Record<string, unknown>
  >(
    sql`select group_id as "groupId",position_key as "positionKey",employment_id as "employmentId",effective_from::text as "effectiveFrom",effective_to::text as "effectiveTo" from hrm_benefit_transaction_responsibilities where org_id=${orgId} and program_id=${programId} order by group_id,position_key,effective_from`,
    "objects",
  );
  const limits = await exec.execute<
    BenefitTransactionPolicy["limits"][number] & Record<string, unknown>
  >(
    sql`select group_id as "groupId",limit_kind as kind,amount::text from hrm_benefit_transaction_limits where org_id=${orgId} and program_id=${programId} order by group_id`,
    "objects",
  );
  return { ...row, itemIds, positions, responsibilities, limits };
}

interface PolicyOwner extends Record<string, unknown> {
  currency: string;
  legal_entity_id: string | null;
  status: string;
  revision: number;
  effective_from: string;
  effective_to: string | null;
  metric: string | null;
}
async function owner(
  orgId: string,
  actorId: string,
  programId: string,
  write: boolean,
): Promise<PolicyOwner> {
  const scope = write
    ? await requireAggregateBenefitsManage(db, orgId, actorId)
    : await requireAggregateBenefitsRead(db, orgId, actorId);
  await assertHrmEnabled(db, orgId);
  const row = (
    await db.execute<PolicyOwner>(
      sql`select currency,legal_entity_id,status,revision,effective_from::text,effective_to::text,metric from hrm_benefit_programs where org_id=${orgId} and id=${programId} ${write ? sql`for update` : sql`for share`}`,
      "objects",
    )
  )[0];
  if (!row || row.legal_entity_id === null || (scope !== null && !scope.has(row.legal_entity_id)))
    throw new BenefitsError(
      "NOT_FOUND",
      "Choose a benefit program with a responsible employer in your legal-entity scope before configuring its transaction rules.",
    );
  return row;
}

export async function getBenefitTransactionPolicy(
  query: BenefitTransactionPolicyQuery,
): Promise<BenefitTransactionPolicyRecord | null> {
  const orgId = requireOrgId(query.orgId),
    actorId = requireActorId(query.actorId),
    programId = requireId(query.programId, "programId");
  return withOrgTransaction(orgId, async () => {
    const p = await owner(orgId, actorId, programId, false);
    const policy = await readTransactionPolicy(db, orgId, programId);
    return policy ? { policy, programRevision: p.revision } : null;
  });
}

/** Reference choices use the same organization and employer restrictions as policy saves. */
export async function getBenefitTransactionReferences(
  query: BenefitTransactionPolicyQuery,
): Promise<{
  segments: { value: string; label: string }[];
  groups: { value: string; label: string; scopeValue: string }[];
}> {
  const orgId = requireOrgId(query.orgId),
    actorId = requireActorId(query.actorId),
    programId = requireId(query.programId, "programId");
  return withOrgTransaction(orgId, async () => {
    const p = await owner(orgId, actorId, programId, false),
      context = await loadSubsidiaryContext(db, orgId);
    const employer = context.byId.get(p.legal_entity_id!);
    if (!employer)
      throw new BenefitsError(
        "NOT_FOUND",
        "The program employer is unavailable — reload its native program record.",
      );
    const segments: { value: string; label: string }[] = [],
      groups = [{ value: employer.id, label: employer.name, scopeValue: "" }];
    const tables: Record<string, string> = {
      subsidiary_id: "subsidiaries",
      department_id: "departments",
      project_id: "projects",
      location_id: "locations",
      class_id: "classes",
    };
    const definitions = await db.execute<{
      id: string;
      name: string;
      source_kind: string;
      storage_column: string | null;
      feature_key: string | null;
    }>(
      sql`select id,name,source_kind,storage_column,feature_key from segment_definitions where org_id=${orgId} order by sort_order,name,id`,
      "objects",
    );
    for (const s of definitions) {
      const table =
        s.source_kind === "custom" && s.storage_column === null
          ? "segment_values"
          : s.source_kind === "builtin" && s.storage_column
            ? tables[s.storage_column]
            : undefined;
      if (!table) continue;
      const feature = table === "projects" ? "projects" : s.feature_key;
      if (feature && !(await lockAndCheckOrgFeature(db, orgId, feature))) continue;
      segments.push({ value: s.id, label: s.name });
      if (table === "subsidiaries") {
        groups.push({ value: employer.id, label: employer.name, scopeValue: s.id });
        continue;
      }
      const values = await db.execute<{
        id: string;
        name: string;
        subsidiary_id: string | null;
        subsidiary_include_children: boolean;
      }>(
        sql`select id,name,subsidiary_id,subsidiary_include_children from ${sql.raw(table)} where org_id=${orgId} ${table === "segment_values" ? sql`and segment_id=${s.id}` : sql``} order by name,id`,
        "objects",
      );
      for (const v of values)
        if (
          v.subsidiary_id === null ||
          restrictionAdmits(context, v.subsidiary_id, v.subsidiary_include_children, employer.id)
        )
          groups.push({ value: v.id, label: v.name, scopeValue: s.id });
    }
    return { segments, groups };
  });
}

function amount(value: unknown, label: string, positive: boolean): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null)
    throw new BenefitsError(
      "INVALID_INPUT",
      decimalNullRefusal(label, "an exact decimal", value, 4),
    );
  const result = normalizeMoney(exact);
  if (!fitsLedgerRange(result) || toUnits(result) < 0n || (positive && toUnits(result) === 0n))
    throw new BenefitsError(
      "INVALID_INPUT",
      `${label} must be ${positive ? "positive" : "non-negative"} and fit the ledger amount range — correct the configured value.`,
    );
  return result;
}

/** Shared validation for authoring, activation and measurement. */
export async function validateTransactionPolicy(
  exec: SqlExecutor,
  orgId: string,
  legalEntityId: string,
  policy: BenefitTransactionPolicy,
  currency: string,
): Promise<void> {
  if (!policy || typeof policy !== "object" || Array.isArray(policy))
    throw new BenefitsError(
      "INVALID_INPUT",
      "Reload the native transaction policy before saving; its configuration must be a record.",
    );
  for (const field of ["itemIds", "positions", "responsibilities", "limits"] as const)
    if (!Array.isArray(policy[field]))
      throw new BenefitsError(
        "INVALID_INPUT",
        `Transaction policy ${field} must be an explicit list — reload its native configuration before saving.`,
      );
  if (
    policy.positions.length > 100 ||
    policy.itemIds.length > 10000 ||
    policy.responsibilities.length > 10000 ||
    policy.limits.length > 10000
  )
    throw new BenefitsError(
      "INVALID_INPUT",
      "This policy exceeds the supported configuration size — split it into separately governed programs before saving.",
    );
  const precision = (
    await exec.execute<{ minor_units: number }>(
      sql`select minor_units from currencies where code=${currency}`,
      "objects",
    )
  )[0]?.minor_units;
  if (precision === undefined || !Number.isInteger(precision) || precision < 0 || precision > 4)
    throw new BenefitsError(
      "REFUSED",
      "The program currency has no supported payable precision — correct its currency registry before recording ceilings.",
    );
  const quantum = 10n ** BigInt(4 - precision);
  if (
    !["sales_order", "customer_invoice", "field_ticket", "quote"].includes(policy.documentKind) ||
    !["document_date", "work_date"].includes(policy.dateBasis)
  )
    throw new BenefitsError(
      "INVALID_INPUT",
      "Select a supported commercial document kind and explicitly choose document date or work date as the source period basis.",
    );
  if (
    !["refuse", "forfeit"].includes(policy.unassignedShare ?? "refuse") ||
    !["per_group", "per_recipient"].includes(policy.rounding ?? "per_group")
  )
    throw new BenefitsError(
      "INVALID_INPUT",
      "Choose whether an unassigned share refuses settlement or is forfeited, and whether rounding is per group or per recipient.",
    );
  const capPercent = policy.capPercent ?? null,
    capProjectTypeId = policy.capProjectTypeId ?? null;
  if (capPercent === null && capProjectTypeId !== null)
    throw new BenefitsError(
      "INVALID_INPUT",
      "Enter the ceiling percentage before choosing which project type it applies to.",
    );
  if (capPercent !== null) {
    const percent = amount(capPercent, "Budget ceiling percentage", false);
    if (toUnits(percent) > 1_000_000n)
      throw new BenefitsError("INVALID_INPUT", "The budget ceiling is a percentage from 0 to 100.");
    if (capProjectTypeId !== null) {
      requireId(capProjectTypeId, "capProjectTypeId");
      if (
        !(
          await exec.execute(
            sql`select 1 from project_types where org_id=${orgId} and id=${capProjectTypeId} for share`,
            "objects",
          )
        ).length
      )
        throw new BenefitsError(
          "NOT_FOUND",
          "The ceiling's project type belongs to another organization — reselect the project type.",
        );
    }
  }
  if (!policy.itemIds.length || new Set(policy.itemIds).size !== policy.itemIds.length)
    throw new BenefitsError(
      "INVALID_INPUT",
      "Select each eligible native source item once; an empty item selection never means all items.",
    );
  for (const id of policy.itemIds) requireId(id, "itemId");
  const items = await exec.execute<{ id: string }>(
    sql`select id from items where org_id=${orgId} and id=any(${`{${policy.itemIds.join(",")}}`}::uuid[]) order by id for share`,
    "objects",
  );
  if (items.length !== policy.itemIds.length)
    throw new BenefitsError(
      "NOT_FOUND",
      "One or more eligible items belong to another organization — reselect the native items.",
    );
  let groupTable: string = "subsidiaries";
  let customSegment: string | null = null;
  if (policy.groupingSegmentId !== null) {
    requireId(policy.groupingSegmentId, "groupingSegmentId");
    const s = (
      await exec.execute<{
        source_kind: string;
        storage_column: string | null;
        feature_key: string | null;
      }>(
        sql`select source_kind,storage_column,feature_key from segment_definitions where org_id=${orgId} and id=${policy.groupingSegmentId} for share`,
        "objects",
      )
    )[0];
    const builtins: Record<string, string> = {
      subsidiary_id: "subsidiaries",
      department_id: "departments",
      project_id: "projects",
      location_id: "locations",
      class_id: "classes",
    };
    if (s?.source_kind === "custom" && s.storage_column === null) {
      groupTable = "segment_values";
      customSegment = policy.groupingSegmentId;
    } else if (s?.source_kind === "builtin" && s.storage_column && builtins[s.storage_column])
      groupTable = builtins[s.storage_column]!;
    else
      throw new BenefitsError(
        "REFUSED",
        "Select an organization-owned grouping dimension with a supported native storage mapping.",
      );
    const feature = groupTable === "projects" ? "projects" : s?.feature_key;
    if (feature && !(await lockAndCheckOrgFeature(exec, orgId, feature)))
      throw new BenefitsError(
        "REFUSED",
        `${feature} is off — enable the grouping capability on Company Settings → Features before configuring the policy.`,
      );
  }
  for (const field of ["positions", "responsibilities", "limits"] as const)
    if (policy[field].some((row) => !row || typeof row !== "object" || Array.isArray(row)))
      throw new BenefitsError(
        "INVALID_INPUT",
        `Each ${field} entry must be a native configuration record — correct the row before saving.`,
      );
  const keys = new Set<string>();
  for (const position of policy.positions) {
    if (
      typeof position.key !== "string" ||
      typeof position.name !== "string" ||
      !position.key.trim() ||
      position.key.length > 120 ||
      !position.name.trim() ||
      position.name.length > 200 ||
      keys.has(position.key)
    )
      throw new BenefitsError(
        "INVALID_INPUT",
        "Give each recipient position a unique key and a readable name before recording assignments.",
      );
    keys.add(position.key);
    amount(position.weight, `Share weight for ${position.name}`, true);
    if (
      position.fallbackOnlyWhenContextAbsent !== undefined &&
      typeof position.fallbackOnlyWhenContextAbsent !== "boolean"
    )
      throw new BenefitsError(
        "INVALID_INPUT",
        "Choose an explicit on or off value for source-context fallback.",
      );
    if (
      position.fallbackOnlyWhenContextAbsent === true &&
      ((position.recipientSource ?? "assignment") === "assignment" || !position.fallbackSource)
    )
      throw new BenefitsError(
        "INVALID_INPUT",
        "Source-context fallback requires a recorded primary role and a fallback role.",
      );
    const source = position.recipientSource ?? "assignment",
      fallback = position.fallbackSource ?? null;
    if (source !== "assignment" && !(ROLE_SOURCES as readonly string[]).includes(source))
      throw new BenefitsError(
        "INVALID_INPUT",
        `Choose where ${position.name}'s recipient comes from: dated assignments or a role recorded on the source.`,
      );
    if (
      fallback !== null &&
      (source === "assignment" ||
        !(ROLE_SOURCES as readonly string[]).includes(fallback) ||
        fallback === source)
    )
      throw new BenefitsError(
        "INVALID_INPUT",
        `${position.name} can fall back only from one recorded role to a different recorded role.`,
      );
    if (
      source !== "assignment" &&
      policy.responsibilities.some((r) => r.positionKey === position.key)
    )
      throw new BenefitsError(
        "INVALID_INPUT",
        `${position.name} takes its recipient from the source documents — remove its dated assignments.`,
      );
  }
  if (!keys.size)
    throw new BenefitsError(
      "INVALID_INPUT",
      "Add at least one recipient position and its share weight before configuring this policy.",
    );
  const groupIds = [
    ...new Set([
      ...policy.responsibilities.map((r) => r.groupId),
      ...policy.limits.map((r) => r.groupId),
    ]),
  ];
  for (const id of groupIds) requireId(id, "groupId");
  if (groupIds.length) {
    const found = await exec.execute<{
      id: string;
      subsidiary_id: string | null;
      subsidiary_include_children: boolean;
    }>(
      sql`select id,${groupTable === "subsidiaries" ? sql`null::uuid as subsidiary_id,true as subsidiary_include_children` : sql`subsidiary_id,subsidiary_include_children`} from ${sql.raw(groupTable)} where org_id=${orgId} and id=any(${`{${groupIds.join(",")}}`}::uuid[]) ${customSegment ? sql`and segment_id=${customSegment}` : sql``} order by id for share`,
      "objects",
    );
    const context = await loadSubsidiaryContext(exec, orgId);
    if (
      found.some(
        (row) =>
          row.subsidiary_id !== null &&
          !restrictionAdmits(
            context,
            row.subsidiary_id,
            row.subsidiary_include_children,
            legalEntityId,
          ),
      )
    )
      throw new BenefitsError(
        "REFUSED",
        "A recipient group is restricted to another legal employer — choose a group available to this program employer.",
      );
    if (
      found.length !== groupIds.length ||
      (groupTable === "subsidiaries" && groupIds.some((id) => id !== legalEntityId))
    )
      throw new BenefitsError(
        "NOT_FOUND",
        "A responsibility or ceiling names a group outside the selected dimension and employer — reselect its native group.",
      );
  }
  const limitGroups = new Set<string>();
  for (const limit of policy.limits) {
    if (
      limitGroups.has(limit.groupId) ||
      !["none", "amount"].includes(limit.kind) ||
      (limit.kind === "none" && limit.amount !== null)
    )
      throw new BenefitsError(
        "INVALID_INPUT",
        "Record one explicit ceiling decision per group: no limit or an exact monetary ceiling.",
      );
    limitGroups.add(limit.groupId);
    if (
      limit.kind === "amount" &&
      toUnits(amount(limit.amount, "Group ceiling", false)) % quantum !== 0n
    )
      throw new BenefitsError(
        "INVALID_INPUT",
        `Group ceilings must use ${precision} payable decimal places for ${currency} — correct the amount before saving.`,
      );
  }
  const spans = new Map<string, BenefitTransactionPolicy["responsibilities"][number][]>();
  for (const r of policy.responsibilities) {
    requireId(r.employmentId, "employmentId");
    requireCivilDate(r.effectiveFrom, "effectiveFrom");
    if (r.effectiveTo !== null) requireCivilDate(r.effectiveTo, "effectiveTo");
    if (
      !keys.has(r.positionKey) ||
      (r.effectiveTo !== null && r.effectiveTo < r.effectiveFrom) ||
      (capPercent === null && !limitGroups.has(r.groupId))
    )
      throw new BenefitsError(
        "INVALID_INPUT",
        "Each dated responsibility needs a configured position, valid dates and an explicit group ceiling decision unless the project budget ceiling applies.",
      );
    const key = `${r.groupId}:${r.positionKey}`,
      prior = spans.get(key) ?? [];
    if (
      prior.some(
        (p) =>
          p.effectiveFrom <= (r.effectiveTo ?? "9999-12-31") &&
          r.effectiveFrom <= (p.effectiveTo ?? "9999-12-31"),
      )
    )
      throw new BenefitsError(
        "REFUSED",
        `Recipient position ${r.positionKey} has overlapping assignments in group ${r.groupId} — end the earlier assignment before starting its replacement.`,
      );
    prior.push(r);
    spans.set(key, prior);
    const employment = (
      await exec.execute<{ employer_subsidiary_id: string }>(
        sql`select employer_subsidiary_id from worker_employments where org_id=${orgId} and id=${r.employmentId} for share`,
        "objects",
      )
    )[0];
    if (!employment || employment.employer_subsidiary_id !== legalEntityId)
      throw new BenefitsError(
        "REFUSED",
        "A recipient employment belongs to another legal employer — choose the program employer's employment record.",
      );
  }
}

/**
 * Save a program's transaction rules. Draft rules change in place; an
 * active program's rules change from a dated revision, so periods starting
 * before the change date keep the rules being replaced.
 */
export async function saveBenefitTransactionPolicy(
  query: BenefitTransactionPolicyQuery & {
    readonly expectedRevision: number;
    readonly policy: BenefitTransactionPolicy;
    readonly reason: string;
    readonly changeEffectiveFrom?: string | null;
  },
): Promise<BenefitTransactionPolicyRecord> {
  const orgId = requireOrgId(query.orgId),
    actorId = requireActorId(query.actorId),
    programId = requireId(query.programId, "programId");
  const reason = typeof query.reason === "string" ? query.reason.trim() : "";
  if (!reason || reason.length > 2000)
    throw new BenefitsError(
      "INVALID_INPUT",
      "Saving transaction rules requires a reason of at most 2000 characters for the program audit history.",
    );
  return withOrgTransaction(orgId, async () => {
    const p = await owner(orgId, actorId, programId, true);
    if (p.metric !== "transactions")
      throw new BenefitsError(
        "REFUSED",
        "Select the transactions metric in the draft program before configuring its transaction rules.",
      );
    if (p.status === "closed")
      throw new BenefitsError(
        "BAD_STATE",
        "A closed program keeps its transaction rules as history — create a new program to pay under different rules.",
      );
    if (!Number.isInteger(query.expectedRevision) || p.revision !== query.expectedRevision)
      throw new BenefitsError(
        "REFUSED",
        "The program changed since you opened it — reload its current rules before saving.",
      );
    await requireTransactionPolicyStorage(db);
    await validateTransactionPolicy(db, orgId, p.legal_entity_id!, query.policy, p.currency);
    if (p.status === "active")
      await recordProgramRevision(db, {
        orgId,
        actorId,
        programId,
        reason,
        changeEffectiveFrom: query.changeEffectiveFrom,
        transactionPolicy: await readTransactionPolicy(db, orgId, programId),
      });
    for (const r of query.policy.responsibilities)
      await requireHrmBenefitsManageOnEmployment(db, orgId, actorId, r.employmentId);
    // Stamp the actual modifying actor before deletion; replacement audit
    // rows must never attribute the operator's change to an earlier author.
    // A collection can legitimately be empty. The parent is locked and its
    // expected revision is checked; every new child insert must be observable.
    for (const table of TABLES) {
      await db.execute(
        sql`update ${sql.raw(table)} set updated_by=${actorId},updated_at=clock_timestamp(),reason=${reason} where org_id=${orgId} and program_id=${programId}`,
      );
      await db.execute(
        sql`delete from ${sql.raw(table)} where org_id=${orgId} and program_id=${programId}`,
      );
    }
    const policy = query.policy;
    requireOneRow(
      await db.execute(
        sql`insert into hrm_benefit_transaction_policies(org_id,program_id,document_kind,date_basis,grouping_segment_id,unassigned_share,rounding,cap_percent,cap_project_type_id,created_by,updated_by,reason) values(${orgId},${programId},${policy.documentKind},${policy.dateBasis},${policy.groupingSegmentId},${policy.unassignedShare ?? "refuse"},${policy.rounding ?? "per_group"},${policy.capPercent ?? null},${policy.capProjectTypeId ?? null},${actorId},${actorId},${reason}) returning id`,
        "objects",
      ),
      "saving the transaction source policy",
    );
    for (const id of policy.itemIds)
      requireOneRow(
        await db.execute(
          sql`insert into hrm_benefit_transaction_items(org_id,program_id,item_id,created_by,updated_by,reason) values(${orgId},${programId},${id},${actorId},${actorId},${reason}) returning id`,
          "objects",
        ),
        "saving the eligible source item",
      );
    for (const r of policy.positions)
      requireOneRow(
        await db.execute(
          sql`insert into hrm_benefit_transaction_positions(org_id,program_id,position_key,name,weight,recipient_source,fallback_source,fallback_only_when_context_absent,created_by,updated_by,reason) values(${orgId},${programId},${r.key},${r.name},${amount(r.weight, "Share weight", true)},${r.recipientSource ?? "assignment"},${r.fallbackSource ?? null},${r.fallbackOnlyWhenContextAbsent ?? false},${actorId},${actorId},${reason}) returning id`,
          "objects",
        ),
        "saving the recipient position",
      );
    for (const r of policy.limits)
      requireOneRow(
        await db.execute(
          sql`insert into hrm_benefit_transaction_limits(org_id,program_id,group_id,limit_kind,amount,created_by,updated_by,reason) values(${orgId},${programId},${r.groupId},${r.kind},${r.amount === null ? null : amount(r.amount, "Group ceiling", false)},${actorId},${actorId},${reason}) returning id`,
          "objects",
        ),
        "saving the group ceiling",
      );
    for (const r of policy.responsibilities)
      requireOneRow(
        await db.execute(
          sql`insert into hrm_benefit_transaction_responsibilities(org_id,program_id,group_id,position_key,employment_id,effective_from,effective_to,created_by,updated_by,reason) values(${orgId},${programId},${r.groupId},${r.positionKey},${r.employmentId},${r.effectiveFrom},${r.effectiveTo},${actorId},${actorId},${reason}) returning id`,
          "objects",
        ),
        "saving the dated responsibility",
      );
    const saved = await readTransactionPolicy(db, orgId, programId);
    if (!saved)
      throw new BenefitsError(
        "REFUSED",
        "The saved transaction policy cannot be read back — the operation was rolled back; reload before retrying.",
      );
    const revision = requireOneRow(
      await db.execute<{ revision: number }>(
        sql`select revision from hrm_benefit_programs where org_id=${orgId} and id=${programId}`,
        "objects",
      ),
      "reading the saved program revision",
    ).revision;
    return { policy: saved, programRevision: revision };
  });
}
