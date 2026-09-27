import { sql } from "drizzle-orm";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
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
}

export interface FundPairRecord extends SetFundPairInput {
  id: string;
  isActive: boolean;
}

/** Insert or update the directed due-from/due-to accounts for two funds. */
export async function setFundPair(input: SetFundPairInput): Promise<FundPairRecord> {
  requireUuid(input.fromFundId, "fromFundId");
  requireUuid(input.toFundId, "toFundId");
  requireUuid(input.dueFromAccountId, "dueFromAccountId");
  requireUuid(input.dueToAccountId, "dueToAccountId");
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
    return {
      id: result.rows[0].id,
      ...input,
      isActive: input.isActive ?? true,
    };
  });
}
