import { sql } from "drizzle-orm";
import { lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { fundFeatureOff, NonprofitError } from "./errors.ts";

export type FundKind = "operating" | "restricted" | "endowment" | "plant" | "board_designated";
export type BudgetaryControl = "off" | "advisory" | "hard";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FUND_KINDS: readonly FundKind[] = ["operating", "restricted", "endowment", "plant", "board_designated"];
const CONTROL_MODES: readonly BudgetaryControl[] = ["off", "advisory", "hard"];

export interface CreateFundInput {
  orgId: string;
  code: string;
  name: string;
  kind: FundKind;
  restrictionClass: string;
  budgetaryControl?: BudgetaryControl;
  parentId?: string | null;
  subsidiaryId?: string | null;
  subsidiaryIncludeChildren?: boolean;
  isActive?: boolean;
  custom?: Record<string, unknown>;
  actorId?: string | null;
}

export interface CreatedFund {
  id: string;
  orgId: string;
  code: string;
  name: string;
  kind: FundKind;
  restrictionClass: string;
  budgetaryControl: BudgetaryControl;
}

async function assertFundAccountingEnabled(orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, "fundAccounting"))) throw fundFeatureOff();
}

function requireText(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new NonprofitError({
      message: `${field} is required.`,
      status: 422,
      code: "fund_input_required",
      remedy: `Enter a value for ${field}.`,
      field,
    });
  }
}

function requireUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) {
    throw new NonprofitError({
      message: `${field} must identify a valid record.`,
      status: 422,
      code: "fund_reference_invalid",
      remedy: `Choose an existing record for ${field}.`,
      field,
    });
  }
}

/** Create the segment value and its accounting classification atomically. */
export async function createFund(input: CreateFundInput): Promise<CreatedFund> {
  requireText(input.code, "code");
  requireText(input.name, "name");
  requireText(input.restrictionClass, "restrictionClass");
  if (!FUND_KINDS.includes(input.kind)) {
    throw new NonprofitError({
      message: "The fund kind is not supported.",
      status: 422,
      code: "fund_kind_invalid",
      remedy: "Choose a supported fund kind.",
      field: "kind",
    });
  }
  if (input.budgetaryControl !== undefined && !CONTROL_MODES.includes(input.budgetaryControl)) {
    throw new NonprofitError({
      message: "The fund budgetary-control mode is not supported.",
      status: 422,
      code: "fund_budgetary_control_invalid",
      remedy: "Choose off, advisory, or hard budgetary control.",
      field: "budgetaryControl",
    });
  }
  if (input.parentId != null) requireUuid(input.parentId, "parentId");
  if (input.subsidiaryId != null) requireUuid(input.subsidiaryId, "subsidiaryId");

  return withOrgTransaction(input.orgId, async () => {
    await assertFundAccountingEnabled(input.orgId);
    const segment = await db.execute<{ id: string; isBalancing: boolean }>(sql`
      select id, is_balancing as "isBalancing"
        from segment_definitions
       where org_id = ${input.orgId} and key = 'fund' and source_kind = 'custom'
       for update
    `);
    const definition = segment.rows[0];
    if (!definition || !definition.isBalancing) {
      throw new NonprofitError({
        message: "Fund accounting has not been provisioned for this organization.",
        status: 409,
        code: "fund_accounting_not_provisioned",
        remedy: "Provision the fund segment before creating a fund.",
      });
    }

    if (input.parentId != null) {
      const parent = await db.execute<{ id: string }>(sql`
        select sv.id from segment_values sv
        join funds f on f.org_id = sv.org_id and f.id = sv.id
         where sv.org_id = ${input.orgId} and sv.segment_id = ${definition.id}
           and sv.id = ${input.parentId} and sv.is_active
         for key share
      `);
      if (parent.rows.length !== 1) {
        throw new NonprofitError({
          message: "The parent value is not an active fund in this organization.",
          status: 422,
          code: "fund_parent_invalid",
          remedy: "Choose a parent from this organization's fund list.",
          field: "parentId",
        });
      }
    }
    if (input.subsidiaryId != null) {
      const subsidiary = await db.execute<{ id: string }>(sql`
        select id from subsidiaries where org_id = ${input.orgId} and id = ${input.subsidiaryId}
      `);
      if (subsidiary.rows.length !== 1) {
        throw new NonprofitError({
          message: "The subsidiary restriction is not in this organization.",
          status: 422,
          code: "fund_subsidiary_invalid",
          remedy: "Choose a subsidiary from this organization.",
          field: "subsidiaryId",
        });
      }
    }

    const duplicate = await db.execute<{ id: string }>(sql`
      select id from segment_values
       where org_id = ${input.orgId} and segment_id = ${definition.id}
         and code is not null and lower(code) = lower(${input.code})
       limit 1
    `);
    if (duplicate.rows.length > 0) {
      throw new NonprofitError({
        message: `Fund code "${input.code}" is already in use.`,
        status: 409,
        code: "fund_code_conflict",
        remedy: "Choose a fund code not already assigned in this organization.",
        field: "code",
      });
    }

    const value = await db.execute<{ id: string }>(sql`
      insert into segment_values
        (org_id, segment_id, code, name, parent_id, subsidiary_id,
         subsidiary_include_children, is_active, created_by, updated_by)
      values (
        ${input.orgId}, ${definition.id}, ${input.code}, ${input.name},
        ${input.parentId ?? null}, ${input.subsidiaryId ?? null},
        ${input.subsidiaryIncludeChildren ?? true}, ${input.isActive ?? true},
        ${input.actorId ?? null}, ${input.actorId ?? null}
      )
      returning id
    `);
    const valueId = value.rows[0]?.id;
    if (!valueId) {
      throw new NonprofitError({
        message: `Fund "${input.code}" was not created.`,
        status: 409,
        code: "fund_value_write_missing",
        remedy: "Retry fund creation after checking the fund setup records.",
      });
    }

    const classified = await db.execute<{ id: string }>(sql`
      insert into funds
        (id, org_id, kind, restriction_class, budgetary_control, custom, created_by, updated_by)
      values (
        ${valueId}, ${input.orgId}, ${input.kind}, ${input.restrictionClass},
        ${input.budgetaryControl ?? "off"}, ${JSON.stringify(input.custom ?? {})}::jsonb,
        ${input.actorId ?? null}, ${input.actorId ?? null}
      )
      returning id
    `);
    if (classified.rows.length !== 1 || classified.rows[0]?.id !== valueId) {
      throw new NonprofitError({
        message: `Fund "${input.code}" has no accounting classification row.`,
        status: 409,
        code: "fund_classification_write_missing",
        remedy: "Retry fund creation after checking the fund setup records.",
      });
    }

    return {
      id: valueId,
      orgId: input.orgId,
      code: input.code,
      name: input.name,
      kind: input.kind,
      restrictionClass: input.restrictionClass,
      budgetaryControl: input.budgetaryControl ?? "off",
    };
  });
}

export interface SetFundPairInput {
  orgId: string;
  fromFundId: string;
  toFundId: string;
  dueFromAccountId: string;
  dueToAccountId: string;
  isActive?: boolean;
  actorId?: string | null;
  /** Business reason for creating or changing the pair; stored on the audit record, never defaulted. */
  reason: string;
}

export interface FundPairRecord extends SetFundPairInput {
  id: string;
  isActive: boolean;
}

/**
 * Insert or update the directed due-from/due-to accounts for two funds.
 * The reason is required and nonblank at every call, and the same
 * transaction writes one audit_log row carrying before/after evidence with
 * actor and reason before reporting success.
 */
export async function setFundPair(input: SetFundPairInput): Promise<FundPairRecord> {
  requireUuid(input.fromFundId, "fromFundId");
  requireUuid(input.toFundId, "toFundId");
  requireUuid(input.dueFromAccountId, "dueFromAccountId");
  requireUuid(input.dueToAccountId, "dueToAccountId");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) {
    throw new NonprofitError({
      message: "A reason is required when saving an interfund pair.",
      status: 422,
      code: "fund_pair_reason_required",
      remedy: "Enter the reason for creating or changing the pair.",
      field: "reason",
    });
  }
  if (input.fromFundId === input.toFundId) {
    throw new NonprofitError({
      message: "An interfund pair must name two different funds.",
      status: 422,
      code: "fund_pair_same_fund",
      remedy: "Choose two different funds for the pair.",
      field: "toFundId",
    });
  }

  return withOrgTransaction(input.orgId, async () => {
    await assertFundAccountingEnabled(input.orgId);
    const funds = await db.execute<{ id: string }>(sql`
      select id from funds
       where org_id = ${input.orgId}
         and id = any(${uuidArray([input.fromFundId, input.toFundId])}::uuid[])
       for update
    `);
    if (new Set(funds.rows.map((row) => row.id)).size !== 2) {
      throw new NonprofitError({
        message: "Both funds in an interfund pair must exist in this organization.",
        status: 422,
        code: "fund_pair_fund_invalid",
        remedy: "Choose two funds from this organization's fund list.",
        field: "fromFundId",
      });
    }

    const accounts = await db.execute<{ id: string }>(sql`
      select id from accounts
       where org_id = ${input.orgId}
         and id = any(${uuidArray([input.dueFromAccountId, input.dueToAccountId])}::uuid[])
    `);
    if (new Set(accounts.rows.map((row) => row.id)).size !== 2) {
      throw new NonprofitError({
        message: "Both due-to and due-from accounts must exist in this organization.",
        status: 422,
        code: "fund_pair_account_invalid",
        remedy: "Choose due-to and due-from accounts from this organization's chart of accounts.",
        field: "dueFromAccountId",
      });
    }

    const before = (await db.execute<{ id: string; due_from_account_id: string; due_to_account_id: string; is_active: boolean }>(sql`
      select id, due_from_account_id, due_to_account_id, is_active from fund_pairs
       where org_id = ${input.orgId} and from_fund_id = ${input.fromFundId} and to_fund_id = ${input.toFundId}
       for update
    `)).rows[0] ?? null;

    // A directed pair is intentionally upserted; RETURNING proves that the
    // configuration write produced an observable row.
    const result = await db.execute<{ id: string }>(sql`
      insert into fund_pairs
        (org_id, from_fund_id, to_fund_id, due_from_account_id, due_to_account_id,
         is_active, created_by, updated_by)
      values (
        ${input.orgId}, ${input.fromFundId}, ${input.toFundId},
        ${input.dueFromAccountId}, ${input.dueToAccountId},
        ${input.isActive ?? true}, ${input.actorId ?? null}, ${input.actorId ?? null}
      )
      on conflict (org_id, from_fund_id, to_fund_id) do update
        set due_from_account_id = excluded.due_from_account_id,
            due_to_account_id = excluded.due_to_account_id,
            is_active = excluded.is_active,
            updated_at = now(),
            updated_by = excluded.updated_by
      returning id
    `);
    if (result.rows.length !== 1 || !result.rows[0]?.id) {
      throw new NonprofitError({
        message: "The interfund pair was not saved.",
        status: 409,
        code: "fund_pair_write_missing",
        remedy: "Retry saving the pair after checking the fund and account records.",
      });
    }
    const audit = (await db.execute<{ id: string }>(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (
        ${input.orgId}, 'fund_pairs', ${result.rows[0].id}, ${before ? "update" : "insert"},
        ${JSON.stringify({
          before,
          after: {
            dueFromAccountId: input.dueFromAccountId,
            dueToAccountId: input.dueToAccountId,
            isActive: input.isActive ?? true,
          },
          reason,
        })}::jsonb,
        ${input.actorId ?? null}
      )
      returning id
    `));
    if (audit.rows.length !== 1 || !audit.rows[0]?.id) {
      throw new NonprofitError({
        message: "The interfund pair audit record was not saved.",
        status: 409,
        code: "fund_pair_audit_missing",
        remedy: "Retry saving the pair after checking the fund and account records.",
      });
    }
    return {
      id: result.rows[0].id,
      ...input,
      isActive: input.isActive ?? true,
      reason,
    };
  });
}

/** Canonical fund register read: the drawer primary projection, shared by list and detail. */
export interface FundReadRecord {
  id: string;
  code: string | null;
  name: string;
  kind: FundKind;
  restrictionClass: string;
  budgetaryControl: BudgetaryControl;
  isActive: boolean;
  parentId: string | null;
  subsidiaryId: string | null;
  subsidiaryIncludeChildren: boolean;
  custom: Record<string, unknown>;
}

export interface FundReadPage {
  funds: FundReadRecord[];
  total: number;
}

interface FundReadRow extends Record<string, unknown> {
  id: string;
  code: string | null;
  name: string;
  kind: string;
  restriction_class: string;
  budgetary_control: string;
  is_active: boolean;
  parent_id: string | null;
  subsidiary_id: string | null;
  subsidiary_include_children: boolean;
  custom: Record<string, unknown> | null;
}

function mapFundRead(row: FundReadRow): FundReadRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind as FundKind,
    restrictionClass: row.restriction_class,
    budgetaryControl: row.budgetary_control as BudgetaryControl,
    isActive: row.is_active,
    parentId: row.parent_id,
    subsidiaryId: row.subsidiary_id,
    subsidiaryIncludeChildren: row.subsidiary_include_children,
    custom: row.custom ?? {},
  };
}

function readLimit(limit: number | undefined): number {
  const value = limit ?? 25;
  if (!Number.isInteger(value) || value < 1) {
    throw new NonprofitError({
      message: "The fund list limit must be a whole number of at least 1.",
      status: 422,
      code: "fund_list_limit_invalid",
      remedy: "Request a fund list limit of 1 or more; values above 100 read the first 100 funds.",
      field: "limit",
    });
  }
  return Math.min(value, 100);
}

function readOffset(offset: number | undefined): number {
  const value = offset ?? 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new NonprofitError({
      message: "The fund list offset must be a whole number starting at 0.",
      status: 422,
      code: "fund_list_offset_invalid",
      remedy: "Request a fund list offset of 0 or more.",
      field: "offset",
    });
  }
  return value;
}

/** List funds in deterministic code order with same-organization totals. */
export async function listFunds(
  input: {
    orgId: string;
    search?: string;
    includeInactive?: boolean;
    limit?: number;
    offset?: number;
  },
  executor?: SqlExecutor,
): Promise<FundReadPage> {
  const runner = executor ?? db;
  if (!(await orgFeatureEnabled(input.orgId, "fundAccounting", runner))) throw fundFeatureOff();
  const limit = readLimit(input.limit);
  const offset = readOffset(input.offset);
  const conds: ReturnType<typeof sql>[] = [sql`f.org_id = ${input.orgId}`];
  if (!input.includeInactive) conds.push(sql`sv.is_active`);
  const search = input.search?.trim();
  if (search) conds.push(sql`(sv.code ilike ${`%${search}%`} or sv.name ilike ${`%${search}%`})`);
  const where = sql.join(conds, sql` and `);
  const rows = await runner.execute<FundReadRow>(sql`
    select f.id::text as id, sv.code, sv.name, f.kind,
           f.restriction_class, f.budgetary_control, sv.is_active, f.custom,
           sv.parent_id::text as parent_id, sv.subsidiary_id::text as subsidiary_id,
           sv.subsidiary_include_children
      from funds f
      join segment_values sv on sv.org_id = f.org_id and sv.id = f.id
      join segment_definitions sd on sd.org_id = f.org_id and sd.id = sv.segment_id
       and sd.key = 'fund' and sd.source_kind = 'custom'
     where ${where}
     order by sv.name, sv.code, sv.id
     limit ${limit} offset ${offset}
  `);
  const counted = await runner.execute<{ n: string }>(sql`
    select count(*) as n
      from funds f
      join segment_values sv on sv.org_id = f.org_id and sv.id = f.id
      join segment_definitions sd on sd.org_id = f.org_id and sd.id = sv.segment_id
       and sd.key = 'fund' and sd.source_kind = 'custom'
     where ${where}
  `);
  return { funds: rows.rows.map(mapFundRead), total: Number(counted.rows[0]?.n ?? 0) };
}

/**
 * Read one fund for the register drawer. Unknown and cross-organization ids
 * resolve to the same null, so a missing record is indistinguishable from
 * another organization's record.
 */
export async function getFund(
  input: { orgId: string; fundId: string },
  executor?: SqlExecutor,
): Promise<FundReadRecord | null> {
  const runner = executor ?? db;
  if (!(await orgFeatureEnabled(input.orgId, "fundAccounting", runner))) throw fundFeatureOff();
  if (!UUID_RE.test(input.fundId)) return null;
  const row = (await runner.execute<FundReadRow>(sql`
    select f.id::text as id, sv.code, sv.name, f.kind,
           f.restriction_class, f.budgetary_control, sv.is_active, f.custom,
           sv.parent_id::text as parent_id, sv.subsidiary_id::text as subsidiary_id,
           sv.subsidiary_include_children
      from funds f
      join segment_values sv on sv.org_id = f.org_id and sv.id = f.id
      join segment_definitions sd on sd.org_id = f.org_id and sd.id = sv.segment_id
       and sd.key = 'fund' and sd.source_kind = 'custom'
     where f.org_id = ${input.orgId} and f.id = ${input.fundId}
  `)).rows[0];
  return row ? mapFundRead(row) : null;
}
