import { lockApprovalSubject } from "../platform/approval-routing.ts";
import { requestNativeCommandApproval } from "../platform/approval-routing.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { sql, and, eq } from "drizzle-orm";
import { db, schema, withOrg, type SqlExecutor } from "../platform/db.ts";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { activePostingPrimaryBookId } from "../platform/accounting-books.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { reversalJournalLines } from "../records/reversal-journal-lines.ts";
import { postEntry, markEntryReversed, type PostEntryLineInput } from "../journal/post-entry.ts";
import { add, cmp, mulRate, neg, sum } from "../money/money.ts";
import {
  earnedRebates,
  selectRebateDeals,
  validateRebateTerms,
  RebateError,
  type RebateTerms,
  type RebateCandidate,
} from "./rebate-math.ts";
export { RebateError } from "./rebate-math.ts";

export type RebateAgreement = {
  id: string;
  code: string;
  name: string;
  status: string;
  subsidiary_id: string;
  side: "customer" | "vendor";
  activity: "sale" | "purchase" | "downstream_sale";
  party_id: string | null;
  class_id: string | null;
  item_id: string | null;
  currency: string;
  effective_from: string;
  effective_to: string;
  method: RebateTerms["method"];
  tier_basis: RebateTerms["tierBasis"];
  tiers: RebateTerms["tiers"];
  target_unit_cost: string | null;
  margin_percent: string | null;
  stacking: "stack" | "best";
  tax_treatment: "outside_scope" | "taxable";
  settlement_tax_code_id: string | null;
  selection_group: string;
  accrual_account_id: string;
  offset_account_id: string;
  fx_account_id: string;
  created_by: string;
};
type EligibleLine = {
  id: string;
  amount: string;
  quantity: string;
  cost: string | null;
  marginRevenue: string | null;
  fx_rate: string;
  party_id: string;
  document_date: string;
  class_id: string | null;
};
export type RebateClaim = {
  id: string;
  agreement_id: string;
  party_id: string;
  amount: string;
  base_amount: string;
  status: string;
  cutoff_on: string;
  created_by: string;
  approved_by: string | null;
  settlement_document_id: string | null;
  settlement_entry_id?: string | null;
  settlement_basis?: unknown;
};
async function enabled(tx: SqlExecutor, orgId: string) {
  if (!(await lockAndCheckOrgFeature(tx, orgId, "rebateManagement")))
    throw new RebateError("Enable Rebate management in Company Settings → Features");
}
async function mutex(tx: SqlExecutor, orgId: string, subsidiaryId: string) {
  await lockLedgerSetupFence(tx, orgId, "shared");
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${orgId}),hashtext(${`rebates:${subsidiaryId}`}))`,
  );
}
function permission(side: string) {
  return side === "customer" ? "ar.post" : "ap.post";
}
async function agreement(tx: SqlExecutor, orgId: string, id: string): Promise<RebateAgreement> {
  const row = (
    await tx.execute<RebateAgreement>(
      sql`select * from rebate_agreements where org_id=${orgId} and id=${id}`,
      "objects",
    )
  )[0];
  if (!row) throw new ScopeNotFoundError();
  return row;
}
export async function approveRebateAgreement(
  orgId: string,
  actorId: string,
  id: string,
  reason: string,
  approvalRunId?: string,
) {
  if (reason.trim().length < 8) throw new RebateError("Enter an approval reason");
  return withOrg(orgId, async () => {
    const identity = (
      await db.execute<{ side: string }>(
        sql`select side from rebate_agreements where org_id=${orgId} and id=${id}`,
        "objects",
      )
    )[0];
    if (!identity) throw new ScopeNotFoundError();
    await lockApprovalSubject(orgId, `${identity.side}_rebate_agreement`, id);
    await lockLedgerSetupFence(db, orgId, "shared");
    const row = await agreement(db, orgId, id);
    await mutex(db, orgId, row.subsidiary_id);
    await enabled(db, orgId);
    await lockActorCommandAuthority(db, orgId, actorId, row.subsidiary_id, permission(row.side));
    const current = (
      await db.execute<RebateAgreement>(
        sql`select * from rebate_agreements where org_id=${orgId} and id=${id} for update`,
        "objects",
      )
    )[0]!;
    if (current.status !== "draft") throw new RebateError("This agreement is already approved");
    if (
      await requestNativeCommandApproval({
        orgId,
        actorId,
        subjectKind: `${current.side}_rebate_agreement`,
        subjectId: id,
        command: { reason: reason.trim() },
        approvalRunId,
      })
    )
      return { id, pendingApproval: true };
    validateRebateTerms({
      method: current.method,
      tierBasis: current.tier_basis,
      tiers: current.tiers,
      targetUnitCost: current.target_unit_cost,
      marginPercent: current.margin_percent,
    });
    if (
      !(
        await db.execute(
          sql`update rebate_agreements set status='approved',approved_by=${actorId},approved_at=now(),updated_by=${actorId},updated_at=now()
      where org_id=${orgId} and id=${id} and status='draft' returning id`,
          "objects",
        )
      )[0]
    )
      throw new RebateError("Agreement approval could not be saved");
    await audit(db, orgId, actorId, "rebate_agreements", id, "approve", reason, current, {
      status: "approved",
    });
    return { id };
  });
}
async function audit(
  tx: SqlExecutor,
  orgId: string,
  actorId: string | null,
  table: string,
  id: string,
  action: string,
  reason: string,
  before: unknown,
  after: unknown,
) {
  if (
    !(
      await tx.execute(
        sql`insert into audit_log(org_id,actor_id,action,table_name,row_id,changes)
    values(${orgId},${actorId},${action},${table},${id},${JSON.stringify({ reason, before, after })}::jsonb) returning id`,
        "objects",
      )
    )[0]
  )
    throw new RebateError("Rebate audit evidence could not be saved");
}

async function eligibleLines(
  tx: SqlExecutor,
  orgId: string,
  a: RebateAgreement,
  date: string,
): Promise<EligibleLine[]> {
  const kinds =
    a.activity === "purchase"
      ? ["vendor_bill", "vendor_credit"]
      : ["customer_invoice", "cash_sale", "customer_credit", "cash_refund"];
  return await tx.execute<EligibleLine>(
    sql`
    select dl.id, (dl.amount * case when d.kind in ('vendor_credit','customer_credit','cash_refund') then -1 else 1 end)::text as amount,
      (coalesce(dl.quantity,1) * case when d.kind in ('vendor_credit','customer_credit','cash_refund') then -1 else 1 end)::text as quantity,
      d.fx_rate::text, ${a.side === "vendor" ? sql`${a.party_id}::uuid` : sql`d.party_id`} as party_id, d.document_date::text,
      coalesce(dl.class_id,d.class_id) as class_id,
      case when ${a.activity}='downstream_sale' then (dl.amount * case when d.kind in ('customer_credit','cash_refund') then -1 else 1 end)::text
        else (select c.resale_amount * case when d.kind in ('vendor_credit','customer_credit','cash_refund') then -1 else 1 end from rebate_cost_attestations c where c.org_id=dl.org_id and c.document_line_id=dl.id and c.currency=d.currency and c.line_basis->>'itemId' IS NOT DISTINCT FROM dl.item_id::text and (c.line_basis->>'quantity')::numeric IS NOT DISTINCT FROM dl.quantity order by c.revision desc limit 1)::text end as "marginRevenue",
      case when ${a.activity}='purchase' or ${a.side}='customer' then (dl.amount * case when d.kind in ('vendor_credit','customer_credit','cash_refund') then -1 else 1 end)::text
        else coalesce(
          (select (-sum(m.total_value)) / nullif(d.fx_rate,0) from inventory_movements m where m.org_id=dl.org_id and m.document_line_id=dl.id and m.status='posted'),
          (select c.cost_amount * case when d.kind in ('customer_credit','cash_refund') then -1 else 1 end from rebate_cost_attestations c where c.org_id=dl.org_id and c.document_line_id=dl.id and c.currency=d.currency and c.line_basis->>'itemId' IS NOT DISTINCT FROM dl.item_id::text and (c.line_basis->>'quantity')::numeric IS NOT DISTINCT FROM dl.quantity order by c.revision desc limit 1)
        )::numeric(19,4)::text end as cost
    from document_lines dl join documents d on d.id=dl.document_id and d.org_id=dl.org_id
    where dl.org_id=${orgId} and d.status='posted' and d.kind in ${kinds} and d.party_id is not null
      and coalesce(dl.subsidiary_id,d.subsidiary_id,(select id from subsidiaries where org_id=${orgId} and parent_id is null))=${a.subsidiary_id}
      and d.currency=${a.currency} and d.document_date<=${date} and d.document_date>=${a.effective_from} and d.document_date<=${a.effective_to}
      ${a.activity === "downstream_sale" || a.party_id === null ? sql`` : sql`and d.party_id=${a.party_id}`}
      ${a.class_id ? sql`and coalesce(dl.class_id,d.class_id)=${a.class_id}` : sql``}
      ${a.item_id ? sql`and dl.item_id=${a.item_id}` : sql``}
      and not exists(select 1 from rebate_claims claim where claim.org_id=d.org_id and claim.settlement_document_id=d.id)
    order by d.document_date,dl.id
  `,
    "objects",
  );
}

/** Re-measure the approved earning periods in one legal entity. Target changes
 * are appended as signed accrual deltas, including returns, voids and retroactive
 * tier crossings. The triggering document's posting unit owns this transaction. */
export async function accrueRebatesForDocument(
  orgId: string,
  documentId: string,
  actorId: string | null,
  postingDate?: string,
) {
  return withOrg(orgId, async () => {
    await lockLedgerSetupFence(db, orgId, "shared");
    const doc = (
      await db.execute<{ subsidiary_id: string; posting_date: string; kind: string }>(
        sql`select coalesce(subsidiary_id,(select id from subsidiaries where org_id=${orgId} and parent_id is null)) as subsidiary_id,coalesce(posting_date,document_date)::text as posting_date,kind from documents where org_id=${orgId} and id=${documentId}`,
        "objects",
      )
    )[0];
    if (!doc) throw new ScopeNotFoundError();
    if (
      ![
        "customer_invoice",
        "cash_sale",
        "customer_credit",
        "cash_refund",
        "vendor_bill",
        "vendor_credit",
      ].includes(doc.kind)
    )
      return;
    if (!(await lockAndCheckOrgFeature(db, orgId, "rebateManagement"))) return;
    if (!doc.subsidiary_id) throw new RebateError("Rebate posting requires a legal entity");
    await mutex(db, orgId, doc.subsidiary_id);
    await refreshEntityAccruals(
      db,
      orgId,
      doc.subsidiary_id,
      actorId,
      postingDate ?? doc.posting_date,
      documentId,
    );
  });
}
async function refreshEntityAccruals(
  tx: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  actorId: string | null,
  date: string,
  sourceDocumentId: string,
) {
  const agreements = await tx.execute<RebateAgreement>(
    sql`select * from rebate_agreements where org_id=${orgId} and subsidiary_id=${subsidiaryId} and status='approved' order by id for share`,
    "objects",
  );
  if (!agreements.length) return;
  if (
    (
      await tx.execute(
        sql`select id from rebate_accruals where org_id=${orgId} and accrued_on>${date} and agreement_id in (select id from rebate_agreements where org_id=${orgId} and subsidiary_id=${subsidiaryId}) limit 1`,
        "objects",
      )
    )[0]
  )
    throw new RebateError(
      "A later rebate assessment exists; use that date or a later posting date for the correction",
    );
  const facts = await tx.execute<{
    agreement_id: string;
    document_line_id: string;
    party_id: string;
    earned: string;
    fx_rate: string;
    revision: number;
  }>(
    sql`
    select a.agreement_id,a.document_line_id,a.party_id,sum(a.amount)::text as earned,max(a.fx_rate)::text as fx_rate,max(a.revision) as revision
    from rebate_accruals a join rebate_agreements p on p.org_id=a.org_id and p.id=a.agreement_id
    where a.org_id=${orgId} and p.subsidiary_id=${subsidiaryId} group by a.agreement_id,a.document_line_id,a.party_id
  `,
    "objects",
  );
  const candidates: RebateCandidate[] = [];
  const basis = new Map<string, EligibleLine>();
  const policies = new Map(agreements.map((a) => [a.id, a]));
  for (const a of agreements) {
    const eligible = await eligibleLines(tx, orgId, a, date);
    const recipients = new Map<string, EligibleLine[]>();
    for (const l of eligible) {
      recipients.set(l.party_id, [...(recipients.get(l.party_id) ?? []), l]);
      basis.set(`${a.id}:${l.id}`, l);
    }
    for (const lines of recipients.values()) {
      const earned = earnedRebates(
        {
          method: a.method,
          tierBasis: a.tier_basis,
          tiers: a.tiers,
          targetUnitCost: a.target_unit_cost,
          marginPercent: a.margin_percent,
        },
        lines,
      );
      for (const l of lines)
        candidates.push({
          agreementId: a.id,
          lineId: l.id,
          amount: earned.get(l.id)!,
          stacking: a.stacking,
          selectionGroup: `${a.side}:${l.party_id}:${a.currency}:${a.selection_group}`,
        });
    }
  }
  const selected = selectRebateDeals(candidates);
  const targets = new Map(selected.map((c) => [`${c.agreementId}:${c.lineId}`, c.amount]));
  const previous = new Map(facts.map((f) => [`${f.agreement_id}:${f.document_line_id}`, f]));
  const keys = new Set([...targets.keys(), ...previous.keys()]);
  const bookId = await activePostingPrimaryBookId(orgId, tx);
  const period = await resolveCoveringPeriod(tx, orgId, date, subsidiaryId);
  if (!bookId || !period)
    throw new RebateError(
      "Configure an active primary posting book and an open accounting period for rebate accruals",
    );
  for (const key of [...keys].sort()) {
    const [agreementId, lineId] = key.split(":") as [string, string];
    const a = policies.get(agreementId)!;
    const old = previous.get(key);
    const target = targets.get(key) ?? "0";
    const delta = add(target, neg(old?.earned ?? "0"));
    if (cmp(delta, "0") === 0) continue;
    const line = basis.get(key);
    const fxRate = line?.fx_rate ?? old?.fx_rate;
    const partyId = line?.party_id ?? old?.party_id;
    if (!fxRate || !partyId)
      throw new RebateError("Rebate source currency and counterparty evidence are missing");
    const base = mulRate(delta, fxRate);
    const revision = (old?.revision ?? 0) + 1;
    const debit = a.side === "customer" ? a.offset_account_id : a.accrual_account_id;
    const credit = a.side === "customer" ? a.accrual_account_id : a.offset_account_id;
    const entry = await postEntry(tx, {
      orgId,
      bookId,
      subsidiaryId,
      periodId: period.id,
      postingDate: date,
      currency: a.currency,
      entryNumber: `REBATE-${agreementId}-${lineId}-${revision}`,
      idempotencyKey: `rebate:${agreementId}:${lineId}:${revision}`,
      origin: "rebate_accrual",
      closeModules: [a.side === "customer" ? "ar" : "ap"],
      sourceDocumentId,
      actorId,
      memo: `Rebate ${a.code} retrospective accrual`,
      auditChanges: { agreementId, target, previous: old?.earned ?? "0" },
      lines: [
        { accountId: debit, amount: base, txnAmount: delta, fxRate, partyId },
        { accountId: credit, amount: neg(base), txnAmount: neg(delta), fxRate, partyId },
      ],
    });
    if (
      !(
        await tx.execute(
          sql`insert into rebate_accruals(org_id,agreement_id,document_line_id,party_id,amount,base_amount,fx_rate,journal_entry_id,accrued_on,revision,basis,actor_id)
      values(${orgId},${agreementId},${lineId},${partyId},${delta},${base},${fxRate},${entry.entryId},${date},${revision},${JSON.stringify({ policy: a, line: line ?? null, previous: old?.earned ?? "0", target, selection: selected.filter((c) => c.lineId === lineId) })}::jsonb,${actorId}) returning id`,
          "objects",
        )
      )[0]
    )
      throw new RebateError("Rebate accrual could not be linked to its earned basis");
  }
}

export async function attestRebateCost(
  orgId: string,
  actorId: string,
  lineId: string,
  input: { costAmount: string; currency: string; evidence: string; resaleAmount?: string | null },
) {
  if (input.evidence.trim().length < 20 || cmp(input.costAmount, "0") < 0)
    throw new RebateError(
      "Enter a non-negative cost and at least twenty characters of supporting evidence",
    );
  return withOrg(orgId, async () => {
    await lockLedgerSetupFence(db, orgId, "shared");
    const identity = (
      await db.execute<{ subsidiary_id: string | null; kind: string }>(
        sql`select d.subsidiary_id,d.kind from document_lines l join documents d on d.org_id=l.org_id and d.id=l.document_id where l.org_id=${orgId} and l.id=${lineId} for share of d`,
        "objects",
      )
    )[0];
    if (!identity?.subsidiary_id) throw new ScopeNotFoundError();
    await lockActorCommandAuthority(
      db,
      orgId,
      actorId,
      identity.subsidiary_id,
      identity.kind.startsWith("vendor") ? "ap.post" : "ar.post",
    );
    await enabled(db, orgId);
    const row = (
      await db.execute<{
        currency: string;
        status: string;
        item_id: string | null;
        quantity: string | null;
      }>(
        sql`select d.currency,d.status,l.item_id,l.quantity::text from document_lines l join documents d on d.org_id=l.org_id and d.id=l.document_id where l.org_id=${orgId} and l.id=${lineId} for share of d for update of l`,
        "objects",
      )
    )[0];
    if (!row) throw new ScopeNotFoundError();
    if (row.currency !== input.currency || !["draft", "approved", "posted"].includes(row.status))
      throw new RebateError(
        "Select a native document line in the attested cost currency and legal entity",
      );
    if (
      !(
        await db.execute(
          sql`insert into rebate_cost_attestations(org_id,document_line_id,cost_amount,currency,evidence,actor_id,resale_amount,revision,line_basis) values(${orgId},${lineId},${input.costAmount},${input.currency},${input.evidence},${actorId},${input.resaleAmount ?? null},(select coalesce(max(revision),0)+1 from rebate_cost_attestations where org_id=${orgId} and document_line_id=${lineId}),${JSON.stringify({ itemId: row.item_id, quantity: row.quantity })}::jsonb) returning id`,
          "objects",
        )
      )[0]
    )
      throw new RebateError("Cost evidence could not be saved");
    return { id: lineId };
  });
}

export async function generateRebateClaim(
  orgId: string,
  actorId: string,
  agreementId: string,
  partyId: string,
  cutoffOn: string,
  reason: string,
) {
  if (!isIsoCalendarDate(cutoffOn) || reason.trim().length < 8)
    throw new RebateError("Enter the claim cutoff date and review reason");
  return withOrg(orgId, async () => {
    await lockLedgerSetupFence(db, orgId, "shared");
    const a = await agreement(db, orgId, agreementId);
    await mutex(db, orgId, a.subsidiary_id);
    await enabled(db, orgId);
    await lockActorCommandAuthority(db, orgId, actorId, a.subsidiary_id, permission(a.side));
    if (
      (
        await db.execute(
          sql`select id from rebate_claims where org_id=${orgId} and agreement_id=${agreementId} and party_id=${partyId} and cutoff_on>${cutoffOn} and status<>'cancelled' limit 1`,
          "objects",
        )
      )[0]
    )
      throw new RebateError("A later rebate claim exists; use its cutoff date or a later date");
    if (a.status !== "approved")
      throw new RebateError("Approve the rebate agreement before generating claims");
    const facts = await db.execute<{ id: string; amount: string; base_amount: string }>(
      sql`select id,amount::text,base_amount::text from rebate_accruals where org_id=${orgId} and agreement_id=${agreementId} and party_id=${partyId} and accrued_on<=${cutoffOn} order by id`,
      "objects",
    );
    const prior = await db.execute<{ amount: string; base_amount: string }>(
      sql`select amount::text,base_amount::text from rebate_claims where org_id=${orgId} and agreement_id=${agreementId} and party_id=${partyId} and status<>'cancelled'`,
      "objects",
    );
    const amount = add(sum(facts.map((f) => f.amount)), neg(sum(prior.map((c) => c.amount))));
    const base = add(
      sum(facts.map((f) => f.base_amount)),
      neg(sum(prior.map((c) => c.base_amount))),
    );
    if (cmp(amount, "0") === 0)
      throw new RebateError("No unclaimed earned rebate remains for this customer or vendor");
    const claim = (
      await db.execute<{ id: string }>(
        sql`insert into rebate_claims(org_id,agreement_id,party_id,amount,base_amount,cutoff_on,reason,basis,created_by,updated_by)
      values(${orgId},${agreementId},${partyId},${amount},${base},${cutoffOn},${reason},${JSON.stringify({ accrualIds: facts.map((f) => f.id), priorClaims: prior, agreement: a })}::jsonb,${actorId},${actorId}) returning id`,
        "objects",
      )
    )[0];
    if (!claim) throw new RebateError("Rebate claim could not be saved");
    return { id: claim.id };
  });
}
export async function rebateClaimContext(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  id: string,
) {
  const claim = (
    await tx.execute<RebateClaim>(
      sql`select * from rebate_claims where org_id=${orgId} and id=${id}`,
      "objects",
    )
  )[0];
  if (!claim) throw new ScopeNotFoundError();
  const a = await agreement(tx, orgId, claim.agreement_id);
  await mutex(tx, orgId, a.subsidiary_id);
  await enabled(tx, orgId);
  await lockActorCommandAuthority(tx, orgId, actorId, a.subsidiary_id, permission(a.side));
  const locked = (
    await tx.execute<RebateClaim>(
      sql`select * from rebate_claims where org_id=${orgId} and id=${id} for update`,
      "objects",
    )
  )[0];
  if (!locked) throw new ScopeNotFoundError();
  return { claim: locked, agreement: a };
}
export async function approveRebateClaim(
  orgId: string,
  actorId: string,
  id: string,
  reason: string,
  approvalRunId?: string,
) {
  if (reason.trim().length < 8) throw new RebateError("Enter an approval reason");
  return withOrg(orgId, async () => {
    const identity = (
      await db.execute<{ side: string }>(
        sql`select a.side from rebate_claims c join rebate_agreements a on a.org_id=c.org_id and a.id=c.agreement_id where c.org_id=${orgId} and c.id=${id}`,
        "objects",
      )
    )[0];
    if (!identity) throw new ScopeNotFoundError();
    await lockApprovalSubject(orgId, `${identity.side}_rebate_claim`, id);
    await lockLedgerSetupFence(db, orgId, "shared");
    const { claim, agreement: owningAgreement } = await rebateClaimContext(db, orgId, actorId, id);
    if (claim.status !== "draft") throw new RebateError("Only a draft claim can be approved");
    if (
      await requestNativeCommandApproval({
        orgId,
        actorId,
        subjectKind: `${owningAgreement.side}_rebate_claim`,
        subjectId: id,
        command: { reason: reason.trim() },
        approvalRunId,
      })
    )
      return { id, pendingApproval: true };
    if (
      !(
        await db.execute(
          sql`update rebate_claims set status='approved',approved_by=${actorId},approved_at=now(),updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${id} and status='draft' returning id`,
          "objects",
        )
      )[0]
    )
      throw new RebateError("Claim approval could not be saved");
    await audit(db, orgId, actorId, "rebate_claims", id, "approve", reason, claim, {
      status: "approved",
    });
    return { id };
  });
}

/** Bank settlement clears the claim's historical carrying amount and books
 * the explicit settlement-date FX difference through the agreement FX account. */
export async function settleRebatePayment(
  orgId: string,
  actorId: string,
  id: string,
  input: { postingDate: string; bankAccountId: string; fxRate: string; reason: string },
) {
  if (!isIsoCalendarDate(input.postingDate) || input.reason.trim().length < 8)
    throw new RebateError("Enter settlement date and reason");
  return withOrg(orgId, async () => {
    await lockLedgerSetupFence(db, orgId, "shared");
    const { claim, agreement: a } = await rebateClaimContext(db, orgId, actorId, id);
    if (
      claim.status === "settled" &&
      canonicalJson(claim.settlement_basis) !== canonicalJson(input)
    )
      throw new RebateError(
        "This claim is settled with different payment details; reverse the settlement before changing it",
      );
    if (claim.status === "settled")
      return {
        entryId: (
          await db.execute<{ settlement_entry_id: string }>(
            sql`select settlement_entry_id from rebate_claims where org_id=${orgId} and id=${id}`,
            "objects",
          )
        )[0]!.settlement_entry_id,
      };
    if (claim.status !== "approved")
      throw new RebateError("Approve the claim before bank settlement");
    if (a.tax_treatment !== "outside_scope")
      throw new RebateError(
        "Prepare the taxable native credit document first, then use native payment or credit application to settle its open item",
      );
    const bank = (
      await db.execute(
        sql`select id from accounts where org_id=${orgId} and id=${input.bankAccountId} and is_active and not is_summary and type='asset_bank' and (subsidiary_id is null or subsidiary_id=${a.subsidiary_id}) for share`,
        "objects",
      )
    )[0];
    if (!bank) throw new RebateError("Select a postable bank asset account");
    const bookId = await activePostingPrimaryBookId(orgId, db);
    const period = await resolveCoveringPeriod(db, orgId, input.postingDate, a.subsidiary_id);
    if (!bookId || !period)
      throw new RebateError("Configure the settlement book and accounting period");
    const baseCurrency = (
      await db.execute<{ base_currency: string }>(
        sql`select base_currency from subsidiaries where org_id=${orgId} and id=${a.subsidiary_id}`,
        "objects",
      )
    )[0]?.base_currency;
    if (!baseCurrency) throw new RebateError("Settlement requires the legal entity currency");
    const cash = mulRate(claim.amount, input.fxRate);
    const carrying = a.side === "customer" ? claim.base_amount : neg(claim.base_amount);
    const bankAmount = a.side === "customer" ? neg(cash) : cash;
    const difference = neg(add(carrying, bankAmount));
    const settlementRevision = (
      await db.execute<{ revision: string }>(
        sql`select count(*)::text as revision from rebate_settlement_reversals where org_id=${orgId} and claim_id=${id}`,
        "objects",
      )
    )[0]!.revision;
    const entry = await postEntry(db, {
      orgId,
      bookId,
      subsidiaryId: a.subsidiary_id,
      periodId: period.id,
      postingDate: input.postingDate,
      currency: a.currency,
      origin: "rebate_settlement",
      closeModules: [a.side === "customer" ? "ar" : "ap"],
      entryNumber: `REBATE-PAY-${id}-R${settlementRevision}`,
      idempotencyKey: `rebate-payment:${id}:revision:${settlementRevision}`,
      actorId,
      memo: input.reason,
      lines: [
        {
          accountId: a.accrual_account_id,
          amount: carrying,
          currency: baseCurrency,
          txnAmount: carrying,
          fxRate: "1",
          partyId: claim.party_id,
        },
        {
          accountId: input.bankAccountId,
          amount: bankAmount,
          txnAmount: a.side === "customer" ? neg(claim.amount) : claim.amount,
          fxRate: input.fxRate,
          partyId: claim.party_id,
        },
        ...(cmp(difference, "0") !== 0
          ? [
              {
                accountId: a.fx_account_id,
                amount: difference,
                currency: baseCurrency,
                txnAmount: difference,
                fxRate: "1",
                partyId: claim.party_id,
              },
            ]
          : []),
      ],
    });
    if (
      !(
        await db.execute(
          sql`update rebate_claims set status='settled',settlement_basis=${JSON.stringify(input)}::jsonb,settlement_entry_id=${entry.entryId},settlement_on=${input.postingDate},updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${id} and status='approved' returning id`,
          "objects",
        )
      )[0]
    )
      throw new RebateError("Payment could not be linked to its claim");
    await audit(db, orgId, actorId, "rebate_claims", id, "settle", input.reason, claim, {
      status: "settled",
      entryId: entry.entryId,
    });
    return { entryId: entry.entryId };
  });
}

/** Native credits and recovery invoices use the accrual account as their
 * financial leg. Linking the document does not settle a claim; only its posted
 * journal, checked here inside the posting unit, clears the claim. */
export async function recordRebateSettlementDocument(
  orgId: string,
  actorId: string,
  claimId: string,
  documentId: string,
) {
  const { claim } = await rebateClaimContext(db, orgId, actorId, claimId);
  if (claim.status !== "approved")
    throw new RebateError("Only an approved claim can create a settlement document");
  if (
    !(
      await db.execute(
        sql`update rebate_claims set status='document_pending',settlement_document_id=${documentId},updated_by=${actorId},updated_at=now()
    where org_id=${orgId} and id=${claimId} and status='approved' returning id`,
        "objects",
      )
    )[0]
  )
    throw new RebateError("Settlement document could not be linked");
  await audit(
    db,
    orgId,
    actorId,
    "rebate_claims",
    claimId,
    "prepare_settlement",
    "Prepared native settlement document",
    claim,
    { documentId },
  );
}
export function rebateSettlementKind(side: "customer" | "vendor", amount: string) {
  return side === "customer"
    ? cmp(amount, "0") > 0
      ? "customer_credit"
      : "customer_invoice"
    : cmp(amount, "0") > 0
      ? "vendor_credit"
      : "vendor_bill";
}
export async function settleRebateForPostedDocument(
  orgId: string,
  documentId: string,
  actorId: string | null,
) {
  const row = (
    await db.execute<RebateClaim>(
      sql`select * from rebate_claims where org_id=${orgId} and settlement_document_id=${documentId}`,
      "objects",
    )
  )[0];
  if (!row) return;
  const a = await agreement(db, orgId, row.agreement_id);
  await mutex(db, orgId, a.subsidiary_id);
  await enabled(db, orgId);
  if (a.tax_treatment === "taxable" && !a.settlement_tax_code_id)
    throw new RebateError(
      "Set the settlement tax code on the taxable rebate agreement, then prepare a new settlement document",
    );
  const claim = (
    await db.execute<RebateClaim>(
      sql`select * from rebate_claims where org_id=${orgId} and id=${row.id} for update`,
      "objects",
    )
  )[0]!;
  const doc = (
    await db.execute<{
      kind: string;
      status: string;
      party_id: string;
      subsidiary_id: string;
      currency: string;
      fx_rate: string;
      posting_date: string;
      posted_entry_id: string;
      amount: string;
      account_id: string;
      line_count: number;
      tax_total: string;
      tax_code_id: string | null;
      tax_group_id: string | null;
      tax_overridden: boolean;
    }>(
      sql`
    select d.kind,d.status,d.party_id,d.subsidiary_id,d.currency,d.fx_rate::text,coalesce(d.posting_date,d.document_date)::text as posting_date,d.posted_entry_id,d.tax_total::text,
      (select sum(l.amount)::text from document_lines l where l.org_id=d.org_id and l.document_id=d.id) as amount,
      (select l.account_id from document_lines l where l.org_id=d.org_id and l.document_id=d.id order by l.line_number limit 1) as account_id,
      (select l.tax_code_id from document_lines l where l.org_id=d.org_id and l.document_id=d.id order by l.line_number limit 1) as tax_code_id,
      (select l.tax_group_id from document_lines l where l.org_id=d.org_id and l.document_id=d.id order by l.line_number limit 1) as tax_group_id,
      (select l.tax_overridden from document_lines l where l.org_id=d.org_id and l.document_id=d.id order by l.line_number limit 1) as tax_overridden,
      (select count(*)::int from document_lines l where l.org_id=d.org_id and l.document_id=d.id) as line_count
    from documents d where d.org_id=${orgId} and d.id=${documentId}
  `,
      "objects",
    )
  )[0];
  if (claim.status === "settled") return;
  const absolute = cmp(claim.amount, "0") < 0 ? neg(claim.amount) : claim.amount;
  const taxMatches =
    doc &&
    (a.tax_treatment === "outside_scope"
      ? cmp(doc.tax_total, "0") === 0 && doc.tax_code_id === null && doc.tax_group_id === null
      : doc.tax_code_id === a.settlement_tax_code_id &&
        doc.tax_group_id === null &&
        !doc.tax_overridden);
  if (
    !doc ||
    doc.status !== "posted" ||
    doc.kind !== rebateSettlementKind(a.side, claim.amount) ||
    doc.party_id !== claim.party_id ||
    doc.subsidiary_id !== a.subsidiary_id ||
    doc.currency !== a.currency ||
    doc.line_count !== 1 ||
    doc.account_id !== a.accrual_account_id ||
    cmp(doc.amount, absolute) !== 0 ||
    !taxMatches ||
    !doc.posted_entry_id ||
    claim.status !== "document_pending"
  ) {
    throw new RebateError(
      "Restore the settlement document counterparty, currency, accrual account, exact claim amount and agreement tax treatment before posting",
    );
  }
  const booked = mulRate(claim.amount, doc.fx_rate);
  const difference = add(claim.base_amount, neg(booked));
  if (cmp(difference, "0") !== 0) {
    const bookId = await activePostingPrimaryBookId(orgId, db);
    const period = await resolveCoveringPeriod(db, orgId, doc.posting_date, a.subsidiary_id);
    const baseCurrency = (
      await db.execute<{ base_currency: string }>(
        sql`select base_currency from subsidiaries where org_id=${orgId} and id=${a.subsidiary_id}`,
        "objects",
      )
    )[0]?.base_currency;
    if (!bookId || !period || !baseCurrency)
      throw new RebateError("Settlement requires the entity currency and posting period");
    const accrualAdjustment = a.side === "customer" ? difference : neg(difference);
    await postEntry(db, {
      orgId,
      bookId,
      subsidiaryId: a.subsidiary_id,
      periodId: period.id,
      postingDate: doc.posting_date,
      currency: baseCurrency,
      actorId,
      sourceDocumentId: documentId,
      origin: "rebate_settlement",
      closeModules: [a.side === "customer" ? "ar" : "ap"],
      entryNumber: `REBATE-FX-${claim.id}-${documentId}`,
      idempotencyKey: `rebate-credit-fx:${documentId}`,
      memo: "Rebate settlement currency adjustment",
      lines: [
        { accountId: a.accrual_account_id, amount: accrualAdjustment, partyId: claim.party_id },
        { accountId: a.fx_account_id, amount: neg(accrualAdjustment), partyId: claim.party_id },
      ],
    });
  }
  if (
    !(
      await db.execute(
        sql`update rebate_claims set status='settled',settlement_entry_id=${doc.posted_entry_id},settlement_on=${doc.posting_date},updated_at=now(),updated_by=${actorId}
    where org_id=${orgId} and id=${claim.id} and status='document_pending' returning id`,
        "objects",
      )
    )[0]
  )
    throw new RebateError("Posted rebate settlement could not be linked");
  await audit(
    db,
    orgId,
    actorId,
    "rebate_claims",
    claim.id,
    "settle",
    "Posted native rebate settlement",
    claim,
    { entryId: doc.posted_entry_id },
  );
}

/** Refuse a changed settlement tax treatment before the document posting kernel validates tax totals. */
export async function assertRebateSettlementTaxBeforePosting(
  orgId: string,
  documentId: string,
): Promise<void> {
  const row = (
    await db.execute<{
      tax_treatment: "outside_scope" | "taxable";
      settlement_tax_code_id: string | null;
      tax_code_id: string | null;
      tax_group_id: string | null;
      tax_overridden: boolean;
      line_count: number;
    }>(
      sql`
    select a.tax_treatment,a.settlement_tax_code_id,l.tax_code_id,l.tax_group_id,l.tax_overridden,
      (select count(*)::int from document_lines all_lines where all_lines.org_id=d.org_id and all_lines.document_id=d.id) as line_count
    from rebate_claims c
    join rebate_agreements a on a.org_id=c.org_id and a.id=c.agreement_id
    join documents d on d.org_id=c.org_id and d.id=c.settlement_document_id
    join document_lines l on l.org_id=d.org_id and l.document_id=d.id
    where c.org_id=${orgId} and c.settlement_document_id=${documentId} and c.status='document_pending'
    order by l.line_number limit 1
    for update of c,a,d,l`,
      "objects",
    )
  )[0];
  if (!row) return;
  const taxMatches =
    row.tax_treatment === "outside_scope"
      ? row.tax_code_id === null && row.tax_group_id === null && !row.tax_overridden
      : row.settlement_tax_code_id !== null &&
        row.tax_code_id === row.settlement_tax_code_id &&
        row.tax_group_id === null &&
        !row.tax_overridden;
  if (row.line_count !== 1 || !taxMatches) {
    throw new RebateError(
      "Restore the settlement document counterparty, currency, accrual account, exact claim amount and agreement tax treatment before posting",
    );
  }
}

/** A generated settlement draft can be voided and prepared again. A posted
 * settlement must be reversed through its claim to retain accrual lineage. */
export async function rebateSettlementVoidContext(orgId: string, documentId: string) {
  const row = (
    await db.execute<RebateClaim>(
      sql`select * from rebate_claims where org_id=${orgId} and settlement_document_id=${documentId}`,
      "objects",
    )
  )[0];
  if (!row) return null;
  const a = await agreement(db, orgId, row.agreement_id);
  await mutex(db, orgId, a.subsidiary_id);
  return (
    (
      await db.execute<RebateClaim>(
        sql`select * from rebate_claims where org_id=${orgId} and id=${row.id} for update`,
        "objects",
      )
    )[0] ?? null
  );
}
export async function releaseVoidedRebateDraft(orgId: string, actorId: string, claim: RebateClaim) {
  if (claim.status !== "document_pending")
    throw new RebateError("Reverse the posted settlement through the rebate claim before voiding");
  if (
    !(
      await db.execute(
        sql`update rebate_claims set status='approved',settlement_document_id=null,updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${claim.id} and status='document_pending' returning id`,
        "objects",
      )
    )[0]
  )
    throw new RebateError("Voided draft could not be released from its claim");
  await audit(
    db,
    orgId,
    actorId,
    "rebate_claims",
    claim.id,
    "release_settlement",
    "Voided native settlement draft",
    claim,
    { status: "approved" },
  );
}

export async function releaseVoidedRebateSettlement(
  orgId: string,
  actorId: string,
  claim: RebateClaim,
  reversalEntryId: string | null,
  date: string,
  reason: string,
) {
  if (claim.status === "document_pending") return releaseVoidedRebateDraft(orgId, actorId, claim);
  if (claim.status !== "settled" || !claim.settlement_entry_id || !reversalEntryId)
    throw new RebateError("Rebate settlement reversal evidence is missing");
  if (
    !(
      await db.execute(
        sql`insert into rebate_settlement_reversals(org_id,claim_id,original_entry_id,reversal_entry_id,reversed_on,reason,actor_id)
    values(${orgId},${claim.id},${claim.settlement_entry_id},${reversalEntryId},${date},${reason},${actorId}) returning id`,
        "objects",
      )
    )[0]
  )
    throw new RebateError("Settlement reversal could not be recorded");
  if (
    !(
      await db.execute(
        sql`update rebate_claims set status='approved',settlement_document_id=null,settlement_entry_id=null,settlement_on=null,settlement_basis=null,updated_at=now(),updated_by=${actorId}
    where org_id=${orgId} and id=${claim.id} and status='settled' returning id`,
        "objects",
      )
    )[0]
  )
    throw new RebateError("Reversed rebate claim could not be reopened");
  await audit(db, orgId, actorId, "rebate_claims", claim.id, "reverse_settlement", reason, claim, {
    status: "approved",
    reversalEntryId,
  });
}

export async function reverseRebatePayment(
  orgId: string,
  actorId: string,
  id: string,
  date: string,
  reason: string,
) {
  if (!isIsoCalendarDate(date) || reason.trim().length < 8)
    throw new RebateError("Enter reversal date and review reason");
  return withOrg(orgId, async () => {
    await lockLedgerSetupFence(db, orgId, "shared");
    const { claim, agreement: a } = await rebateClaimContext(db, orgId, actorId, id);
    if (claim.status !== "settled" || claim.settlement_document_id || !claim.settlement_entry_id)
      throw new RebateError(
        "Select a settled bank payment; reverse credit settlements through their native document",
      );
    const original = (
      await db.execute<{ book_id: string }>(
        sql`select book_id from journal_entries where org_id=${orgId} and id=${claim.settlement_entry_id} and status='posted' for update -- Live entries only: an already reversed rebate settlement cannot be reversed again.
      `,
        "objects",
      )
    )[0];
    const period = await resolveCoveringPeriod(db, orgId, date, a.subsidiary_id);
    if (!original || !period)
      throw new RebateError("The original settlement or reversal accounting period is unavailable");
    const lines = await db
      .select()
      .from(schema.journalLines)
      .where(
        and(
          eq(schema.journalLines.orgId, orgId),
          eq(schema.journalLines.entryId, claim.settlement_entry_id),
        ),
      );
    const entry = await postEntry(db, {
      orgId,
      bookId: original.book_id,
      subsidiaryId: a.subsidiary_id,
      postingDate: date,
      periodId: period.id,
      entryNumber: `REBATE-REV-${claim.settlement_entry_id}`,
      idempotencyKey: `rebate-payment-reversal:${claim.settlement_entry_id}`,
      origin: "rebate_settlement",
      closeModules: [a.side === "customer" ? "ar" : "ap"],
      actorId,
      reversesEntryId: claim.settlement_entry_id,
      memo: reason,
      amountBasis: "book",
      accountBasis: "book",
      lines: reversalJournalLines(lines, { orgId, entryId: claim.settlement_entry_id }).map(
        (line) => ({
          ...line,
          accountId: line.accountId,
          amount: String(line.amount),
          extraDims: line.extraDims as PostEntryLineInput["extraDims"],
          custom: line.custom as PostEntryLineInput["custom"],
        }),
      ),
    });
    await markEntryReversed(db, { orgId, entryId: claim.settlement_entry_id, actorId });
    await releaseVoidedRebateSettlement(orgId, actorId, claim, entry.entryId, date, reason);
    return { entryId: entry.entryId };
  });
}

/** Manual reassessment uses the same posting service after cost attestation or
 * agreement approval. The permission belongs to the actual source document. */
export async function reassessRebates(
  orgId: string,
  actorId: string,
  documentId: string,
  date: string,
  reason: string,
) {
  if (!isIsoCalendarDate(date) || reason.trim().length < 8)
    throw new RebateError("Enter an assessment posting date and reason");
  return withOrg(orgId, async () => {
    await lockLedgerSetupFence(db, orgId, "shared");
    const doc = (
      await db.execute<{ subsidiary_id: string; kind: string; status: string }>(
        sql`select subsidiary_id,kind,status from documents where org_id=${orgId} and id=${documentId} for share`,
        "objects",
      )
    )[0];
    if (!doc?.subsidiary_id || doc.status !== "posted") throw new ScopeNotFoundError();
    await enabled(db, orgId);
    await lockActorCommandAuthority(
      db,
      orgId,
      actorId,
      doc.subsidiary_id,
      doc.kind.startsWith("vendor") ? "ap.post" : "ar.post",
    );
    await accrueRebatesForDocument(orgId, documentId, actorId, date);
    await audit(db, orgId, actorId, "documents", documentId, "rebate_reassessment", reason, null, {
      postingDate: date,
    });
    return { documentId };
  });
}

export async function cancelRebateClaim(
  orgId: string,
  actorId: string,
  id: string,
  reason: string,
) {
  if (reason.trim().length < 8) throw new RebateError("Enter a cancellation reason");
  return withOrg(orgId, async () => {
    await lockLedgerSetupFence(db, orgId, "shared");
    const { claim } = await rebateClaimContext(db, orgId, actorId, id);
    if (!["draft", "approved"].includes(claim.status) || claim.settlement_document_id)
      throw new RebateError("Void or reverse the linked settlement before cancelling this claim");
    if (
      !(
        await db.execute(
          sql`update rebate_claims set status='cancelled',updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${id} and status in ('draft','approved') returning id`,
          "objects",
        )
      )[0]
    )
      throw new RebateError("Claim cancellation could not be saved");
    await audit(db, orgId, actorId, "rebate_claims", id, "cancel", reason, claim, {
      status: "cancelled",
    });
    return { id };
  });
}
