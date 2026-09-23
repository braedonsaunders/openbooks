import { consolidationHistory } from "./consolidation-history.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { withTransactionSavepoint, type SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import {
  add,
  cmp,
  isZero,
  mulRate,
  divRate,
  neg,
  sum,
  toUnits,
} from "../money/money.ts";
import { assertFinancialChangeAccess } from "../organization/financial-change-access.ts";
import {
  loadSubsidiaryContext,
  restrictionAdmits,
  uuidArray,
  validateSubsidiaryRestrictions,
} from "../organization/subsidiaries.ts";
import { assertPeriodModulesOpen } from "../close/period-policy.ts";
import { assertFinalKernelBalance } from "../ledger/posting-invariants.ts";
import {
  assertFinancialChangeApproved,
  completeFinancialChange,
  existingFinancialChange,
  loadFinancialChange,
  proposeFinancialChange,
} from "../platform/financial-changes.ts";
import {
  runOwnershipConsolidationIn,
  withOwnershipSourceTransaction,
} from "./consolidation.ts";
import { consolidateAssetTransfers } from "./asset-transfers.ts";
import {
  measureLossOfControl,
  type LossOfControlBalance,
} from "./loss-of-control-measurement.ts";

export interface LossOfControlInput {
  effectiveOn: string;
  reason: string;
  idempotencyKey: string;
  assessment: string;
  ociAssessment: string;
  eliminationSubsidiaryId: string;
  proceeds: string;
  proceedsAccountId: string;
  parentInvestmentCarrying: string;
  parentRetainedCarrying: string;
  parentToGroupRate: string;
  investmentTranslationAccountId: string;
  retainedFairValue: string;
  retainedPercent: string;
  retainedMethod: "none" | "equity" | "financial_asset";
  retainedAccountId: string;
  gainLossAccountId: string;
  parentGainLossAccountId: string;
  equityIncomeAccountId: string;
  distributionAccountId: string | null;
  distributionIncomeAccountId: string | null;
  rates: { subsidiaryId: string; rate: string }[];
  /** Controller-attributed consolidation adjustments (for example impairment
   * of acquisition goodwill). Each selected posted journal becomes evidence. */
  additionalConsolidationLines: { lineId: string; amount: string }[];
  oci: {
    accountId: string;
    balance: string;
    treatment: "profit_loss" | "retained_earnings";
    destinationAccountId: string;
    description: string;
  }[];
}
export class LossOfControlProposalError extends Error {
  constructor(
    readonly status: 404 | 403,
    message: string,
  ) {
    super(message);
  }
}

export interface LossOfControlProposalData {
  interest: {
    subsidiary_id: string;
    parent_subsidiary_id: string;
    investment_account_id: string;
    equity_income_account_id: string;
  };
  subsidiaries: {
    id: string;
    name: string;
    parent_id: string | null;
    base_currency: string;
    is_elimination: boolean;
  }[];
  accounts: { id: string; number: string; name: string; type: string }[];
  eliminations: { id: string; name: string; base_currency: string }[];
  adjustmentLines: {
    id: string;
    entry_number: string;
    posting_date: string;
    account_name: string;
    amount: string;
    memo: string | null;
  }[];
}

/**
 * Selector behind GET interests/[id]/loss-of-control. The account picker
 * offers only accounts admissible to this disposal's posting entities (the
 * parent and the visible elimination entities) under the house
 * account-restriction semantics — an account restricted to another family's
 * subtree never appears, and neither does anything outside the actor's
 * scope. Manual elimination lines carry no family lineage (L2).
 */
export async function loadLossOfControlProposalData(
  runner: SqlExecutor,
  orgId: string,
  interestId: string,
  allowedSubsidiaryIds: Set<string> | null,
): Promise<LossOfControlProposalData> {
  const interest = (
    await runner.execute<LossOfControlProposalData["interest"]>(
      sql`select subsidiary_id,parent_subsidiary_id,investment_account_id,equity_income_account_id from subsidiary_ownership_interests where org_id=${orgId} and id=${interestId}`,
    )
  ).rows[0];
  if (
    !interest ||
    (allowedSubsidiaryIds &&
      (!allowedSubsidiaryIds.has(interest.subsidiary_id) ||
        !allowedSubsidiaryIds.has(interest.parent_subsidiary_id)))
  )
    throw new LossOfControlProposalError(404, "ownership interest not found");
  const subsidiaries = (
    await runner.execute<LossOfControlProposalData["subsidiaries"][number]>(
      sql`with recursive family as(select id,org_id,name,parent_id,base_currency,is_elimination from subsidiaries where org_id=${orgId} and id=${interest.subsidiary_id} union all select s.id,s.org_id,s.name,s.parent_id,s.base_currency,s.is_elimination from subsidiaries s join family f on f.org_id=s.org_id and s.parent_id=f.id where not s.is_elimination) select id,name,parent_id,base_currency,is_elimination from family order by name`,
    )
  ).rows;
  if (
    allowedSubsidiaryIds &&
    subsidiaries.some((s) => !allowedSubsidiaryIds.has(s.id))
  )
    throw new LossOfControlProposalError(
      403,
      "this disposal includes an entity outside your authorization",
    );
  const context = await loadSubsidiaryContext(runner, orgId);
  const eliminations = (
    await runner.execute<LossOfControlProposalData["eliminations"][number]>(
      sql`select id,name,base_currency from subsidiaries where org_id=${orgId} and is_active and is_elimination order by name`,
    )
  ).rows.filter(
    (s) => !allowedSubsidiaryIds || allowedSubsidiaryIds.has(s.id),
  );
  const postingTargets = [
    interest.parent_subsidiary_id,
    ...eliminations.map((s) => s.id),
  ];
  const accounts = (
    await runner.execute<
      LossOfControlProposalData["accounts"][number] & {
        subsidiary_id: string | null;
        subsidiary_include_children: boolean;
      }
    >(
      sql`select id,number,name,type,subsidiary_id,subsidiary_include_children from accounts where org_id=${orgId} and is_active and not is_summary order by number`,
    )
  ).rows.filter(
    (a) =>
      postingTargets.some((t) =>
        restrictionAdmits(
          context,
          a.subsidiary_id,
          a.subsidiary_include_children,
          t,
        ),
      ) &&
      (!allowedSubsidiaryIds ||
        !a.subsidiary_id ||
        allowedSubsidiaryIds.has(a.subsidiary_id)),
  );
  // Manual elimination journals carry no family lineage: the elimination
  // entity is shared by unrelated families, so a subsidiary-restricted caller
  // cannot tell this interest's lines from another family's. Offer them only
  // to unrestricted callers; restricted callers see none (L2). Selecting a
  // line likewise requires an unrestricted proposer (see scope()).
  const adjustmentLines =
    allowedSubsidiaryIds || !eliminations.length
      ? []
      : (
          await runner.execute<LossOfControlProposalData["adjustmentLines"][number]>(
            sql`${consolidationHistory(orgId)} select l.id,e.entry_number,e.posting_date::text,a.name as account_name,l.amount::text,l.memo from journal_entries e join journal_lines l on l.org_id=e.org_id and l.entry_id=e.id join accounts a on a.org_id=l.org_id and a.id=l.account_id where e.org_id=${orgId} and e.subsidiary_id in(select jsonb_array_elements_text(${JSON.stringify(eliminations.map((s) => s.id))}::jsonb)::uuid) and e.status in('posted','reversed') and not exists(select 1 from history h where h.id=e.id) order by e.posting_date desc,e.entry_number,l.line_number`,
          )
        ).rows;
  return {
    interest,
    subsidiaries,
    accounts: accounts.map(({ id, number, name, type }) => ({
      id,
      number,
      name,
      type,
    })),
    eliminations,
    adjustmentLines,
  };
}

/**
 * Every account the disposal posts must admit its posting entity under the
 * house account-restriction semantics — the picker offers only admissible
 * accounts, and the proposal refuses anything else by name (L1). The
 * controlling investment comes from the interest record itself, not the
 * caller, but it posts to the parent all the same.
 */
async function assertDisposalAccountsAdmissible(
  tx: SqlExecutor,
  orgId: string,
  context: Awaited<ReturnType<typeof loadSubsidiaryContext>>,
  args: {
    parentId: string;
    eliminationId: string;
    investmentAccountId: string;
    input: LossOfControlInput;
  },
) {
  const legs: { accountId: string; targetId: string; leg: string }[] = [
    { accountId: args.input.proceedsAccountId, targetId: args.parentId, leg: "disposal proceeds" },
    { accountId: args.input.retainedAccountId, targetId: args.parentId, leg: "retained investment" },
    { accountId: args.input.retainedAccountId, targetId: args.eliminationId, leg: "retained interest remeasurement" },
    { accountId: args.input.parentGainLossAccountId, targetId: args.parentId, leg: "separate-book disposal gain or loss" },
    { accountId: args.investmentAccountId, targetId: args.parentId, leg: "controlling investment" },
    { accountId: args.input.investmentTranslationAccountId, targetId: args.eliminationId, leg: "investment translation" },
    { accountId: args.input.gainLossAccountId, targetId: args.eliminationId, leg: "consolidated disposal gain or loss" },
    ...args.input.oci.flatMap((o) => [
      { accountId: o.accountId, targetId: args.eliminationId, leg: "OCI release" },
      { accountId: o.destinationAccountId, targetId: args.eliminationId, leg: "OCI destination" },
    ]),
  ];
  const seen = new Set<string>();
  const wanted = legs.filter((l) => {
    const key = `${l.accountId}:${l.targetId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const accounts = (
    await tx.execute<{
      id: string;
      name: string;
      subsidiary_id: string | null;
      subsidiary_include_children: boolean;
    }>(
      sql`select id,name,subsidiary_id,subsidiary_include_children from accounts where org_id=${orgId} and id=any(${uuidArray(wanted.map((l) => l.accountId))}::uuid[])`,
    )
  ).rows;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const leg of wanted) {
    const account = byId.get(leg.accountId);
    if (!account) continue;
    if (
      !restrictionAdmits(
        context,
        account.subsidiary_id,
        account.subsidiary_include_children,
        leg.targetId,
      )
    ) {
      const restrictedTo = account.subsidiary_id
        ? context.byId.get(account.subsidiary_id)?.name ?? "another subsidiary"
        : null;
      throw new Error(
        restrictedTo
          ? `account "${account.name}" is restricted to "${restrictedTo}" and cannot post the ${leg.leg} leg to "${context.byId.get(leg.targetId)?.name ?? leg.targetId}" in this disposal`
          : `account "${account.name}" cannot post the ${leg.leg} leg in this disposal`,
      );
    }
  }
}

type Interest = {
  id: string;
  subsidiary_id: string;
  parent_subsidiary_id: string;
  method: string;
  ownership_percent: string;
  effective_from: string;
  effective_to: string | null;
  acquisition_date: string;
  investment_account_id: string;
  nci_equity_account_id: string | null;
  goodwill_account_id: string | null;
  fair_value_adjustment_account_id: string | null;
};
function validate(input: LossOfControlInput) {
  if (!isIsoCalendarDate(input.effectiveOn))
    throw new Error("control-loss date must be a calendar date");
  for (const name of ["assessment", "ociAssessment"] as const)
    if (input[name].trim().length < 8)
      throw new Error(
        "document the control-loss and OCI assessments, including why any category has no balance",
      );
  for (const name of [
    "proceeds",
    "parentInvestmentCarrying",
    "parentRetainedCarrying",
    "retainedFairValue",
    "retainedPercent",
  ] as const) {
    const v = canonicalDecimal(input[name], 4);
    if (v === null || toUnits(v) < 0n)
      throw new Error(`${name} must be an exact non-negative decimal`);
  }
  if (cmp(input.retainedPercent, "100") >= 0)
    throw new Error(
      "retained interest must be below 100 percent and the assessment must demonstrate that control has ceased",
    );
  if (
    input.retainedMethod === "none" &&
    [
      input.retainedPercent,
      input.retainedFairValue,
      input.parentRetainedCarrying,
    ].some((v) => !isZero(v))
  )
    throw new Error(
      "no retained interest requires zero percentage and zero carrying/fair values",
    );
  if (input.retainedMethod !== "none" && isZero(input.retainedPercent))
    throw new Error("record the percentage of the retained interest");
  for (const rate of [
    input.parentToGroupRate,
    ...input.rates.map((r) => r.rate),
  ])
    if (
      canonicalDecimal(rate, 10) === null ||
      BigInt(rate.replace(".", "")) <= 0n
    )
      throw new Error("translation rates must be exact positive decimals");
  if (
    new Set(input.rates.map((r) => r.subsidiaryId)).size !== input.rates.length
  )
    throw new Error("supply one translation rate per subsidiary");
  if (
    new Set(input.additionalConsolidationLines.map((l) => l.lineId)).size !==
    input.additionalConsolidationLines.length
  )
    throw new Error(
      "a consolidation adjustment journal cannot be attributed twice",
    );
}
async function scope(
  tx: SqlExecutor,
  orgId: string,
  interestId: string,
  actorId: string,
  input: LossOfControlInput,
) {
  const interest = (
    await tx.execute<Interest>(
      sql`select *,effective_from::text,effective_to::text,acquisition_date::text from subsidiary_ownership_interests where org_id=${orgId} and id=${interestId} for update`,
    )
  ).rows[0];
  if (!interest || interest.method !== "full")
    throw new Error(
      "select the full-consolidation ownership interest whose control has ceased",
    );
  if (
    input.effectiveOn < interest.effective_from ||
    (interest.effective_to && input.effectiveOn > interest.effective_to)
  )
    throw new Error(
      "the control-loss date must lie in the existing ownership window",
    );
  if (cmp(input.retainedPercent, interest.ownership_percent) > 0)
    throw new Error(
      "retained ownership cannot exceed the disposed controlling interest",
    );
  const prior = (
    await tx.execute(
      sql`select id from consolidation_control_losses where org_id=${orgId} and interest_id=${interestId} and reversed_by_change_id is null`,
    )
  ).rows[0];
  if (prior)
    throw new Error(
      "loss of control has already been recorded for this interest",
    );
  await tx.execute(
    sql`select id from subsidiaries where org_id=${orgId} order by id for share`,
  );
  const context = await loadSubsidiaryContext(tx, orgId),
    parent = context.byId.get(interest.parent_subsidiary_id),
    elimination = context.byId.get(input.eliminationSubsidiaryId);
  if (!parent?.isActive || !elimination?.isActive || !elimination.isElimination)
    throw new Error("the parent and group elimination entity must be active");
  if (
    [...context.byId.values()].find((row) => row.isElimination && row.isActive)
      ?.id !== elimination.id
  )
    throw new Error(
      "select the active ownership-consolidation elimination entity",
    );
  const family = [interest.subsidiary_id];
  for (let i = 0; i < family.length; i++)
    for (const child of context.byId.values())
      if (
        child.parentId === family[i] &&
        !family.includes(child.id) &&
        !child.isElimination
      )
        family.push(child.id);
  const requiredSubsidiaryIds = [
    ...new Set([parent.id, elimination.id, ...family]),
  ];
  await assertDisposalAccountsAdmissible(tx, orgId, context, {
    parentId: parent.id,
    eliminationId: elimination.id,
    investmentAccountId: interest.investment_account_id,
    input,
  });
  await assertFinancialChangeAccess(tx, {
    orgId,
    actorId,
    subsidiaryIds: requiredSubsidiaryIds,
    permission: "close.run",
    feature: "multiSubsidiary",
  });
  if (input.additionalConsolidationLines.length > 0) {
    // Manual elimination lines carry no family lineage (see the selector
    // above): a subsidiary-restricted actor cannot verify attribution, so
    // only an unrestricted group controller may select them explicitly (L2).
    const actorScope = await actorAllowedSubsidiaryIds(tx, orgId, actorId);
    if (actorScope)
      throw new Error(
        "manual elimination lines carry no family attribution, so a subsidiary-restricted proposal cannot select them; have an unrestricted group controller include the lines explicitly",
      );
  }
  const period = (
    await tx.execute<{ id: string; starts_on: string; ends_on: string }>(
      sql`select p.id,p.starts_on::text,p.ends_on::text from accounting_periods p join fiscal_calendars c on c.org_id=p.org_id and c.id=p.fiscal_calendar_id where p.org_id=${orgId} and c.is_active and c.is_default and not p.is_adjustment and p.starts_on<=${input.effectiveOn} and p.ends_on>=${input.effectiveOn} for share of p,c`,
    )
  ).rows;
  if (period.length !== 1)
    throw new Error(
      "configure one default-calendar accounting period for the control-loss date",
    );
  const book = (
    await tx.execute<{ id: string }>(
      sql`select id from accounting_books where org_id=${orgId} and is_primary and is_active and posts_gl for share`,
    )
  ).rows;
  if (book.length !== 1)
    throw new Error(
      "loss of control requires the active primary consolidation book",
    );
  await assertPeriodModulesOpen(tx, {
    orgId,
    periodId: period[0]!.id,
    bookId: book[0]!.id,
    subsidiaryIds: requiredSubsidiaryIds,
    modules: ["gl"],
  });
  const policies = (
    await tx.execute<Interest>(
      sql`select interest.*,interest.effective_from::text,interest.effective_to::text,interest.acquisition_date::text from subsidiary_ownership_interests interest where interest.org_id=${orgId} and interest.subsidiary_id=any(${uuidArray(family)}::uuid[]) and interest.is_active and interest.effective_from<=${input.effectiveOn} order by interest.subsidiary_id,interest.effective_from,interest.id for share`,
    )
  ).rows;
  // A descendant accounted for by the equity method contributes its investment
  // in the parent, not its underlying assets. Joint operations carry their
  // proportionate share. The root was fully consolidated through the cutoff.
  const factors: Record<string, string> = { [interest.subsidiary_id]: "1" };
  for (const id of family.slice(1)) {
    const entity = context.byId.get(id)!;
    const policy = policies
      .filter(
        (p) =>
          p.subsidiary_id === id &&
          (!p.effective_to || p.effective_to >= input.effectiveOn),
      )
      .at(-1);
    factors[id] = mulRate(
      factors[entity.parentId!] ?? "0",
      policy?.method === "equity"
        ? "0"
        : policy?.method === "proportionate"
          ? divRate(policy.ownership_percent, "100")
          : "1",
    );
  }
  const ownershipInterestIds = policies
    .filter((p) => !p.effective_to || p.effective_to >= period[0]!.starts_on)
    .map((p) => p.id);
  const late = (
    await tx.execute(
      sql`select 1 from ownership_consolidation_entries c join subsidiary_ownership_interests p on p.org_id=c.org_id and p.id=c.interest_id join journal_entries e on e.org_id=c.org_id and e.id=c.journal_entry_id where c.org_id=${orgId} and p.subsidiary_id=any(${uuidArray(family)}::uuid[]) and e.posting_date>${input.effectiveOn} and e.status='posted' and not exists(select 1 from journal_entries r where r.org_id=e.org_id and r.reverses_entry_id=e.id and r.status='posted') limit 1`,
    )
  ).rows[0];
  if (late)
    throw new Error(
      "a later ownership close is already posted; reverse that later consolidation generation before recording an earlier loss of control",
    );
  for (const id of family) {
    const entity = context.byId.get(id)!,
      rate = input.rates.find((r) => r.subsidiaryId === id)?.rate;
    if (!rate)
      throw new Error(`supply the closing translation rate for ${entity.name}`);
    if (
      entity.baseCurrency === elimination.baseCurrency &&
      mulRate("1000000", rate) !== "1000000.0000"
    )
      throw new Error("same-currency subsidiary translation must be at one");
  }
  if (
    parent.baseCurrency === elimination.baseCurrency &&
    mulRate("1000000", input.parentToGroupRate) !== "1000000.0000"
  )
    throw new Error("same-currency parent translation must be at one");
  const baseline = (
    await tx.execute<{
      subsidiary_id: string;
      account_id: string;
      amount: string;
      line_count: string;
      latest: string | null;
    }>(
      sql`select l.subsidiary_id,l.account_id,sum(l.amount)::text as amount,count(*)::text as line_count,max(e.created_at)::text as latest from journal_entries e join journal_lines l on l.org_id=e.org_id and l.entry_id=e.id where e.org_id=${orgId} and e.book_id=${book[0]!.id} and e.status in('posted','reversed') and e.posting_date<=${input.effectiveOn} and l.subsidiary_id=any(${uuidArray(requiredSubsidiaryIds)}::uuid[]) group by l.subsidiary_id,l.account_id order by l.subsidiary_id,l.account_id`,
    )
  ).rows;
  const rates = (
    await tx.execute(
      sql`select period_id,from_currency,to_currency,current_rate::text,average_rate::text,historical_rate::text,source from consolidated_fx_rates where org_id=${orgId} and period_id=${period[0]!.id} order by from_currency,to_currency`,
    )
  ).rows;
  return {
    interest,
    parent,
    elimination,
    family,
    requiredSubsidiaryIds,
    period: period[0]!,
    bookId: book[0]!.id,
    policies,
    factors,
    ownershipInterestIds,
    baseline,
    rates,
  };
}
type Scope = Awaited<ReturnType<typeof scope>>;
async function measure(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  input: LossOfControlInput,
  s: Scope,
  currentChangeId: string | null,
) {
  const ownershipRun = await runOwnershipConsolidationIn(
    orgId,
    s.period.id,
    actorId,
    tx,
    {
      asOf: input.effectiveOn,
      interestIds: s.ownershipInterestIds,
    },
  );
  // Asset profit eliminations are part of the disposed group's carrying basis.
  // A mid-period close uses only charges actually accrued through the cutoff.
  const assetEntries = await consolidateAssetTransfers(
    tx,
    orgId,
    s.period.id,
    actorId,
    input.effectiveOn,
    s.family,
    s.bookId,
  );
  const balances = (
    await tx.execute<{
      subsidiary_id: string;
      account_id: string;
      type: string;
      name: string;
      amount: string;
    }>(
      sql`select l.subsidiary_id,l.account_id,a.type,a.name,sum(l.amount)::text as amount from journal_entries e join journal_lines l on l.org_id=e.org_id and l.entry_id=e.id join accounts a on a.org_id=l.org_id and a.id=l.account_id where e.org_id=${orgId} and e.book_id=${s.bookId} and e.status in('posted','reversed') and e.posting_date<=${input.effectiveOn} and l.subsidiary_id=any(${uuidArray(s.family)}::uuid[]) and a.type not in('income','income_other','cogs','expense','expense_other','expense_deferred','equity') group by l.subsidiary_id,l.account_id,a.type,a.name order by l.subsidiary_id,l.account_id`,
    )
  ).rows;
  const netAssetBalances: LossOfControlBalance[] = balances.map((l) => ({
    accountId: l.account_id,
    amount: mulRate(
      mulRate(l.amount, s.factors[l.subsidiary_id] ?? "0"),
      input.rates.find((r) => r.subsidiaryId === l.subsidiary_id)!.rate,
    ),
    description: l.name,
  }));
  const owned = (
    await tx.execute<{
      interest_id: string | null;
      parent_subsidiary_id: string | null;
      account_id: string;
      type: string;
      name: string;
      amount: string;
    }>(
      sql`${consolidationHistory(orgId)} select l.account_id,a.type,a.name,h.interest_id,h.parent_id as parent_subsidiary_id,sum(l.amount)::text as amount from history h join journal_entries e on e.org_id=${orgId} and e.id=h.id join journal_lines l on l.org_id=e.org_id and l.entry_id=e.id join accounts a on a.org_id=l.org_id and a.id=l.account_id where e.book_id=${s.bookId} and e.status in('posted','reversed') and e.posting_date<=${input.effectiveOn} and e.subsidiary_id=${s.elimination.id} and (h.subject_id=any(${uuidArray(s.family)}::uuid[]) or h.buyer_id=any(${uuidArray(s.family)}::uuid[])) group by l.account_id,a.type,a.name,h.interest_id,h.parent_id order by l.account_id,h.interest_id`,
    )
  ).rows.map((l) => ({
    ...l,
    amount: mulRate(
      l.amount,
      l.parent_subsidiary_id && l.parent_subsidiary_id !== s.parent.id
        ? (s.factors[l.parent_subsidiary_id] ?? "0")
        : "1",
    ),
  }));
  const manualEvidence: {
    lineId: string;
    entryId: string;
    accountId: string;
    amount: string;
    sourceAmount: string;
  }[] = [];
  // One elimination line backs at most its own amount across EVERY disposal:
  // lock each source line in a stable order, then cap the cumulative absolute
  // attribution (this request plus every other pending, approved or
  // applied-and-active loss-of-control change) at the source amount (L3).
  // Reversal and rejection release the reservation because only active
  // changes count below; the serializable source transaction turns a
  // concurrent over-attribution into a conflict retry instead of a double
  // derecognition.
  const attributed = [...input.additionalConsolidationLines].sort((a, b) =>
    a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0,
  );
  for (const inputLine of attributed) {
    if (canonicalDecimal(inputLine.amount, 4) === null)
      throw new Error(
        "attributed consolidation amounts must be exact signed decimals",
      );
    const line = (
      await tx.execute<{
        entry_id: string;
        entry_number: string;
        account_id: string;
        type: string;
        name: string;
        amount: string;
      }>(
        sql`${consolidationHistory(orgId)} select e.id as entry_id,e.entry_number,l.account_id,a.type,a.name,l.amount::text from journal_lines l join journal_entries e on e.org_id=l.org_id and e.id=l.entry_id join accounts a on a.org_id=l.org_id and a.id=l.account_id where l.org_id=${orgId} and l.id=${inputLine.lineId} and e.book_id=${s.bookId} and e.subsidiary_id=${s.elimination.id} and e.status in('posted','reversed') and e.posting_date<=${input.effectiveOn} and not exists(select 1 from history h where h.id=e.id)`,
      )
    ).rows[0];
    if (!line)
      throw new Error(
        "select a posted, manually attributed elimination line; ownership and transferred-asset adjustments are already included automatically",
      );
    const source = toUnits(line.amount),
      portion = toUnits(inputLine.amount);
    if (
      source < 0n !== portion < 0n ||
      (source < 0n ? -source : source) < (portion < 0n ? -portion : portion)
    )
      throw new Error(
        "the attributed portion must have the source line sign and cannot exceed its amount",
      );
    await tx.execute(
      sql`select id from journal_lines where org_id=${orgId} and id=${inputLine.lineId} for update`,
    );
    const prior = (
      await tx.execute<{ used: string }>(
        sql`with prior as(select abs((e->>'amount')::numeric) as amount from consolidation_control_losses c,jsonb_array_elements(c.measurement->'manualEvidence') e where c.org_id=${orgId} and c.reversed_by_change_id is null and e->>'lineId'=${inputLine.lineId} union all select abs((e->>'amount')::numeric) from financial_changes f,jsonb_array_elements(coalesce(f.payload->'additionalConsolidationLines','[]'::jsonb)) e where f.org_id=${orgId} and f.domain='consolidation' and f.operation='loss_of_control' and f.status in('pending','approved') and e->>'lineId'=${inputLine.lineId} and (${currentChangeId}::uuid is null or f.id!=${currentChangeId}::uuid)) select coalesce(sum(amount),0)::text as used from prior`,
      )
    ).rows[0]!.used;
    const sourceAbs = source < 0n ? -source : source,
      portionAbs = portion < 0n ? -portion : portion,
      remaining = sourceAbs - toUnits(prior);
    if (portionAbs > remaining)
      throw new Error(
        `elimination line "${line.name}" (entry ${line.entry_number}) already attributes ${prior} to other disposals against a ${line.amount} source; attribute at most the remaining balance`,
      );
    owned.push({
      ...line,
      amount: inputLine.amount,
      interest_id: null,
      parent_subsidiary_id: null,
    });
    manualEvidence.push({
      lineId: inputLine.lineId,
      entryId: line.entry_id,
      accountId: line.account_id,
      amount: inputLine.amount,
      sourceAmount: line.amount,
    });
  }
  const nciIds = new Set(
    s.policies
      .map((p) => p.nci_equity_account_id)
      .filter((id): id is string => !!id),
  );
  const upstreamNci = (
    await tx.execute<{ account_id: string; amount: string }>(
      sql`${consolidationHistory(orgId)} select l.account_id,sum(l.amount)::text as amount from history h join journal_entries e on e.org_id=${orgId} and e.id=h.id join journal_lines l on l.org_id=e.org_id and l.entry_id=e.id where e.book_id=${s.bookId} and h.seller_id=any(${uuidArray(s.family)}::uuid[]) and not(h.buyer_id=any(${uuidArray(s.family)}::uuid[])) and e.status in('posted','reversed') and e.posting_date<=${input.effectiveOn} and l.account_id=any(${uuidArray([...nciIds])}::uuid[]) group by l.account_id`,
    )
  ).rows;
  for (const l of upstreamNci)
    owned.push({
      ...l,
      type: "equity",
      name: "NCI on previously transferred assets",
      interest_id: null,
      parent_subsidiary_id: null,
    });
  const nciRows: { account_id: string; amount: string }[] = [];
  for (const l of owned.filter((l) => nciIds.has(l.account_id))) {
    const prior = nciRows.find((r) => r.account_id === l.account_id);
    if (prior) prior.amount = add(prior.amount, l.amount);
    else nciRows.push({ account_id: l.account_id, amount: l.amount });
  }
  // The measured NCI accounts remain separate legs even where there is a
  // nested non-controlling interest; the total feeds the gain calculation.
  const nciTotal = sum(nciRows.map((l) => l.amount));
  const investment = owned
    .filter(
      (l) =>
        l.interest_id === s.interest.id &&
        l.account_id === s.interest.investment_account_id,
    )
    .reduce((a, l) => add(a, l.amount), "0");
  for (const l of owned)
    if (
      !(
        l.interest_id === s.interest.id &&
        l.account_id === s.interest.investment_account_id
      ) &&
      !nciIds.has(l.account_id) &&
      ![
        "income",
        "income_other",
        "cogs",
        "expense",
        "expense_other",
        "expense_deferred",
        "equity",
      ].includes(l.type)
    )
      netAssetBalances.push({
        accountId: l.account_id,
        amount: l.amount,
        description: l.name,
      });
  const measured = measureLossOfControl({
    netAssetBalances,
    nciBalance: nciRows.length
      ? {
          accountId: nciRows[0]!.account_id,
          amount: nciTotal,
          description: "Consolidated non-controlling interests",
        }
      : null,
    eliminatedInvestmentBalance: {
      accountId: s.interest.investment_account_id,
      amount: investment,
      description: "Disposed investment",
    },
    parentProceeds: mulRate(input.proceeds, input.parentToGroupRate),
    parentInvestmentCarrying: mulRate(
      input.parentInvestmentCarrying,
      input.parentToGroupRate,
    ),
    parentRetainedCarrying: mulRate(
      input.parentRetainedCarrying,
      input.parentToGroupRate,
    ),
    investmentTranslationAccountId: input.investmentTranslationAccountId,
    retainedFairValue: input.retainedFairValue,
    retainedAccountId: input.retainedAccountId,
    gainLossAccountId: input.gainLossAccountId,
    oci: input.oci,
  });
  if (nciRows.length > 1) {
    measured.lines = measured.lines.filter(
      (l) => l.description !== "Derecognize non-controlling interests",
    );
    measured.lines.push(
      ...nciRows
        .filter((l) => !isZero(l.amount))
        .map((l) => ({
          accountId: l.account_id,
          amount: neg(l.amount),
          description: "Derecognize non-controlling interests",
        })),
    );
  }
  const parentBalance =
    s.baseline.find(
      (l) =>
        l.subsidiary_id === s.parent.id &&
        l.account_id === s.interest.investment_account_id,
    )?.amount ?? "0";
  if (cmp(parentBalance, input.parentInvestmentCarrying) < 0)
    throw new Error(
      "the attributed investment carrying amount exceeds the parent investment account balance",
    );
  const accountIds = [
    ...new Set([
      input.investmentTranslationAccountId,
      input.proceedsAccountId,
      s.interest.investment_account_id,
      input.retainedAccountId,
      input.gainLossAccountId,
      input.parentGainLossAccountId,
      ...measured.lines.map((l) => l.accountId),
    ]),
  ];
  const accounts = (
    await tx.execute<{ id: string; type: string }>(
      sql`select id,type from accounts where org_id=${orgId} and id=any(${uuidArray(accountIds)}::uuid[]) and is_active and not is_summary for share`,
    )
  ).rows;
  if (accounts.length !== accountIds.length)
    throw new Error(
      "select active posting accounts for every disposal, retained interest and OCI leg",
    );
  for (const oci of input.oci) {
    const destination = accounts.find((a) => a.id === oci.destinationAccountId);
    if (
      oci.treatment === "retained_earnings"
        ? destination?.type !== "equity"
        : !["income", "income_other", "expense", "expense_other"].includes(
            destination?.type ?? "",
          )
    )
      throw new Error(
        "OCI recycling must post to profit/loss; a direct reserve transfer must post to retained earnings",
      );
  }
  const parentLines = [
    {
      accountId: input.proceedsAccountId,
      amount: input.proceeds,
      description: "Disposal proceeds",
    },
    {
      accountId: input.retainedAccountId,
      amount: input.parentRetainedCarrying,
      description: "Retained investment in separate books",
    },
    {
      accountId: s.interest.investment_account_id,
      amount: neg(input.parentInvestmentCarrying),
      description: "Derecognize controlling investment",
    },
    {
      accountId: input.parentGainLossAccountId,
      amount: neg(
        add(
          add(input.proceeds, input.parentRetainedCarrying),
          neg(input.parentInvestmentCarrying),
        ),
      ),
      description: "Separate-book investment disposal gain or loss",
    },
  ].filter((l) => !isZero(l.amount));
  const sourceEntryIds = (
    await tx.execute<{ id: string }>(
      sql`${consolidationHistory(orgId)} select e.id from history h join journal_entries e on e.org_id=${orgId} and e.id=h.id where e.book_id=${s.bookId} and e.status in('posted','reversed') and e.posting_date<=${input.effectiveOn} and (h.subject_id=any(${uuidArray(s.family)}::uuid[]) or h.buyer_id=any(${uuidArray(s.family)}::uuid[]) or h.seller_id=any(${uuidArray(s.family)}::uuid[])) order by e.id`,
    )
  ).rows.map((e) => e.id);
  return {
    sourceEntryIds,
    manualEvidence,
    generatedEntryIds: [...ownershipRun.entryIds, ...assetEntries],
    preview: measured,
    parentLines,
    ownershipInterestIds: s.ownershipInterestIds,
  };
}
class PreviewRollback extends Error {
  constructor(readonly value: Awaited<ReturnType<typeof measure>>) {
    super("rollback provisional consolidation measurements");
  }
}
async function preview(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  input: LossOfControlInput,
  s: Scope,
  currentChangeId: string | null,
) {
  // Reuse the real ownership/asset accounting, including first-acquisition and
  // current-period NCI logic, under a rollback-only savepoint. No provisional
  // journal, audit row, close generation or notification can commit here.
  try {
    await withTransactionSavepoint(tx, async () => {
      throw new PreviewRollback(
        await measure(tx, orgId, actorId, input, s, currentChangeId),
      );
    });
  } catch (e) {
    if (e instanceof PreviewRollback) {
      const {
        generatedEntryIds,
        sourceEntryIds,
        ...stable
      } = e.value;
      // Preview must not return rolled-back journal ids. The bindings exist
      // only to drop those keys; they are not read.
      void generatedEntryIds;
      void sourceEntryIds;
      return stable;
    }
    throw e;
  }
  throw new Error("loss-of-control preview did not return its measurement");
}
export async function proposeLossOfControl(
  orgId: string,
  interestId: string,
  actorId: string,
  input: LossOfControlInput,
): Promise<string> {
  validate(input);
  return withOwnershipSourceTransaction(orgId, async (tx) => {
    const replay = (
      await tx.execute<{
        id: string;
        subsidiary_id: string;
        payload: Record<string, unknown>;
      }>(
        sql`select id,subsidiary_id,payload from financial_changes where org_id=${orgId} and idempotency_key=${input.idempotencyKey}`,
      )
    ).rows[0];
    if (replay) {
      await assertFinancialChangeAccess(tx, {
        orgId,
        actorId,
        subsidiaryIds: replay.payload.requiredSubsidiaryIds as string[],
        permission: "close.run",
        feature: "multiSubsidiary",
      });
      return (await existingFinancialChange(tx, {
        orgId,
        actorId,
        subsidiaryId: replay.subsidiary_id,
        domain: "consolidation",
        subjectId: interestId,
        operation: "loss_of_control",
        effectiveOn: input.effectiveOn,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        payload: {
          ...input,
          requiredSubsidiaryIds: replay.payload.requiredSubsidiaryIds,
        },
      }))!;
    }
    const s = await scope(tx, orgId, interestId, actorId, input),
      args = {
        orgId,
        subsidiaryId: s.parent.id,
        domain: "consolidation" as const,
        subjectId: interestId,
        operation: "loss_of_control",
        effectiveOn: input.effectiveOn,
        reason: input.reason,
        actorId,
        idempotencyKey: input.idempotencyKey,
        payload: { ...input, requiredSubsidiaryIds: s.requiredSubsidiaryIds },
      };
    const old = await existingFinancialChange(tx, args);
    if (old) return old;
    const calculated = await preview(tx, orgId, actorId, input, s, null);
    return proposeFinancialChange(tx, {
      ...args,
      beforeState: { ...s, ...calculated },
    });
  });
}
async function post(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  s: Pick<Scope, "bookId"> & { period: { id: string } },
  subsidiaryId: string,
  currency: string,
  date: string,
  lines: LossOfControlBalance[],
  number: string,
  reversesEntryId?: string,
) {
  const material = lines.filter((l) => !isZero(l.amount));
  if (!material.length) return null;
  const context = await loadSubsidiaryContext(tx, orgId),
    scoped = material.map((l) => ({ ...l, subsidiaryId }));
  await validateSubsidiaryRestrictions(tx, {
    orgId,
    ctx: context,
    docSubsidiaryId: subsidiaryId,
    lines: scoped,
  });
  const accountIds = [...new Set(material.map((line) => line.accountId))];
  const accounts = (
    await tx.execute<{ id: string }>(
      sql`select id from accounts where org_id=${orgId} and id=any(${uuidArray(accountIds)}::uuid[]) and is_active and not is_summary for share`,
    )
  ).rows;
  if (accounts.length !== accountIds.length)
    throw new Error(
      "restore the active posting accounts required by this approved disposal journal",
    );
  assertFinalKernelBalance(scoped);
  const id = randomUUID();
  await tx.execute(
    sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,memo,status,origin,reverses_entry_id,created_by,updated_by) values(${id},${orgId},${s.bookId},${subsidiaryId},${number},${date},${s.period.id},'Approved loss of control','draft','translation',${reversesEntryId ?? null},${actorId},${actorId})`,
  );
  for (const [i, l] of material.entries())
    await tx.execute(
      sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,memo) values(${orgId},${id},${i + 1},${l.accountId},${subsidiaryId},${l.amount},${currency},${l.amount},1,${l.description})`,
    );
  const posted = await tx.execute(
    sql`update journal_entries set status='posted',posted_at=now(),posted_by=${actorId},updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${id} and status='draft' returning id`,
  );
  if (posted.rows.length !== 1)
    throw new Error("loss-of-control journal was not posted");
  return id;
}
export async function applyLossOfControl(
  orgId: string,
  changeId: string,
  actorId: string,
): Promise<Record<string, unknown>> {
  return withOwnershipSourceTransaction(orgId, async (tx) => {
    const change = await loadFinancialChange(tx, orgId, changeId);
    if (
      change.domain !== "consolidation" ||
      change.operation !== "loss_of_control"
    )
      throw new Error("select a loss-of-control proposal");
    await assertFinancialChangeAccess(tx, {
      orgId,
      actorId,
      subsidiaryIds: change.payload.requiredSubsidiaryIds as string[],
      permission: "close.run",
      feature: "multiSubsidiary",
    });
    if (change.status === "applied") return change.result!;
    const input = change.payload as unknown as LossOfControlInput;
    validate(input);
    const s = await scope(tx, orgId, change.subject_id, actorId, input),
      calculated = await preview(tx, orgId, actorId, input, s, changeId);
    assertFinancialChangeApproved(change, {
      domain: "consolidation",
      subjectId: change.subject_id,
      beforeState: { ...s, ...calculated },
    });
    const approverScope = await actorAllowedSubsidiaryIds(
      tx,
      orgId,
      change.approved_by!,
    );
    if (
      approverScope &&
      s.requiredSubsidiaryIds.some((id) => !approverScope.has(id))
    )
      throw new Error(
        "the approver no longer covers every affected entity; obtain a new scoped approval",
      );
    const closed = await tx.execute(
      sql`update subsidiary_ownership_interests set effective_to=${input.effectiveOn},last_change_id=${changeId},updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${change.subject_id} returning id`,
    );
    if (closed.rows.length !== 1)
      throw new Error("ownership window could not be closed");
    const measured = await measure(tx, orgId, actorId, input, s, changeId);
    if (
      canonicalJson(measured.preview) !== canonicalJson(calculated.preview) ||
      canonicalJson(measured.parentLines) !==
        canonicalJson(calculated.parentLines)
    )
      throw new Error(
        "the final disposal measurement differs from its approved workpaper",
      );
    const parentEntry = await post(
      tx,
      orgId,
      actorId,
      s,
      s.parent.id,
      s.parent.baseCurrency,
      input.effectiveOn,
      measured.parentLines,
      `CONTROL-PARENT-${changeId}`,
    );
    const entry = await post(
      tx,
      orgId,
      actorId,
      s,
      s.elimination.id,
      s.elimination.baseCurrency,
      input.effectiveOn,
      measured.preview.lines,
      `CONTROL-GROUP-${changeId}`,
    );
    let retainedInterestId: string | null = null;
    if (input.retainedMethod === "equity") {
      retainedInterestId = randomUUID();
      const next = new Date(
        Date.parse(input.effectiveOn + "T00:00:00Z") + 86400000,
      )
        .toISOString()
        .slice(0, 10);
      await tx.execute(
        sql`insert into subsidiary_ownership_interests(id,org_id,parent_subsidiary_id,subsidiary_id,effective_from,ownership_percent,method,acquisition_date,acquisition_cost,fair_value_net_assets,acquisition_rate,nci_measurement,investment_account_id,equity_income_account_id,distribution_account_id,distribution_income_account_id,last_change_id,created_by,updated_by) values(${retainedInterestId},${orgId},${s.parent.id},${s.interest.subsidiary_id},${next},${input.retainedPercent},'equity',${next},${input.retainedFairValue},0,1,'proportionate',${input.retainedAccountId},${input.equityIncomeAccountId},${input.distributionAccountId},${input.distributionIncomeAccountId},${changeId},${actorId},${actorId})`,
      );
    }
    await tx.execute(
      sql`insert into consolidation_control_losses(org_id,change_id,interest_id,subsidiary_id,parent_subsidiary_id,elimination_subsidiary_id,book_id,period_id,effective_on,excluded_subsidiary_ids,measurement,parent_journal_entry_id,journal_entry_id,retained_method,retained_interest_id,created_by) values(${orgId},${changeId},${s.interest.id},${s.interest.subsidiary_id},${s.parent.id},${s.elimination.id},${s.bookId},${s.period.id},${input.effectiveOn},${JSON.stringify(s.family)}::jsonb,${JSON.stringify({ ...measured, closingRates: input.rates, factors: s.factors, originalEffectiveTo: s.interest.effective_to })}::jsonb,${parentEntry},${entry},${input.retainedMethod},${retainedInterestId},${actorId})`,
    );
    const result = {
      entryIds: [...measured.generatedEntryIds, parentEntry, entry].filter(
        (id): id is string => !!id,
      ),
      retainedInterestId,
      groupGain: measured.preview.totalGroupGain,
      effectiveOn: input.effectiveOn,
    };
    await completeFinancialChange(tx, orgId, changeId, actorId, result);
    return result;
  });
}

/** Correct an erroneous disposal in its original open period. A later change
 * in control is a new acquisition, not a rewrite of the disposed window. */
async function reversalState(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  sourceChangeId: string,
) {
  const source = await loadFinancialChange(tx, orgId, sourceChangeId);
  if (
    source.domain !== "consolidation" ||
    source.operation !== "loss_of_control" ||
    source.status !== "applied"
  )
    throw new Error("select an applied loss-of-control change");
  const loss = (
    await tx.execute<{
      id: string;
      interest_id: string;
      retained_interest_id: string | null;
      book_id: string;
      period_id: string;
      effective_on: string;
      reversed_by_change_id: string | null;
      measurement: { originalEffectiveTo: string | null };
      parent_subsidiary_id: string;
      elimination_subsidiary_id: string;
    }>(
      sql`select *,effective_on::text from consolidation_control_losses where org_id=${orgId} and change_id=${sourceChangeId} for update`,
    )
  ).rows[0];
  if (!loss || loss.reversed_by_change_id)
    throw new Error("this loss of control has already been corrected");
  const requiredSubsidiaryIds = source.payload
    .requiredSubsidiaryIds as string[];
  await assertFinancialChangeAccess(tx, {
    orgId,
    actorId,
    subsidiaryIds: requiredSubsidiaryIds,
    permission: "close.run",
    feature: "multiSubsidiary",
  });
  await assertPeriodModulesOpen(tx, {
    orgId,
    periodId: loss.period_id,
    bookId: loss.book_id,
    subsidiaryIds: requiredSubsidiaryIds,
    modules: ["gl"],
  });
  if (
    loss.retained_interest_id &&
    (
      await tx.execute(
        sql`select 1 from ownership_consolidation_entries c join journal_entries e on e.org_id=c.org_id and e.id=c.journal_entry_id where c.org_id=${orgId} and c.interest_id=${loss.retained_interest_id} and e.status='posted' and not exists(select 1 from journal_entries r where r.org_id=e.org_id and r.reverses_entry_id=e.id and r.status in('posted','reversed')) limit 1`,
      )
    ).rows.length
  )
    throw new Error(
      "the retained interest has subsequent consolidation history; reverse its later consolidation entries before correcting this disposal",
    );
  const entries = (source.result?.entryIds ?? []) as string[];
  const journals = (
    await tx.execute<{
      id: string;
      subsidiary_id: string;
      book_id: string;
      status: string;
      reverses_entry_id: string | null;
      currency: string;
    }>(
      sql`select e.id,e.subsidiary_id,e.book_id,e.status,e.reverses_entry_id,s.base_currency as currency from journal_entries e join subsidiaries s on s.org_id=e.org_id and s.id=e.subsidiary_id where e.org_id=${orgId} and e.id=any(${uuidArray(entries)}::uuid[]) order by e.id for update of e`,
    )
  ).rows;
  if (
    journals.length !== entries.length ||
    journals.some((e) => e.status !== "posted")
  )
    throw new Error(
      "a disposal journal has subsequent correction history; retain that evidence and reconcile it before proposing a new disposal correction",
    );
  const lines = (
    await tx.execute<{
      entry_id: string;
      account_id: string;
      amount: string;
      memo: string | null;
    }>(
      sql`select entry_id,account_id,amount::text,memo from journal_lines where org_id=${orgId} and entry_id=any(${uuidArray(entries)}::uuid[]) order by entry_id,line_number`,
    )
  ).rows;
  const policies = (
    await tx.execute(
      sql`select * from subsidiary_ownership_interests where org_id=${orgId} and (id=${loss.interest_id} or id=${loss.retained_interest_id}) order by id for update`,
    )
  ).rows;
  return { source, loss, requiredSubsidiaryIds, journals, lines, policies };
}
export async function proposeLossOfControlReversal(
  orgId: string,
  sourceChangeId: string,
  actorId: string,
  reason: string,
  idempotencyKey: string,
) {
  return withOwnershipSourceTransaction(orgId, async (tx) => {
    const source = await loadFinancialChange(tx, orgId, sourceChangeId),
      requiredSubsidiaryIds = source.payload.requiredSubsidiaryIds as string[];
    await assertFinancialChangeAccess(tx, {
      orgId,
      actorId,
      subsidiaryIds: requiredSubsidiaryIds,
      permission: "close.run",
      feature: "multiSubsidiary",
    });
    const args = {
      orgId,
      actorId,
      subsidiaryId: source.subsidiary_id,
      domain: "consolidation" as const,
      subjectId: source.subject_id,
      operation: "reversal",
      effectiveOn: source.effective_on,
      reason,
      idempotencyKey,
      payload: {
        sourceChangeId,
        reason,
        idempotencyKey,
        requiredSubsidiaryIds,
      },
    };
    const old = await existingFinancialChange(tx, args);
    if (old) return old;
    return proposeFinancialChange(tx, {
      ...args,
      beforeState: await reversalState(tx, orgId, actorId, sourceChangeId),
    });
  });
}
export async function applyLossOfControlReversal(
  orgId: string,
  changeId: string,
  actorId: string,
): Promise<Record<string, unknown>> {
  return withOwnershipSourceTransaction(orgId, async (tx) => {
    const change = await loadFinancialChange(tx, orgId, changeId);
    await assertFinancialChangeAccess(tx, {
      orgId,
      actorId,
      subsidiaryIds: change.payload.requiredSubsidiaryIds as string[],
      permission: "close.run",
      feature: "multiSubsidiary",
    });
    if (change.status === "applied") return change.result!;
    if (change.domain !== "consolidation" || change.operation !== "reversal")
      throw new Error("select a consolidation correction");
    const state = await reversalState(
      tx,
      orgId,
      actorId,
      String(change.payload.sourceChangeId),
    );
    assertFinancialChangeApproved(change, {
      domain: "consolidation",
      subjectId: state.source.subject_id,
      beforeState: state,
    });
    const allowed = await actorAllowedSubsidiaryIds(
      tx,
      orgId,
      change.approved_by!,
    );
    if (allowed && state.requiredSubsidiaryIds.some((id) => !allowed.has(id)))
      throw new Error(
        "the independent approver no longer covers every affected entity",
      );
    const marked = await tx.execute(
      sql`update consolidation_control_losses set reversed_by_change_id=${changeId} where org_id=${orgId} and id=${state.loss.id} and reversed_by_change_id is null returning id`,
    );
    if (marked.rows.length !== 1)
      throw new Error("the disposal correction could not be recorded");
    if (state.loss.retained_interest_id) {
      const retired = await tx.execute(
        sql`update subsidiary_ownership_interests set is_active=false,last_change_id=${changeId},updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${state.loss.retained_interest_id} and is_active returning id`,
      );
      if (retired.rows.length !== 1)
        throw new Error("the retained interest could not be retired");
    }
    const reopened = await tx.execute(
      sql`update subsidiary_ownership_interests set effective_to=${state.loss.measurement.originalEffectiveTo},last_change_id=${changeId},updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${state.loss.interest_id} returning id`,
    );
    if (reopened.rows.length !== 1)
      throw new Error("the original control window could not be restored");
    const entryIds: string[] = [];
    for (const entry of state.journals) {
      // Keep cancellation of an earlier consolidation generation intact. Its
      // replacement is regenerated below; reversing a reversal would resurrect
      // an unlinked old acquisition alongside that replacement.
      if (entry.reverses_entry_id) continue;
      const id = await post(
        tx,
        orgId,
        actorId,
        { bookId: entry.book_id, period: { id: state.loss.period_id } },
        entry.subsidiary_id,
        entry.currency,
        state.loss.effective_on,
        state.lines
          .filter((l) => l.entry_id === entry.id)
          .map((l) => ({
            accountId: l.account_id,
            amount: neg(l.amount),
            description: `Correction: ${l.memo ?? "loss of control"}`,
          })),
        `CONTROL-REV-${changeId}-${entry.id}`,
        entry.id,
      );
      if (id) entryIds.push(id);
      const reversed = await tx.execute(
        sql`update journal_entries set status='reversed',updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${entry.id} and status='posted' returning id`,
      );
      if (reversed.rows.length !== 1)
        throw new Error(
          "a disposal journal could not be linked to its correction",
        );
    }
    const restored = await runOwnershipConsolidationIn(
      orgId,
      state.loss.period_id,
      actorId,
      tx,
      {
        asOf: state.loss.effective_on,
        interestIds: (
          state.source.before_state as { ownershipInterestIds?: string[] }
        ).ownershipInterestIds ?? [state.loss.interest_id],
      },
    );
    entryIds.push(...restored.entryIds);
    const result = {
      entryIds,
      sourceChangeId: state.source.id,
      restoredInterestId: state.loss.interest_id,
    };
    await completeFinancialChange(tx, orgId, changeId, actorId, result);
    return result;
  });
}
