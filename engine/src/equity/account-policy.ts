/**
 * Validation of an equity account policy version, the one place the Setup
 * write path and the engine agree on what a valid version is:
 *  - share capital, paid-in capital and treasury accounts are equity
 *    accounts; the compensation expense account is an expense account; the
 *    convertible instruments account is a liability or equity account (SAFEs
 *    and notes are classified by their terms);
 *  - the convertible note interest expense account is an expense account,
 *    the accrued interest account a liability account (it may be the
 *    convertible instruments account itself) and the early-exercise deposit
 *    account a liability account; these three are mapped by the legal
 *    entities that need them, and a posting that needs an unmapped one
 *    refuses with this Setup remedy;
 *  - every account is an active posting account of the organization;
 *  - a version may not take effect on or before the legal entity's latest
 *    equity posting, so a new version never reinterprets posted history.
 */
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";
import { isUuid } from "../platform/uuid.ts";
import { EQUITY_TYPES, LIABILITY_TYPES, PNL_COST_TYPES } from "../records/account-types.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
import { equityError, fig, type EquityError, type EquityTermName } from "./errors.ts";
import { governEquityAction, type GovernedStatus } from "./governance.ts";
import { requireReason, writeEquityAudit } from "./internal.ts";
import { EQUITY_JOURNAL_ORIGIN } from "./posting.ts";
import { inEquityCommand } from "./structure.ts";

/** The kind of account a policy role accepts, as a refusal names it. */
export type EquityPolicyAccountKind = "equity" | "expense" | "liabilityOrEquity" | "liability";

export interface EquityPolicyAccountField {
  key: EquityTermName;
  kind: EquityPolicyAccountKind;
  types: readonly string[];
}

export const EQUITY_POLICY_ACCOUNT_FIELDS: readonly EquityPolicyAccountField[] = [
  { key: "commonStockAccountId", kind: "equity", types: EQUITY_TYPES },
  { key: "preferredStockAccountId", kind: "equity", types: EQUITY_TYPES },
  { key: "apicAccountId", kind: "equity", types: EQUITY_TYPES },
  { key: "apicShareBasedAccountId", kind: "equity", types: EQUITY_TYPES },
  { key: "compensationExpenseAccountId", kind: "expense", types: PNL_COST_TYPES },
  { key: "treasuryStockAccountId", kind: "equity", types: EQUITY_TYPES },
  {
    key: "convertibleInstrumentsAccountId",
    kind: "liabilityOrEquity",
    types: [...LIABILITY_TYPES, ...EQUITY_TYPES],
  },
];

/** Accrued interest and deposits are other current or long-term liabilities, never payables or card balances. */
const ACCRUAL_TYPES = ["liability_current_other", "liability_long_term"];

/** Accounts a version maps when the legal entity carries interest-bearing notes or early-exercisable options. */
export const EQUITY_POLICY_OPTIONAL_ACCOUNT_FIELDS: readonly EquityPolicyAccountField[] = [
  { key: "interestExpenseAccountId", kind: "expense", types: PNL_COST_TYPES },
  { key: "accruedInterestAccountId", kind: "liability", types: ACCRUAL_TYPES },
  { key: "earlyExerciseDepositAccountId", kind: "liability", types: ACCRUAL_TYPES },
];

/**
 * The refusal for a proposed policy version, or null when it is valid. It
 * answers 422 for a version being recorded and 409 when a recorded version
 * no longer satisfies the ledger it is about to apply to.
 */
export async function equityAccountPolicyRefusal(
  runner: SqlExecutor,
  orgId: string,
  body: Record<string, unknown>,
  status: 409 | 422 = 422,
): Promise<EquityError | null> {
  const subsidiaryId = body.subsidiaryId;
  if (typeof subsidiaryId !== "string" || !isUuid(subsidiaryId))
    return equityError("accountPolicyEntityMissing", {}, { status });
  const effectiveFrom = body.effectiveFrom;
  if (typeof effectiveFrom !== "string" || !isIsoCalendarDate(effectiveFrom)) {
    return equityError(
      "accountPolicyEffectiveDateInvalid",
      { field: fig.term("effectiveFrom") },
      { status },
    );
  }
  const fields = [
    ...EQUITY_POLICY_ACCOUNT_FIELDS.map((field) => ({ ...field, required: true })),
    ...EQUITY_POLICY_OPTIONAL_ACCOUNT_FIELDS.map((field) => ({ ...field, required: false })),
  ];
  for (const field of fields) {
    const accountId = body[field.key];
    if (!field.required && (accountId === undefined || accountId === null || accountId === ""))
      continue;
    if (typeof accountId !== "string" || !isUuid(accountId))
      return equityError(
        "accountPolicyAccountMissing",
        { account: fig.term(field.key) },
        { status },
      );
    const row = (
      await runner.execute<{ type: string; is_active: boolean; is_summary: boolean }>(
        sql`
      select type, is_active, is_summary from accounts where org_id = ${orgId} and id = ${accountId}`,
        "objects",
      )
    )[0];
    if (!row || !row.is_active || row.is_summary || !field.types.includes(row.type)) {
      return equityError(
        "accountPolicyAccountType",
        { account: fig.term(field.key), kind: fig.choice(field.kind) },
        { status },
      );
    }
  }
  const latest = (
    await runner.execute<{ posting_date: string }>(
      sql`
    select max(posting_date)::text as posting_date from journal_entries
     where org_id = ${orgId} and subsidiary_id = ${subsidiaryId} and origin = ${EQUITY_JOURNAL_ORIGIN}
       and status in ('posted', 'reversed')`,
      "objects",
    )
  )[0];
  if (latest?.posting_date && effectiveFrom <= latest.posting_date) {
    return equityError(
      "accountPolicyBeforeLatestPosting",
      { date: fig.date(latest.posting_date) },
      { status },
    );
  }
  return null;
}

export interface RecordAccountPolicyInput {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  effectiveFrom: string;
  commonStockAccountId: string;
  preferredStockAccountId: string;
  apicAccountId: string;
  apicShareBasedAccountId: string;
  compensationExpenseAccountId: string;
  treasuryStockAccountId: string;
  convertibleInstrumentsAccountId: string;
  interestExpenseAccountId?: string | null;
  accruedInterestAccountId?: string | null;
  earlyExerciseDepositAccountId?: string | null;
  reason: string;
}

/**
 * Record a new equity account policy version (equity.manage; a governed
 * action an Equity action Flow may require approval for). Versions are
 * retained: a change is a new version from its date.
 */
export async function recordEquityAccountPolicy(
  input: RecordAccountPolicyInput,
): Promise<{ id: string | null; status: GovernedStatus; requestId: string }> {
  const reason = requireReason(input.reason, "accountPolicy");
  const refusal = await withOrgTransaction(input.orgId, () =>
    equityAccountPolicyRefusal(db, input.orgId, input as unknown as Record<string, unknown>, 422),
  );
  if (refusal) throw refusal;
  const { orgId: _org, actorId: _actor, ...payload } = input;
  const outcome = await governEquityAction(
    {
      orgId: input.orgId,
      actorId: input.actorId,
      subsidiaryId: input.subsidiaryId,
      action: "account_policy",
      subjectId: null,
      subjectLabel: `Equity accounts from ${input.effectiveFrom}`,
      effectiveOn: input.effectiveFrom,
      reason,
      summary: {},
      payload,
      idempotencyKey: null,
    },
    (actorId) => applyEquityAccountPolicy({ ...input, actorId }),
  );
  return { id: outcome.result?.id ?? null, status: outcome.status, requestId: outcome.requestId };
}

/** Apply an account policy version: the command its approval releases. */
export async function applyEquityAccountPolicy(
  input: RecordAccountPolicyInput,
): Promise<{ id: string }> {
  const reason = requireReason(input.reason, "accountPolicy");
  return inEquityCommand(input, "equity.manage", async () => {
    const refusal = await equityAccountPolicyRefusal(
      db,
      input.orgId,
      input as unknown as Record<string, unknown>,
      409,
    );
    if (refusal) throw refusal;
    const optional = (value: string | null | undefined) =>
      typeof value === "string" && value !== "" ? value : null;
    const row = (
      await db.execute<{ id: string }>(
        sql`
      insert into equity_account_policies (org_id, subsidiary_id, effective_from, common_stock_account_id, preferred_stock_account_id,
        apic_account_id, apic_share_based_account_id, compensation_expense_account_id, treasury_stock_account_id,
        convertible_instruments_account_id, interest_expense_account_id, accrued_interest_account_id, early_exercise_deposit_account_id,
        reason, created_by, updated_by)
      values (${input.orgId}, ${input.subsidiaryId}, ${input.effectiveFrom}::date, ${input.commonStockAccountId}, ${input.preferredStockAccountId},
        ${input.apicAccountId}, ${input.apicShareBasedAccountId}, ${input.compensationExpenseAccountId}, ${input.treasuryStockAccountId},
        ${input.convertibleInstrumentsAccountId}, ${optional(input.interestExpenseAccountId)}, ${optional(input.accruedInterestAccountId)},
        ${optional(input.earlyExerciseDepositAccountId)}, ${reason}, ${input.actorId}, ${input.actorId})
      returning id`,
        "objects",
      )
    )[0];
    if (!row) throw equityError("notSaved", { record: fig.choice("accountPolicy") });
    await writeEquityAudit(db, {
      orgId: input.orgId,
      table: "equity_account_policies",
      rowId: row.id,
      action: "equity.account_policy.create",
      actorId: input.actorId,
      changes: { before: null, after: { ...input, orgId: undefined, actorId: undefined }, reason },
    });
    return { id: row.id };
  });
}
