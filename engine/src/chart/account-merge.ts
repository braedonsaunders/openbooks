import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  db,
  withOrgTransaction,
  withTransactionSavepoint,
  type SqlExecutor,
} from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { businessTodayInTx } from "../platform/business-date.ts";
import {
  ACCOUNT_MERGE_OPERATION,
  assertFinancialChangeApproved,
  completeFinancialChange,
  loadFinancialChange,
  proposeFinancialChange,
} from "../platform/financial-changes.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { loadSubsidiaryContext, restrictionAdmits } from "../organization/subsidiaries.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { assertPeriodModulesOpen, CloseError } from "../periods/period-policy.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { nextFreeEntryNumber } from "../records/entry-number.ts";
import {
  CONTROL_ACCOUNT_ROLE_LABELS,
  type ControlAccountRole,
} from "../records/control-accounts.ts";
import { postEntry } from "../journal/post-entry.ts";
import {
  countDraftAccountLines,
  repointDraftAccountLines,
} from "../journal/draft-account-lines.ts";
import { submitFinancialChange } from "../flows/financial-changes-adapter.ts";
import {
  buildReclassEntries,
  mergeConsequenceDigest,
  PROFIT_AND_LOSS_TYPES,
  transferRate,
  type BalanceGroup,
} from "./account-merge-legs.ts";
import {
  ACCOUNT_JSON_REFERENCES,
  ACCOUNT_REFERENCE_RULES,
  classifyAccountReference,
  discoverAccountReferenceColumns,
  type AccountReferenceRule,
} from "./account-references.ts";

/**
 * Account merge: fold a source account into a surviving (target) account.
 *
 * A merge is previewed first. The preview lists every refusal (type,
 * currency, legal-entity availability, hierarchy, open subledger items,
 * unreconciled bank lines, in-flight documents and runs, closed periods,
 * dimension requirements) and every consequence: the balances that move
 * per book, subsidiary, currency and dimension tuple; the configuration
 * references that move to the survivor; the history that stays; child
 * accounts that move under the survivor; and control-account roles. The
 * consequences are digested, and execution refuses unless the operator
 * confirms that exact digest.
 *
 * Execution runs in one transaction: configuration references move to the
 * survivor (audited before/after), draft journal lines and child accounts
 * follow, the source's balance moves to the survivor through one balanced
 * reclass journal per book and subsidiary dated the effective date (through
 * the posting kernel, so period locks and every posting guard apply), the
 * merge is recorded, and the source is marked merged — inactive, permanent,
 * refusing every new posting and reference with the survivor named. Posted
 * history is never rewritten: earlier lines keep the source account and
 * reports can present them under the survivor.
 *
 * Profit-and-loss accounts move only their fiscal-year-to-date balance
 * (earlier years are already closed into retained earnings); balance-sheet
 * accounts move their cumulative balance. Postings dated after the effective
 * date refuse the merge, so the source ends with a zero balance on every
 * book, entity, currency and dimension tuple.
 *
 * When an enabled Accounting event Flow exists, a merge is proposed and
 * submitted for approval instead, and applied after approval against an
 * unchanged preview. A retried request with the same key returns the same
 * merge.
 */

export class AccountMergeError extends Error {
  readonly name = "AccountMergeError";
  readonly status: number;
  readonly code: string;
  readonly remedy?: string;
  constructor(message: string, code: string, remedy?: string, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
    if (remedy) this.remedy = remedy;
  }
}

export interface AccountMergeRefusal {
  code: string;
  message: string;
  remedy: string;
}

export interface MergeAccountSummary {
  id: string;
  number: string | null;
  name: string;
  type: string;
  isActive: boolean;
  isSummary: boolean;
  currencyRestriction: string | null;
  subsidiaryId: string | null;
}

export interface MergeBalanceTransfer {
  bookId: string;
  bookName: string;
  subsidiaryId: string;
  subsidiaryName: string;
  currency: string;
  functionalCurrency: string;
  amount: string;
  txnAmount: string;
  fxRate: string | null;
  balanceFrom: string | null;
  dimensions: {
    departmentId: string | null;
    projectId: string | null;
    locationId: string | null;
    classId: string | null;
    partyId: string | null;
    equipmentUnitId: string | null;
    paymentCardId: string | null;
    extraDims: Record<string, string>;
  };
}

export interface MergeReferenceImpact {
  key: string;
  label: string;
  table: string;
  column: string;
  kind: "column" | "json";
  redirect: number;
  history: number;
  blocked: number;
}

export interface AccountMergePreview {
  source: MergeAccountSummary;
  target: MergeAccountSummary;
  effectiveDate: string;
  /** Common P&L fiscal-year start, or null when entity calendars differ or the account is balance-sheet. */
  balanceFrom: string | null;
  refusals: AccountMergeRefusal[];
  balances: MergeBalanceTransfer[];
  entries: {
    bookId: string;
    bookName: string;
    subsidiaryId: string;
    subsidiaryName: string;
    lines: number;
  }[];
  references: MergeReferenceImpact[];
  children: { id: string; number: string | null; name: string }[];
  draftJournalLines: number;
  controlRoles: { scope: string; role: string; label: string }[];
  pendingChangeId: string | null;
  alreadyMerged: { mergeId: string; targetAccountId: string } | null;
  digest: string;
}

export interface AccountMergeRequest {
  sourceAccountId: string;
  targetAccountId: string;
  effectiveDate: string;
}

export interface AccountMergeResult {
  status: "completed";
  mergeId: string;
  replayed: boolean;
  entryIds: string[];
  moved: Record<string, number>;
}

interface AccountRow extends Record<string, unknown> {
  id: string;
  number: string | null;
  name: string;
  type: string;
  is_summary: boolean;
  is_active: boolean;
  currency_restriction: string | null;
  eliminate: boolean;
  subsidiary_id: string | null;
  subsidiary_include_children: boolean;
  reconcilable: boolean;
  monetary: boolean | null;
  required_dimensions: string[] | null;
  parent_id: string | null;
  merged_into_id: string | null;
}

/** Subledger controls whose open items and party balances must stay on a distinct account. */
const SUBLEDGER_CONTROL_ROLES: ReadonlySet<string> = new Set([
  "ar",
  "ap",
  "employeePayable",
  "employeeReceivable",
  "retainagePayable",
  "retainageReceivable",
  "unbilledReceivable",
  "storedValueLiability",
]);

const BUILTIN_DIMENSION_FIELDS: Record<
  string,
  keyof MergeBalanceTransfer["dimensions"] | "subsidiaryId"
> = {
  subsidiary: "subsidiaryId",
  department: "departmentId",
  project: "projectId",
  location: "locationId",
  class: "classId",
  party: "partyId",
};

function summary(row: AccountRow): MergeAccountSummary {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    type: row.type,
    isActive: row.is_active,
    isSummary: row.is_summary,
    currencyRestriction: row.currency_restriction,
    subsidiaryId: row.subsidiary_id,
  };
}

function accountLabel(row: Pick<AccountRow, "number" | "name">): string {
  return row.number ? `${row.number} · ${row.name}` : row.name;
}

function cleanExtraDims(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, selected] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (typeof selected === "string" && selected !== "") out[key] = selected;
  }
  return out;
}

async function loadAccounts(
  tx: SqlExecutor,
  orgId: string,
  ids: string[],
  lock: boolean,
): Promise<Map<string, AccountRow>> {
  const rows = await tx.execute<AccountRow>(
    sql`
    select id, number, name, type, is_summary, is_active, currency_restriction, eliminate,
           subsidiary_id, subsidiary_include_children, reconcilable, monetary,
           required_dimensions, parent_id, merged_into_id
      from accounts
     where org_id = ${orgId} and id in ${ids}
     order by id
     ${lock ? sql`for update` : sql``}`,
    "objects",
  );
  return new Map(rows.map((row) => [row.id, row]));
}

interface MergePlan {
  preview: AccountMergePreview;
  source: AccountRow;
  target: AccountRow;
  periodIdsBySubsidiary: Map<string, string>;
  groups: (BalanceGroup & { fxRate: string })[];
  referenceColumns: { table: string; column: string; rule: AccountReferenceRule }[];
}

async function planAccountMerge(
  tx: SqlExecutor,
  orgId: string,
  request: AccountMergeRequest,
  options: { lock: boolean; allowedSubsidiaryIds: ReadonlySet<string> | null },
): Promise<MergePlan> {
  const refusals: AccountMergeRefusal[] = [];
  const refuse = (code: string, message: string, remedy: string) =>
    refusals.push({ code, message, remedy });
  if (options.allowedSubsidiaryIds !== null) {
    throw new AccountMergeError(
      "Merging accounts changes the shared chart of accounts and every legal entity's configuration.",
      "account_merge_scope",
      "Ask a user with access to every subsidiary to merge the accounts.",
      403,
    );
  }
  if (request.sourceAccountId === request.targetAccountId) {
    throw new AccountMergeError(
      "An account cannot be merged into itself.",
      "account_merge_same",
      "Choose a different surviving account.",
    );
  }
  if (!isIsoCalendarDate(request.effectiveDate)) {
    throw new AccountMergeError(
      "The merge effective date must be a calendar date (YYYY-MM-DD).",
      "account_merge_date",
      "Enter the date the balance moves on.",
    );
  }
  const accounts = await loadAccounts(
    tx,
    orgId,
    [request.sourceAccountId, request.targetAccountId],
    options.lock,
  );
  const source = accounts.get(request.sourceAccountId);
  const target = accounts.get(request.targetAccountId);
  if (!source || !target) {
    throw new AccountMergeError(
      "The account was not found.",
      "account_merge_not_found",
      "Reload the chart of accounts and choose existing accounts.",
      404,
    );
  }

  const existingMerge = (
    await tx.execute<{ id: string; target_account_id: string }>(
      sql`
    select id, target_account_id from account_merges
     where org_id = ${orgId} and source_account_id = ${source.id}`,
      "objects",
    )
  )[0];
  const alreadyMerged = existingMerge
    ? { mergeId: existingMerge.id, targetAccountId: existingMerge.target_account_id }
    : null;
  if (source.merged_into_id && source.merged_into_id !== target.id) {
    refuse(
      "source_merged",
      `${accountLabel(source)} was already merged into another account.`,
      "Open the surviving account instead; a merge is permanent.",
    );
  }
  if (target.merged_into_id) {
    refuse(
      "target_merged",
      `${accountLabel(target)} was itself merged into another account.`,
      "Choose that account's survivor as the surviving account.",
    );
  }

  // Compatibility.
  if (!target.is_active && !target.merged_into_id) {
    refuse(
      "target_inactive",
      `The surviving account ${accountLabel(target)} is inactive.`,
      "Reactivate the surviving account, then merge.",
    );
  }
  if (target.is_summary) {
    refuse(
      "target_summary",
      `The surviving account ${accountLabel(target)} is a summary account and cannot hold postings.`,
      "Choose a postable account as the survivor.",
    );
  }
  if (source.is_summary) {
    refuse(
      "source_summary",
      `${accountLabel(source)} is a summary account; it holds no postings to merge.`,
      "Move its child accounts under another parent and inactivate it instead.",
    );
  }
  if (source.type !== target.type) {
    refuse(
      "type_mismatch",
      `${accountLabel(source)} and ${accountLabel(target)} have different account types.`,
      "Merge only accounts of the same type; reclassify the balance with a journal entry instead.",
    );
  }
  if ((source.currency_restriction ?? null) !== (target.currency_restriction ?? null)) {
    refuse(
      "currency_mismatch",
      "The accounts accept different currencies.",
      "Merge only accounts with the same currency restriction.",
    );
  }
  if (source.eliminate !== target.eliminate) {
    refuse(
      "elimination_mismatch",
      "Only one of the accounts is eliminated in consolidation.",
      "Align the intercompany elimination setting of both accounts first.",
    );
  }
  if (source.reconcilable !== target.reconcilable) {
    refuse(
      "reconcilable_mismatch",
      "Only one of the accounts is reconcilable.",
      "Merge reconcilable accounts only into another reconcilable account.",
    );
  }
  if ((source.monetary ?? null) !== (target.monetary ?? null)) {
    refuse(
      "monetary_mismatch",
      "The accounts are classified differently for FX revaluation.",
      "Align the monetary-item setting of both accounts first.",
    );
  }

  // Hierarchy: the survivor may not sit beneath the source.
  const descendant =
    (
      await tx.execute<{ found: boolean }>(
        sql`
    with recursive below as (
      select id from accounts where org_id = ${orgId} and parent_id = ${source.id}
      union
      select child.id from accounts child join below on child.parent_id = below.id where child.org_id = ${orgId}
    ) select exists (select 1 from below where id = ${target.id}) as found`,
        "objects",
      )
    )[0]?.found === true;
  if (descendant) {
    refuse(
      "target_below_source",
      `The surviving account ${accountLabel(target)} sits beneath ${accountLabel(source)} in the chart.`,
      "Move the surviving account out from under the source account first.",
    );
  }
  const children = await tx.execute<{ id: string; number: string | null; name: string }>(
    sql`
    select id, number, name from accounts
     where org_id = ${orgId} and parent_id = ${source.id} and id <> ${target.id}
     order by number nulls last, name, id`,
    "objects",
  );

  // Effective date and period.
  const today = await businessTodayInTx(tx, orgId);
  if (request.effectiveDate > today) {
    refuse(
      "future_date",
      `The effective date ${request.effectiveDate} is in the future.`,
      "Merge on or before today's date.",
    );
  }
  const sourceSubsidiaries = (
    await tx.execute<{ subsidiary_id: string }>(
      sql`
    select distinct l.subsidiary_id
      from journal_lines l
      join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id and e.status in ('posted', 'reversed')
     where l.org_id = ${orgId} and l.account_id = ${source.id}
     order by l.subsidiary_id`,
      "objects",
    )
  ).map((row) => row.subsidiary_id);
  if (source.subsidiary_id && !sourceSubsidiaries.includes(source.subsidiary_id))
    sourceSubsidiaries.push(source.subsidiary_id);
  sourceSubsidiaries.sort();
  const periodsBySubsidiary = new Map<
    string,
    NonNullable<Awaited<ReturnType<typeof resolveCoveringPeriod>>>
  >();
  const balanceFromBySubsidiary = new Map<string, string>();
  for (const subsidiaryId of sourceSubsidiaries) {
    const entityPeriod = await resolveCoveringPeriod(
      tx,
      orgId,
      request.effectiveDate,
      subsidiaryId,
    );
    if (!entityPeriod) {
      refuse(
        "no_period",
        `No accounting period in the subsidiary's effective fiscal calendar covers ${request.effectiveDate}.`,
        "Generate the entity's fiscal periods for that date, then preview the merge again.",
      );
      continue;
    }
    periodsBySubsidiary.set(subsidiaryId, entityPeriod);
    if (PROFIT_AND_LOSS_TYPES.has(source.type)) {
      const starts = (
        await tx.execute<{ starts: string | null }>(
          sql`
        select min(starts_on)::text as starts from accounting_periods
         where org_id = ${orgId} and fiscal_calendar_id = ${entityPeriod.fiscal_calendar_id}
           and fiscal_year = ${entityPeriod.fiscal_year} and not is_adjustment`,
          "objects",
        )
      )[0]?.starts;
      balanceFromBySubsidiary.set(subsidiaryId, starts ?? entityPeriod.starts_on);
    }
  }
  if (sourceSubsidiaries.length === 0) {
    const defaultPeriod = await resolveCoveringPeriod(
      tx,
      orgId,
      request.effectiveDate,
      source.subsidiary_id,
    );
    if (!defaultPeriod) {
      refuse(
        "no_period",
        `No accounting period covers ${request.effectiveDate}.`,
        "Create the fiscal period for that date under Accounting periods, then merge.",
      );
    }
  }
  const latest =
    (
      await tx.execute<{ latest: string | null }>(
        sql`
    select max(e.posting_date)::text as latest
      from journal_lines l
      join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id and e.status in ('posted', 'reversed')
     where l.org_id = ${orgId} and l.account_id = ${source.id}`,
        "objects",
      )
    )[0]?.latest ?? null;
  if (latest && latest > request.effectiveDate) {
    refuse(
      "postings_after_date",
      `${accountLabel(source)} has postings dated ${latest}, after the effective date.`,
      `Choose an effective date on or after ${latest}.`,
    );
  }

  // Profit-and-loss accounts move their fiscal-year-to-date balance.
  const commonBalanceStarts = [...new Set(balanceFromBySubsidiary.values())];
  const balanceFrom = commonBalanceStarts.length === 1 ? commonBalanceStarts[0]! : null;
  const balanceScope =
    PROFIT_AND_LOSS_TYPES.has(source.type) && sourceSubsidiaries.length > 0
      ? sql`and (${sql.join(
          sourceSubsidiaries.map((subsidiaryId) => {
            const starts = balanceFromBySubsidiary.get(subsidiaryId);
            return starts
              ? sql`(l.subsidiary_id = ${subsidiaryId} and e.posting_date >= ${starts}::date)`
              : sql`l.subsidiary_id = ${subsidiaryId}`;
          }),
          sql` or `,
        )})`
      : sql``;

  // Balances to move.
  const balanceRows = await tx.execute<{
    book_id: string;
    book_name: string;
    book_active: boolean;
    subsidiary_id: string;
    subsidiary_name: string;
    functional_currency: string;
    currency: string;
    amount: string;
    txn_amount: string;
    department_id: string | null;
    project_id: string | null;
    location_id: string | null;
    class_id: string | null;
    party_id: string | null;
    equipment_unit_id: string | null;
    payment_card_id: string | null;
    extra_dims: unknown;
  }>(
    sql`
    select e.book_id, b.name as book_name, (b.is_active and b.posts_gl) as book_active,
           l.subsidiary_id, s.name as subsidiary_name, public.accounting_book_currency(${orgId}, e.book_id, l.subsidiary_id) as functional_currency,
           l.currency, sum(l.amount)::text as amount, sum(l.txn_amount)::text as txn_amount,
           l.department_id, l.project_id, l.location_id, l.class_id, l.party_id,
           l.equipment_unit_id, l.payment_card_id, l.extra_dims
      from journal_lines l
      join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id and e.status in ('posted', 'reversed')
      join accounting_books b on b.org_id = e.org_id and b.id = e.book_id
      join subsidiaries s on s.org_id = l.org_id and s.id = l.subsidiary_id
     where l.org_id = ${orgId} and l.account_id = ${source.id}
       and e.posting_date <= ${request.effectiveDate}
       ${balanceScope}
     group by e.book_id, b.name, b.is_active, b.posts_gl, l.subsidiary_id, s.name, l.currency,
              l.department_id, l.project_id, l.location_id, l.class_id, l.party_id,
              l.equipment_unit_id, l.payment_card_id, l.extra_dims
    having sum(l.amount) <> 0 or sum(l.txn_amount) <> 0
     order by e.book_id, l.subsidiary_id, l.currency`,
    "objects",
  );

  const balances: MergeBalanceTransfer[] = [];
  const groups: (BalanceGroup & { fxRate: string })[] = [];
  const requiredDims = Array.isArray(target.required_dimensions) ? target.required_dimensions : [];
  for (const row of balanceRows) {
    const group: BalanceGroup = {
      bookId: row.book_id,
      subsidiaryId: row.subsidiary_id,
      functionalCurrency: row.functional_currency,
      currency: row.currency,
      amount: row.amount,
      txnAmount: row.txn_amount,
      departmentId: row.department_id,
      projectId: row.project_id,
      locationId: row.location_id,
      classId: row.class_id,
      partyId: row.party_id,
      equipmentUnitId: row.equipment_unit_id,
      paymentCardId: row.payment_card_id,
      extraDims: cleanExtraDims(row.extra_dims),
    };
    const rate = transferRate(group);
    balances.push({
      bookId: row.book_id,
      bookName: row.book_name,
      subsidiaryId: row.subsidiary_id,
      subsidiaryName: row.subsidiary_name,
      currency: row.currency,
      functionalCurrency: row.functional_currency,
      amount: row.amount,
      txnAmount: row.txn_amount,
      fxRate: rate.ok ? rate.fxRate : null,
      balanceFrom: balanceFromBySubsidiary.get(row.subsidiary_id) ?? null,
      dimensions: {
        departmentId: group.departmentId,
        projectId: group.projectId,
        locationId: group.locationId,
        classId: group.classId,
        partyId: group.partyId,
        equipmentUnitId: group.equipmentUnitId,
        paymentCardId: group.paymentCardId,
        extraDims: group.extraDims,
      },
    });
    if (!row.book_active) {
      refuse(
        "book_inactive",
        `Accounting book ${row.book_name} holds a balance on ${accountLabel(source)} but no longer posts.`,
        "Reactivate the book for posting, or clear its balance on the source account first.",
      );
    }
    if (!rate.ok) {
      refuse(
        "fx_residue",
        `The ${row.currency} balance in ${row.subsidiary_name} (${row.book_name}) carries ${row.amount} ${row.functional_currency} against ${row.txn_amount} ${row.currency}, which no positive exchange rate reproduces.`,
        `Revalue the source account's ${row.currency} balance through ${request.effectiveDate}, or post an adjusting journal entry, so the functional balance corresponds to the foreign balance.`,
      );
      continue;
    }
    for (const key of requiredDims) {
      const field = BUILTIN_DIMENSION_FIELDS[key];
      const present =
        field === "subsidiaryId"
          ? true
          : field
            ? Boolean(group[field as keyof BalanceGroup])
            : Boolean(group.extraDims[key]);
      if (!present) {
        refuse(
          "target_requires_dimension",
          `${accountLabel(target)} requires ${key} on every posting, but a ${row.currency} balance in ${row.subsidiary_name} has none.`,
          `Reclassify that balance onto a ${key} on the source account first, or remove the ${key} requirement from the surviving account.`,
        );
        break;
      }
    }
    groups.push({ ...group, fxRate: rate.fxRate });
  }

  // Legal-entity availability: the survivor must accept every entity the source carries.
  const subsidiaryContext = await loadSubsidiaryContext(tx, orgId);
  const carried = new Set<string>(balanceRows.map((row) => row.subsidiary_id));
  const posted = await tx.execute<{ subsidiary_id: string }>(
    sql`
    select distinct subsidiary_id from journal_lines where org_id = ${orgId} and account_id = ${source.id}`,
    "objects",
  );
  for (const row of posted) carried.add(row.subsidiary_id);
  if (source.subsidiary_id) carried.add(source.subsidiary_id);
  for (const subsidiaryId of carried) {
    if (
      !restrictionAdmits(
        subsidiaryContext,
        target.subsidiary_id,
        target.subsidiary_include_children,
        subsidiaryId,
      )
    ) {
      const name = subsidiaryContext.byId.get(subsidiaryId)?.name ?? subsidiaryId;
      refuse(
        "subsidiary_unavailable",
        `The surviving account is not available to ${name}, where ${accountLabel(source)} is used.`,
        "Widen the surviving account's subsidiary availability, or merge into an account available to every entity the source is used in.",
      );
    }
  }
  // Open subledger items and reconciliation state.
  const openParties =
    (
      await tx.execute<{ n: number }>(
        sql`
    select count(*)::int as n from (
      select e.book_id, l.party_id
        from journal_lines l
        join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id and e.status in ('posted', 'reversed')
       where l.org_id = ${orgId} and l.account_id = ${source.id} and l.is_open_item
       group by e.book_id, l.party_id
      having sum(l.amount) <> 0
    ) open_items`,
        "objects",
      )
    )[0]?.n ?? 0;
  if (Number(openParties) > 0) {
    refuse(
      "open_items",
      `${accountLabel(source)} carries open receivable or payable items for ${openParties} part${Number(openParties) === 1 ? "y" : "ies"}.`,
      "Settle or apply the open items on the source account, then merge.",
    );
  }
  if (source.reconcilable) {
    const unreconciled =
      (
        await tx.execute<{ n: number }>(
          sql`
      select count(*)::int as n
        from journal_lines l
        join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
       where l.org_id = ${orgId} and l.account_id = ${source.id}
         and e.status = 'posted' -- Live entries only: a reversed entry and its reversal cancel out and are never reconciled
         and e.reverses_entry_id is null and l.reconciled_at is null`,
          "objects",
        )
      )[0]?.n ?? 0;
    if (Number(unreconciled) > 0) {
      refuse(
        "unreconciled_lines",
        `${accountLabel(source)} has ${unreconciled} unreconciled posted line(s).`,
        "Reconcile the source account through the effective date, then merge.",
      );
    }
  }

  // Control-account roles.
  const roleRows = await tx.execute<{
    scope: string;
    scope_name: string;
    role: string;
    account_id: string;
  }>(
    sql`
    select 'organization' as scope, 'Organization' as scope_name, kv.key as role, kv.value as account_id
      from orgs o, jsonb_each_text(coalesce(o.settings -> 'controlAccounts', '{}'::jsonb)) kv
     where o.id = ${orgId} and kv.value in (${source.id}, ${target.id})
    union all
    select s.id::text, s.name, kv.key, kv.value
      from subsidiaries s, jsonb_each_text(coalesce(s.control_accounts, '{}'::jsonb)) kv
     where s.org_id = ${orgId} and jsonb_typeof(coalesce(s.control_accounts, '{}'::jsonb)) = 'object'
       and kv.value in (${source.id}, ${target.id})
     order by 1, 3`,
    "objects",
  );
  const controlRoles: AccountMergePreview["controlRoles"] = [];
  for (const row of roleRows) {
    if (row.account_id !== source.id) continue;
    controlRoles.push({
      scope: row.scope_name,
      role: row.role,
      label: CONTROL_ACCOUNT_ROLE_LABELS[row.role as ControlAccountRole] ?? row.role,
    });
    const targetRoles = roleRows.filter(
      (other) =>
        other.scope === row.scope && other.account_id === target.id && other.role !== row.role,
    );
    if (
      targetRoles.length > 0 &&
      (SUBLEDGER_CONTROL_ROLES.has(row.role) ||
        targetRoles.some((other) => SUBLEDGER_CONTROL_ROLES.has(other.role)))
    ) {
      refuse(
        "control_role_conflict",
        `${accountLabel(source)} is the ${CONTROL_ACCOUNT_ROLE_LABELS[row.role as ControlAccountRole] ?? row.role} account and ${accountLabel(target)} is the ${targetRoles.map((other) => CONTROL_ACCOUNT_ROLE_LABELS[other.role as ControlAccountRole] ?? other.role).join(", ")} account for ${row.scope_name}; subledger control accounts stay distinct.`,
        "Assign one of the control roles to another account in Settings, then merge.",
      );
    }
  }

  // Configuration and history references.
  const discovered = await discoverAccountReferenceColumns(tx);
  const columns = new Map<string, { table: string; column: string }>();
  for (const column of discovered) columns.set(`${column.table}.${column.column}`, column);
  const declared = await tx.execute<{ table_name: string; column_name: string }>(
    sql`
    select table_name::text, column_name::text from information_schema.columns
     where table_schema = 'public' and is_generated = 'NEVER'
       and (table_name || '.' || column_name) in ${Object.keys(ACCOUNT_REFERENCE_RULES)}`,
    "objects",
  );
  for (const row of declared)
    columns.set(`${row.table_name}.${row.column_name}`, {
      table: row.table_name,
      column: row.column_name,
    });

  const references: MergeReferenceImpact[] = [];
  const referenceColumns: MergePlan["referenceColumns"] = [];
  for (const column of [...columns.values()].sort((a, b) =>
    `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`),
  )) {
    const classification = classifyAccountReference(column);
    if (classification === "owned") continue;
    const blockedPredicate = classification?.blockWhere?.predicate;
    const blockedWhere =
      typeof blockedPredicate === "function"
        ? blockedPredicate(request.effectiveDate)
        : blockedPredicate;
    const counts = (
      await tx.execute<{ total: number; redirect: number; blocked: number }>(
        sql`
      select count(*)::int as total,
             count(*) filter (where ${classification?.disposition === "redirect" ? (classification.redirectWhere ?? sql`true`) : sql`false`})::int as redirect,
             count(*) filter (where ${blockedWhere ?? sql`false`})::int as blocked
        from ${sql.identifier(column.table)} r
       where r.org_id = ${orgId} and r.${sql.identifier(column.column)} = ${source.id}`,
        "objects",
      )
    )[0];
    const total = Number(counts?.total ?? 0);
    if (total === 0) {
      if (classification) referenceColumns.push({ ...column, rule: classification });
      continue;
    }
    if (!classification) {
      refuse(
        "unclassified_reference",
        `${total} row(s) of ${column.table}.${column.column} reference ${accountLabel(source)}, and the merge has no rule for whether they are configuration or history.`,
        "Contact support to classify this reference before merging; the merge refuses rather than guess.",
      );
      continue;
    }
    const blocked = Number(counts?.blocked ?? 0);
    const redirect = Number(counts?.redirect ?? 0);
    references.push({
      key: `${column.table}.${column.column}`,
      label: classification.label,
      table: column.table,
      column: column.column,
      kind: "column",
      redirect,
      blocked,
      history: total - redirect - blocked,
    });
    if (blocked > 0 && classification.blockWhere) {
      refuse(
        "reference_in_flight",
        `${blocked} ${classification.label.toLowerCase()} reference ${accountLabel(source)} and are in progress.`,
        classification.blockWhere.remedy,
      );
    }
    referenceColumns.push({ ...column, rule: classification });
  }
  const needle = `%"${source.id}"%`;
  for (const ref of ACCOUNT_JSON_REFERENCES) {
    const value = ref.path
      ? sql`(r.${sql.identifier(ref.column)} -> ${ref.path})`
      : sql`r.${sql.identifier(ref.column)}`;
    const referenceScope = ref.scope
      ? ref.blockWhere
        ? sql`and (${ref.scope} or ${ref.blockWhere.predicate})`
        : sql`and ${ref.scope}`
      : sql``;
    const counts = (
      await tx.execute<{ total: number; blocked: number }>(
        sql`
      select count(*)::int as total,
             count(*) filter (where ${ref.blockWhere?.predicate ?? sql`false`})::int as blocked
        from ${sql.identifier(ref.table)} r
       where r.${sql.identifier(ref.orgColumn)} = ${orgId}
         and ${value}::text like ${needle}
         ${referenceScope}`,
        "objects",
      )
    )[0];
    const total = Number(counts?.total ?? 0);
    if (total === 0) continue;
    const blocked = Number(counts?.blocked ?? 0);
    references.push({
      key: ref.key,
      label: ref.label,
      table: ref.table,
      column: ref.column,
      kind: "json",
      redirect: total - blocked,
      history: 0,
      blocked,
    });
    if (blocked > 0 && ref.blockWhere) {
      refuse(
        "reference_in_flight",
        `${blocked} ${ref.label.toLowerCase()} reference ${accountLabel(source)} and are in progress.`,
        ref.blockWhere.remedy,
      );
    }
  }

  const draftJournalLines = await countDraftAccountLines(tx, { orgId, accountId: source.id });

  // Reclass entries and their period gates.
  const entriesPlan = buildReclassEntries(groups, source.id, target.id);
  const bookNames = new Map(balances.map((row) => [row.bookId, row.bookName]));
  const subsidiaryNames = new Map(balances.map((row) => [row.subsidiaryId, row.subsidiaryName]));
  for (const entry of entriesPlan) {
    const entityPeriod = periodsBySubsidiary.get(entry.subsidiaryId);
    if (!entityPeriod) {
      refuse(
        "no_period",
        `No accounting period in the subsidiary's effective fiscal calendar covers ${request.effectiveDate}.`,
        "Generate the entity's fiscal periods for that date, then preview the merge again.",
      );
      continue;
    }
    try {
      await assertPeriodModulesOpen(tx, {
        orgId,
        periodId: entityPeriod.id,
        bookId: entry.bookId,
        subsidiaryIds: [entry.subsidiaryId],
        modules: [],
      });
    } catch (error) {
      if (!(error instanceof CloseError)) throw error;
      refuse(
        "period_closed",
        `${bookNames.get(entry.bookId) ?? "The book"} is closed on ${request.effectiveDate} for ${subsidiaryNames.get(entry.subsidiaryId) ?? "the subsidiary"}: ${error.message}`,
        "Choose an effective date in an open period, or request a controlled reopen of the period.",
      );
    }
  }

  const pendingChange = (
    await tx.execute<{ id: string }>(
      sql`
    select id from financial_changes
     where org_id = ${orgId} and domain = 'ledger' and operation = ${ACCOUNT_MERGE_OPERATION}
       and subject_id = ${source.id} and status in ('draft', 'pending', 'approved')
     order by created_at desc limit 1`,
      "objects",
    )
  )[0];

  const consequences = {
    version: 1,
    sourceAccountId: source.id,
    targetAccountId: target.id,
    effectiveDate: request.effectiveDate,
    balanceFrom,
    entries: entriesPlan,
    references: references.map(({ key, redirect, history, blocked }) => ({
      key,
      redirect,
      history,
      blocked,
    })),
    periods: [...periodsBySubsidiary].map(([subsidiaryId, period]) => ({
      subsidiaryId,
      periodId: period.id,
    })),
    balanceFromBySubsidiary: [...balanceFromBySubsidiary].map(([subsidiaryId, startsOn]) => ({
      subsidiaryId,
      startsOn,
    })),
    children: children.map((child) => child.id),
    draftJournalLines,
    controlRoles: controlRoles.map(({ scope, role }) => ({ scope, role })),
  };

  return {
    source,
    target,
    periodIdsBySubsidiary: new Map(
      [...periodsBySubsidiary].map(([subsidiaryId, period]) => [subsidiaryId, period.id]),
    ),
    groups,
    referenceColumns,
    preview: {
      source: summary(source),
      target: summary(target),
      effectiveDate: request.effectiveDate,
      balanceFrom,
      refusals,
      balances,
      entries: entriesPlan.map((entry) => ({
        bookId: entry.bookId,
        bookName: bookNames.get(entry.bookId) ?? entry.bookId,
        subsidiaryId: entry.subsidiaryId,
        subsidiaryName: subsidiaryNames.get(entry.subsidiaryId) ?? entry.subsidiaryId,
        lines: entry.lines.length,
      })),
      references,
      children,
      draftJournalLines,
      controlRoles,

      pendingChangeId: pendingChange?.id ?? null,
      alreadyMerged,
      digest: mergeConsequenceDigest(consequences),
    },
  };
}

async function assertFeature(tx: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(tx, orgId, "accountMerges"))) {
    throw new AccountMergeError(
      "Account merges are turned off for this company.",
      "feature_disabled",
      "Turn on Account merges in Company Settings → Features.",
      403,
    );
  }
}

/** Read-only preview of a merge's refusals and consequences. */
export async function previewAccountMerge(
  orgId: string,
  request: AccountMergeRequest,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<AccountMergePreview> {
  return withOrgTransaction(orgId, async () => {
    await assertFeature(db, orgId);
    return (await planAccountMerge(db, orgId, request, { lock: false, allowedSubsidiaryIds }))
      .preview;
  });
}

function firstRefusal(refusals: AccountMergeRefusal[]): AccountMergeError {
  const first = refusals[0]!;
  const more =
    refusals.length > 1
      ? ` (${refusals.length - 1} more refusal${refusals.length > 2 ? "s" : ""} in the preview)`
      : "";
  return new AccountMergeError(`${first.message}${more}`, first.code, first.remedy);
}

async function lockMerges(tx: SqlExecutor, orgId: string): Promise<void> {
  // One merge at a time per organization, serialized with chart hierarchy edits.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`accounts-hierarchy:${orgId}`}, 0))`,
  );
}

async function replayedMerge(
  tx: SqlExecutor,
  orgId: string,
  idempotencyKey: string,
  request: AccountMergeRequest,
): Promise<AccountMergeResult | null> {
  const prior = (
    await tx.execute<{
      id: string;
      source_account_id: string;
      target_account_id: string;
      effective_date: string;
      result: Record<string, unknown>;
    }>(
      sql`
    select id, source_account_id, target_account_id, effective_date::text as effective_date, result
      from account_merges where org_id = ${orgId} and idempotency_key = ${idempotencyKey}`,
      "objects",
    )
  )[0];
  if (!prior) return null;
  if (
    prior.source_account_id !== request.sourceAccountId ||
    prior.target_account_id !== request.targetAccountId ||
    prior.effective_date !== request.effectiveDate
  ) {
    throw new AccountMergeError(
      "This request key already belongs to a different account merge.",
      "account_merge_key_conflict",
      "Review the earlier merge; use a new request key only for a separate merge.",
      409,
    );
  }
  return {
    status: "completed",
    mergeId: prior.id,
    replayed: true,
    entryIds: Array.isArray(prior.result.entryIds) ? (prior.result.entryIds as string[]) : [],
    moved: (prior.result.moved ?? {}) as Record<string, number>,
  };
}

async function audit(
  tx: SqlExecutor,
  orgId: string,
  table: string,
  rowId: string,
  action: string,
  changes: Record<string, unknown>,
  actorId: string,
): Promise<void> {
  const inserted = await tx.execute(
    sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, ${table}, ${rowId}, ${action}, ${JSON.stringify(changes)}::jsonb, ${actorId})
    returning id`,
    "objects",
  );
  if (inserted.length !== 1) throw new Error("account merge audit was not recorded");
}

/** The single writer: apply a planned merge inside the caller's transaction. */
async function applyMerge(
  tx: SqlExecutor,
  orgId: string,
  plan: MergePlan,
  input: {
    reason: string;
    idempotencyKey: string;
    actorId: string;
    financialChangeId: string | null;
  },
): Promise<AccountMergeResult> {
  const { source, target } = plan;
  const mergeId = randomUUID();
  const reason = input.reason.trim();
  const moved: Record<string, number> = {};
  const redirectAudits: { table: string; column: string; rowIds: (string | null)[] }[] = [];

  // Configuration references follow the survivor.
  for (const { table, column, rule } of plan.referenceColumns) {
    if (rule.disposition !== "redirect") continue;
    let rows: { id: string | null }[];
    try {
      rows = await withTransactionSavepoint(
        tx,
        async () =>
          await tx.execute<{ id: string | null }>(
            sql`
        update ${sql.identifier(table)} as r set ${sql.identifier(column)} = ${target.id}
         where r.org_id = ${orgId} and r.${sql.identifier(column)} = ${source.id}
           ${rule.redirectWhere ? sql`and ${rule.redirectWhere}` : sql``}
        returning (to_jsonb(r) ->> 'id') as id`,
            "objects",
          ),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new AccountMergeError(
        `${rule.label} could not move to ${accountLabel(target)}: ${detail}`,
        "reference_redirect_refused",
        "Resolve the conflict on those records (for example a record that already exists for the surviving account), then merge again.",
        409,
      );
    }
    if (rows.length > 0) {
      moved[`${table}.${column}`] = rows.length;
      redirectAudits.push({ table, column, rowIds: rows.map((row) => row.id) });
    }
  }
  const sourceNeedle = `"${source.id}"`;
  const targetNeedle = `"${target.id}"`;
  for (const ref of ACCOUNT_JSON_REFERENCES) {
    const value = ref.path
      ? sql`(r.${sql.identifier(ref.column)} -> ${ref.path})`
      : sql`r.${sql.identifier(ref.column)}`;
    const replaced =
      ref.key === "cam_pools.expense_account_ids"
        ? sql`(
          select coalesce(jsonb_agg(deduped.value order by deduped.first_position), '[]'::jsonb)
            from (
              select case when item.value = to_jsonb(${source.id}::text)
                          then to_jsonb(${target.id}::text) else item.value end as value,
                     min(item.ordinality) as first_position
                from jsonb_array_elements(${value}) with ordinality as item(value, ordinality)
               group by 1
            ) deduped
        )`
        : sql`replace(${value}::text, ${sourceNeedle}, ${targetNeedle})::jsonb`;
    const assignment = ref.path
      ? sql`${sql.identifier(ref.column)} = jsonb_set(r.${sql.identifier(ref.column)}, array[${ref.path}]::text[], ${replaced}, false)`
      : sql`${sql.identifier(ref.column)} = ${replaced}`;
    const rows = await tx.execute<{ id: string | null }>(
      sql`
      update ${sql.identifier(ref.table)} as r set ${assignment}
       where r.${sql.identifier(ref.orgColumn)} = ${orgId}
         and ${value}::text like ${`%${sourceNeedle}%`}
         ${ref.scope ? sql`and ${ref.scope}` : sql``}
         ${ref.blockWhere ? sql`and not (${ref.blockWhere.predicate})` : sql``}
      returning (to_jsonb(r) ->> 'id') as id`,
      "objects",
    );
    if (rows.length > 0) {
      moved[ref.key] = rows.length;
      redirectAudits.push({
        table: ref.table,
        column: ref.path ? `${ref.column}.${ref.path}` : ref.column,
        rowIds: rows.map((row) => row.id),
      });
    }
  }

  const draftLines = await repointDraftAccountLines(tx, {
    orgId,
    fromId: source.id,
    toId: target.id,
  });
  if (draftLines > 0) moved["journal_lines.draft"] = draftLines;

  const children = await tx.execute<{ id: string }>(
    sql`
    update accounts set parent_id = ${target.id}, updated_at = now(), updated_by = ${input.actorId}
     where org_id = ${orgId} and parent_id = ${source.id} and id <> ${target.id}
    returning id`,
    "objects",
  );
  if (children.length > 0) moved["accounts.parent_id"] = children.length;
  if (target.parent_id === source.id) {
    const reparented = await tx.execute(
      sql`
      update accounts set parent_id = ${source.parent_id}, updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${orgId} and id = ${target.id} returning id`,
      "objects",
    );
    if (reparented.length !== 1)
      throw new Error(
        "the surviving account could not take the source account's place in the chart",
      );
  }

  // Balances move through the posting kernel.
  const entryIds: string[] = [];
  const entries = buildReclassEntries(plan.groups, source.id, target.id);
  if (entries.length > 0) {
    if (!source.is_active) {
      // The reclass credits the source; an inactive duplicate is posted to
      // inside this transaction only, then marked merged and inactive.
      const reactivated = await tx.execute(
        sql`
        update accounts set is_active = true where org_id = ${orgId} and id = ${source.id} and not is_active returning id`,
        "objects",
      );
      if (reactivated.length !== 1)
        throw new Error("the source account could not be prepared for its reclass");
    }
    let sequence = 0;
    for (const entry of entries) {
      sequence += 1;
      // The org transaction's pinned executor is the allocator's transaction.
      const allocator = tx as Parameters<typeof nextFreeEntryNumber>[0];
      const entryNumber = await nextFreeEntryNumber(
        allocator,
        orgId,
        `AM-${(source.number ?? "ACCT").replace(/[^A-Za-z0-9_-]/g, "")}-${sequence}`,
      );
      const period = await resolveCoveringPeriod(
        tx,
        orgId,
        plan.preview.effectiveDate,
        entry.subsidiaryId,
      );
      if (!period)
        throw new AccountMergeError(
          `No accounting period in the subsidiary's effective fiscal calendar covers ${plan.preview.effectiveDate}.`,
          "no_period",
          "Generate the entity's fiscal periods for that date, then retry the merge.",
        );
      if (plan.periodIdsBySubsidiary.get(entry.subsidiaryId) !== period.id) {
        throw new AccountMergeError(
          "The subsidiary's accounting period changed after the merge preview.",
          "account_merge_preview_changed",
          "Refresh the preview and confirm the current entity fiscal periods.",
          409,
        );
      }
      const posted = await postEntry(tx, {
        orgId,
        bookId: entry.bookId,
        subsidiaryId: entry.subsidiaryId,
        entryNumber,
        postingDate: plan.preview.effectiveDate,
        periodId: period.id,
        memo: `Merge of ${accountLabel(source)} into ${accountLabel(target)}`,
        origin: "account_merge",
        amountBasis: "book",
        accountBasis: "book",
        replicate: false,
        actorId: input.actorId,
        idempotencyKey: `account-merge:${input.idempotencyKey}:${entry.bookId}:${entry.subsidiaryId}`,
        custom: {
          accountMerge: { mergeId, sourceAccountId: source.id, targetAccountId: target.id },
        },
        auditChanges: { reason, mergeId },
        lines: entry.lines.map((line) => ({
          accountId: line.accountId,
          subsidiaryId: line.subsidiaryId,
          amount: line.amount,
          currency: line.currency,
          txnAmount: line.txnAmount,
          fxRate: line.fxRate,
          departmentId: line.departmentId,
          projectId: line.projectId,
          locationId: line.locationId,
          classId: line.classId,
          partyId: line.partyId,
          equipmentUnitId: line.equipmentUnitId,
          paymentCardId: line.paymentCardId,
          extraDims: line.extraDims,
          memo: "Account merge",
        })),
      });
      entryIds.push(posted.entryId);
    }
  }

  const result = {
    entryIds,
    moved,
    balances: plan.preview.balances.length,
    balanceFrom: plan.preview.balanceFrom,
    children: children.map((row) => row.id),
    controlRoles: plan.preview.controlRoles,
    source: plan.preview.source,
    target: plan.preview.target,
  };
  const recorded = await tx.execute(
    sql`
    insert into account_merges (id, org_id, source_account_id, target_account_id, effective_date, reason,
      idempotency_key, financial_change_id, preview_digest, result, merged_by)
    values (${mergeId}, ${orgId}, ${source.id}, ${target.id}, ${plan.preview.effectiveDate}, ${reason},
      ${input.idempotencyKey}, ${input.financialChangeId}, ${plan.preview.digest}, ${JSON.stringify(result)}::jsonb, ${input.actorId})
    returning id`,
    "objects",
  );
  if (recorded.length !== 1) throw new Error("the account merge could not be recorded");

  const marked = await tx.execute(
    sql`
    update accounts
       set is_active = false, merged_into_id = ${target.id}, merged_at = now(), merged_by = ${input.actorId},
           merge_reason = ${reason}, updated_at = now(), updated_by = ${input.actorId}
     where org_id = ${orgId} and id = ${source.id} and merged_into_id is null
    returning id`,
    "objects",
  );
  if (marked.length !== 1) throw new Error("the source account could not be marked merged");

  await audit(
    tx,
    orgId,
    "accounts",
    source.id,
    "merge",
    {
      before: { isActive: source.is_active, parentId: source.parent_id, mergedIntoId: null },
      after: { isActive: false, mergedIntoId: target.id },
      reason,
      mergeId,
      survivor: target.id,
      effectiveDate: plan.preview.effectiveDate,
      entryIds,
      moved,
    },
    input.actorId,
  );
  for (const redirect of redirectAudits) {
    await audit(
      tx,
      orgId,
      redirect.table,
      mergeId,
      "update",
      {
        column: redirect.column,
        before: source.id,
        after: target.id,
        rowIds: redirect.rowIds,
        reason,
        mergeId,
      },
      input.actorId,
    );
  }
  for (const child of children) {
    await audit(
      tx,
      orgId,
      "accounts",
      child.id,
      "update",
      {
        before: { parentId: source.id },
        after: { parentId: target.id },
        reason,
        mergeId,
      },
      input.actorId,
    );
  }
  if (input.financialChangeId) {
    await completeFinancialChange(tx, orgId, input.financialChangeId, input.actorId, {
      mergeId,
      entryIds,
    });
  }
  return { status: "completed", mergeId, replayed: false, entryIds, moved };
}

export interface AccountMergeCommand extends AccountMergeRequest {
  reason: string;
  idempotencyKey: string;
  /** The digest of the preview the operator confirmed. */
  expectedDigest: string;
  actorId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}

export type AccountMergeOutcome =
  AccountMergeResult | { status: "pending_approval"; changeId: string; replayed: boolean };

function validateCommand(command: AccountMergeCommand): void {
  const reason = command.reason.trim();
  if (reason.length < 8 || reason.length > 1000) {
    throw new AccountMergeError(
      "Record a reason between 8 and 1,000 characters for the merge.",
      "account_merge_reason",
      "Describe why these accounts are merged.",
    );
  }
  if (!command.idempotencyKey || command.idempotencyKey.length > 120) {
    throw new AccountMergeError(
      "Provide a request key of at most 120 characters.",
      "account_merge_key",
      "Retry from the merge dialog.",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(command.expectedDigest)) {
    throw new AccountMergeError(
      "Preview the merge before confirming it.",
      "account_merge_unpreviewed",
      "Open the merge preview and confirm what it shows.",
    );
  }
}

/**
 * Merge, or propose the merge for approval when an Accounting event Flow
 * governs it. Refuses unless the current consequences match the confirmed
 * preview digest.
 */
export async function requestAccountMerge(
  orgId: string,
  command: AccountMergeCommand,
): Promise<AccountMergeOutcome> {
  validateCommand(command);
  return withOrgTransaction(orgId, async () => {
    const tx = db;
    await assertFeature(tx, orgId);
    await lockMerges(tx, orgId);
    const replay = await replayedMerge(tx, orgId, command.idempotencyKey, command);
    if (replay) return replay;
    const existingChange = (
      await tx.execute<{
        id: string;
        subject_id: string;
        domain: string;
        operation: string;
        status: string;
        effective_on: string;
        reason: string;
        submitted_by: string;
        payload: Record<string, unknown>;
      }>(
        sql`
      select id, subject_id, domain, operation, status, effective_on::text, reason, submitted_by, payload
        from financial_changes where org_id = ${orgId} and idempotency_key = ${command.idempotencyKey}`,
        "objects",
      )
    )[0];
    if (existingChange) {
      if (
        existingChange.domain !== "ledger" ||
        existingChange.operation !== ACCOUNT_MERGE_OPERATION ||
        existingChange.subject_id !== command.sourceAccountId ||
        existingChange.payload?.targetAccountId !== command.targetAccountId ||
        existingChange.effective_on !== command.effectiveDate ||
        existingChange.reason !== command.reason.trim() ||
        existingChange.submitted_by !== command.actorId ||
        existingChange.payload.previewDigest !== command.expectedDigest
      ) {
        throw new AccountMergeError(
          "This request key already belongs to a different proposal.",
          "account_merge_key_conflict",
          "Review the earlier proposal; use a new request key only for a separate merge.",
          409,
        );
      }
      if (existingChange.status === "approved" || existingChange.status === "applied")
        return applyApprovedAccountMerge(orgId, {
          changeId: existingChange.id,
          actorId: command.actorId,
          allowedSubsidiaryIds: command.allowedSubsidiaryIds,
        });
      if (existingChange.status !== "pending")
        throw new AccountMergeError(
          "The original merge proposal is no longer awaiting approval.",
          "account_merge_not_pending",
          "Open its recorded outcome and create a new proposal for changed work.",
          409,
        );
      return { status: "pending_approval", changeId: existingChange.id, replayed: true };
    }
    const plan = await planAccountMerge(tx, orgId, command, {
      lock: true,
      allowedSubsidiaryIds: command.allowedSubsidiaryIds,
    });
    if (
      plan.preview.alreadyMerged &&
      plan.preview.alreadyMerged.targetAccountId === command.targetAccountId
    ) {
      const prior = (
        await tx.execute<{ result: Record<string, unknown> }>(
          sql`
        select result from account_merges where org_id = ${orgId} and id = ${plan.preview.alreadyMerged.mergeId}`,
          "objects",
        )
      )[0];
      return {
        status: "completed",
        mergeId: plan.preview.alreadyMerged.mergeId,
        replayed: true,
        entryIds: Array.isArray(prior?.result.entryIds) ? (prior!.result.entryIds as string[]) : [],
        moved: (prior?.result.moved ?? {}) as Record<string, number>,
      };
    }
    if (plan.preview.refusals.length > 0) throw firstRefusal(plan.preview.refusals);
    if (plan.preview.digest !== command.expectedDigest) {
      throw new AccountMergeError(
        "The merge's consequences changed after the preview you confirmed.",
        "account_merge_preview_changed",
        "Review the refreshed preview and confirm again.",
        409,
      );
    }
    if (plan.preview.pendingChangeId) {
      throw new AccountMergeError(
        "A merge of this account is already awaiting approval.",
        "account_merge_pending",
        "Decide or apply the pending proposal first.",
        409,
      );
    }
    {
      const anchor =
        plan.source.subsidiary_id ??
        (
          await tx.execute<{ id: string }>(
            sql`
        select id from subsidiaries where org_id = ${orgId} and parent_id is null and not is_elimination order by created_at, id limit 1`,
            "objects",
          )
        )[0]?.id;
      if (!anchor)
        throw new AccountMergeError(
          "The company has no root subsidiary to record the proposal against.",
          "account_merge_no_entity",
          "Create the company's root subsidiary first.",
        );
      const required = [
        ...new Set([anchor, ...plan.preview.balances.map((row) => row.subsidiaryId)]),
      ].sort();
      const changeId = await proposeFinancialChange(tx, {
        orgId,
        subsidiaryId: anchor,
        domain: "ledger",
        subjectId: plan.source.id,
        operation: ACCOUNT_MERGE_OPERATION,
        effectiveOn: command.effectiveDate,
        reason: command.reason,
        actorId: command.actorId,
        idempotencyKey: command.idempotencyKey,
        payload: {
          sourceAccountId: plan.source.id,
          targetAccountId: plan.target.id,
          effectiveDate: command.effectiveDate,
          previewDigest: plan.preview.digest,
          requiredSubsidiaryIds: required,
        },
        beforeState: { previewDigest: plan.preview.digest },
      });
      await submitFinancialChange(orgId, changeId, command.actorId);
      const change = await loadFinancialChange(tx, orgId, changeId);
      if (change.status === "approved")
        return applyApprovedAccountMerge(orgId, {
          changeId,
          actorId: command.actorId,
          allowedSubsidiaryIds: command.allowedSubsidiaryIds,
        });
      return { status: "pending_approval", changeId, replayed: false };
    }
  });
}

/** Apply an approved merge proposal, provided its consequences are unchanged since approval. */
export async function applyApprovedAccountMerge(
  orgId: string,
  input: { changeId: string; actorId: string; allowedSubsidiaryIds: ReadonlySet<string> | null },
): Promise<AccountMergeResult> {
  return withOrgTransaction(orgId, async () => {
    const tx = db;
    await assertFeature(tx, orgId);
    await lockMerges(tx, orgId);
    const change = await loadFinancialChange(tx, orgId, input.changeId);
    if (change.domain !== "ledger" || change.operation !== ACCOUNT_MERGE_OPERATION) {
      throw new AccountMergeError(
        "The accounting event is not an account merge.",
        "account_merge_not_found",
        "Open the account merge proposal instead.",
        404,
      );
    }
    const idempotencyKey = `change:${change.id}`;
    const request: AccountMergeRequest = {
      sourceAccountId: change.subject_id,
      targetAccountId: String(change.payload.targetAccountId ?? ""),
      effectiveDate: change.effective_on,
    };
    const replay = await replayedMerge(tx, orgId, idempotencyKey, request);
    if (replay) return replay;
    const plan = await planAccountMerge(tx, orgId, request, {
      lock: true,
      allowedSubsidiaryIds: input.allowedSubsidiaryIds,
    });
    if (plan.preview.refusals.length > 0) throw firstRefusal(plan.preview.refusals);
    assertFinancialChangeApproved(change, {
      domain: "ledger",
      subjectId: change.subject_id,
      beforeState: { previewDigest: plan.preview.digest },
    });
    return applyMerge(tx, orgId, plan, {
      reason: change.reason,
      idempotencyKey,
      actorId: input.actorId,
      financialChangeId: change.id,
    });
  });
}

export interface AccountMergeHistoryRow {
  id: string;
  kind: "merge" | "proposal";
  status: "completed" | "draft" | "pending" | "approved" | "rejected" | "applied";
  sourceAccountId: string;
  sourceLabel: string;
  targetAccountId: string;
  targetLabel: string;
  effectiveDate: string;
  reason: string;
  actorId: string | null;
  actorName: string | null;
  at: string;
  entryIds: string[];
}

/** Executed merges and open proposals, newest first. */
export async function listAccountMerges(
  orgId: string,
  options: { limit: number; offset: number; accountId?: string | null },
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
): Promise<{ rows: AccountMergeHistoryRow[]; total: number }> {
  return withOrgTransaction(
    orgId,
    async () => {
      const accountFilter = options.accountId
        ? sql`and (x.source_account_id = ${options.accountId} or x.target_account_id = ${options.accountId})`
        : sql``;
      const sourceScope = subsidiaryVisibleFilter(sql`sa.subsidiary_id`, allowedSubsidiaryIds, {
        orgWideNull: true,
      });
      const targetScope = subsidiaryVisibleFilter(sql`ta.subsidiary_id`, allowedSubsidiaryIds, {
        orgWideNull: true,
      });
      const base = sql`
      select m.id, 'merge' as kind, 'completed' as status, m.source_account_id, m.target_account_id,
             m.effective_date::text as effective_date, m.reason, m.merged_by as actor_id, m.merged_at as at,
             coalesce(m.result -> 'entryIds', '[]'::jsonb) as entry_ids
        from account_merges m where m.org_id = ${orgId}
      union all
      select f.id, 'proposal', f.status, f.subject_id, (f.payload ->> 'targetAccountId')::uuid,
             f.effective_on::text, f.reason, f.submitted_by, f.created_at, '[]'::jsonb
        from financial_changes f
       where f.org_id = ${orgId} and f.domain = 'ledger' and f.operation = ${ACCOUNT_MERGE_OPERATION}
         and f.status <> 'applied'`;
      const rows = await db.execute<{
        id: string;
        kind: "merge" | "proposal";
        status: AccountMergeHistoryRow["status"];
        source_account_id: string;
        target_account_id: string;
        effective_date: string;
        reason: string;
        actor_id: string | null;
        at: Date | string;
        entry_ids: string[];
        source_label: string;
        target_label: string;
        actor_name: string | null;
      }>(
        sql`
      select x.*, concat_ws(' · ', sa.number, sa.name) as source_label, concat_ws(' · ', ta.number, ta.name) as target_label,
             u.name as actor_name
        from (${base}) x
        join accounts sa on sa.org_id = ${orgId} and sa.id = x.source_account_id
        join accounts ta on ta.org_id = ${orgId} and ta.id = x.target_account_id
        left join users u on u.org_id = ${orgId} and u.id = x.actor_id
       where true ${accountFilter}
         ${sourceScope} ${targetScope}
       order by x.at desc, x.id
       limit ${options.limit} offset ${options.offset}`,
        "objects",
      );
      const matching =
        (
          await db.execute<{ n: number }>(
            sql`
      select count(*)::int as n from (${base}) x
        join accounts sa on sa.org_id = ${orgId} and sa.id = x.source_account_id
        join accounts ta on ta.org_id = ${orgId} and ta.id = x.target_account_id
       where true ${accountFilter} ${sourceScope} ${targetScope}`,
            "objects",
          )
        )[0]?.n ?? 0;
      return {
        total: matching,
        rows: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          status: row.status,
          sourceAccountId: row.source_account_id,
          sourceLabel: row.source_label,
          targetAccountId: row.target_account_id,
          targetLabel: row.target_label,
          effectiveDate: row.effective_date,
          reason: row.reason,
          actorId: row.actor_id,
          actorName: row.actor_name,
          at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
          entryIds: Array.isArray(row.entry_ids) ? row.entry_ids : [],
        })),
      };
    },
    { readOnly: true },
  );
}
