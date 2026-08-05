import { sql } from "drizzle-orm";
import { db, inDbTransaction } from "./db.ts";
import { add, cmp, fromUnits, toUnits } from "./money.ts";

/**
 * Year-end information returns: 1099-NEC, 1099-MISC and T4A.
 *
 * The hard part is not the form, it is the number. A 1099 reports CASH PAID in
 * the calendar year — not billed, not accrued — so the figure is built by
 * tracing every posted vendor payment back to what it settled:
 *
 *   payment (bank leg, base currency)
 *     → applications → the bill open-item lines it extinguished
 *       → that bill's expense lines → each line's account
 *         → a box, via information_return_box_rules
 *
 * Cash is allocated across that weight tree by largest remainder, so the boxes
 * of a recipient always re-add to the cash that actually left the bank — to the
 * penny, with no residue parked in a rounding account. A payment that settled
 * nothing (a deposit or advance) lands in the recipient's default box, because
 * the money did leave and the IRS does not care that we had no bill yet.
 *
 * Everything the engine cannot decide it REPORTS rather than guesses: a
 * reportable vendor with no TIN, a corporation flagged as reportable, a vendor
 * paid over the threshold that nobody flagged. Those are the exceptions list,
 * and they are the whole reason this is a workspace and not a report.
 */

export class InformationReturnError extends Error {}

export type FormType = "1099-NEC" | "1099-MISC" | "T4A";

export type TaxClassification =
  | "individual"
  | "sole_proprietor"
  | "partnership"
  | "c_corp"
  | "s_corp"
  | "llc"
  | "trust_estate"
  | "government"
  | "nonprofit"
  | "other";

export interface FormBox {
  /** Stable key stored in computed_amounts / box rules. */
  key: string;
  /** The number printed on the form. */
  number: string;
  name: string;
  /** Statutory reporting threshold for this box alone, when it differs. */
  threshold?: string;
  /** Tax withheld and remitted for the recipient rather than paid to them. */
  isWithholding?: boolean;
  /** A checkbox, not an amount (printed as an X). */
  isIndicator?: boolean;
}

export interface FormDefinition {
  formType: FormType;
  name: string;
  /** Jurisdiction, for the facsimile masthead. */
  authority: string;
  /** Box every unmapped payment lands in. */
  defaultBox: string;
  /** Statutory filing threshold on total reportable amounts. */
  defaultThreshold: string;
  boxes: FormBox[];
}

/**
 * The statutory box catalogue. Boxes are law, not tenant configuration — what
 * an org configures is which of ITS accounts feeds which box
 * (information_return_box_rules).
 */
export const INFORMATION_RETURN_FORMS: Record<FormType, FormDefinition> = {
  "1099-NEC": {
    formType: "1099-NEC",
    name: "Nonemployee Compensation",
    authority: "Internal Revenue Service",
    defaultBox: "nec1",
    defaultThreshold: "600",
    boxes: [
      { key: "nec1", number: "1", name: "Nonemployee compensation", threshold: "600" },
      { key: "nec2", number: "2", name: "Payer made direct sales totaling $5,000 or more", isIndicator: true },
      { key: "nec4", number: "4", name: "Federal income tax withheld", isWithholding: true, threshold: "0.01" },
    ],
  },
  "1099-MISC": {
    formType: "1099-MISC",
    name: "Miscellaneous Information",
    authority: "Internal Revenue Service",
    defaultBox: "misc3",
    defaultThreshold: "600",
    boxes: [
      { key: "misc1", number: "1", name: "Rents", threshold: "600" },
      { key: "misc2", number: "2", name: "Royalties", threshold: "10" },
      { key: "misc3", number: "3", name: "Other income", threshold: "600" },
      { key: "misc4", number: "4", name: "Federal income tax withheld", isWithholding: true, threshold: "0.01" },
      { key: "misc5", number: "5", name: "Fishing boat proceeds", threshold: "600" },
      { key: "misc6", number: "6", name: "Medical and health care payments", threshold: "600" },
      { key: "misc8", number: "8", name: "Substitute payments in lieu of dividends or interest", threshold: "10" },
      { key: "misc9", number: "9", name: "Crop insurance proceeds", threshold: "600" },
      { key: "misc10", number: "10", name: "Gross proceeds paid to an attorney", threshold: "600" },
      { key: "misc11", number: "11", name: "Fish purchased for resale", threshold: "600" },
      { key: "misc12", number: "12", name: "Section 409A deferrals" },
      { key: "misc14", number: "14", name: "Excess golden parachute payments" },
      { key: "misc15", number: "15", name: "Nonqualified deferred compensation" },
    ],
  },
  T4A: {
    formType: "T4A",
    name: "Statement of Pension, Retirement, Annuity, and Other Income",
    authority: "Canada Revenue Agency",
    defaultBox: "t4a048",
    defaultThreshold: "500",
    boxes: [
      { key: "t4a020", number: "020", name: "Self-employed commissions", threshold: "500" },
      { key: "t4a048", number: "048", name: "Fees for services", threshold: "500" },
      { key: "t4a022", number: "022", name: "Income tax deducted", isWithholding: true, threshold: "0.01" },
    ],
  },
};

export const FORM_TYPES = Object.keys(INFORMATION_RETURN_FORMS) as FormType[];

export function formDefinition(formType: string): FormDefinition {
  const def = INFORMATION_RETURN_FORMS[formType as FormType];
  if (!def) throw new InformationReturnError(`unknown information return form "${formType}"`);
  return def;
}

/** Corporations are outside 1099 reporting except for a handful of box types. */
const CORPORATE_CLASSIFICATIONS: ReadonlySet<TaxClassification> = new Set<TaxClassification>([
  "c_corp",
  "s_corp",
]);

/**
 * Boxes that stay reportable for a corporation: attorney gross proceeds and
 * medical/health payments. Being explicit here is what keeps the exceptions list
 * from crying wolf on every incorporated law firm.
 */
const CORPORATE_REPORTABLE_BOXES: ReadonlySet<string> = new Set(["misc6", "misc10"]);

// ---------------------------------------------------------------------------
// Exact proportional allocation
// ---------------------------------------------------------------------------

/**
 * Split `total` across `weights` so the parts sum to exactly `total`.
 *
 * Largest-remainder: floor every share, then hand the leftover units out to the
 * biggest remainders, ties broken by position so the result is deterministic.
 * All-zero weights put everything on the first bucket rather than losing it —
 * cash that left the bank has to land somewhere.
 */
export function allocateProportionally(total: string, weights: readonly string[]): string[] {
  if (weights.length === 0) return [];
  const totalUnits = toUnits(total);
  if (totalUnits === 0n) return weights.map(() => "0.0000");
  const w = weights.map((x) => {
    const u = toUnits(x);
    return u < 0n ? -u : u;
  });
  const weightSum = w.reduce((a, b) => a + b, 0n);
  if (weightSum === 0n) return weights.map((_, i) => (i === 0 ? fromUnits(totalUnits) : "0.0000"));

  const negative = totalUnits < 0n;
  const absTotal = negative ? -totalUnits : totalUnits;
  const shares = w.map((weight) => (absTotal * weight) / weightSum);
  const remainders = w.map((weight, i) => ({ i, r: (absTotal * weight) % weightSum }));
  let allocated = shares.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (b.r === a.r ? a.i - b.i : b.r > a.r ? 1 : -1));
  let cursor = 0;
  while (allocated < absTotal) {
    const target = remainders[cursor % remainders.length]!.i;
    shares[target] += 1n;
    allocated += 1n;
    cursor += 1;
  }
  return shares.map((s) => fromUnits(negative ? -s : s));
}

// ---------------------------------------------------------------------------
// Computation inputs (pure core)
// ---------------------------------------------------------------------------

/** One expense line of a settled bill: the weight, and the account behind it. */
export interface SettledLine {
  accountId: string | null;
  /** Line amount + its tax, transaction currency. Used only as a ratio. */
  weight: string;
}

/** One bill a payment settled, and how much of the payment went to it. */
export interface SettledBill {
  documentId: string;
  /** Applied amount, base currency. */
  applied: string;
  lines: SettledLine[];
}

export interface PaymentTrace {
  paymentId: string;
  documentNumber: string;
  paymentDate: string;
  /** Cash that left the bank, base currency, positive. */
  cash: string;
  bills: SettledBill[];
}

export interface RecipientProfile {
  partyId: string;
  displayName: string;
  legalName: string | null;
  reportable: boolean;
  /** Resolved form: vendor override, else the compliance class default. */
  resolvedForm: FormType | "none" | null;
  defaultBox: string | null;
  taxClassification: TaxClassification | null;
  tinLast4: string | null;
  tinType: string | null;
  backupWithholding: boolean;
  address: Record<string, string | null>;
}

export interface RecipientAmounts {
  /** Box key → exact-decimal amount. */
  boxAmounts: Record<string, string>;
  /** Sum of every non-withholding box: what the recipient was paid. */
  reportableTotal: string;
  /** Sum of withholding boxes. */
  withheld: string;
  paymentCount: number;
  /** Cash traced, base currency. Equals the sum of every box. */
  tracedCash: string;
}

export type ExceptionKind =
  | "missing_tin"
  | "missing_form_assignment"
  | "corporation_flagged"
  | "unflagged_over_threshold"
  | "backup_withholding_not_withheld"
  | "unmapped_account";

export interface ComputationException {
  kind: ExceptionKind;
  partyId: string | null;
  partyName: string;
  detail: string;
  /** Amount at stake, when the exception is about money. */
  amount?: string;
}

export interface RecipientComputation {
  profile: RecipientProfile;
  amounts: RecipientAmounts;
  /** Below the statutory threshold for every box that carries an amount. */
  belowThreshold: boolean;
  /** Payment-by-payment trace, for the drill-down. */
  paymentIds: string[];
}

export interface FilingComputation {
  taxYear: number;
  formType: FormType;
  threshold: string;
  currency: string;
  recipients: RecipientComputation[];
  exceptions: ComputationException[];
  /** Cash traced across every recipient — ties the filing back to the ledger. */
  tracedCash: string;
}

/**
 * Allocate one payment's cash to boxes.
 *
 * Weights come from the bill lines the payment settled: applied-amount ×
 * line-share. Unsettled cash (an advance, or a payment whose bill carries no
 * lines) falls to `defaultBox`. Two rounding stages would drift, so the whole
 * payment is allocated once against a single flattened weight vector.
 */
export function allocatePaymentToBoxes(args: {
  payment: PaymentTrace;
  /** account id → box key. */
  boxByAccount: ReadonlyMap<string, string>;
  defaultBox: string;
}): { boxAmounts: Record<string, string>; unmappedAccountIds: string[] } {
  const buckets: { box: string; weight: string; accountId: string | null }[] = [];
  let appliedTotal = 0n;
  for (const bill of args.payment.bills) {
    appliedTotal += toUnits(bill.applied);
    const lineWeightSum = bill.lines.reduce((n, l) => n + toUnits(l.weight), 0n);
    if (bill.lines.length === 0 || lineWeightSum === 0n) {
      // A settled bill we cannot decompose still consumed cash: attribute it to
      // the default box rather than dropping it out of the filing.
      buckets.push({ box: args.defaultBox, weight: bill.applied, accountId: null });
      continue;
    }
    for (const line of bill.lines) {
      // weight = applied × (line ÷ bill). Kept as an exact rational by scaling
      // through the applied amount; the final rounding happens once, below.
      const share = (toUnits(bill.applied) * toUnits(line.weight)) / lineWeightSum;
      if (share === 0n) continue;
      const box = (line.accountId && args.boxByAccount.get(line.accountId)) || args.defaultBox;
      buckets.push({ box, weight: fromUnits(share), accountId: line.accountId });
    }
  }
  // Cash beyond what it settled: prepayment, retainer, or an over-payment.
  const unapplied = toUnits(args.payment.cash) - appliedTotal;
  if (unapplied > 0n) {
    buckets.push({ box: args.defaultBox, weight: fromUnits(unapplied), accountId: null });
  }
  if (buckets.length === 0) {
    buckets.push({ box: args.defaultBox, weight: args.payment.cash, accountId: null });
  }

  const parts = allocateProportionally(
    args.payment.cash,
    buckets.map((b) => b.weight),
  );
  const boxAmounts: Record<string, string> = {};
  const unmapped = new Set<string>();
  buckets.forEach((bucket, i) => {
    const amount = parts[i]!;
    boxAmounts[bucket.box] = add(boxAmounts[bucket.box] ?? "0", amount);
    if (bucket.accountId && !args.boxByAccount.has(bucket.accountId) && toUnits(amount) !== 0n) {
      unmapped.add(bucket.accountId);
    }
  });
  return { boxAmounts, unmappedAccountIds: [...unmapped] };
}

/** Roll a recipient's payments up into box totals and a threshold verdict. */
export function summarizeRecipient(args: {
  form: FormDefinition;
  payments: readonly PaymentTrace[];
  boxByAccount: ReadonlyMap<string, string>;
  defaultBox: string;
  filingThreshold: string;
}): { amounts: RecipientAmounts; belowThreshold: boolean; unmappedAccountIds: string[] } {
  const boxAmounts: Record<string, string> = {};
  const unmapped = new Set<string>();
  let traced = "0";
  for (const payment of args.payments) {
    const allocated = allocatePaymentToBoxes({
      payment,
      boxByAccount: args.boxByAccount,
      defaultBox: args.defaultBox,
    });
    for (const [box, amount] of Object.entries(allocated.boxAmounts)) {
      boxAmounts[box] = add(boxAmounts[box] ?? "0", amount);
    }
    for (const id of allocated.unmappedAccountIds) unmapped.add(id);
    traced = add(traced, payment.cash);
  }
  const withholdingBoxes = new Set(args.form.boxes.filter((b) => b.isWithholding).map((b) => b.key));
  let reportableTotal = "0";
  let withheld = "0";
  for (const [box, amount] of Object.entries(boxAmounts)) {
    if (withholdingBoxes.has(box)) withheld = add(withheld, amount);
    else reportableTotal = add(reportableTotal, amount);
  }

  // Above threshold when the total clears the filing threshold, or when any
  // single box clears its own (royalties at $10 must file even at $15 total).
  const boxByKey = new Map(args.form.boxes.map((b) => [b.key, b]));
  const boxClears = Object.entries(boxAmounts).some(([box, amount]) => {
    const threshold = boxByKey.get(box)?.threshold;
    return threshold !== undefined && cmp(amount, threshold) >= 0;
  });
  const belowThreshold = !(cmp(reportableTotal, args.filingThreshold) >= 0 || boxClears);

  return {
    amounts: {
      boxAmounts,
      reportableTotal,
      withheld,
      paymentCount: args.payments.length,
      tracedCash: traced,
    },
    belowThreshold,
    unmappedAccountIds: [...unmapped],
  };
}

/** The exceptions a person has to look at before this filing is trustworthy. */
export function recipientExceptions(args: {
  profile: RecipientProfile;
  amounts: RecipientAmounts;
  form: FormDefinition;
  belowThreshold: boolean;
  filingThreshold: string;
  unmappedAccountNames: readonly string[];
}): ComputationException[] {
  const out: ComputationException[] = [];
  const { profile, amounts } = args;
  const name = profile.legalName ?? profile.displayName;
  const included = profile.reportable && !args.belowThreshold;

  if (profile.reportable && (profile.resolvedForm === null || profile.resolvedForm === "none")) {
    out.push({
      kind: "missing_form_assignment",
      partyId: profile.partyId,
      partyName: name,
      detail: "flagged as reportable but no information return is assigned",
      amount: amounts.reportableTotal,
    });
  }
  if (included && !profile.tinLast4) {
    out.push({
      kind: "missing_tin",
      partyId: profile.partyId,
      partyName: name,
      detail: "no taxpayer identification number on file",
      amount: amounts.reportableTotal,
    });
  }
  if (
    included &&
    profile.taxClassification &&
    CORPORATE_CLASSIFICATIONS.has(profile.taxClassification) &&
    !Object.keys(amounts.boxAmounts).some((box) => CORPORATE_REPORTABLE_BOXES.has(box))
  ) {
    out.push({
      kind: "corporation_flagged",
      partyId: profile.partyId,
      partyName: name,
      detail: `classified ${profile.taxClassification} — corporations are generally not reportable`,
      amount: amounts.reportableTotal,
    });
  }
  if (
    !profile.reportable &&
    cmp(amounts.reportableTotal, args.filingThreshold) >= 0 &&
    !(profile.taxClassification && CORPORATE_CLASSIFICATIONS.has(profile.taxClassification))
  ) {
    out.push({
      kind: "unflagged_over_threshold",
      partyId: profile.partyId,
      partyName: name,
      detail: `paid over the ${args.filingThreshold} threshold but not flagged as reportable`,
      amount: amounts.reportableTotal,
    });
  }
  if (included && profile.backupWithholding && cmp(amounts.withheld, "0") === 0) {
    out.push({
      kind: "backup_withholding_not_withheld",
      partyId: profile.partyId,
      partyName: name,
      detail: "flagged for backup withholding but no tax was withheld",
      amount: amounts.reportableTotal,
    });
  }
  for (const account of args.unmappedAccountNames) {
    out.push({
      kind: "unmapped_account",
      partyId: profile.partyId,
      partyName: name,
      detail: `spend on "${account}" has no box rule and fell to the default box`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/** account id → box key, for one form. */
export async function loadBoxRules(
  orgId: string,
  formType: FormType,
  runner: Pick<typeof db, "execute"> = db,
): Promise<Map<string, string>> {
  const r = (await runner.execute(sql`
    select account_id, box from information_return_box_rules
     where org_id = ${orgId} and form_type = ${formType} and is_active
  `)) as unknown as { rows: { account_id: string; box: string }[] };
  return new Map(r.rows.map((row) => [row.account_id, row.box]));
}

/**
 * Every posted vendor payment in the calendar year, traced to the bills and
 * bill lines it settled.
 *
 * Cash is the bank-side leg in BASE currency, which is what a 1099 reports; the
 * per-line weights stay in transaction currency because they are only ratios.
 * Voided payments and unapplied (reversed) applications are excluded — the
 * filing reflects cash that actually and finally moved.
 */
export async function loadPaymentTraces(args: {
  orgId: string;
  taxYear: number;
  subsidiaryId?: string | null;
  runner?: Pick<typeof db, "execute">;
}): Promise<Map<string, PaymentTrace[]>> {
  const runner = args.runner ?? db;
  const from = `${args.taxYear}-01-01`;
  const to = `${args.taxYear}-12-31`;
  const payments = (await runner.execute(sql`
    select d.id, d.document_number, d.party_id, d.document_date,
           -- Cash out is the credit to the funding account; sum the negative,
           -- non-open-item legs so cheques, EFT and card runs all measure alike.
           coalesce(-sum(jl.amount) filter (where jl.amount < 0 and not jl.is_open_item), 0) as cash
      from documents d
      join journal_entries je on je.id = d.posted_entry_id and je.status = 'posted'
      join journal_lines jl on jl.entry_id = je.id
     where d.org_id = ${args.orgId} and d.kind = 'vendor_payment' and d.status = 'posted'
       and d.document_date between ${from} and ${to}
       and d.party_id is not null
       and (${args.subsidiaryId ?? null}::uuid is null or d.subsidiary_id = ${args.subsidiaryId ?? null}::uuid)
     group by d.id, d.document_number, d.party_id, d.document_date
     having coalesce(-sum(jl.amount) filter (where jl.amount < 0 and not jl.is_open_item), 0) > 0
     order by d.document_date, d.document_number
  `)) as unknown as {
    rows: { id: string; document_number: string; party_id: string; document_date: string; cash: string }[];
  };
  if (payments.rows.length === 0) return new Map();

  const paymentIds = payments.rows.map((p) => p.id);
  // What each payment settled, and each settled bill's expense composition.
  // `applications.amount` is base currency, matching the cash figure above.
  const settled = (await runner.execute(sql`
    with paid as (
      select d.id as payment_id, jl.id as line_id
        from documents d
        join journal_entries je on je.id = d.posted_entry_id and je.status = 'posted'
        join journal_lines jl on jl.entry_id = je.id and jl.is_open_item
       where d.org_id = ${args.orgId} and d.id = any(${`{${paymentIds.join(',')}}`}::uuid[])
    )
    select paid.payment_id, bill.id as bill_id, sum(a.amount) as applied
      from paid
      join applications a on a.from_line_id = paid.line_id and a.unapplied_at is null
      join journal_lines target on target.id = a.to_line_id
      join journal_entries bje on bje.id = target.entry_id
      join documents bill on bill.id = bje.source_document_id
     where a.org_id = ${args.orgId}
     group by paid.payment_id, bill.id
  `)) as unknown as { rows: { payment_id: string; bill_id: string; applied: string }[] };

  const billIds = [...new Set(settled.rows.map((r) => r.bill_id))];
  const lines = billIds.length
    ? ((await runner.execute(sql`
        select dl.document_id, dl.account_id,
               -- Tax rides along proportionally: a 1099 reports the gross paid.
               (dl.amount + coalesce(dl.tax_amount, 0)) as weight
          from document_lines dl
         where dl.org_id = ${args.orgId} and dl.document_id = any(${`{${billIds.join(',')}}`}::uuid[])
         order by dl.document_id, dl.line_number
      `)) as unknown as { rows: { document_id: string; account_id: string | null; weight: string }[] })
    : { rows: [] };

  const linesByBill = new Map<string, SettledLine[]>();
  for (const row of lines.rows) {
    const list = linesByBill.get(row.document_id) ?? [];
    list.push({ accountId: row.account_id, weight: row.weight });
    linesByBill.set(row.document_id, list);
  }
  const billsByPayment = new Map<string, SettledBill[]>();
  for (const row of settled.rows) {
    const list = billsByPayment.get(row.payment_id) ?? [];
    list.push({
      documentId: row.bill_id,
      applied: row.applied,
      lines: linesByBill.get(row.bill_id) ?? [],
    });
    billsByPayment.set(row.payment_id, list);
  }

  const byParty = new Map<string, PaymentTrace[]>();
  for (const p of payments.rows) {
    const list = byParty.get(p.party_id) ?? [];
    list.push({
      paymentId: p.id,
      documentNumber: p.document_number,
      paymentDate: p.document_date,
      cash: p.cash,
      bills: billsByPayment.get(p.id) ?? [],
    });
    byParty.set(p.party_id, list);
  }
  return byParty;
}

/** Vendor identification for every party paid in the year. */
export async function loadRecipientProfiles(args: {
  orgId: string;
  partyIds: readonly string[];
  runner?: Pick<typeof db, "execute">;
}): Promise<Map<string, RecipientProfile>> {
  if (args.partyIds.length === 0) return new Map();
  const runner = args.runner ?? db;
  const r = (await runner.execute(sql`
    select p.id, p.display_name, p.legal_name,
           vr.is_t4a as reportable,
           coalesce(vr.information_return_form, cc.default_information_return) as resolved_form,
           vr.information_return_box as default_box,
           vr.tax_classification, vr.tin_last4, vr.tin_type,
           coalesce(vr.backup_withholding, false) as backup_withholding,
           a.line1, a.line2, a.city, a.region, a.postal_code, a.country
      from parties p
      left join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id
      left join compliance_classes cc on cc.id = vr.compliance_class_id and cc.org_id = p.org_id
      left join lateral (
        select line1, line2, city, region, postal_code, country
          from addresses
         where org_id = p.org_id and party_id = p.id
         order by is_default_billing desc, created_at
         limit 1
      ) a on true
     where p.org_id = ${args.orgId} and p.id = any(${`{${[...args.partyIds].join(',')}}`}::uuid[])
  `)) as unknown as {
    rows: {
      id: string;
      display_name: string;
      legal_name: string | null;
      reportable: boolean | null;
      resolved_form: string | null;
      default_box: string | null;
      tax_classification: TaxClassification | null;
      tin_last4: string | null;
      tin_type: string | null;
      backup_withholding: boolean;
      line1: string | null;
      line2: string | null;
      city: string | null;
      region: string | null;
      postal_code: string | null;
      country: string | null;
    }[];
  };
  return new Map(
    r.rows.map((row) => [
      row.id,
      {
        partyId: row.id,
        displayName: row.display_name,
        legalName: row.legal_name,
        reportable: row.reportable === true,
        resolvedForm: (row.resolved_form as FormType | "none" | null) ?? null,
        defaultBox: row.default_box,
        taxClassification: row.tax_classification,
        tinLast4: row.tin_last4,
        tinType: row.tin_type,
        backupWithholding: row.backup_withholding,
        address: {
          line1: row.line1,
          line2: row.line2,
          city: row.city,
          region: row.region,
          postalCode: row.postal_code,
          country: row.country,
        },
      } satisfies RecipientProfile,
    ]),
  );
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

/**
 * Compute one filing from the ledger. Read-only: nothing is written until a
 * caller persists the result, so an org can re-run this as often as it likes
 * while chasing W-9s.
 */
export async function computeFiling(args: {
  orgId: string;
  taxYear: number;
  formType: FormType;
  threshold?: string;
  currency: string;
  subsidiaryId?: string | null;
  runner?: Pick<typeof db, "execute">;
}): Promise<FilingComputation> {
  const runner = args.runner ?? db;
  const form = formDefinition(args.formType);
  const threshold = args.threshold ?? form.defaultThreshold;
  const [traces, boxByAccount] = await Promise.all([
    loadPaymentTraces({
      orgId: args.orgId,
      taxYear: args.taxYear,
      subsidiaryId: args.subsidiaryId ?? null,
      runner,
    }),
    loadBoxRules(args.orgId, args.formType, runner),
  ]);
  const profiles = await loadRecipientProfiles({
    orgId: args.orgId,
    partyIds: [...traces.keys()],
    runner,
  });

  // Account names only for the accounts an exception will actually name.
  const accountNames = new Map<string, string>();
  const validBoxes = new Set(form.boxes.map((b) => b.key));

  const recipients: RecipientComputation[] = [];
  const exceptions: ComputationException[] = [];
  let tracedCash = "0";

  for (const [partyId, payments] of traces) {
    const profile = profiles.get(partyId);
    if (!profile) continue;
    // Only vendors whose resolved form is THIS form belong in this filing.
    // Unassigned reportable vendors are surfaced as exceptions instead.
    const onThisForm = profile.resolvedForm === args.formType;
    const unassigned = profile.reportable && (profile.resolvedForm === null || profile.resolvedForm === "none");
    const defaultBox =
      profile.defaultBox && validBoxes.has(profile.defaultBox) ? profile.defaultBox : form.defaultBox;
    const summary = summarizeRecipient({
      form,
      payments,
      boxByAccount,
      defaultBox,
      filingThreshold: threshold,
    });
    tracedCash = add(tracedCash, summary.amounts.tracedCash);

    if (summary.unmappedAccountIds.length > 0 && (onThisForm || unassigned)) {
      const missing = summary.unmappedAccountIds.filter((id) => !accountNames.has(id));
      if (missing.length > 0) {
        const named = (await runner.execute(sql`
          select id, coalesce(number || ' · ' || name, name) as label
            from accounts where org_id = ${args.orgId} and id = any(${`{${missing.join(',')}}`}::uuid[])
        `)) as unknown as { rows: { id: string; label: string }[] };
        for (const row of named.rows) accountNames.set(row.id, row.label);
      }
    }

    exceptions.push(
      ...recipientExceptions({
        profile,
        amounts: summary.amounts,
        form,
        belowThreshold: summary.belowThreshold,
        filingThreshold: threshold,
        unmappedAccountNames: (onThisForm ? summary.unmappedAccountIds : []).map(
          (id) => accountNames.get(id) ?? id,
        ),
      }),
    );

    if (!onThisForm) continue;
    recipients.push({
      profile,
      amounts: summary.amounts,
      belowThreshold: summary.belowThreshold,
      paymentIds: payments.map((p) => p.paymentId),
    });
  }

  recipients.sort((a, b) =>
    cmp(b.amounts.reportableTotal, a.amounts.reportableTotal) ||
    a.profile.displayName.localeCompare(b.profile.displayName),
  );
  return {
    taxYear: args.taxYear,
    formType: args.formType,
    threshold,
    currency: args.currency,
    recipients,
    exceptions,
    tracedCash,
  };
}

/** The figure that gets filed: computed plus any deliberate adjustment. */
export function filedBoxAmounts(
  computed: Record<string, string>,
  adjustments: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...computed };
  for (const [box, delta] of Object.entries(adjustments)) {
    out[box] = add(out[box] ?? "0", delta);
  }
  return out;
}

/** Sum of the non-withholding boxes actually being filed. */
export function filedTotal(form: FormDefinition, boxAmounts: Record<string, string>): string {
  const withholding = new Set(form.boxes.filter((b) => b.isWithholding).map((b) => b.key));
  const indicators = new Set(form.boxes.filter((b) => b.isIndicator).map((b) => b.key));
  return Object.entries(boxAmounts)
    .filter(([box]) => !withholding.has(box) && !indicators.has(box))
    .reduce((total, [, amount]) => add(total, amount), "0");
}

// ---------------------------------------------------------------------------
// Filing lifecycle
// ---------------------------------------------------------------------------

export interface FilingRow {
  id: string;
  taxYear: number;
  formType: FormType;
  subsidiaryId: string | null;
  status: "draft" | "computed" | "finalized" | "filed" | "void";
  threshold: string;
  currency: string;
}

/** Open (or create) this year's filing. Idempotent per year/form/entity. */
export async function ensureFiling(args: {
  orgId: string;
  taxYear: number;
  formType: FormType;
  subsidiaryId?: string | null;
  currency: string;
  threshold?: string;
  actorId: string;
  runner?: Pick<typeof db, "execute">;
}): Promise<FilingRow> {
  const runner = args.runner ?? db;
  const form = formDefinition(args.formType);
  const subsidiaryId = args.subsidiaryId ?? null;
  const existing = (await runner.execute(sql`
    select id, tax_year as "taxYear", form_type as "formType", subsidiary_id as "subsidiaryId",
           status, threshold, currency
      from information_return_filings
     where org_id = ${args.orgId} and tax_year = ${args.taxYear} and form_type = ${args.formType}
       and subsidiary_id is not distinct from ${subsidiaryId}::uuid
  `)) as unknown as { rows: FilingRow[] };
  if (existing.rows[0]) return existing.rows[0];
  const inserted = (await runner.execute(sql`
    insert into information_return_filings
      (org_id, tax_year, form_type, subsidiary_id, status, threshold, currency, created_by, updated_by)
    values (${args.orgId}, ${args.taxYear}, ${args.formType}, ${subsidiaryId}, 'draft',
            ${args.threshold ?? form.defaultThreshold}, ${args.currency}, ${args.actorId}, ${args.actorId})
    returning id, tax_year as "taxYear", form_type as "formType", subsidiary_id as "subsidiaryId",
              status, threshold, currency
  `)) as unknown as { rows: FilingRow[] };
  return inserted.rows[0]!;
}

/**
 * Recompute a filing from the ledger and store the result.
 *
 * Only a draft/computed filing may be recomputed: a finalized filing is what
 * was transmitted, and re-deriving it would destroy the evidence of what the
 * recipient was actually sent. Adjustments and exclusions a person entered
 * SURVIVE a recompute — they are decisions about the filing, not derived data —
 * and a recipient who no longer has any cash is voided rather than deleted, so
 * the disappearance is visible.
 */
export async function recomputeFiling(args: {
  orgId: string;
  filingId: string;
  actorId: string;
}): Promise<{ filing: FilingRow; computation: FilingComputation }> {
  const filings = (await db.execute(sql`
    select id, tax_year as "taxYear", form_type as "formType", subsidiary_id as "subsidiaryId",
           status, threshold, currency
      from information_return_filings
     where org_id = ${args.orgId} and id = ${args.filingId}
  `)) as unknown as { rows: FilingRow[] };
  const filing = filings.rows[0];
  if (!filing) throw new InformationReturnError("information return filing not found");
  if (filing.status !== "draft" && filing.status !== "computed") {
    throw new InformationReturnError(
      `a ${filing.status} filing cannot be recomputed — void it and open a corrected filing instead`,
    );
  }

  const computation = await computeFiling({
    orgId: args.orgId,
    taxYear: filing.taxYear,
    formType: filing.formType,
    threshold: filing.threshold,
    currency: filing.currency,
    subsidiaryId: filing.subsidiaryId,
  });
  const form = formDefinition(filing.formType);
  const withholdingBoxes = new Set(form.boxes.filter((b) => b.isWithholding).map((b) => b.key));

  await inDbTransaction(async (tx) => {
    const seen: string[] = [];
    for (const recipient of computation.recipients) {
      seen.push(recipient.profile.partyId);
      const withheld = Object.entries(recipient.amounts.boxAmounts)
        .filter(([box]) => withholdingBoxes.has(box))
        .reduce((total, [, amount]) => add(total, amount), "0");
      // Below the threshold is an exclusion, not an omission: the row stays so
      // a reviewer can see the vendor was considered and why it is not filed.
      const belowThresholdReason = `below the ${filing.threshold} ${filing.currency} reporting threshold`;
      await tx.execute(sql`
        insert into information_return_recipients
          (org_id, filing_id, party_id, recipient_snapshot, tin_last4, tin_type,
           computed_amounts, tax_withheld, status, exclusion_reason, created_by, updated_by)
        values (${args.orgId}, ${filing.id}, ${recipient.profile.partyId},
                ${JSON.stringify({
                  displayName: recipient.profile.displayName,
                  legalName: recipient.profile.legalName,
                  taxClassification: recipient.profile.taxClassification,
                  backupWithholding: recipient.profile.backupWithholding,
                  address: recipient.profile.address,
                  paymentIds: recipient.paymentIds,
                })}::jsonb,
                ${recipient.profile.tinLast4}, ${recipient.profile.tinType},
                ${JSON.stringify(recipient.amounts.boxAmounts)}::jsonb, ${withheld},
                ${recipient.belowThreshold ? "excluded" : "included"},
                ${recipient.belowThreshold ? belowThresholdReason : null},
                ${args.actorId}, ${args.actorId})
        on conflict (filing_id, party_id) do update set
          recipient_snapshot = excluded.recipient_snapshot,
          tin_last4 = excluded.tin_last4,
          tin_type = excluded.tin_type,
          computed_amounts = excluded.computed_amounts,
          tax_withheld = excluded.tax_withheld,
          -- A person's decision to exclude a recipient outranks the automatic
          -- threshold verdict; everything else re-derives.
          status = case
            when information_return_recipients.status = 'excluded'
             and information_return_recipients.exclusion_reason <> ${belowThresholdReason}
              then information_return_recipients.status
            else excluded.status end,
          exclusion_reason = case
            when information_return_recipients.status = 'excluded'
             and information_return_recipients.exclusion_reason <> ${belowThresholdReason}
              then information_return_recipients.exclusion_reason
            else excluded.exclusion_reason end,
          updated_at = now(), updated_by = ${args.actorId}
      `);
    }
    // Recipients that no longer trace to any cash: voided, never deleted.
    await tx.execute(sql`
      update information_return_recipients
         set status = 'void', updated_at = now(), updated_by = ${args.actorId}
       where org_id = ${args.orgId} and filing_id = ${filing.id}
         and status <> 'void'
         and (${seen.length === 0} or party_id <> all(${`{${seen.join(",")}}`}::uuid[]))
    `);
    await tx.execute(sql`
      update information_return_filings
         set status = 'computed', computed_at = now(), computed_by = ${args.actorId},
             updated_at = now(), updated_by = ${args.actorId}
       where org_id = ${args.orgId} and id = ${filing.id}
    `);
  });

  return { filing: { ...filing, status: "computed" }, computation };
}

/**
 * Freeze the filing. The payer identification is snapshotted here because the
 * transmitted forms must remain reproducible after the org record changes, and
 * a filing with unresolved blocking exceptions (a recipient with no TIN) is
 * refused rather than transmitted with a blank.
 */
export async function finalizeFiling(args: {
  orgId: string;
  filingId: string;
  actorId: string;
}): Promise<void> {
  const rows = (await db.execute(sql`
    select f.status, f.tax_year, f.form_type, f.threshold, f.currency,
           o.name as org_name, o.settings->'taxIds' as tax_ids,
           s.name as subsidiary_name,
           (select count(*)::int from information_return_recipients r
             where r.filing_id = f.id and r.status = 'included') as included,
           (select count(*)::int from information_return_recipients r
             where r.filing_id = f.id and r.status = 'included' and r.tin_last4 is null) as missing_tin
      from information_return_filings f
      join orgs o on o.id = f.org_id
      left join subsidiaries s on s.id = f.subsidiary_id
     where f.org_id = ${args.orgId} and f.id = ${args.filingId}
  `)) as unknown as {
    rows: {
      status: string;
      tax_year: number;
      form_type: string;
      threshold: string;
      currency: string;
      org_name: string;
      tax_ids: Record<string, string> | null;
      subsidiary_name: string | null;
      included: number;
      missing_tin: number;
    }[];
  };
  const filing = rows.rows[0];
  if (!filing) throw new InformationReturnError("information return filing not found");
  if (filing.status !== "computed") {
    throw new InformationReturnError(
      filing.status === "draft"
        ? "compute the filing before finalizing it"
        : `a ${filing.status} filing cannot be finalized again`,
    );
  }
  if (filing.included === 0) throw new InformationReturnError("the filing has no recipients to file");
  if (filing.missing_tin > 0) {
    throw new InformationReturnError(
      `${filing.missing_tin} recipient(s) have no taxpayer identification number — collect a W-9 or exclude them before finalizing`,
    );
  }
  await db.execute(sql`
    update information_return_filings
       set status = 'finalized', finalized_at = now(), finalized_by = ${args.actorId},
           payer_snapshot = ${JSON.stringify({
             name: filing.subsidiary_name ?? filing.org_name,
             orgName: filing.org_name,
             taxIds: filing.tax_ids ?? {},
             taxYear: filing.tax_year,
             formType: filing.form_type,
             threshold: filing.threshold,
             currency: filing.currency,
           })}::jsonb,
           updated_at = now(), updated_by = ${args.actorId}
     where org_id = ${args.orgId} and id = ${args.filingId}
  `);
}

/** Record the transmission. Only a finalized filing can be filed. */
export async function markFilingFiled(args: {
  orgId: string;
  filingId: string;
  channel: "iris" | "fire" | "paper" | "provider" | "other";
  reference?: string | null;
  actorId: string;
}): Promise<void> {
  const updated = (await db.execute(sql`
    update information_return_filings
       set status = 'filed', filed_at = now(), filed_by = ${args.actorId},
           filing_channel = ${args.channel}, filing_reference = ${args.reference ?? null},
           updated_at = now(), updated_by = ${args.actorId}
     where org_id = ${args.orgId} and id = ${args.filingId} and status = 'finalized'
    returning id
  `)) as unknown as { rows: { id: string }[] };
  if (updated.rows.length === 0) {
    throw new InformationReturnError("only a finalized filing can be recorded as filed");
  }
}
