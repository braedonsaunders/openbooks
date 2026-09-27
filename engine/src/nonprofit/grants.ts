import { sql } from "drizzle-orm";
import {
  addMoney,
  cmpMoney,
  negMoney,
  parseMoney,
  parseRate,
  type Money,
} from "../money/brands.ts";
import { mulPercent, toUnits } from "../money/money.ts";
import { lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { nextFreeEntryNumber } from "../records/entry-number.ts";
import { accountGroupNamePatternError } from "../records/account-groups.ts";
import { db, withOrgContext, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import { NonprofitError, NonprofitPostingError } from "./errors.ts";
import { reversalJournalLines, type ReversalSourceJournalLine } from "../records/reversal-journal-lines.ts";

export type GrantSponsorKind = "government" | "foundation" | "corporate";
export type GrantDetermination = "contribution_unconditional" | "contribution_conditional" | "exchange";
export type GrantStatus = "draft" | "awarded" | "active" | "closed_out" | "closed" | "void";
export type GrantIndirectBase = "direct_costs" | "modified_total_direct";
export type GrantDrawdownKind = "advance" | "reimbursement" | "final";
export type GrantDrawdownStatus = "draft" | "submitted" | "paid" | "recognized" | "void";
export type GrantReportStatus = "upcoming" | "submitted" | "overdue";

export interface GrantRecord {
  id: string;
  orgId: string;
  code: string;
  name: string;
  sponsorPartyId: string;
  sponsorKind: GrantSponsorKind;
  determination: GrantDetermination;
  barrier: string | null;
  barrierMetAt: string | null;
  barrierEvidence: string | null;
  rightOfReturn: boolean;
  awardAmount: string;
  periodFrom: string;
  periodTo: string;
  indirectRate: string;
  indirectBase: GrantIndirectBase;
  costShareRequired: boolean;
  costShareAmount: string;
  fundId: string;
  allowableAccountGroupId: string;
  status: GrantStatus;
  awardEntryId: string | null;
  version: number;
  supersedesId: string | null;
  custom: Record<string, unknown>;
}

export interface GrantPostingAccounts {
  bankAccountId: string;
  grantsReceivableAccountId: string;
  refundableAdvanceAccountId: string;
  grantRevenueAccountId: string;
  exchangeReceivableAccountId: string;
  exchangeRevenueAccountId: string;
}

export interface CreateGrantInput {
  orgId: string;
  code: string;
  name: string;
  sponsorPartyId: string;
  sponsorKind: GrantSponsorKind;
  determination: GrantDetermination;
  barrier?: string | null;
  rightOfReturn?: boolean;
  awardAmount: string;
  periodFrom: string;
  periodTo: string;
  indirectRate?: string;
  indirectBase?: GrantIndirectBase;
  costShareRequired?: boolean;
  costShareAmount?: string;
  fundId: string;
  allowableAccountGroupId: string;
  custom?: Record<string, unknown>;
  actorId: string;
}

export interface GrantReportInput {
  orgId: string;
  grantId: string;
  title: string;
  dueOn: string;
  actorId: string;
}

interface GrantRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  code: string;
  name: string;
  sponsor_party_id: string;
  sponsor_kind: GrantSponsorKind;
  determination: GrantDetermination;
  barrier: string | null;
  barrier_met_at: string | null;
  barrier_evidence: string | null;
  right_of_return: boolean;
  award_amount: string;
  period_from: string;
  period_to: string;
  indirect_rate: string;
  indirect_base: GrantIndirectBase;
  cost_share_required: boolean;
  cost_share_amount: string;
  fund_id: string;
  allowable_account_group_id: string;
  status: GrantStatus;
  award_entry_id: string | null;
  version: number;
  supersedes_id: string | null;
  custom: Record<string, unknown> | null;
  created_at?: string;
  created_by?: string | null;
  updated_at?: string;
  updated_by?: string | null;
}

interface GroupRow extends Record<string, unknown> {
  id: string;
  dimension: string;
  name: string;
  sort_order: number;
  match: {
    accountTypes?: string[];
    numberPrefixes?: string[];
    namePattern?: string;
  };
  is_catch_all: boolean;
}

interface AccountRow extends Record<string, unknown> {
  id: string;
  number: string | null;
  name: string;
  type: string;
}

const SPONSOR_KINDS: readonly GrantSponsorKind[] = ["government", "foundation", "corporate"];
const DETERMINATIONS: readonly GrantDetermination[] = [
  "contribution_unconditional",
  "contribution_conditional",
  "exchange",
];
const INDIRECT_BASES: readonly GrantIndirectBase[] = ["direct_costs", "modified_total_direct"];
const EXPENSE_TYPES = new Set(["cogs", "expense", "expense_other"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRANT_FEATURE_REMEDY = "Enable Grant Management in Company Settings → Features.";

function refusal(input: {
  message: string;
  code: string;
  remedy: string;
  status?: 409 | 422;
  field?: string;
}): NonprofitError {
  const { status, ...rest } = input;
  return new NonprofitError({ status: status ?? 422, ...rest });
}

function grantFeatureOff(): NonprofitError {
  return refusal({
    message: "Grant Management is disabled; enable grantManagement in Company Settings → Features.",
    code: "feature_off",
    remedy: GRANT_FEATURE_REMEDY,
  });
}

async function requireGrantFeature(orgId: string, runner: SqlExecutor, write: boolean): Promise<void> {
  const enabled = write
    ? await lockAndCheckOrgFeature(runner, orgId, "grantManagement")
    : await orgFeatureEnabled(orgId, "grantManagement", runner);
  if (!enabled) throw grantFeatureOff();
}

async function withGrantWrite<T>(orgId: string, fn: (runner: SqlExecutor) => Promise<T>): Promise<T> {
  return withOrgTransaction(orgId, async () => {
    await requireGrantFeature(orgId, db, true);
    return fn(db);
  });
}

async function withGrantRead<T>(orgId: string, fn: (runner: SqlExecutor) => Promise<T>): Promise<T> {
  return withOrgContext(orgId, async () => {
    await requireGrantFeature(orgId, db, false);
    return fn(db);
  });
}

function parseGrantMoney(value: unknown, field: string, positive = false): Money {
  let parsed: Money;
  try {
    parsed = parseMoney(value);
  } catch {
    throw refusal({
      message: `${field} must be an exact decimal amount with no more than four decimal places.`,
      code: "grant_amount_invalid",
      remedy: `Enter ${field} as a decimal amount with no more than four decimal places.`,
      field,
    });
  }
  if ((positive && cmpMoney(parsed, "0.0000") <= 0) || (!positive && cmpMoney(parsed, "0.0000") < 0)) {
    throw refusal({
      message: `${field} must be ${positive ? "greater than" : "at least"} zero.`,
      code: "grant_amount_invalid",
      remedy: `Enter a ${positive ? "positive" : "non-negative"} amount for ${field}.`,
      field,
    });
  }
  return parsed;
}

function parseGrantRate(value: unknown): string {
  let parsed: string;
  try {
    parsed = parseRate(value ?? "0");
  } catch {
    throw refusal({
      message: "The indirect rate must be an exact percentage with no more than ten decimal places.",
      code: "grant_indirect_rate_invalid",
      remedy: "Enter a non-negative indirect percentage from the signed award terms.",
      field: "indirectRate",
    });
  }
  if (parsed.startsWith("-")) {
    throw refusal({
      message: "The indirect rate cannot be negative.",
      code: "grant_indirect_rate_invalid",
      remedy: "Enter a non-negative indirect percentage from the signed award terms.",
      field: "indirectRate",
    });
  }
  return parsed;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw refusal({
      message: `${field} is required.`,
      code: "grant_input_required",
      remedy: `Enter a value for ${field}.`,
      field,
    });
  }
  return value.trim();
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw refusal({
      message: `${field} must identify a valid record.`,
      code: "grant_reference_invalid",
      remedy: `Choose an existing record for ${field}.`,
      field,
    });
  }
  return value;
}

function requireDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !isIsoCalendarDate(value)) {
    throw refusal({
      message: `${field} must be a valid calendar date in YYYY-MM-DD format.`,
      code: "grant_date_invalid",
      remedy: `Enter a real calendar date for ${field}.`,
      field,
    });
  }
  return value;
}

function mapGrant(row: GrantRow): GrantRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    code: row.code,
    name: row.name,
    sponsorPartyId: row.sponsor_party_id,
    sponsorKind: row.sponsor_kind,
    determination: row.determination,
    barrier: row.barrier,
    barrierMetAt: row.barrier_met_at,
    barrierEvidence: row.barrier_evidence,
    rightOfReturn: row.right_of_return,
    awardAmount: row.award_amount,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    indirectRate: row.indirect_rate,
    indirectBase: row.indirect_base,
    costShareRequired: row.cost_share_required,
    costShareAmount: row.cost_share_amount,
    fundId: row.fund_id,
    allowableAccountGroupId: row.allowable_account_group_id,
    status: row.status,
    awardEntryId: row.award_entry_id,
    version: row.version,
    supersedesId: row.supersedes_id,
    custom: row.custom ?? {},
  };
}

function grantReportStatus(row: { dueOn: string; submittedAt: string | null }, asOf: string): GrantReportStatus {
  if (row.submittedAt) return "submitted";
  return row.dueOn < asOf ? "overdue" : "upcoming";
}

/** Exact indirect calculation. Rates are percentages, and all results stay at ledger precision. */
export function calculateIndirectCost(input: {
  directCosts: string;
  modifiedTotalDirect: string;
  ratePercent: string;
  base: GrantIndirectBase;
}): Money {
  const base = input.base === "direct_costs" ? input.directCosts : input.modifiedTotalDirect;
  return parseMoney(mulPercent(parseMoney(base), parseGrantRate(input.ratePercent)));
}

export function calculateAllowableSpend(input: {
  directCosts: string;
  modifiedTotalDirect: string;
  ratePercent: string;
  base: GrantIndirectBase;
}): Money {
  const direct = parseGrantMoney(input.directCosts, "directCosts");
  return addMoney(direct, calculateIndirectCost(input));
}

async function auditGrant(
  runner: SqlExecutor,
  input: { orgId: string; rowId: string; action: string; actorId: string; changes: Record<string, unknown> },
): Promise<void> {
  const result = await runner.execute<{ id: string }>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${input.orgId}, 'grants', ${input.rowId}, ${input.action}, ${JSON.stringify(input.changes)}::jsonb, ${input.actorId})
    returning id
  `);
  if (result.rows.length !== 1) {
    throw refusal({
      message: `The grant ${input.action} was not recorded in the audit history.`,
      code: "grant_audit_write_missing",
      remedy: "Retry the grant change after checking the audit service.",
      status: 409,
    });
  }
}

async function validateGrantReferences(
  runner: SqlExecutor,
  orgId: string,
  refs: { sponsorPartyId: string; fundId: string; allowableAccountGroupId: string },
): Promise<void> {
  const sponsor = await runner.execute<{ id: string }>(sql`
    select id from parties where org_id = ${orgId} and id = ${refs.sponsorPartyId} for key share
  `);
  if (sponsor.rows.length !== 1) {
    throw refusal({
      message: "The sponsor is not a party in this organization.",
      code: "grant_sponsor_invalid",
      remedy: "Choose the grant sponsor from this organization's party records.",
      field: "sponsorPartyId",
    });
  }
  const fund = await runner.execute<{ id: string }>(sql`
    select f.id from funds f
    join segment_values sv on sv.org_id = f.org_id and sv.id = f.id
    join segment_definitions sd on sd.org_id = sv.org_id and sd.id = sv.segment_id and sd.key = 'fund'
    where f.org_id = ${orgId} and f.id = ${refs.fundId} and sv.is_active
    for key share of f, sv
  `);
  if (fund.rows.length !== 1) {
    throw refusal({
      message: "The grant fund is not an active fund in this organization.",
      code: "grant_fund_invalid",
      remedy: "Choose an active fund from this organization's fund list.",
      field: "fundId",
    });
  }
  const group = await runner.execute<{ id: string }>(sql`
    select id from account_groups where org_id = ${orgId} and id = ${refs.allowableAccountGroupId} and is_active
    for key share
  `);
  if (group.rows.length !== 1) {
    throw refusal({
      message: "The allowable-cost account group is not active in this organization.",
      code: "grant_allowable_group_invalid",
      remedy: "Choose an active account group from this organization's account-group setup.",
      field: "allowableAccountGroupId",
    });
  }
}

function validateGrantTerms(input: CreateGrantInput): {
  code: string;
  name: string;
  sponsorPartyId: string;
  fundId: string;
  allowableAccountGroupId: string;
  awardAmount: Money;
  periodFrom: string;
  periodTo: string;
  indirectRate: string;
  indirectBase: GrantIndirectBase;
  costShareAmount: Money;
} {
  const code = requireText(input.code, "code");
  const name = requireText(input.name, "name");
  const sponsorPartyId = requireUuid(input.sponsorPartyId, "sponsorPartyId");
  const fundId = requireUuid(input.fundId, "fundId");
  const allowableAccountGroupId = requireUuid(input.allowableAccountGroupId, "allowableAccountGroupId");
  if (!SPONSOR_KINDS.includes(input.sponsorKind)) {
    throw refusal({ message: "The sponsor kind is not supported.", code: "grant_sponsor_kind_invalid", remedy: "Choose government, foundation, or corporate.", field: "sponsorKind" });
  }
  if (!DETERMINATIONS.includes(input.determination)) {
    throw refusal({ message: "The accounting determination is not supported.", code: "grant_determination_invalid", remedy: "Choose an unconditional contribution, a conditional contribution, or an exchange transaction.", field: "determination" });
  }
  if (input.determination === "contribution_conditional" && (!input.barrier?.trim() || input.rightOfReturn !== true)) {
    throw refusal({ message: "A conditional award needs a barrier and a right of return or release.", code: "grant_conditional_terms_required", remedy: "Record the substantive barrier and the agreement's right of return before saving the award.", field: "barrier" });
  }
  if (input.indirectBase !== undefined && !INDIRECT_BASES.includes(input.indirectBase)) {
    throw refusal({ message: "The indirect-cost base is not supported.", code: "grant_indirect_base_invalid", remedy: "Choose direct costs or modified total direct costs.", field: "indirectBase" });
  }
  const periodFrom = requireDate(input.periodFrom, "periodFrom");
  const periodTo = requireDate(input.periodTo, "periodTo");
  if (periodTo < periodFrom) {
    throw refusal({ message: "The grant end date precedes its start date.", code: "grant_period_invalid", remedy: "Set the grant end date on or after its start date.", field: "periodTo" });
  }
  const awardAmount = parseGrantMoney(input.awardAmount, "awardAmount", true);
  const costShareAmount = parseGrantMoney(input.costShareAmount ?? "0", "costShareAmount");
  if (!input.costShareRequired && cmpMoney(costShareAmount, "0.0000") !== 0) {
    throw refusal({ message: "A cost-share amount was supplied without a cost-share requirement.", code: "grant_cost_share_invalid", remedy: "Mark cost sharing as required or set its amount to zero.", field: "costShareAmount" });
  }
  return {
    code,
    name,
    sponsorPartyId,
    fundId,
    allowableAccountGroupId,
    awardAmount,
    periodFrom,
    periodTo,
    indirectRate: parseGrantRate(input.indirectRate ?? "0"),
    indirectBase: input.indirectBase ?? "direct_costs",
    costShareAmount,
  };
}

async function loadGrantById(runner: SqlExecutor, orgId: string, grantId: string, lock = false): Promise<GrantRow> {
  const result = await runner.execute<GrantRow>(sql`
    select id, org_id, code, name, sponsor_party_id, sponsor_kind, determination, barrier,
           barrier_met_at::text as barrier_met_at, barrier_evidence, right_of_return,
           award_amount::text as award_amount, period_from::text as period_from, period_to::text as period_to,
           indirect_rate::text as indirect_rate, indirect_base, cost_share_required,
           cost_share_amount::text as cost_share_amount, fund_id, allowable_account_group_id, status,
           award_entry_id, version, supersedes_id, custom, created_at::text as created_at,
           created_by, updated_at::text as updated_at, updated_by
      from grants where org_id = ${orgId} and id = ${grantId}
      ${lock ? sql`for update` : sql``}
  `);
  const row = result.rows[0];
  if (!row) {
    throw refusal({
      message: "The grant is not in this organization.",
      code: "grant_not_found",
      remedy: "Choose a grant from this organization's grant list.",
      status: 409,
    });
  }
  return row;
}

async function loadCurrentGrant(runner: SqlExecutor, orgId: string, grantId: string, lock = false): Promise<GrantRow> {
  const requested = await loadGrantById(runner, orgId, grantId, lock);
  const current = await runner.execute<GrantRow>(sql`
    select id, org_id, code, name, sponsor_party_id, sponsor_kind, determination, barrier,
           barrier_met_at::text as barrier_met_at, barrier_evidence, right_of_return,
           award_amount::text as award_amount, period_from::text as period_from, period_to::text as period_to,
           indirect_rate::text as indirect_rate, indirect_base, cost_share_required,
           cost_share_amount::text as cost_share_amount, fund_id, allowable_account_group_id, status,
           award_entry_id, version, supersedes_id, custom, created_at::text as created_at,
           created_by, updated_at::text as updated_at, updated_by
      from grants where org_id = ${orgId} and code = ${requested.code}
      order by version desc limit 1 ${lock ? sql`for update` : sql``}
  `);
  const row = current.rows[0];
  if (!row) {
    throw refusal({
      message: `Grant ${requested.code} has no current version.`,
      code: "grant_version_missing",
      remedy: "Review the grant's version history before retrying.",
      status: 409,
    });
  }
  return row;
}

function requireLatestVersion(row: GrantRow, requestedId: string): void {
  if (row.id !== requestedId) {
    throw refusal({
      message: `Grant ${row.code} has a newer version than the record selected.`,
      code: "grant_version_stale",
      remedy: "Open the current grant version and retry the change.",
      status: 409,
    });
  }
}

async function getPostingContext(
  runner: SqlExecutor,
  orgId: string,
  postingDateInput: string,
): Promise<{ bookId: string; subsidiaryId: string; currency: string; periodId: string }> {
  const postingDate = requireDate(postingDateInput, "postingDate");
  const book = await runner.execute<{ id: string }>(sql`
    select id from accounting_books
     where org_id = ${orgId} and is_primary and is_active and posts_gl
     limit 1 for share
  `);
  const subsidiary = await runner.execute<{ id: string; currency: string | null }>(sql`
    select id, nullif(trim(base_currency), '') as currency from subsidiaries
     where org_id = ${orgId} and is_active and not is_elimination and parent_id is null
     limit 1 for share
  `);
  const period = await resolveCoveringPeriod(runner, orgId, postingDate);
  if (!book.rows[0] || !subsidiary.rows[0]?.currency || !period) {
    throw refusal({
      message: "A grant posting needs an active primary book, root subsidiary currency, and covering accounting period.",
      code: "grant_posting_context_missing",
      remedy: "Configure the primary book and subsidiary currency, then choose a date in an open accounting period.",
      status: 409,
    });
  }
  return { bookId: book.rows[0].id, subsidiaryId: subsidiary.rows[0].id, currency: subsidiary.rows[0].currency, periodId: period.id };
}

async function validatePostingAccounts(
  runner: SqlExecutor,
  orgId: string,
  slots: readonly { id: string; label: string; types: readonly string[] }[],
): Promise<void> {
  for (const slot of slots) {
    const account = await runner.execute<{ id: string; type: string }>(sql`
      select id, type from accounts
       where org_id = ${orgId} and id = ${slot.id} and is_active and not is_summary
       for key share
    `);
    if (account.rows.length !== 1 || !slot.types.includes(account.rows[0]!.type)) {
      throw refusal({
        message: `${slot.label} must be an active posting account of the required account type in this organization.`,
        code: "grant_posting_account_invalid",
        remedy: `Choose an active ${slot.label.toLowerCase()} account from this organization's chart of accounts.`,
        field: slot.label,
      });
    }
  }
}

function postFailure(error: unknown, grantCode: string): never {
  if (error instanceof NonprofitError) throw error;
  if (error && typeof error === "object") {
    const shape = error as { status?: unknown; code?: unknown; remedy?: unknown };
    if (Number.isInteger(shape.status) && Number(shape.status) >= 400 && Number(shape.status) <= 499 &&
        typeof shape.code === "string" && typeof shape.remedy === "string") throw error;
  }
  const detail = error instanceof Error ? error.message : String(error);
  throw new NonprofitPostingError({
    message: `Grant ${grantCode} could not be posted: ${detail}`,
    status: 422,
    code: "grant_posting_refused",
    remedy: "Review the accounting period, posting accounts, and fund assignments before retrying.",
  });
}

async function postGrantEntry(
  runner: SqlExecutor,
  grant: GrantRow,
  input: {
    actorId: string;
    postingDate: string;
    event: string;
    idempotencyKey: string;
    lines: {
      accountId: string;
      amount: string;
      partyId?: string | null;
      isOpenItem?: boolean;
      dueDate?: string | null;
      memo?: string | null;
    }[];
  },
): Promise<string> {
  const context = await getPostingContext(runner, grant.org_id, input.postingDate);
  const entryNumber = await db.transaction((tx) =>
    nextFreeEntryNumber(tx, grant.org_id, `GRANT-${grant.code}-${input.event.toUpperCase()}-V${grant.version}`),
  );
  try {
    const posted = await postEntry(runner, {
      orgId: grant.org_id,
      bookId: context.bookId,
      subsidiaryId: context.subsidiaryId,
      entryNumber,
      postingDate: input.postingDate,
      periodId: context.periodId,
      memo: `Grant ${grant.code}: ${input.event}`,
      origin: "grant",
      actorId: input.actorId,
      currency: context.currency,
      idempotencyKey: input.idempotencyKey,
      auditAction: "create",
      auditChanges: { grantId: grant.id, grantCode: grant.code, event: input.event },
      lines: input.lines.map((line) => ({
        accountId: line.accountId,
        amount: line.amount,
        partyId: line.partyId ?? null,
        isOpenItem: line.isOpenItem ?? false,
        dueDate: line.dueDate ?? null,
        memo: line.memo ?? null,
        extraDims: { fund: grant.fund_id },
      })),
    });
    return posted.entryId;
  } catch (error) {
    return postFailure(error, grant.code);
  }
}

async function resolveGroupMembers(
  runner: SqlExecutor,
  orgId: string,
  targetGroupId: string,
): Promise<Map<string, string>> {
  const target = await runner.execute<{ id: string; dimension: string; is_active: boolean }>(sql`
    select id, dimension, is_active from account_groups
     where org_id = ${orgId} and id = ${targetGroupId} for key share
  `);
  const targetRow = target.rows[0];
  if (!targetRow?.is_active) {
    throw refusal({
      message: "The allowable-cost account group is missing or inactive.",
      code: "grant_allowable_group_invalid",
      remedy: "Choose an active account group from this organization's account-group setup.",
    });
  }
  const groupsResult = await runner.execute<GroupRow>(sql`
    select id, dimension, name, sort_order, match, is_catch_all
      from account_groups where org_id = ${orgId} and dimension = ${targetRow.dimension} and is_active
      order by sort_order, name for share
  `);
  const groups = groupsResult.rows;
  const pins = await runner.execute<{ account_id: string; group_id: string }>(sql`
    select m.account_id, m.group_id from account_group_members m
      join account_groups g on g.org_id = m.org_id and g.id = m.group_id
     where m.org_id = ${orgId} and g.dimension = ${targetRow.dimension} and g.is_active
     order by m.account_id, m.group_id for share of m
  `);
  const accountRows = await runner.execute<AccountRow>(sql`
    select id, number, name, type from accounts where org_id = ${orgId} and not is_summary order by id
  `);
  const pinByAccount = new Map<string, string>();
  for (const pin of pins.rows) if (!pinByAccount.has(pin.account_id)) pinByAccount.set(pin.account_id, pin.group_id);
  const catchAlls = groups.filter((group) => group.is_catch_all);
  if (catchAlls.length > 1) {
    throw refusal({
      message: `The ${targetRow.dimension} account groups have more than one active catch-all.`,
      code: "grant_allowable_group_ambiguous",
      remedy: "Deactivate all but the authoritative catch-all account group, then retry the reimbursement.",
      status: 409,
    });
  }
  const catchAll = catchAlls[0];
  const ordinaryGroups = groups.filter((group) => !group.is_catch_all);
  const included = new Map<string, string>();
  for (const account of accountRows.rows) {
    const pinned = pinByAccount.get(account.id);
    if (pinned) {
      if (pinned === targetGroupId) included.set(account.id, account.type);
      continue;
    }
    let selected: GroupRow | undefined;
    for (const group of ordinaryGroups) {
      const rule = group.match ?? {};
      const accountTypes = Array.isArray(rule.accountTypes) ? rule.accountTypes : [];
      const prefixes = Array.isArray(rule.numberPrefixes) ? rule.numberPrefixes : [];
      if (accountTypes.length > 0 && !accountTypes.includes(account.type)) continue;
      if (prefixes.length > 0 && !prefixes.some((prefix) => account.number?.startsWith(prefix))) continue;
      if (rule.namePattern) {
        const problem = accountGroupNamePatternError(rule.namePattern);
        if (problem) {
          throw refusal({
            message: `Account group "${group.name}" has an unsafe matching rule: ${problem}.`,
            code: "grant_allowable_group_rule_invalid",
            remedy: "Correct the matching rule on the account group, then retry the drawdown.",
          });
        }
        if (!new RegExp(rule.namePattern, "i").test(account.name)) continue;
      }
      if (accountTypes.length === 0 && prefixes.length === 0 && !rule.namePattern) continue;
      selected = group;
      break;
    }
    selected ??= catchAll;
    if (selected?.id === targetGroupId) included.set(account.id, account.type);
  }
  return included;
}

async function grantExpenseTotal(runner: SqlExecutor, grant: GrantRow): Promise<Money> {
  const grouped = await resolveGroupMembers(runner, grant.org_id, grant.allowable_account_group_id);
  const accountIds = [...grouped].filter(([, type]) => EXPENSE_TYPES.has(type)).map(([id]) => id);
  if (accountIds.length === 0) return parseMoney("0");
  const defaultFund = await runner.execute<{ id: string | null }>(sql`
    select default_value_id as id from segment_definitions
     where org_id = ${grant.org_id} and key = 'fund' and source_kind = 'custom'
  `);
  const primaryBook = await runner.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${grant.org_id} and is_primary and is_active and posts_gl limit 1
  `);
  if (!primaryBook.rows[0]) {
    throw refusal({
      message: "The organization has no active primary posting book for grant-cost measurement.",
      code: "grant_primary_book_missing",
      remedy: "Configure an active primary posting book before measuring grant costs.",
      status: 409,
    });
  }
  const result = await runner.execute<{ total: string }>(sql`
    select coalesce(sum(jl.amount), 0)::text as total
      from journal_lines jl
      join journal_entries je on je.org_id = jl.org_id and je.id = jl.entry_id
      join accounts a on a.org_id = jl.org_id and a.id = jl.account_id
     where jl.org_id = ${grant.org_id} and je.book_id = ${primaryBook.rows[0].id}
       and je.status = 'posted' and a.type in ('cogs', 'expense', 'expense_other')
       and jl.account_id = any(${uuidArray(accountIds)}::uuid[])
       and coalesce(jl.extra_dims->>'fund', ${defaultFund.rows[0]?.id ?? null}) = ${grant.fund_id}
  `);
  return parseMoney(result.rows[0]?.total ?? "0");
}

async function drawdownTotals(runner: SqlExecutor, grant: GrantRow, exceptId?: string): Promise<{ all: Money; reimbursements: Money }> {
  const result = await runner.execute<{ total_drawn: string; reimbursements: string }>(sql`
    select coalesce(sum(d.amount), 0)::text as total_drawn,
           coalesce(sum(d.amount) filter (where d.kind in ('reimbursement', 'final')), 0)::text as reimbursements
      from grant_drawdowns d join grants g on g.org_id = d.org_id and g.id = d.grant_id
     where d.org_id = ${grant.org_id} and g.code = ${grant.code} and d.status <> 'void'
       and (${exceptId ?? null}::uuid is null or d.id <> ${exceptId ?? null}::uuid)
  `);
  return {
    all: parseMoney(result.rows[0]?.total_drawn ?? "0"),
    reimbursements: parseMoney(result.rows[0]?.reimbursements ?? "0"),
  };
}

async function requireDrawdownCapacity(
  runner: SqlExecutor,
  grant: GrantRow,
  amount: Money,
  kind: GrantDrawdownKind,
  exceptId?: string,
): Promise<void> {
  const totals = await drawdownTotals(runner, grant, exceptId);
  const remainingAward = addMoney(grant.award_amount, negMoney(totals.all));
  if (cmpMoney(amount, remainingAward) > 0) {
    throw refusal({
      message: `Drawdown ${amount} exceeds grant ${grant.code}'s remaining award balance of ${remainingAward}.`,
      code: "grant_drawdown_over_award",
      remedy: "Amend the award as a new version or reduce the drawdown amount.",
    });
  }
  if (kind === "advance") return;
  const directCosts = await grantExpenseTotal(runner, grant);
  const allowable = calculateAllowableSpend({
    directCosts,
    modifiedTotalDirect: directCosts,
    ratePercent: grant.indirect_rate,
    base: grant.indirect_base,
  });
  const remainingAllowable = addMoney(allowable, negMoney(totals.reimbursements));
  if (cmpMoney(amount, remainingAllowable) > 0) {
    const group = await runner.execute<{ name: string }>(sql`
      select name from account_groups where org_id = ${grant.org_id} and id = ${grant.allowable_account_group_id}
    `);
    const groupName = group.rows[0]?.name ?? "the grant's allowable-cost account group";
    throw refusal({
      message: `Reimbursement ${amount} exceeds allowable spend remaining of ${remainingAllowable} under "${groupName}".`,
      code: "grant_drawdown_over_allowable_spend",
      remedy: "Reduce the reimbursement or post qualifying grant-fund expenses to accounts in the allowable-cost group.",
    });
  }
}

function selectedReceivable(grant: GrantRow, accounts: GrantPostingAccounts): string {
  return grant.determination === "exchange" ? accounts.exchangeReceivableAccountId : accounts.grantsReceivableAccountId;
}

function selectedRevenue(grant: GrantRow, accounts: GrantPostingAccounts): string {
  return grant.determination === "exchange" ? accounts.exchangeRevenueAccountId : accounts.grantRevenueAccountId;
}

async function assertExchangeAccountsSeparate(grant: GrantRow, accounts: GrantPostingAccounts): Promise<void> {
  if (grant.determination === "exchange" &&
      (accounts.exchangeReceivableAccountId === accounts.grantsReceivableAccountId ||
       accounts.exchangeRevenueAccountId === accounts.grantRevenueAccountId)) {
    throw refusal({
      message: "An exchange award cannot use the contribution grant receivable or grant revenue account.",
      code: "grant_exchange_account_invalid",
      remedy: "Choose the ordinary receivable and revenue accounts for exchange transactions.",
    });
  }
}

async function validateAwardAccounts(runner: SqlExecutor, grant: GrantRow, accounts: GrantPostingAccounts): Promise<void> {
  await assertExchangeAccountsSeparate(grant, accounts);
  if (grant.determination === "exchange") {
    await validatePostingAccounts(runner, grant.org_id, [
      { id: accounts.exchangeReceivableAccountId, label: "Exchange receivable", types: ["asset_receivable"] },
      { id: accounts.exchangeRevenueAccountId, label: "Exchange revenue", types: ["income", "income_other"] },
    ]);
  } else {
    await validatePostingAccounts(runner, grant.org_id, [
      { id: accounts.grantsReceivableAccountId, label: "Grant receivable", types: ["asset_receivable"] },
      { id: accounts.grantRevenueAccountId, label: "Grant revenue", types: ["income", "income_other"] },
    ]);
  }
}

export async function createGrant(input: CreateGrantInput): Promise<GrantRecord> {
  return withGrantWrite(input.orgId, async (runner) => {
    const terms = validateGrantTerms(input);
    await validateGrantReferences(runner, input.orgId, terms);
    const inserted = await runner.execute<GrantRow>(sql`
      insert into grants
        (org_id, code, name, sponsor_party_id, sponsor_kind, determination, barrier, right_of_return,
         award_amount, period_from, period_to, indirect_rate, indirect_base, cost_share_required,
         cost_share_amount, fund_id, allowable_account_group_id, status, version, custom, created_by, updated_by)
      values
        (${input.orgId}, ${terms.code}, ${terms.name}, ${terms.sponsorPartyId}, ${input.sponsorKind},
         ${input.determination}, ${input.determination === "contribution_conditional" ? input.barrier!.trim() : null},
         ${input.determination === "contribution_conditional" ? true : input.rightOfReturn ?? false},
         ${terms.awardAmount}, ${terms.periodFrom}, ${terms.periodTo}, ${terms.indirectRate}, ${terms.indirectBase},
         ${input.costShareRequired ?? false}, ${terms.costShareAmount}, ${terms.fundId}, ${terms.allowableAccountGroupId},
         'draft', 1, ${JSON.stringify(input.custom ?? {})}::jsonb, ${input.actorId}, ${input.actorId})
      returning id, org_id, code, name, sponsor_party_id, sponsor_kind, determination, barrier,
                barrier_met_at::text as barrier_met_at, barrier_evidence, right_of_return,
                award_amount::text as award_amount, period_from::text as period_from, period_to::text as period_to,
                indirect_rate::text as indirect_rate, indirect_base, cost_share_required,
                cost_share_amount::text as cost_share_amount, fund_id, allowable_account_group_id, status,
                award_entry_id, version, supersedes_id, custom
    `);
    const row = inserted.rows[0];
    if (!row) {
      throw refusal({ message: `Grant ${terms.code} was not created.`, code: "grant_write_missing", remedy: "Retry grant creation after checking the grant records.", status: 409 });
    }
    await auditGrant(runner, { orgId: input.orgId, rowId: row.id, action: "create", actorId: input.actorId, changes: { event: "grant_created", after: mapGrant(row) } });
    return mapGrant(row);
  });
}

export async function awardGrant(input: {
  orgId: string;
  grantId: string;
  accounts: GrantPostingAccounts;
  postingDate: string;
  actorId: string;
}): Promise<{ grant: GrantRecord; entryId: string | null }> {
  return withGrantWrite(input.orgId, async (runner) => {
    const grant = await loadCurrentGrant(runner, input.orgId, input.grantId, true);
    requireLatestVersion(grant, input.grantId);
    if (grant.status !== "draft") {
      throw refusal({ message: `Grant ${grant.code} cannot be awarded from ${grant.status}.`, code: "grant_state_conflict", remedy: "Award the current draft version, or create a successor version for changed terms.", status: 409 });
    }
    let entryId: string | null = null;
    if (grant.determination !== "contribution_conditional") {
      await validateAwardAccounts(runner, grant, input.accounts);
      entryId = await postGrantEntry(runner, grant, {
        actorId: input.actorId,
        postingDate: input.postingDate,
        event: "award",
        idempotencyKey: `grant-award:${grant.id}:v${grant.version}`,
        lines: [
          { accountId: selectedReceivable(grant, input.accounts), amount: grant.award_amount, partyId: grant.sponsor_party_id, isOpenItem: true, dueDate: grant.period_to },
          { accountId: selectedRevenue(grant, input.accounts), amount: negMoney(grant.award_amount), partyId: grant.sponsor_party_id },
        ],
      });
    }
    const updated = await runner.execute<GrantRow>(sql`
      update grants set status = 'awarded', award_entry_id = ${entryId}, updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${grant.id} and status = 'draft'
       returning id, org_id, code, name, sponsor_party_id, sponsor_kind, determination, barrier,
                 barrier_met_at::text as barrier_met_at, barrier_evidence, right_of_return,
                 award_amount::text as award_amount, period_from::text as period_from, period_to::text as period_to,
                 indirect_rate::text as indirect_rate, indirect_base, cost_share_required,
                 cost_share_amount::text as cost_share_amount, fund_id, allowable_account_group_id, status,
                 award_entry_id, version, supersedes_id, custom
    `);
    const row = updated.rows[0];
    if (!row) throw refusal({ message: `Grant ${grant.code} was not advanced to awarded.`, code: "grant_award_write_missing", remedy: "Reload the grant and retry the award action.", status: 409 });
    await auditGrant(runner, { orgId: input.orgId, rowId: grant.id, action: "update", actorId: input.actorId, changes: { event: "grant_awarded", before: { status: grant.status }, after: { status: row.status, awardEntryId: row.award_entry_id } } });
    return { grant: mapGrant(row), entryId };
  });
}

export async function activateGrant(input: { orgId: string; grantId: string; actorId: string }): Promise<GrantRecord> {
  return withGrantWrite(input.orgId, async (runner) => {
    const grant = await loadCurrentGrant(runner, input.orgId, input.grantId, true);
    requireLatestVersion(grant, input.grantId);
    if (grant.status !== "awarded") throw refusal({ message: `Grant ${grant.code} cannot be activated from ${grant.status}.`, code: "grant_state_conflict", remedy: "Award the grant before activating it.", status: 409 });
    const updated = await runner.execute<GrantRow>(sql`
      update grants set status = 'active', updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${grant.id} and status = 'awarded'
       returning id, org_id, code, name, sponsor_party_id, sponsor_kind, determination, barrier,
                 barrier_met_at::text as barrier_met_at, barrier_evidence, right_of_return,
                 award_amount::text as award_amount, period_from::text as period_from, period_to::text as period_to,
                 indirect_rate::text as indirect_rate, indirect_base, cost_share_required,
                 cost_share_amount::text as cost_share_amount, fund_id, allowable_account_group_id, status,
                 award_entry_id, version, supersedes_id, custom
    `);
    const row = updated.rows[0];
    if (!row) throw refusal({ message: `Grant ${grant.code} was not activated.`, code: "grant_activation_write_missing", remedy: "Reload the grant and retry activation.", status: 409 });
    await auditGrant(runner, { orgId: input.orgId, rowId: grant.id, action: "update", actorId: input.actorId, changes: { event: "grant_activated", before: { status: grant.status }, after: { status: row.status } } });
    return mapGrant(row);
  });
}

export async function satisfyGrantBarrier(input: {
  orgId: string;
  grantId: string;
  evidence: string;
  actorId: string;
}): Promise<GrantRecord> {
  return withGrantWrite(input.orgId, async (runner) => {
    const grant = await loadCurrentGrant(runner, input.orgId, input.grantId, true);
    requireLatestVersion(grant, input.grantId);
    if (grant.determination !== "contribution_conditional" || !["awarded", "active"].includes(grant.status)) {
      throw refusal({ message: `Grant ${grant.code} has no satisfiable conditional barrier in its current state.`, code: "grant_barrier_state_conflict", remedy: "Record barrier evidence only for an awarded or active conditional grant.", status: 409 });
    }
    if (grant.barrier_met_at) throw refusal({ message: `Grant ${grant.code}'s barrier is already recorded as satisfied.`, code: "grant_barrier_already_met", remedy: "Review the existing satisfaction evidence; create a new grant version if the agreement changes.", status: 409 });
    const evidence = requireText(input.evidence, "evidence");
    const updated = await runner.execute<GrantRow>(sql`
      update grants set barrier_met_at = now(), barrier_evidence = ${evidence}, updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${grant.id} and barrier_met_at is null
       returning id, org_id, code, name, sponsor_party_id, sponsor_kind, determination, barrier,
                 barrier_met_at::text as barrier_met_at, barrier_evidence, right_of_return,
                 award_amount::text as award_amount, period_from::text as period_from, period_to::text as period_to,
                 indirect_rate::text as indirect_rate, indirect_base, cost_share_required,
                 cost_share_amount::text as cost_share_amount, fund_id, allowable_account_group_id, status,
                 award_entry_id, version, supersedes_id, custom
    `);
    const row = updated.rows[0];
    if (!row) throw refusal({ message: `Grant ${grant.code}'s barrier evidence was not recorded.`, code: "grant_barrier_write_missing", remedy: "Reload the grant and retry after confirming the barrier is still open.", status: 409 });
    await auditGrant(runner, { orgId: input.orgId, rowId: grant.id, action: "update", actorId: input.actorId, changes: { event: "grant_barrier_satisfied", before: { barrierMetAt: null }, after: { barrierMetAt: row.barrier_met_at, evidence: row.barrier_evidence } } });
    return mapGrant(row);
  });
}

export async function recordGrantDrawdown(input: {
  orgId: string;
  grantId: string;
  drawdownId?: string;
  amount: string;
  kind: GrantDrawdownKind;
  accounts: GrantPostingAccounts;
  postingDate: string;
  actorId: string;
}): Promise<{ id: string; status: "paid"; entryId: string }> {
  return withGrantWrite(input.orgId, async (runner) => {
    const grant = await loadCurrentGrant(runner, input.orgId, input.grantId, true);
    if (grant.status !== "active") throw refusal({ message: `Grant ${grant.code} does not accept drawdowns while ${grant.status}.`, code: "grant_drawdown_state_conflict", remedy: "Activate the grant before recording a drawdown.", status: 409 });
    if (!(input.kind === "advance" || input.kind === "reimbursement" || input.kind === "final")) {
      throw refusal({ message: "The drawdown kind is not supported.", code: "grant_drawdown_kind_invalid", remedy: "Choose advance, reimbursement, or final.", field: "kind" });
    }
    const amount = parseGrantMoney(input.amount, "amount", true);
    let drawdownId = input.drawdownId;
    let expectedStatus: "draft" | "submitted" = "draft";
    if (drawdownId) {
      const existing = await runner.execute<{ id: string; amount: string; kind: GrantDrawdownKind; status: GrantDrawdownStatus; grant_id: string }>(sql`
        select id, amount::text as amount, kind, status, grant_id from grant_drawdowns
         where org_id = ${input.orgId} and id = ${drawdownId} for update
      `);
      const existingRow = existing.rows[0];
      if (!existingRow || existingRow.kind !== input.kind || existingRow.status !== "submitted" ||
          cmpMoney(existingRow.amount, amount) !== 0) {
        throw refusal({ message: `Drawdown ${drawdownId} is not a matching submitted request.`, code: "grant_drawdown_state_conflict", remedy: "Record payment against the matching submitted drawdown, or create a new drawdown.", status: 409 });
      }
      const originalGrant = await loadGrantById(runner, input.orgId, existingRow.grant_id);
      if (originalGrant.code !== grant.code) throw refusal({ message: `Drawdown ${drawdownId} belongs to another grant.`, code: "grant_drawdown_grant_mismatch", remedy: "Choose a submitted drawdown for the selected grant.", status: 409 });
      expectedStatus = "submitted";
      await requireDrawdownCapacity(runner, grant, amount, input.kind, drawdownId);
    } else {
      await requireDrawdownCapacity(runner, grant, amount, input.kind);
      const drawdown = await runner.execute<{ id: string }>(sql`
        insert into grant_drawdowns (org_id, grant_id, amount, kind, status, created_by, updated_by)
        values (${input.orgId}, ${grant.id}, ${amount}, ${input.kind}, 'draft', ${input.actorId}, ${input.actorId})
        returning id
      `);
      drawdownId = drawdown.rows[0]?.id;
      if (!drawdownId) throw refusal({ message: `The ${input.kind} drawdown was not created.`, code: "grant_drawdown_write_missing", remedy: "Retry the drawdown after checking the grant records.", status: 409 });
    }

    const conditional = grant.determination === "contribution_conditional";
    if (conditional) {
      await validatePostingAccounts(runner, input.orgId, [
        { id: input.accounts.bankAccountId, label: "Bank", types: ["asset_bank"] },
        { id: input.accounts.refundableAdvanceAccountId, label: "Refundable advance", types: ["liability_current_other", "liability_long_term", "liability_payable"] },
      ]);
    } else {
      await validatePostingAccounts(runner, input.orgId, [
        { id: input.accounts.bankAccountId, label: "Bank", types: ["asset_bank"] },
        { id: selectedReceivable(grant, input.accounts), label: "Grant receivable", types: ["asset_receivable"] },
      ]);
      await assertExchangeAccountsSeparate(grant, input.accounts);
    }
    const liabilityOrReceivable = conditional ? input.accounts.refundableAdvanceAccountId : selectedReceivable(grant, input.accounts);
    const entryId = await postGrantEntry(runner, grant, {
      actorId: input.actorId,
      postingDate: input.postingDate,
      event: `${input.kind} drawdown`,
      idempotencyKey: `grant-drawdown:${drawdownId}`,
      lines: [
        { accountId: input.accounts.bankAccountId, amount: amount },
        { accountId: liabilityOrReceivable, amount: negMoney(amount), partyId: grant.sponsor_party_id, isOpenItem: !conditional },
      ],
    });
    const updated = await runner.execute<{ id: string }>(sql`
      update grant_drawdowns
         set status = 'paid', receivable_entry_id = ${entryId}, updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${drawdownId} and status = ${expectedStatus}
       returning id
    `);
    if (updated.rows.length !== 1) throw refusal({ message: `Drawdown ${drawdownId} was posted but not marked paid.`, code: "grant_drawdown_status_write_missing", remedy: "Reload the grant activity and reconcile the drawdown with its journal entry.", status: 409 });
    await auditGrant(runner, { orgId: input.orgId, rowId: grant.id, action: "update", actorId: input.actorId, changes: { event: "grant_drawdown_paid", drawdownId, kind: input.kind, amount, entryId } });
    return { id: drawdownId, status: "paid", entryId };
  });
}

export async function createGrantDrawdown(input: {
  orgId: string;
  grantId: string;
  amount: string;
  kind: GrantDrawdownKind;
  actorId: string;
}): Promise<{ id: string; grantId: string; amount: string; kind: GrantDrawdownKind; status: "draft" }> {
  return withGrantWrite(input.orgId, async (runner) => {
    const grant = await loadCurrentGrant(runner, input.orgId, input.grantId, true);
    if (grant.status !== "active") throw refusal({ message: `Grant ${grant.code} does not accept drawdowns while ${grant.status}.`, code: "grant_drawdown_state_conflict", remedy: "Activate the grant before recording a drawdown.", status: 409 });
    if (!(input.kind === "advance" || input.kind === "reimbursement" || input.kind === "final")) throw refusal({ message: "The drawdown kind is not supported.", code: "grant_drawdown_kind_invalid", remedy: "Choose advance, reimbursement, or final.", field: "kind" });
    const amount = parseGrantMoney(input.amount, "amount", true);
    await requireDrawdownCapacity(runner, grant, amount, input.kind);
    const inserted = await runner.execute<{ id: string }>(sql`
      insert into grant_drawdowns (org_id, grant_id, amount, kind, status, created_by, updated_by)
      values (${input.orgId}, ${grant.id}, ${amount}, ${input.kind}, 'draft', ${input.actorId}, ${input.actorId}) returning id
    `);
    const id = inserted.rows[0]?.id;
    if (!id) throw refusal({ message: `The ${input.kind} drawdown was not created.`, code: "grant_drawdown_write_missing", remedy: "Retry the drawdown after checking the grant records.", status: 409 });
    await auditGrant(runner, { orgId: input.orgId, rowId: grant.id, action: "update", actorId: input.actorId, changes: { event: "grant_drawdown_created", drawdownId: id, kind: input.kind, amount } });
    return { id, grantId: grant.id, amount, kind: input.kind, status: "draft" };
  });
}

export async function submitGrantDrawdown(input: { orgId: string; drawdownId: string; actorId: string }): Promise<{ id: string; status: "submitted" }> {
  return withGrantWrite(input.orgId, async (runner) => {
    const found = await runner.execute<{ grant_id: string }>(sql`
      select grant_id from grant_drawdowns where org_id = ${input.orgId} and id = ${input.drawdownId}
    `);
    const drawdownGrantId = found.rows[0]?.grant_id;
    if (!drawdownGrantId) throw refusal({ message: "The drawdown is not in this organization.", code: "grant_drawdown_not_found", remedy: "Choose a drawdown from this organization's grant activity.", status: 409 });
    const grant = await loadCurrentGrant(runner, input.orgId, drawdownGrantId, true);
    if (grant.status !== "active") throw refusal({ message: `Grant ${grant.code} does not accept drawdowns while ${grant.status}.`, code: "grant_drawdown_state_conflict", remedy: "Activate the grant before submitting a drawdown.", status: 409 });
    const row = await runner.execute<{ id: string; amount: string; kind: GrantDrawdownKind; status: GrantDrawdownStatus }>(sql`
      select id, amount::text as amount, kind, status from grant_drawdowns
       where org_id = ${input.orgId} and id = ${input.drawdownId} for update
    `);
    const drawdown = row.rows[0];
    if (!drawdown || drawdown.status !== "draft") throw refusal({ message: `Drawdown ${input.drawdownId} cannot be submitted from ${drawdown?.status ?? "missing"}.`, code: "grant_drawdown_state_conflict", remedy: "Submit a draft drawdown exactly once.", status: 409 });
    await requireDrawdownCapacity(runner, grant, parseMoney(drawdown.amount), drawdown.kind, drawdown.id);
    const updated = await runner.execute<{ id: string }>(sql`
      update grant_drawdowns set status = 'submitted', updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${drawdown.id} and status = 'draft' returning id
    `);
    if (updated.rows.length !== 1) throw refusal({ message: `Drawdown ${drawdown.id} was not submitted.`, code: "grant_drawdown_submit_write_missing", remedy: "Reload grant activity and retry the submission.", status: 409 });
    await auditGrant(runner, { orgId: input.orgId, rowId: grant.id, action: "update", actorId: input.actorId, changes: { event: "grant_drawdown_submitted", drawdownId: drawdown.id, kind: drawdown.kind, amount: drawdown.amount } });
    return { id: drawdown.id, status: "submitted" };
  });
}

export async function recognizeGrantDrawdown(input: {
  orgId: string;
  drawdownId: string;
  grantRevenueAccountId: string;
  refundableAdvanceAccountId: string;
  postingDate: string;
  actorId: string;
}): Promise<{ id: string; status: "recognized"; entryId: string }> {
  return withGrantWrite(input.orgId, async (runner) => {
    const result = await runner.execute<{
      id: string; grant_id: string; grant_code: string; status: GrantDrawdownStatus; kind: GrantDrawdownKind;
      amount: string; org_id: string; sponsor_party_id: string; determination: GrantDetermination;
      barrier: string | null; barrier_met_at: string | null; fund_id: string; version: number;
    }>(sql`
      select d.id, d.grant_id, g.code as grant_code, d.status, d.kind, d.amount::text as amount,
             g.org_id, g.sponsor_party_id, g.determination, g.barrier, g.barrier_met_at::text as barrier_met_at,
             g.fund_id, g.version
        from grant_drawdowns d join grants g on g.org_id = d.org_id and g.id = d.grant_id
       where d.org_id = ${input.orgId} and d.id = ${input.drawdownId} for update of d, g
    `);
    const row = result.rows[0];
    if (!row) throw refusal({ message: "The drawdown is not in this organization.", code: "grant_drawdown_not_found", remedy: "Choose a drawdown from this organization's grant activity.", status: 409 });
    if (row.determination !== "contribution_conditional") {
      throw refusal({ message: `Drawdown ${row.id} is not on a conditional grant.`, code: "grant_recognition_kind_invalid", remedy: "Recognize only a paid drawdown on a conditional grant after its barrier is met.", status: 409 });
    }
    if (!row.barrier_met_at) {
      const grant = await loadGrantById(runner, input.orgId, row.grant_id);
      throw refusal({ message: `Grant ${row.grant_code} cannot recognize revenue while barrier stands: ${grant.barrier}.`, code: "grant_barrier_unmet", remedy: "Record barrier satisfaction and its evidence on the grant, then recognize the advance." });
    }
    if (row.status !== "paid") throw refusal({ message: `Drawdown ${row.id} cannot be recognized from ${row.status}.`, code: "grant_drawdown_state_conflict", remedy: "Recognize a paid conditional drawdown exactly once.", status: 409 });
    await validatePostingAccounts(runner, input.orgId, [
      { id: input.refundableAdvanceAccountId, label: "Refundable advance", types: ["liability_current_other", "liability_long_term", "liability_payable"] },
      { id: input.grantRevenueAccountId, label: "Grant revenue", types: ["income", "income_other"] },
    ]);
    const grant = await loadGrantById(runner, input.orgId, row.grant_id);
    const entryId = await postGrantEntry(runner, grant, {
      actorId: input.actorId,
      postingDate: input.postingDate,
      event: "barrier recognition",
      idempotencyKey: `grant-recognition:${row.id}`,
      lines: [
        { accountId: input.refundableAdvanceAccountId, amount: row.amount, partyId: row.sponsor_party_id },
        { accountId: input.grantRevenueAccountId, amount: negMoney(row.amount), partyId: row.sponsor_party_id },
      ],
    });
    const updated = await runner.execute<{ id: string }>(sql`
      update grant_drawdowns set status = 'recognized', revenue_entry_id = ${entryId}, updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${row.id} and status = 'paid' returning id
    `);
    if (updated.rows.length !== 1) throw refusal({ message: `Drawdown ${row.id} was posted but not marked recognized.`, code: "grant_recognition_write_missing", remedy: "Reload grant activity and reconcile the drawdown with its journal entry.", status: 409 });
    await auditGrant(runner, { orgId: input.orgId, rowId: row.grant_id, action: "update", actorId: input.actorId, changes: { event: "grant_advance_recognized", drawdownId: row.id, amount: row.amount, entryId } });
    return { id: row.id, status: "recognized", entryId };
  });
}

export async function amendGrant(input: {
  orgId: string;
  grantId: string;
  reason: string;
  changes: Partial<Pick<CreateGrantInput,
    "name" | "sponsorPartyId" | "sponsorKind" | "determination" | "barrier" | "rightOfReturn" |
    "awardAmount" | "periodFrom" | "periodTo" | "indirectRate" | "indirectBase" |
    "costShareRequired" | "costShareAmount" | "fundId" | "allowableAccountGroupId">>;
  accounts: GrantPostingAccounts;
  postingDate: string;
  actorId: string;
}): Promise<GrantRecord> {
  return withGrantWrite(input.orgId, async (runner) => {
    const previous = await loadCurrentGrant(runner, input.orgId, input.grantId, true);
    requireLatestVersion(previous, input.grantId);
    if (["closed_out", "closed", "void"].includes(previous.status)) {
      throw refusal({ message: `Grant ${previous.code} cannot be amended while ${previous.status}.`, code: "grant_amendment_state_conflict", remedy: "Create a new grant for a separate award, or reopen the award through the approved finance process.", status: 409 });
    }
    const reason = requireText(input.reason, "reason");
    if (reason.length < 5 || reason.length > 500) throw refusal({ message: "The amendment reason must contain 5 to 500 characters.", code: "grant_amendment_reason_invalid", remedy: "Record the business reason for the amendment in 5 to 500 characters.", field: "reason" });
    const change = input.changes;
    const next = {
      name: change.name === undefined ? previous.name : requireText(change.name, "name"),
      sponsorPartyId: change.sponsorPartyId === undefined ? previous.sponsor_party_id : requireUuid(change.sponsorPartyId, "sponsorPartyId"),
      sponsorKind: change.sponsorKind ?? previous.sponsor_kind,
      determination: change.determination ?? previous.determination,
      barrier: change.barrier === undefined ? previous.barrier : change.barrier?.trim() || null,
      rightOfReturn: change.rightOfReturn ?? previous.right_of_return,
      awardAmount: change.awardAmount === undefined ? parseMoney(previous.award_amount) : parseGrantMoney(change.awardAmount, "awardAmount", true),
      periodFrom: change.periodFrom === undefined ? previous.period_from : requireDate(change.periodFrom, "periodFrom"),
      periodTo: change.periodTo === undefined ? previous.period_to : requireDate(change.periodTo, "periodTo"),
      indirectRate: change.indirectRate === undefined ? previous.indirect_rate : parseGrantRate(change.indirectRate),
      indirectBase: change.indirectBase ?? previous.indirect_base,
      costShareRequired: change.costShareRequired ?? previous.cost_share_required,
      costShareAmount: change.costShareAmount === undefined ? parseMoney(previous.cost_share_amount) : parseGrantMoney(change.costShareAmount, "costShareAmount"),
      fundId: change.fundId === undefined ? previous.fund_id : requireUuid(change.fundId, "fundId"),
      allowableAccountGroupId: change.allowableAccountGroupId === undefined ? previous.allowable_account_group_id : requireUuid(change.allowableAccountGroupId, "allowableAccountGroupId"),
    };
    if (!SPONSOR_KINDS.includes(next.sponsorKind) || !DETERMINATIONS.includes(next.determination) || !INDIRECT_BASES.includes(next.indirectBase)) {
      throw refusal({ message: "The amendment contains an unsupported grant option.", code: "grant_amendment_value_invalid", remedy: "Choose supported sponsor, determination, and indirect-cost values." });
    }
    if (next.periodTo < next.periodFrom || (next.determination === "contribution_conditional" && (!next.barrier || !next.rightOfReturn))) {
      throw refusal({ message: "The amended grant terms do not form a valid award.", code: "grant_amendment_terms_invalid", remedy: "Correct the period and conditional-award terms before saving the amendment." });
    }
    if (!next.costShareRequired && cmpMoney(next.costShareAmount, "0.0000") !== 0) {
      throw refusal({ message: "The amendment has a cost-share amount without a cost-share requirement.", code: "grant_cost_share_invalid", remedy: "Mark cost sharing as required or set its amount to zero.", field: "costShareAmount" });
    }
    const currentDrawdowns = await drawdownTotals(runner, previous);
    if (cmpMoney(next.awardAmount, currentDrawdowns.all) < 0) {
      const minimum = currentDrawdowns.all;
      throw refusal({ message: `The amended award amount ${next.awardAmount} is below its existing drawdowns of ${minimum}.`, code: "grant_amendment_below_drawdowns", remedy: "Set the amended award to at least the amount already drawn, or reverse excess drawdowns first." });
    }
    const structuralChanged = next.sponsorPartyId !== previous.sponsor_party_id || next.sponsorKind !== previous.sponsor_kind ||
      next.determination !== previous.determination || next.barrier !== previous.barrier || next.rightOfReturn !== previous.right_of_return || next.fundId !== previous.fund_id;
    if (previous.status !== "draft" && structuralChanged) {
      throw refusal({ message: `The active terms for grant ${previous.code} cannot change its sponsor, determination, barrier, or fund.`, code: "grant_amendment_structural_conflict", remedy: "Create a separate grant for different legal terms, then reverse the original award through the grant activity.", status: 409 });
    }
    await validateGrantReferences(runner, input.orgId, { sponsorPartyId: next.sponsorPartyId, fundId: next.fundId, allowableAccountGroupId: next.allowableAccountGroupId });
    const inserted = await runner.execute<GrantRow>(sql`
      insert into grants
        (org_id, code, name, sponsor_party_id, sponsor_kind, determination, barrier, barrier_met_at,
         barrier_evidence, right_of_return, award_amount, period_from, period_to, indirect_rate, indirect_base,
         cost_share_required, cost_share_amount, fund_id, allowable_account_group_id, status, award_entry_id,
         version, supersedes_id, custom, created_by, updated_by)
      values
        (${input.orgId}, ${previous.code}, ${next.name}, ${next.sponsorPartyId}, ${next.sponsorKind},
         ${next.determination}, ${next.barrier}, ${previous.barrier_met_at}, ${previous.barrier_evidence},
         ${next.rightOfReturn}, ${next.awardAmount}, ${next.periodFrom}, ${next.periodTo}, ${next.indirectRate},
         ${next.indirectBase}, ${next.costShareRequired}, ${next.costShareAmount}, ${next.fundId},
         ${next.allowableAccountGroupId}, ${previous.status}, null, ${previous.version + 1}, ${previous.id},
         ${JSON.stringify(previous.custom ?? {})}::jsonb, ${input.actorId}, ${input.actorId})
      returning id, org_id, code, name, sponsor_party_id, sponsor_kind, determination, barrier,
                barrier_met_at::text as barrier_met_at, barrier_evidence, right_of_return,
                award_amount::text as award_amount, period_from::text as period_from, period_to::text as period_to,
                indirect_rate::text as indirect_rate, indirect_base, cost_share_required,
                cost_share_amount::text as cost_share_amount, fund_id, allowable_account_group_id, status,
                award_entry_id, version, supersedes_id, custom
    `);
    const created = inserted.rows[0];
    if (!created) throw refusal({ message: `A new version of grant ${previous.code} was not created.`, code: "grant_amendment_write_missing", remedy: "Retry the amendment after checking the grant version history.", status: 409 });
    let adjustmentEntryId: string | null = null;
    const delta = addMoney(next.awardAmount, negMoney(previous.award_amount));
    if (previous.status !== "draft" && previous.determination !== "contribution_conditional" && toUnits(delta) !== 0n) {
      await validateAwardAccounts(runner, previous, input.accounts);
      adjustmentEntryId = await postGrantEntry(runner, created, {
        actorId: input.actorId,
        postingDate: input.postingDate,
        event: "award amendment",
        idempotencyKey: `grant-amendment:${created.id}`,
        lines: [
          { accountId: selectedReceivable(previous, input.accounts), amount: delta, partyId: previous.sponsor_party_id, isOpenItem: true, dueDate: previous.period_to },
          { accountId: selectedRevenue(previous, input.accounts), amount: negMoney(delta), partyId: previous.sponsor_party_id },
        ],
      });
      const stamped = await runner.execute<{ id: string }>(sql`
        update grants set award_entry_id = ${adjustmentEntryId}, updated_at = now(), updated_by = ${input.actorId}
         where org_id = ${input.orgId} and id = ${created.id} returning id
      `);
      if (stamped.rows.length !== 1) throw refusal({ message: `The award adjustment for grant ${previous.code} was not linked to its version.`, code: "grant_amendment_entry_write_missing", remedy: "Reconcile the new grant version with its journal entry.", status: 409 });
      created.award_entry_id = adjustmentEntryId;
    }
    await auditGrant(runner, {
      orgId: input.orgId,
      rowId: created.id,
      action: "amend",
      actorId: input.actorId,
      changes: { event: "grant_amended", reason, before: mapGrant(previous), after: mapGrant(created), adjustmentEntryId },
    });
    return mapGrant(created);
  });
}

async function reverseGrantEntry(
  runner: SqlExecutor,
  orgId: string,
  entryId: string,
  actorId: string,
  postingDate: string,
  reason: string,
): Promise<string | null> {
  const head = await runner.execute<{
    id: string; book_id: string; subsidiary_id: string; entry_number: string; origin: string; status: string;
  }>(sql`
    select id, book_id, subsidiary_id, entry_number, origin, status
      from journal_entries where org_id = ${orgId} and id = ${entryId} for update
  `);
  const entry = head.rows[0];
  if (!entry || entry.status === "reversed") return null;
  if (entry.status !== "posted") throw refusal({ message: `Grant journal entry ${entry.entry_number} is ${entry.status} and cannot be reversed.`, code: "grant_entry_state_conflict", remedy: "Reverse only a posted grant journal entry.", status: 409 });
  const lines = await runner.execute<ReversalSourceJournalLine>(sql`
    select line_number as "lineNumber", account_id as "accountId", subsidiary_id as "subsidiaryId",
           amount, currency, txn_amount as "txnAmount", fx_rate as "fxRate", party_id as "partyId",
           department_id as "departmentId", project_id as "projectId", location_id as "locationId",
           class_id as "classId", equipment_unit_id as "equipmentUnitId", extra_dims as "extraDims",
           payment_card_id as "paymentCardId", tax_code_id as "taxCodeId", memo, quantity, unit, custom,
           contributor_kind as "contributorKind", contributor_ref as "contributorRef"
      from journal_lines where org_id = ${orgId} and entry_id = ${entryId} order by line_number
  `);
  if (lines.rows.length === 0) throw refusal({ message: `Grant journal entry ${entry.entry_number} has no lines to reverse.`, code: "grant_entry_lines_missing", remedy: "Review the journal entry before voiding its grant.", status: 409 });
  const period = await resolveCoveringPeriod(runner, orgId, requireDate(postingDate, "postingDate"));
  if (!period) throw refusal({ message: `No accounting period covers ${postingDate}.`, code: "grant_reversal_period_missing", remedy: "Choose a reversal date in an open accounting period." });
  const reversalNumber = await db.transaction((tx) => nextFreeEntryNumber(tx, orgId, `${entry.entry_number}-R`));
  try {
    const posted = await postEntry(runner, {
      orgId,
      bookId: entry.book_id,
      subsidiaryId: entry.subsidiary_id,
      entryNumber: reversalNumber,
      postingDate,
      periodId: period.id,
      memo: `Grant reversal: ${reason}`,
      origin: entry.origin,
      reversesEntryId: entry.id,
      actorId,
      idempotencyKey: `grant-reversal:${entry.id}`,
      auditAction: "update",
      auditChanges: { event: "grant_entry_reversed", reversedEntryId: entry.id, reason, reversalDate: postingDate },
      lines: reversalJournalLines(lines.rows, { entryId: "", orgId }).map((line) => ({
        accountId: line.accountId!,
        subsidiaryId: line.subsidiaryId,
        amount: line.amount!,
        currency: line.currency,
        txnAmount: line.txnAmount,
        fxRate: line.fxRate,
        memo: line.memo,
        partyId: line.partyId,
        departmentId: line.departmentId,
        projectId: line.projectId,
        locationId: line.locationId,
        classId: line.classId,
        equipmentUnitId: line.equipmentUnitId,
        extraDims: line.extraDims as Record<string, unknown> | null,
        paymentCardId: line.paymentCardId,
        taxCodeId: line.taxCodeId,
        quantity: line.quantity,
        unit: line.unit,
        dueDate: null,
        isOpenItem: false,
        custom: line.custom as Record<string, unknown> | undefined,
        contributorKind: line.contributorKind,
        contributorRef: line.contributorRef,
        lineNumber: line.lineNumber,
      })),
    });
    await markEntryReversed(runner, { orgId, entryId: entry.id, actorId });
    return posted.entryId;
  } catch (error) {
    return postFailure(error, entry.entry_number);
  }
}

export async function voidGrant(input: {
  orgId: string;
  grantId: string;
  postingDate: string;
  reason: string;
  actorId: string;
}): Promise<GrantRecord> {
  return withGrantWrite(input.orgId, async (runner) => {
    const grant = await loadCurrentGrant(runner, input.orgId, input.grantId, true);
    requireLatestVersion(grant, input.grantId);
    if (grant.status === "closed") throw refusal({ message: `Closed grant ${grant.code} cannot be voided.`, code: "grant_state_conflict", remedy: "Use a controlled adjusting entry after close rather than changing the closed award.", status: 409 });
    const reason = requireText(input.reason, "reason");
    if (reason.length < 5 || reason.length > 500) throw refusal({ message: "The void reason must contain 5 to 500 characters.", code: "grant_void_reason_invalid", remedy: "Record the business reason for the void in 5 to 500 characters.", field: "reason" });
    const versions = await runner.execute<{ id: string }>(sql`select id from grants where org_id = ${input.orgId} and code = ${grant.code} order by version for update`);
    const versionIds = versions.rows.map((row) => row.id);
    const entries = await runner.execute<{ id: string }>(sql`
      select posted.entry_id as id
        from (
        select award_entry_id as entry_id from grants where org_id = ${input.orgId} and code = ${grant.code}
        union all
        select d.receivable_entry_id from grant_drawdowns d join grants g on g.org_id = d.org_id and g.id = d.grant_id
         where d.org_id = ${input.orgId} and g.code = ${grant.code}
        union all
        select d.revenue_entry_id from grant_drawdowns d join grants g on g.org_id = d.org_id and g.id = d.grant_id
         where d.org_id = ${input.orgId} and g.code = ${grant.code}
        ) posted
        join journal_entries je on je.org_id = ${input.orgId} and je.id = posted.entry_id
       where posted.entry_id is not null
       group by posted.entry_id, je.posting_date, je.created_at
       order by je.posting_date desc, je.created_at desc, posted.entry_id desc
    `);
    for (const row of entries.rows) await reverseGrantEntry(runner, input.orgId, row.id, input.actorId, input.postingDate, reason);
    const drawdownUpdates = await runner.execute<{ id: string }>(sql`
      update grant_drawdowns d set status = 'void', updated_at = now(), updated_by = ${input.actorId}
       where d.org_id = ${input.orgId} and d.status <> 'void'
         and exists (select 1 from grants g where g.org_id = d.org_id and g.id = d.grant_id and g.code = ${grant.code})
       returning d.id
    `);
    const grantsUpdated = await runner.execute<{ id: string }>(sql`
      update grants set status = 'void', updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and code = ${grant.code} and status <> 'void' returning id
    `);
    if (grantsUpdated.rows.length !== versionIds.length) throw refusal({ message: `Grant ${grant.code} version history was not fully voided.`, code: "grant_void_write_missing", remedy: "Reload grant activity and reconcile every version before retrying.", status: 409 });
    await auditGrant(runner, { orgId: input.orgId, rowId: grant.id, action: "void", actorId: input.actorId, changes: { event: "grant_voided", reason, reversedEntries: entries.rows.map((row) => row.id), voidedDrawdowns: drawdownUpdates.rows.length } });
    return mapGrant({ ...grant, status: "void" });
  });
}

export async function voidGrantDrawdown(input: {
  orgId: string;
  drawdownId: string;
  postingDate: string;
  reason: string;
  actorId: string;
}): Promise<void> {
  await withGrantWrite(input.orgId, async (runner) => {
    const result = await runner.execute<{ id: string; grant_id: string; grant_code: string; status: GrantDrawdownStatus; receivable_entry_id: string | null; revenue_entry_id: string | null }>(sql`
      select d.id, d.grant_id, g.code as grant_code, d.status, d.receivable_entry_id, d.revenue_entry_id
        from grant_drawdowns d join grants g on g.org_id = d.org_id and g.id = d.grant_id
       where d.org_id = ${input.orgId} and d.id = ${input.drawdownId} for update of d, g
    `);
    const row = result.rows[0];
    if (!row) throw refusal({ message: "The drawdown is not in this organization.", code: "grant_drawdown_not_found", remedy: "Choose a drawdown from this organization's grant activity.", status: 409 });
    if (row.status === "void") throw refusal({ message: `Drawdown ${row.id} is already void.`, code: "grant_drawdown_state_conflict", remedy: "Review the existing void activity instead of voiding the drawdown again.", status: 409 });
    const reason = requireText(input.reason, "reason");
    if (reason.length < 5 || reason.length > 500) throw refusal({ message: "The void reason must contain 5 to 500 characters.", code: "grant_void_reason_invalid", remedy: "Record the business reason for the void in 5 to 500 characters.", field: "reason" });
    const entries = [...new Set([row.revenue_entry_id, row.receivable_entry_id].filter((id): id is string => !!id))];
    for (const entryId of entries) await reverseGrantEntry(runner, input.orgId, entryId, input.actorId, input.postingDate, reason);
    const updated = await runner.execute<{ id: string }>(sql`
      update grant_drawdowns set status = 'void', updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${row.id} and status <> 'void' returning id
    `);
    if (updated.rows.length !== 1) throw refusal({ message: `Drawdown ${row.id} was not marked void.`, code: "grant_drawdown_void_write_missing", remedy: "Reload grant activity and reconcile the drawdown with its reversal entries.", status: 409 });
    await auditGrant(runner, { orgId: input.orgId, rowId: row.grant_id, action: "update", actorId: input.actorId, changes: { event: "grant_drawdown_voided", drawdownId: row.id, reason, reversedEntries: entries } });
  });
}

async function transitionGrant(input: { orgId: string; grantId: string; actorId: string; from: GrantStatus; to: GrantStatus }): Promise<GrantRecord> {
  return withGrantWrite(input.orgId, async (runner) => {
    const grant = await loadCurrentGrant(runner, input.orgId, input.grantId, true);
    requireLatestVersion(grant, input.grantId);
    if (grant.status !== input.from) throw refusal({ message: `Grant ${grant.code} cannot move from ${grant.status} to ${input.to}.`, code: "grant_state_conflict", remedy: `Move the grant through its required lifecycle state before ${input.to.replaceAll("_", " ")}.`, status: 409 });
    if (input.to === "closed_out") {
      const outstanding = await runner.execute<{ count: number }>(sql`
        select count(*)::int as count from grant_drawdowns d
          join grants g on g.org_id = d.org_id and g.id = d.grant_id
         where d.org_id = ${input.orgId} and g.code = ${grant.code}
           and g.determination = 'contribution_conditional' and d.status = 'paid'
      `);
      if ((outstanding.rows[0]?.count ?? 0) > 0) throw refusal({ message: `Grant ${grant.code} has a conditional advance that has not been recognized or reversed.`, code: "grant_closeout_unrecognized_advance", remedy: "Recognize each paid advance after its barrier is met, or reverse the advance before closing out the grant.", status: 409 });
    }
    const updated = await runner.execute<GrantRow>(sql`
      update grants set status = ${input.to}, updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${grant.id} and status = ${input.from}
       returning id, org_id, code, name, sponsor_party_id, sponsor_kind, determination, barrier,
                 barrier_met_at::text as barrier_met_at, barrier_evidence, right_of_return,
                 award_amount::text as award_amount, period_from::text as period_from, period_to::text as period_to,
                 indirect_rate::text as indirect_rate, indirect_base, cost_share_required,
                 cost_share_amount::text as cost_share_amount, fund_id, allowable_account_group_id, status,
                 award_entry_id, version, supersedes_id, custom
    `);
    const row = updated.rows[0];
    if (!row) throw refusal({ message: `Grant ${grant.code} was not moved to ${input.to}.`, code: "grant_status_write_missing", remedy: "Reload the grant and retry the lifecycle change.", status: 409 });
    await auditGrant(runner, { orgId: input.orgId, rowId: grant.id, action: "update", actorId: input.actorId, changes: { event: `grant_${input.to}`, before: { status: grant.status }, after: { status: row.status } } });
    return mapGrant(row);
  });
}

export function closeOutGrant(input: { orgId: string; grantId: string; actorId: string }): Promise<GrantRecord> {
  return transitionGrant({ ...input, from: "active", to: "closed_out" });
}

export function closeGrant(input: { orgId: string; grantId: string; actorId: string }): Promise<GrantRecord> {
  return transitionGrant({ ...input, from: "closed_out", to: "closed" });
}

export async function createGrantReport(input: GrantReportInput): Promise<{ id: string; grantId: string; title: string; dueOn: string }> {
  return withGrantWrite(input.orgId, async (runner) => {
    const grant = await loadCurrentGrant(runner, input.orgId, input.grantId, true);
    requireLatestVersion(grant, input.grantId);
    const title = requireText(input.title, "title");
    const dueOn = requireDate(input.dueOn, "dueOn");
    const inserted = await runner.execute<{ id: string }>(sql`
      insert into grant_reports (org_id, grant_id, title, due_on, created_by, updated_by)
      values (${input.orgId}, ${grant.id}, ${title}, ${dueOn}, ${input.actorId}, ${input.actorId}) returning id
    `);
    const id = inserted.rows[0]?.id;
    if (!id) throw refusal({ message: `The report deadline for grant ${grant.code} was not created.`, code: "grant_report_write_missing", remedy: "Retry the deadline after checking the grant records.", status: 409 });
    await auditGrant(runner, { orgId: input.orgId, rowId: grant.id, action: "update", actorId: input.actorId, changes: { event: "grant_report_created", reportId: id, title, dueOn } });
    return { id, grantId: grant.id, title, dueOn };
  });
}

export async function submitGrantReport(input: { orgId: string; reportId: string; actorId: string }): Promise<{ id: string; submittedAt: string }> {
  return withGrantWrite(input.orgId, async (runner) => {
    const report = await runner.execute<{ id: string; grant_id: string; submitted_at: string | null }>(sql`
      select id, grant_id, submitted_at::text as submitted_at from grant_reports
       where org_id = ${input.orgId} and id = ${input.reportId} for update
    `);
    const row = report.rows[0];
    if (!row) throw refusal({ message: "The grant report is not in this organization.", code: "grant_report_not_found", remedy: "Choose a report deadline from this organization's grant records.", status: 409 });
    if (row.submitted_at) throw refusal({ message: `Grant report ${row.id} has already been submitted.`, code: "grant_report_already_submitted", remedy: "Review the existing submission time instead of submitting it again.", status: 409 });
    const grant = await loadGrantById(runner, input.orgId, row.grant_id);
    const updated = await runner.execute<{ id: string; submitted_at: string }>(sql`
      update grant_reports set submitted_at = now(), submitted_by = ${input.actorId}, updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${row.id} and submitted_at is null
       returning id, submitted_at::text as submitted_at
    `);
    const saved = updated.rows[0];
    if (!saved) throw refusal({ message: `Grant report ${row.id} was not marked submitted.`, code: "grant_report_submit_write_missing", remedy: "Reload the report deadline and retry submission.", status: 409 });
    await auditGrant(runner, { orgId: input.orgId, rowId: grant.id, action: "update", actorId: input.actorId, changes: { event: "grant_report_submitted", reportId: row.id, submittedAt: saved.submitted_at, submittedBy: input.actorId } });
    return { id: saved.id, submittedAt: saved.submitted_at };
  });
}

export async function getGrantTerms(orgId: string, grantId: string): Promise<GrantRecord> {
  return withGrantRead(orgId, async (runner) => mapGrant(await loadCurrentGrant(runner, orgId, grantId)));
}

export async function getGrantBudget(orgId: string, grantId: string): Promise<{
  awardAmount: string;
  drawnAmount: string;
  remainingAward: string;
  allowableDirectCosts: string;
  indirectCost: string;
  allowableSpend: string;
  reimbursedAmount: string;
  remainingAllowableSpend: string;
}> {
  return withGrantRead(orgId, async (runner) => {
    const grant = await loadCurrentGrant(runner, orgId, grantId);
    const totals = await drawdownTotals(runner, grant);
    const direct = await grantExpenseTotal(runner, grant);
    const allowable = calculateAllowableSpend({ directCosts: direct, modifiedTotalDirect: direct, ratePercent: grant.indirect_rate, base: grant.indirect_base });
    const indirect = addMoney(allowable, negMoney(direct));
    return {
      awardAmount: grant.award_amount,
      drawnAmount: totals.all,
      remainingAward: addMoney(grant.award_amount, negMoney(totals.all)),
      allowableDirectCosts: direct,
      indirectCost: indirect,
      allowableSpend: allowable,
      reimbursedAmount: totals.reimbursements,
      remainingAllowableSpend: addMoney(allowable, negMoney(totals.reimbursements)),
    };
  });
}

export async function listGrantDrawdowns(orgId: string, grantId: string): Promise<{
  id: string; grantId: string; amount: string; kind: GrantDrawdownKind; status: GrantDrawdownStatus;
  receivableEntryId: string | null; revenueEntryId: string | null; version: number;
}[]> {
  return withGrantRead(orgId, async (runner) => {
    const grant = await loadCurrentGrant(runner, orgId, grantId);
    const rows = await runner.execute<{
      id: string; grant_id: string; amount: string; kind: GrantDrawdownKind; status: GrantDrawdownStatus;
      receivable_entry_id: string | null; revenue_entry_id: string | null; version: number;
    }>(sql`
      select d.id, d.grant_id, d.amount::text as amount, d.kind, d.status,
             d.receivable_entry_id, d.revenue_entry_id, g.version
        from grant_drawdowns d join grants g on g.org_id = d.org_id and g.id = d.grant_id
       where d.org_id = ${orgId} and g.code = ${grant.code}
       order by g.version, d.created_at, d.id
    `);
    return rows.rows.map((row) => ({
      id: row.id, grantId: row.grant_id, amount: row.amount, kind: row.kind, status: row.status,
      receivableEntryId: row.receivable_entry_id, revenueEntryId: row.revenue_entry_id, version: row.version,
    }));
  });
}

export async function listGrantReports(orgId: string, grantId: string, asOf: string): Promise<{
  id: string; grantId: string; title: string; dueOn: string; submittedAt: string | null;
  submittedBy: string | null; status: GrantReportStatus; version: number;
}[]> {
  requireDate(asOf, "asOf");
  return withGrantRead(orgId, async (runner) => {
    const grant = await loadCurrentGrant(runner, orgId, grantId);
    const result = await runner.execute<{
      id: string; grant_id: string; title: string; due_on: string; submitted_at: string | null;
      submitted_by: string | null; version: number;
    }>(sql`
      select r.id, r.grant_id, r.title, r.due_on::text as due_on, r.submitted_at::text as submitted_at,
             r.submitted_by, g.version
        from grant_reports r join grants g on g.org_id = r.org_id and g.id = r.grant_id
       where r.org_id = ${orgId} and g.code = ${grant.code}
       order by r.due_on, r.id
    `);
    return result.rows.map((row) => ({
      id: row.id, grantId: row.grant_id, title: row.title, dueOn: row.due_on,
      submittedAt: row.submitted_at, submittedBy: row.submitted_by,
      status: grantReportStatus({ dueOn: row.due_on, submittedAt: row.submitted_at }, asOf), version: row.version,
    }));
  });
}

export async function listGrantActivity(orgId: string, grantId: string): Promise<{
  journalEntries: { id: string; entryNumber: string; postingDate: string; status: string; memo: string | null; createdAt: string }[];
  changes: { id: string; rowId: string; action: string; actorId: string | null; at: string; changes: Record<string, unknown> }[];
}> {
  return withGrantRead(orgId, async (runner) => {
    const grant = await loadCurrentGrant(runner, orgId, grantId);
    const versions = await runner.execute<{ id: string }>(sql`select id from grants where org_id = ${orgId} and code = ${grant.code} order by version`);
    const ids = versions.rows.map((row) => row.id);
    const entries = await runner.execute<{
      id: string; entry_number: string; posting_date: string; status: string; memo: string | null; created_at: string;
    }>(sql`
      select distinct je.id, je.entry_number, je.posting_date::text as posting_date, je.status,
             je.memo, je.created_at::text as created_at
        from journal_entries je
       where je.org_id = ${orgId} and je.id = any(${uuidArray(ids)}::uuid[])
       union
      select distinct je.id, je.entry_number, je.posting_date::text as posting_date, je.status,
             je.memo, je.created_at::text as created_at
        from journal_entries je
        join grant_drawdowns d on d.org_id = je.org_id and je.id in (d.receivable_entry_id, d.revenue_entry_id)
       where je.org_id = ${orgId} and d.grant_id = any(${uuidArray(ids)}::uuid[])
       order by created_at, id
    `);
    const changes = await runner.execute<{
      id: string; row_id: string; action: string; actor_id: string | null; at: string; changes: Record<string, unknown>;
    }>(sql`
      select id, row_id, action, actor_id, at::text as at, changes
        from audit_log
       where org_id = ${orgId} and table_name = 'grants' and row_id = any(${uuidArray(ids)}::uuid[])
       order by at, id
    `);
    return {
      journalEntries: entries.rows.map((row) => ({ id: row.id, entryNumber: row.entry_number, postingDate: row.posting_date, status: row.status, memo: row.memo, createdAt: row.created_at })),
      changes: changes.rows.map((row) => ({ id: row.id, rowId: row.row_id, action: row.action, actorId: row.actor_id, at: row.at, changes: row.changes })),
    };
  });
}

export { grantReportStatus };
