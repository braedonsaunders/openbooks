import type { CreditExposure, CreditGroup } from "./deferred-credit-pool.ts";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  db,
  withOrg,
  withTransactionSavepoint,
  type SqlExecutor,
} from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import {
  add,
  neg,
  sum,
  cmp,
  isZero,
  fromUnits,
  toUnits,
  roundDiv,
} from "../money/money.ts";
import { assertFinancialChangeAccess } from "../organization/financial-change-access.ts";
import {
  loadSubsidiaryContext,
  validateSubsidiaryRestrictions,
} from "../organization/subsidiaries.ts";
import {
  existingFinancialChange,
  proposeFinancialChange,
  loadFinancialChange,
  assertFinancialChangeApproved,
  completeFinancialChange,
} from "../platform/financial-changes.ts";
import {
  measureRevenueModificationGroup,
  modificationMoney,
  type RevenueModificationTreatment,
} from "./contract-modification-measurement.ts";
import {
  addDays,
  buildRecognitionScheduleOn,
  lockRevenueContract,
  recognitionUnearnedRemaining,
  runRevenueRecognition,
  recognitionProgressTarget,
  type RecognitionMethod,
  type RevenueChangeBasis,
} from "./recognition.ts";

export interface RevenueModificationPromise {
  existingId?: string;
  description: string;
  standaloneSellingPrice: string;
  recognitionRuleId: string;
  recognitionEndsOn?: string | null;
  percentComplete: string;
  deferredAccountId: string;
  recognizedAccountId: string;
  events?: { periodMonth: string; amount: string; description: string }[];
}
export interface RevenueModificationInput {
  effectiveOn: string;
  reason: string;
  idempotencyKey: string;
  subsidiaryId: string;
  /** Approval by the contractual parties, separate from internal accounting approval. */
  enforceableRightsEvidence: string;
  assessment: string;
  /** Historical/non-monetary recognition rate supported by the assessment,
   * not a silently selected current spot rate. One explicit rate per book. */
  bookRates: { bookId: string; fxRate: string }[];
  groups: {
    treatment: RevenueModificationTreatment;
    existingObligationIds: string[];
    considerationChange: string;
    remainingDistinct: boolean;
    additionsAtStandalonePrice: boolean;
    promises: RevenueModificationPromise[];
  }[];
}
export async function withRevenueChangeTransaction<T>(
  orgId: string,
  fn: (tx: SqlExecutor) => Promise<T>,
) {
  return withOrg(orgId, () => withTransactionSavepoint(db, () => fn(db)));
}
type Contract = {
  id: string;
  customer_id: string;
  project_id: string | null;
  contract_number: string;
  status: string;
  currency: string | null;
  subsidiary_id: string | null;
  revision: number;
  last_change_id: string | null;
  total_transaction_price: string;
  starts_on: string | null;
  ends_on: string | null;
  pricing: unknown;
};
type Obligation = {
  id: string;
  contract_id: string;
  description: string;
  status: string;
  allocated_price: string;
  recognition_rule_id: string;
  recognition_starts_on: string | null;
  recognition_ends_on: string | null;
  /** The OLD rule's start offset, pinned by recognition_rule_id. */
  start_offset_days: number;
  percent_complete: string | null;
  deferred_account_id: string | null;
  recognized_account_id: string | null;
  method: RecognitionMethod;
  is_forecast: boolean;
  source_subsidiary_id: string | null;
  item_id: string | null;
  document_line_id: string | null;
};
type Schedule = {
  id: string;
  obligation_id: string;
  book_id: string;
  total_amount: string;
  revision: number;
  change_basis: RevenueChangeBasis | null;
};
type PlanLine = {
  id: string;
  schedule_id: string;
  period_id: string;
  sequence: number;
  revision: number;
  planned_amount: string;
  recognized_amount: string | null;
  journal_entry_id: string | null;
  reversal_journal_entry_id: string | null;
  posting_date: string | null;
  starts_on: string;
  ends_on: string;
  modification_adjustment: boolean;
  superseded_by_change_id: string | null;
};
type Rule = {
  id: string;
  method: RecognitionMethod;
  is_forecast: boolean;
  is_active: boolean;
  recognition_periods: number | null;
  start_offset_days: number;
  period_offset: number;
  initial_amount_percent: string;
};
async function lockedContract(tx: SqlExecutor, orgId: string, id: string) {
  await lockRevenueContract(tx, orgId, id);
  // Recognition locks obligation then contract. Match that order to prevent
  // a modification-versus-posting inversion; re-read the full set below.
  await tx.execute(
    sql`select id from performance_obligations where org_id=${orgId} and contract_id=${id} order by id for update`,
  );
  const c = (
    await tx.execute<Contract>(sql`select id,customer_id,project_id,contract_number,status,currency,subsidiary_id,revision,last_change_id,total_transaction_price::text,starts_on::text,ends_on::text,pricing
    from revenue_contracts where org_id=${orgId} and id=${id} for update`)
  ).rows[0];
  if (!c) throw new Error("revenue contract not found");
  return c;
}
function validate(input: RevenueModificationInput) {
  if (!isIsoCalendarDate(input.effectiveOn))
    throw new Error("enter a calendar effective date");
  if (
    typeof input.enforceableRightsEvidence !== "string" ||
    input.enforceableRightsEvidence.trim().length < 8
  )
    throw new Error(
      "record evidence that the parties approved enforceable amended rights and obligations",
    );
  if (
    typeof input.assessment !== "string" ||
    input.assessment.trim().length < 8
  )
    throw new Error(
      "record the distinctness, price, progress and recognition-rate assessment",
    );
  if (
    !Array.isArray(input.groups) ||
    !input.groups.length ||
    input.groups.length > 100
  )
    throw new Error("enter between one and 100 modification groups");
  if (!Array.isArray(input.bookRates) || !input.bookRates.length)
    throw new Error(
      "provide a recognition exchange rate for every active posting book",
    );
  const ids = new Set<string>();
  for (const group of input.groups) {
    modificationMoney(group.considerationChange, "Consideration change");
    if (
      !Array.isArray(group.promises) ||
      !group.promises.length ||
      group.promises.length > 500
    )
      throw new Error("each group requires one to 500 promises");
    for (const id of group.existingObligationIds) {
      if (ids.has(id))
        throw new Error(
          "an existing obligation can belong to only one modification group",
        );
      ids.add(id);
    }
    for (const p of group.promises) {
      if (
        typeof p.description !== "string" ||
        !p.description.trim() ||
        p.description.length > 1000
      )
        throw new Error(
          "each promise needs a description of at most 1,000 characters",
        );
      modificationMoney(p.standaloneSellingPrice, "Standalone selling price");
      modificationMoney(p.percentComplete, "Progress");
      if (
        p.recognitionEndsOn &&
        (!isIsoCalendarDate(p.recognitionEndsOn) ||
          p.recognitionEndsOn < input.effectiveOn)
      )
        throw new Error(
          "remaining recognition end cannot precede the modification",
        );
      if (p.events && p.events.length > 1200)
        throw new Error(
          "a promise can carry at most 1,200 dated recognition events",
        );
      for (const e of p.events ?? []) {
        if (
          !isIsoCalendarDate(e.periodMonth) ||
          !e.periodMonth.endsWith("-01") ||
          e.periodMonth.slice(0, 7) < input.effectiveOn.slice(0, 7)
        )
          throw new Error(
            "new milestone/usage events must belong to the modification month or a later month",
          );
        modificationMoney(e.amount, "Event amount");
      }
    }
  }
}
function recognized(lines: PlanLine[]) {
  return sum(
    lines
      .filter((l) => l.journal_entry_id && !l.reversal_journal_entry_id)
      .map((l) => l.recognized_amount ?? "0"),
  );
}
/** Elapsed part of a time-based old promise, measured on actual service days.
 * It posts separately before the amendment, never under the revised price.
 *
 * The stub is measured from the OLD rule's effective start — the recognition
 * start shifted by the rule's start_offset_days through the same addDays
 * helper the schedule builder uses — never from the unshifted contract or
 * period start. A point-in-time promise earns nothing before its event date
 * and the full amount on or after it; a straight-line promise earns only the
 * post-offset days. A previously amended promise (change basis) was already
 * rebuilt from its amendment date with a zeroed offset, so its stub measures
 * from the stored recognition start with no further shift. */
function accruedBeforeChange(
  o: Obligation,
  lines: PlanLine[],
  effectiveOn: string,
  total: string,
  earned: string,
  basis?: RevenueChangeBasis | null,
  oldPolicy?: { startOffsetDays: number; contractStartsOn: string | null },
) {
  const method = basis?.method ?? o.method;
  if (method === "percent_complete")
    return add(
      recognitionProgressTarget(total, o.percent_complete ?? "0", basis),
      neg(earned),
    );
  const rows = lines.filter(
    (l) =>
      !l.journal_entry_id &&
      !l.superseded_by_change_id &&
      l.starts_on < effectiveOn &&
      l.ends_on >= effectiveOn,
  );
  if (method === "milestone" || method === "usage") return "0.0000";
  const anchor =
    o.recognition_starts_on ?? oldPolicy?.contractStartsOn ?? null;
  // A schedule already rewritten by a prior amendment runs from its stored
  // recognition start; only a first-generation schedule still carries the
  // rule offset the builder applied when it planned the lines.
  const offset = basis ? 0 : (oldPolicy?.startOffsetDays ?? 0);
  return sum(
    rows.map((l) => {
      const ruleStart = anchor ? addDays(anchor, offset) : null;
      const start =
        ruleStart && ruleStart > l.starts_on ? ruleStart : l.starts_on;
      const end =
        o.recognition_ends_on && o.recognition_ends_on < l.ends_on
          ? o.recognition_ends_on
          : l.ends_on;
      if (effectiveOn < start) return "0.0000";
      if (method === "point_in_time") return l.planned_amount;
      const day = (s: string) => BigInt(Date.parse(s) / 86400000);
      const elapsed = day(effectiveOn) - day(start),
        days = day(end) - day(start) + 1n;
      if (days <= 0n)
        throw new Error(
          "the current revenue schedule has an inverted service interval",
        );
      return fromUnits(
        roundDiv(
          toUnits(l.planned_amount) * (elapsed > days ? days : elapsed),
          days,
        ),
      );
    }),
  );
}
async function snapshot(
  tx: SqlExecutor,
  orgId: string,
  c: Contract,
  input: RevenueModificationInput,
) {
  if (!["active", "complete"].includes(c.status))
    throw new Error(
      "only an active or completed enforceable contract can be modified",
    );
  if (c.starts_on && input.effectiveOn < c.starts_on)
    throw new Error("a modification cannot precede contract inception");
  if (c.last_change_id) {
    const prior = await loadFinancialChange(tx, orgId, c.last_change_id);
    if (input.effectiveOn < prior.effective_on)
      throw new Error(
        "a new modification cannot precede the current approved revision",
      );
  }
  const subsidiaries = (
    await tx.execute<{
      id: string;
      base_currency: string;
      is_active: boolean;
      is_elimination: boolean;
    }>(
      sql`select id,base_currency,is_active,is_elimination from subsidiaries where org_id=${orgId} order by id for share`,
    )
  ).rows;
  const owner = subsidiaries.find((s) => s.id === input.subsidiaryId);
  if (!owner || !owner.is_active || owner.is_elimination)
    throw new Error("select an active operating legal entity");
  if (c.subsidiary_id && c.subsidiary_id !== owner.id)
    throw new Error(
      "a modification cannot move a contract to another legal entity",
    );
  const obligations = (
    await tx.execute<Obligation>(sql`select o.id,o.contract_id,o.description,o.status,o.allocated_price::text,o.recognition_rule_id,r.start_offset_days,
    o.recognition_starts_on::text,o.recognition_ends_on::text,o.percent_complete::text,
    coalesce(o.deferred_account_id,i.deferred_account_id,r.deferred_account_id) as deferred_account_id,
    coalesce(o.recognized_account_id,r.recognized_account_id,i.income_account_id) as recognized_account_id,
    r.method,r.is_forecast,coalesce(dl.subsidiary_id,d.subsidiary_id,p.subsidiary_id) as source_subsidiary_id,o.item_id,o.document_line_id
    from performance_obligations o join recognition_rules r on r.id=o.recognition_rule_id and r.org_id=o.org_id
    left join items i on i.id=o.item_id and i.org_id=o.org_id
    left join document_lines dl on dl.id=o.document_line_id and dl.org_id=o.org_id
    left join documents d on d.id=dl.document_id and d.org_id=dl.org_id
    left join projects p on p.id=${c.project_id} and p.org_id=o.org_id
    where o.contract_id=${c.id} and o.org_id=${orgId} order by o.id for update of o for share of r`)
  ).rows;
  if (
    obligations.some(
      (o) => o.source_subsidiary_id && o.source_subsidiary_id !== owner.id,
    )
  )
    throw new Error(
      "the contract contains performance in another legal entity; its source legal entities must be reconciled before changing it",
    );
  const selected = new Set(
    input.groups.flatMap((g) => g.existingObligationIds),
  );
  for (const id of selected)
    if (
      !obligations.some(
        (o) => o.id === id && o.status !== "cancelled" && !o.is_forecast,
      )
    )
      throw new Error(
        "each selected obligation must be a live actual-revenue promise in this contract",
      );
  const books = (
    await tx.execute<{ id: string; is_primary: boolean }>(
      sql`select id,is_primary from accounting_books where org_id=${orgId} and is_active and posts_gl order by is_primary desc,id for share`,
    )
  ).rows;
  if (!books.length || books.filter((b) => b.is_primary).length !== 1)
    throw new Error("configure one authoritative primary posting book");
  if (
    input.bookRates.length !== books.length ||
    new Set(input.bookRates.map((b) => b.bookId)).size !== books.length ||
    books.some((b) => !input.bookRates.some((r) => r.bookId === b.id))
  )
    throw new Error(
      "provide exactly one recognition rate for every active posting book",
    );
  const currency = c.currency ?? owner.base_currency;
  for (const r of input.bookRates) {
    const rate = canonicalDecimal(r.fxRate, 10);
    if (
      rate === null ||
      !/^\d+(\.\d+)?$/.test(rate) ||
      rate.split(".")[0]!.length > 18 ||
      BigInt(rate.replace(".", "")) === 0n
    )
      throw new Error(
        "recognition exchange rates must be positive exact decimals with at most ten fractional digits",
      );
    if (currency === owner.base_currency && !/^1(?:\.0+)?$/.test(rate))
      throw new Error(
        "a functional-currency contract requires a recognition exchange rate of one",
      );
  }
  const schedules = (
    await tx.execute<Schedule>(
      sql`select s.id,s.obligation_id,s.book_id,s.total_amount::text,s.revision,s.change_basis from recognition_schedules s join performance_obligations o on o.id=s.obligation_id and o.org_id=s.org_id where o.contract_id=${c.id} and s.org_id=${orgId} order by s.id for update of s`,
    )
  ).rows;
  const lines = (
    await tx.execute<PlanLine>(sql`select l.id,l.schedule_id,l.period_id,l.sequence,l.revision,l.planned_amount::text,l.recognized_amount::text,l.journal_entry_id,l.reversal_journal_entry_id,l.modification_adjustment,l.superseded_by_change_id,p.starts_on::text,p.ends_on::text,e.posting_date::text
    from recognition_schedule_lines l join recognition_schedules s on s.id=l.schedule_id and s.org_id=l.org_id join performance_obligations o on o.id=s.obligation_id and o.org_id=s.org_id
    join accounting_periods p on p.id=l.period_id and p.org_id=l.org_id left join journal_entries e on e.id=l.journal_entry_id and e.org_id=l.org_id
    where o.contract_id=${c.id} and l.org_id=${orgId} order by l.id for update of l`)
  ).rows;
  const unavailable = (
    await tx.execute<{
      name: string;
    }>(sql`select distinct b.name from recognition_schedules s join accounting_books b on b.id=s.book_id and b.org_id=s.org_id
    where s.org_id=${orgId} and s.obligation_id in(select jsonb_array_elements_text(${JSON.stringify([...selected])}::jsonb)::uuid)
      and (not b.is_active or not b.posts_gl) and exists(select 1 from recognition_schedule_lines l where l.org_id=s.org_id and l.schedule_id=s.id and l.journal_entry_id is null and l.superseded_by_change_id is null and l.planned_amount<>0)`)
  ).rows;
  if (unavailable.length)
    throw new Error(
      `The affected recognition plan belongs to an inactive or non-posting book (${unavailable.map((b) => b.name).join(", ")}). Enable its Active and Posts GL settings in Accounting setup → Accounting books before applying a change to that plan.`,
    );
  const events = (
    await tx.execute<{
      id: string;
      obligation_id: string;
      period_month: string;
      amount: string;
    }>(
      sql`select e.id,e.obligation_id,e.period_month,e.amount::text from recognition_events e join performance_obligations o on o.id=e.obligation_id and o.org_id=e.org_id where o.contract_id=${c.id} and e.org_id=${orgId} order by e.id for share of e`,
    )
  ).rows;
  const ruleIds = [
    ...new Set(
      input.groups.flatMap((g) => g.promises.map((p) => p.recognitionRuleId)),
    ),
  ];
  const rules = (
    await tx.execute<Rule>(
      sql`select id,method,is_forecast,is_active,recognition_periods,start_offset_days,period_offset,initial_amount_percent::text from recognition_rules where org_id=${orgId} and id in (select jsonb_array_elements_text(${JSON.stringify(ruleIds)}::jsonb)::uuid) order by id for share`,
    )
  ).rows;
  for (const g of input.groups)
    for (const promise of g.promises) {
      const rule = rules.find((r) => r.id === promise.recognitionRuleId);
      if (!rule || !rule.is_active || rule.is_forecast)
        throw new Error(
          "each revised promise needs an active actual-recognition rule",
        );
      // Accounts with existing earned history cannot be re-labelled as if prior
      // journals used different accounts. Reclassification is a separate entry.
      const old = promise.existingId
        ? obligations.find((o) => o.id === promise.existingId)
        : null;
      if (
        old &&
        (old.deferred_account_id !== promise.deferredAccountId ||
          old.recognized_account_id !== promise.recognizedAccountId)
      )
        throw new Error(
          "retain the existing promise accounts; post an approved account reclassification separately",
        );
      if (!promise.existingId && cmp(promise.percentComplete, "0") !== 0)
        throw new Error(
          "a new performance obligation starts with no prior recognized performance",
        );
      if (
        rule.method.startsWith("straight_line_") &&
        !promise.recognitionEndsOn
      )
        throw new Error(
          "enter the explicit remaining service end for a time-based amended promise",
        );
      if (
        (rule.method === "milestone" || rule.method === "usage") &&
        (promise.events ?? []).some((e) => cmp(e.amount, "0") < 0)
      )
        throw new Error(
          "new amendment events must be non-negative; corrections retain their original event lineage",
        );
    }
  const accountIds = [
    ...new Set(
      input.groups.flatMap((g) =>
        g.promises.flatMap((p) => [p.deferredAccountId, p.recognizedAccountId]),
      ),
    ),
  ];
  const accounts = (
    await tx.execute<{ id: string; is_active: boolean; is_summary: boolean }>(
      sql`select id,is_active,is_summary from accounts where org_id=${orgId} and id in (select jsonb_array_elements_text(${JSON.stringify(accountIds)}::jsonb)::uuid) order by id for share`,
    )
  ).rows;
  if (
    accountIds.some(
      (id) =>
        !accounts.some((a) => a.id === id && a.is_active && !a.is_summary),
    )
  )
    throw new Error(
      "revenue accounts must be active non-summary accounts in this organization",
    );
  await validateSubsidiaryRestrictions(tx, {
    orgId,
    ctx: await loadSubsidiaryContext(tx, orgId),
    docSubsidiaryId: owner.id,
    lines: accountIds.map((accountId) => ({
      accountId,
      amount: "0", // Scope validation only; no monetary posting is made here.
      subsidiaryId: owner.id,
    })),
  });
  const balances: Record<
    string,
    {
      allocated: string;
      recognized: string;
      stub: string;
      credits: string;
      creditBaseline: string;
      exposure: CreditExposure;
    }
  > = {};
  for (const b of books)
    for (const o of obligations.filter((o) => selected.has(o.id))) {
      const schedule = schedules.find(
        (s) => s.obligation_id === o.id && s.book_id === b.id,
      );
      if (!schedule)
        throw new Error(
          `build the missing recognition schedule for ${o.description} before proposing its modification`,
        );
      const own = lines.filter((l) => l.schedule_id === schedule.id);
      if (
        own.some(
          (l) =>
            l.journal_entry_id &&
            !l.reversal_journal_entry_id &&
            l.posting_date! >= input.effectiveOn,
        )
      )
        throw new Error(
          "revenue is already posted on or after the amendment date; use an open prospective date and an attributable correcting adjustment",
        );
      if (
        own.some(
          (l) =>
            !l.journal_entry_id &&
            !l.superseded_by_change_id &&
            !isZero(l.planned_amount) &&
            l.ends_on < input.effectiveOn,
        )
      )
        throw new Error(
          `run revenue recognition through the day before ${input.effectiveOn} before proposing this modification`,
        );
      if (!o.deferred_account_id)
        throw new Error(
          "the existing promise has no deferred/contract-asset account",
        );
      const cap = await recognitionUnearnedRemaining(tx, {
        orgId,
        obligationId: o.id,
        bookId: b.id,
        deferredAccountId: o.deferred_account_id,
      });
      const earned = recognized(own);
      const rawStub = accruedBeforeChange(
        o,
        own,
        input.effectiveOn,
        schedule.total_amount,
        earned,
        schedule.change_basis,
        { startOffsetDays: o.start_offset_days, contractStartsOn: c.starts_on },
      );
      const stub =
        cmp(rawStub, "0") > 0 && cmp(rawStub, cap.remaining) > 0
          ? cmp(cap.remaining, "0") > 0
            ? cap.remaining
            : "0.0000"
          : rawStub;
      balances[`${b.id}:${o.id}`] = {
        allocated: schedule.total_amount,
        recognized: add(earned, stub),
        stub,
        credits: cap.credited,
        exposure: cap.exposure,
        creditBaseline: add(
          schedule.change_basis?.creditBaseline ?? "0",
          cap.credited,
        ),
      };
    }
  const preview = books.map((book) => ({
    bookId: book.id,
    elapsedServiceAccruals: obligations
      .filter((o) => selected.has(o.id))
      .map((o) => ({
        description: o.description,
        amount: balances[`${book.id}:${o.id}`]!.stub,
      }))
      .filter((a) => !isZero(a.amount)),
    groups: input.groups.map((group) =>
      measureRevenueModificationGroup({
        treatment: group.treatment,
        considerationChange: group.considerationChange,
        existing: group.existingObligationIds.map((id) => ({
          id,
          allocated: balances[`${book.id}:${id}`]!.allocated,
          recognized: balances[`${book.id}:${id}`]!.recognized,
          netCredits: balances[`${book.id}:${id}`]!.credits,
        })),
        promises: group.promises.map((p) => ({
          existingId: p.existingId,
          ssp: p.standaloneSellingPrice,
          percentComplete: p.percentComplete,
        })),
        remainingDistinct: group.remainingDistinct,
        additionsAtStandalonePrice: group.additionsAtStandalonePrice,
      }),
    ),
  }));
  const creditGroups: Record<string, CreditGroup[]> = {};
  for (const book of books)
    creditGroups[book.id] = input.groups.map((group, i) => ({
      previous: group.existingObligationIds.map((id) => ({
        exposure: balances[`${book.id}:${id}`]!.exposure,
        baseline: balances[`${book.id}:${id}`]!.credits,
      })),
      weights: preview
        .find((p) => p.bookId === book.id)!
        .groups[i]!.promises.map((p) => p.remaining),
    }));
  return {
    contract: c,
    owner,
    currency,
    obligations,
    books,
    schedules,
    lines,
    events,
    rules,
    accounts,
    balances,
    creditGroups,
    preview,
    dayCountPolicy: "actual_service_days_before_modification",
  };
}
export async function proposeRevenueModification(
  orgId: string,
  contractId: string,
  actorId: string,
  input: RevenueModificationInput,
) {
  return withRevenueChangeTransaction(orgId, async (tx) => {
    const contract = await lockedContract(tx, orgId, contractId);
    await assertFinancialChangeAccess(tx, {
      orgId,
      actorId,
      subsidiaryIds: [input.subsidiaryId],
      permission: "ar.post",
      feature: "revenueRecognition",
    });
    const proposal = {
      orgId,
      actorId,
      subsidiaryId: input.subsidiaryId,
      domain: "revenue" as const,
      subjectId: contractId,
      operation: "contract_modification",
      effectiveOn: input.effectiveOn,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      payload: input as unknown as Record<string, unknown>,
    };
    const replay = await existingFinancialChange(tx, proposal);
    if (replay) return { changeId: replay };
    validate(input);
    const beforeState = await snapshot(tx, orgId, contract, input);
    return {
      changeId: await proposeFinancialChange(tx, { ...proposal, beforeState }),
    };
  });
}

async function appendAdjustment(
  tx: SqlExecutor,
  args: {
    orgId: string;
    schedule: Schedule;
    amount: string;
    date: string;
    actorId: string;
  },
) {
  if (isZero(args.amount)) return;
  const period = (
    await tx.execute<{
      id: string;
    }>(sql`select p.id from accounting_periods p join fiscal_calendars c on c.id=p.fiscal_calendar_id and c.org_id=p.org_id
    where p.org_id=${args.orgId} and not p.is_adjustment and c.is_default and c.is_active and p.starts_on<=${args.date}::date and p.ends_on>=${args.date}::date for share of p,c`)
  ).rows;
  if (period.length !== 1)
    throw new Error(
      `provision one default-calendar accounting period covering ${args.date}`,
    );
  const inserted =
    await tx.execute(sql`insert into recognition_schedule_lines(org_id,schedule_id,period_id,sequence,planned_amount,revision,modification_adjustment,recognition_on,created_by,updated_by)
    values(${args.orgId},${args.schedule.id},${period[0]!.id},
      (select coalesce(max(sequence),-1)+1 from recognition_schedule_lines where org_id=${args.orgId} and schedule_id=${args.schedule.id}),
      ${args.amount},${args.schedule.revision},true,${args.date},${args.actorId},${args.actorId}) returning id`);
  if (inserted.rows.length !== 1)
    throw new Error("revenue adjustment could not be recorded");
}
async function postAdjustments(
  orgId: string,
  actorId: string,
  date: string,
  obligationIds: string[],
  subsidiaryId: string,
) {
  const entryIds: string[] = [];
  for (const id of [...new Set(obligationIds)]) {
    const posted = await runRevenueRecognition(orgId, date, actorId, id, [
      subsidiaryId,
    ]);
    if (posted.problems.length) throw new Error(posted.problems.join("; "));
    entryIds.push(...posted.entries.map((e) => e.entryId));
    const pending = (
      await db.execute<{
        id: string;
      }>(sql`select l.id from recognition_schedule_lines l join recognition_schedules s on s.id=l.schedule_id and s.org_id=l.org_id
      where s.org_id=${orgId} and s.obligation_id=${id} and l.modification_adjustment and (l.journal_entry_id is null or l.recognized_amount<>l.planned_amount) and l.superseded_by_change_id is null and l.planned_amount<>0 and l.recognition_on<=${date}::date`)
    ).rows;
    if (pending.length)
      throw new Error(
        "a required amendment adjustment did not post; review the accounting book and period configuration",
      );
  }
  return entryIds;
}
export async function applyRevenueModification(
  orgId: string,
  changeId: string,
  actorId: string,
): Promise<Record<string, unknown>> {
  return withRevenueChangeTransaction(orgId, async (tx) => {
    const identity = (
      await tx.execute<{ subject_id: string }>(
        sql`select subject_id from financial_changes where org_id=${orgId} and id=${changeId} and domain='revenue'`,
      )
    ).rows[0];
    if (!identity) throw new Error("revenue modification not found");
    const contract = await lockedContract(tx, orgId, identity.subject_id);
    const change = await loadFinancialChange(tx, orgId, changeId);
    const input = change.payload as unknown as RevenueModificationInput;
    await assertFinancialChangeAccess(tx, {
      orgId,
      actorId,
      subsidiaryIds: [input.subsidiaryId],
      permission: "ar.post",
      feature: "revenueRecognition",
    });
    if (change.status === "applied") return change.result!;
    validate(input);
    const state = await snapshot(tx, orgId, contract, input);
    assertFinancialChangeApproved(change, {
      domain: "revenue",
      subjectId: contract.id,
      beforeState: state,
    });
    const affected = input.groups.flatMap((g) => g.existingObligationIds),
      entryIds: string[] = [];
    const scheduleIds = state.schedules
      .filter((s) => affected.includes(s.obligation_id))
      .map((s) => s.id);
    const archived =
      await tx.execute(sql`update recognition_schedule_lines set superseded_by_change_id=${changeId},updated_by=${actorId},updated_at=now()
      where org_id=${orgId} and schedule_id in(select jsonb_array_elements_text(${JSON.stringify(scheduleIds)}::jsonb)::uuid)
      and journal_entry_id is null and superseded_by_change_id is null returning id`);
    if (
      archived.rows.length !==
      state.lines.filter(
        (l) =>
          scheduleIds.includes(l.schedule_id) &&
          !l.journal_entry_id &&
          !l.superseded_by_change_id,
      ).length
    )
      throw new Error(
        "the future revenue plan changed while applying its approved amendment",
      );
    for (const schedule of state.schedules.filter(
      (s) =>
        affected.includes(s.obligation_id) &&
        state.books.some((b) => b.id === s.book_id),
    )) {
      const balance =
        state.balances[`${schedule.book_id}:${schedule.obligation_id}`]!;
      await appendAdjustment(tx, {
        orgId,
        schedule,
        amount: balance.stub,
        date: input.effectiveOn,
        actorId,
      });
    }
    entryIds.push(
      ...(await postAdjustments(
        orgId,
        actorId,
        input.effectiveOn,
        affected,
        input.subsidiaryId,
      )),
    );
    const primary = state.books.find((b) => b.is_primary)!;
    const primaryPreview = state.preview.find((b) => b.bookId === primary.id)!;
    const newContractIds: string[] = [],
      obligationIds: string[] = [],
      rebuild: { id: string; bookId: string }[] = [];
    let contractDelta = "0.0000";
    for (let gi = 0; gi < input.groups.length; gi++) {
      const group = input.groups[gi]!,
        primaryMeasured = primaryPreview.groups[gi]!;
      let targetContractId = contract.id;
      if (group.treatment === "separate") {
        targetContractId = randomUUID();
        const inserted =
          await tx.execute(sql`insert into revenue_contracts(id,org_id,customer_id,contract_number,status,starts_on,currency,total_transaction_price,subsidiary_id,parent_contract_id,pricing,created_by,updated_by)
          values(${targetContractId},${orgId},${contract.customer_id},${`${contract.contract_number}-M-${changeId}-${gi + 1}`},'active',${input.effectiveOn},${state.currency},${primaryMeasured.newTotal},${input.subsidiaryId},${contract.id},
            ${JSON.stringify({ changeId, enforceableRightsEvidence: input.enforceableRightsEvidence, assessment: input.assessment })}::jsonb,${actorId},${actorId}) returning id`);
        if (inserted.rows.length !== 1)
          throw new Error(
            "the separate revenue contract could not be recorded",
          );
        newContractIds.push(targetContractId);
      } else
        contractDelta = add(
          contractDelta,
          add(primaryMeasured.newTotal, neg(primaryMeasured.priorPrice)),
        );
      for (let pi = 0; pi < group.promises.length; pi++) {
        const promise = group.promises[pi]!,
          id = promise.existingId ?? randomUUID(),
          measured = primaryMeasured.promises[pi]!;
        if (promise.existingId) {
          const updated =
            await tx.execute(sql`update performance_obligations set description=${promise.description},allocated_price=${measured.allocated},standalone_selling_price=${promise.standaloneSellingPrice},
            recognition_rule_id=${promise.recognitionRuleId},recognition_starts_on=${input.effectiveOn},recognition_ends_on=${promise.recognitionEndsOn ?? null},percent_complete=${promise.percentComplete},
            deferred_account_id=${promise.deferredAccountId},recognized_account_id=${promise.recognizedAccountId},status='open',last_change_id=${changeId},updated_by=${actorId},updated_at=now()
            where org_id=${orgId} and id=${id} and contract_id=${contract.id} returning id`);
          if (updated.rows.length !== 1)
            throw new Error(
              "the revised performance obligation could not be saved",
            );
        } else {
          const inserted =
            await tx.execute(sql`insert into performance_obligations(id,org_id,contract_id,description,recognition_rule_id,standalone_selling_price,allocated_price,percent_complete,recognition_starts_on,recognition_ends_on,deferred_account_id,recognized_account_id,last_change_id,status,created_by,updated_by)
            values(${id},${orgId},${targetContractId},${promise.description},${promise.recognitionRuleId},${promise.standaloneSellingPrice},${measured.allocated},${promise.percentComplete},${input.effectiveOn},${promise.recognitionEndsOn ?? null},${promise.deferredAccountId},${promise.recognizedAccountId},${changeId},'open',${actorId},${actorId}) returning id`);
          if (inserted.rows.length !== 1)
            throw new Error(
              "the added performance obligation could not be saved",
            );
        }
        obligationIds.push(id);
        for (const book of state.books) {
          const oldSchedule = state.schedules.find(
            (s) => s.obligation_id === id && s.book_id === book.id,
          );
          const bookMeasured = state.preview.find((b) => b.bookId === book.id)!
            .groups[gi]!.promises[pi]!;
          const basis: RevenueChangeBasis = {
            changeId,
            effectiveOn: input.effectiveOn,
            treatment: group.treatment,
            totalAmount: bookMeasured.allocated,
            remaining: bookMeasured.remaining,
            targetRecognized: bookMeasured.targetRecognized,
            progressAtChange: promise.percentComplete,
            creditBaseline: "0",
            creditExposure: {
              kind: "modification",
              changeId,
              bookId: book.id,
              groupIndex: gi,
              promiseIndex: pi,
            },
            excludedEventIds: state.events
              .filter((e) => e.obligation_id === id)
              .map((e) => e.id),
            retired: false,
            deferredAccountId: promise.deferredAccountId,
            recognizedAccountId: promise.recognizedAccountId,
            currency: state.currency,
            functionalCurrency: state.owner.base_currency,
            method: state.rules.find((r) => r.id === promise.recognitionRuleId)!
              .method,
            fxRate: input.bookRates.find((r) => r.bookId === book.id)!.fxRate,
          };
          const scheduleId = oldSchedule?.id ?? randomUUID(),
            revision = (oldSchedule?.revision ?? 0) + 1;
          const written = oldSchedule
            ? await tx.execute(
                sql`update recognition_schedules set revision=${revision},total_amount=${bookMeasured.allocated},change_basis=${JSON.stringify(basis)}::jsonb,status='planned',updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${scheduleId} returning id`,
              )
            : await tx.execute(
                sql`insert into recognition_schedules(id,org_id,obligation_id,book_id,revision,total_amount,change_basis,status,created_by,updated_by) values(${scheduleId},${orgId},${id},${book.id},${revision},${bookMeasured.allocated},${JSON.stringify(basis)}::jsonb,'planned',${actorId},${actorId}) returning id`,
              );
          if (written.rows.length !== 1)
            throw new Error(
              "a book-specific amended revenue plan could not be saved",
            );
          await appendAdjustment(tx, {
            orgId,
            schedule: {
              id: scheduleId,
              obligation_id: id,
              book_id: book.id,
              total_amount: bookMeasured.allocated,
              revision,
              change_basis: basis,
            },
            amount: bookMeasured.catchUp,
            date: input.effectiveOn,
            actorId,
          });
          rebuild.push({ id, bookId: book.id });
        }
        for (let ei = 0; ei < (promise.events?.length ?? 0); ei++) {
          const e = promise.events![ei]!;
          const inserted =
            await tx.execute(sql`insert into recognition_events(org_id,obligation_id,period_month,amount,description,source_reference,created_by,updated_by)
            values(${orgId},${id},${e.periodMonth},${e.amount},${e.description},${`modification:${changeId}:${gi}:${pi}:${ei}`},${actorId},${actorId}) returning id`);
          if (inserted.rows.length !== 1)
            throw new Error("amended performance event could not be recorded");
        }
      }
      for (const retired of primaryMeasured.retired) {
        const updated = await tx.execute(
          sql`update performance_obligations set allocated_price=${retired.allocated},status='satisfied',last_change_id=${changeId},updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${retired.id} returning id`,
        );
        if (updated.rows.length !== 1)
          throw new Error("the extinguished promise could not be closed");
        for (const book of state.books) {
          const old = state.schedules.find(
              (s) => s.obligation_id === retired.id && s.book_id === book.id,
            )!,
            balance = state.balances[`${book.id}:${retired.id}`]!;
          const o = state.obligations.find((o) => o.id === retired.id)!;
          const basis: RevenueChangeBasis = {
            changeId,
            effectiveOn: input.effectiveOn,
            treatment: group.treatment,
            totalAmount: balance.recognized,
            remaining: "0.0000",
            targetRecognized: balance.recognized,
            progressAtChange: "100",
            creditBaseline: "0",
            creditExposure: { kind: "none" },
            excludedEventIds: state.events
              .filter((e) => e.obligation_id === o.id)
              .map((e) => e.id),
            retired: true,
            deferredAccountId: o.deferred_account_id!,
            recognizedAccountId: o.recognized_account_id!,
            currency: state.currency,
            functionalCurrency: state.owner.base_currency,
            method: o.method,
            fxRate: input.bookRates.find((r) => r.bookId === book.id)!.fxRate,
          };
          const saved = await tx.execute(
            sql`update recognition_schedules set revision=revision+1,total_amount=${balance.recognized},change_basis=${JSON.stringify(basis)}::jsonb,status='complete',updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${old.id} returning id`,
          );
          if (saved.rows.length !== 1)
            throw new Error("the extinguished book plan could not be closed");
        }
      }
    }
    entryIds.push(
      ...(await postAdjustments(
        orgId,
        actorId,
        input.effectiveOn,
        obligationIds,
        input.subsidiaryId,
      )),
    );
    for (const plan of rebuild)
      await buildRecognitionScheduleOn(
        tx,
        plan.id,
        orgId,
        actorId,
        plan.bookId,
        input.effectiveOn,
      );
    const newPrice = add(contract.total_transaction_price, contractDelta);
    if (cmp(newPrice, "0") < 0)
      throw new Error(
        "the amendment would leave the contract with a negative transaction price",
      );
    const updated =
      await tx.execute(sql`update revenue_contracts set subsidiary_id=${input.subsidiaryId},revision=revision+1,last_change_id=${changeId},total_transaction_price=${newPrice},
      status=${input.groups.some((g) => g.treatment !== "separate") ? "active" : contract.status},pricing=pricing||${JSON.stringify({ lastModificationId: changeId })}::jsonb,updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${contract.id} and revision=${contract.revision} returning id`);
    if (updated.rows.length !== 1)
      throw new Error("the revenue contract revision could not be finalized");
    const result = {
      revision: contract.revision + 1,
      newTransactionPrice: newPrice,
      entryIds,
      obligationIds,
      separateContractIds: newContractIds,
      preview: state.preview,
    };
    await completeFinancialChange(tx, orgId, changeId, actorId, result);
    return result;
  });
}
